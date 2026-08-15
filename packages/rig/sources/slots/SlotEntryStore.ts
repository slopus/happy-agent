import { createId } from "@paralleldrive/cuid2";
import type { AppletFeature } from "@slopus/happy-agent-features";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

import { inTx } from "../persistence/inTx.js";
import type { SessionDatabase } from "../persistence/database/openSessionDatabase.js";
import { withDatabase } from "../persistence/databaseContext.js";
import { querySlotEntries } from "../persistence/slots/querySlotEntries.js";
import { querySlotEntry } from "../persistence/slots/querySlotEntry.js";
import { querySlotScopeTargetExists } from "../persistence/slots/querySlotScopeTargetExists.js";
import { slotEntryCreate } from "../persistence/slots/slotEntryCreate.js";
import { slotEntryRemove } from "../persistence/slots/slotEntryRemove.js";
import { slotEntriesRemoveByPluginAuthor } from "../persistence/slots/slotEntriesRemoveByPluginAuthor.js";
import { slotEntryUpdate } from "../persistence/slots/slotEntryUpdate.js";
import { createEventIdFactory } from "../protocol/createEventIdFactory.js";
import {
    createSlotEntryRequestSchema,
    updateSlotEntryRequestSchema,
    type CreateSlotEntryRequest,
    type SlotEntry,
    type SlotEntryFilter,
    type SlotsChangedEvent,
    type UpdateSlotEntryRequest,
} from "../protocol/SlotProtocol.js";
import { allowedSlotScopes, describeAllowedScopesForSlot } from "../protocol/SlotScopeRules.js";
import { describeAppletScopeNotAllowed } from "./describeAppletScopeNotAllowed.js";
import { SlotEntryInvalidError } from "./SlotEntryInvalidError.js";
import { SlotEntryNotFoundError } from "./SlotEntryNotFoundError.js";

export interface SlotEntryStoreOptions {
    applets: Pick<AppletFeature, "get">;
    database: SessionDatabase;
    now?: () => number;
    /** Delivers a change to the live global stream after the database write committed. */
    publish: (ctx: Context, event: SlotsChangedEvent) => void | Promise<void>;
    /**
     * Whether a session id names a live session. The in-memory store holds sessions outside
     * SQLite, so the slot store asks its owner instead of the sessions table.
     */
    sessionExists: (ctx: Context, sessionId: string) => boolean | Promise<boolean>;
}

/**
 * Owns every slot entry: agent- and plugin-authored content plugged into fixed Happy UI slots.
 *
 * Rig verifies types only — an unknown slot, scope, content shape, or dangling scope reference is
 * rejected with a typed error, and the content itself is never interpreted. Every change persists
 * first and then publishes `slots_changed` with the whole current set, so clients stay current
 * without polling.
 */
export class SlotEntryStore {
    readonly #applets: Pick<AppletFeature, "get">;
    readonly #createEventId = createEventIdFactory();
    readonly #database: SessionDatabase;
    readonly #now: () => number;
    readonly #publish: (ctx: Context, event: SlotsChangedEvent) => void | Promise<void>;
    readonly #sessionExists: (ctx: Context, sessionId: string) => boolean | Promise<boolean>;

    constructor(options: SlotEntryStoreOptions) {
        this.#applets = options.applets;
        this.#database = options.database;
        this.#now = options.now ?? Date.now;
        this.#publish = options.publish;
        this.#sessionExists = options.sessionExists;
    }

    async create(ctx: Context, request: CreateSlotEntryRequest): Promise<SlotEntry> {
        ctx = withDatabase(ctx, this.#database);
        if (!Value.Check(createSlotEntryRequestSchema, request)) {
            throw new SlotEntryInvalidError(describeInvalid(createSlotEntryRequestSchema, request));
        }
        requireAllowedSlotScope(request.slot, request.scope);
        const now = this.#now();
        const entry: SlotEntry = {
            id: createId(),
            slot: request.slot,
            scope: request.scope,
            ...scopeReference(request),
            content: request.content,
            author: request.author,
            description: request.description,
            purpose: request.purpose,
            createdAt: now,
            updatedAt: now,
        };
        const created = await inTx(ctx, "rig.sql.slots.store_create", async (ctx) => {
            await this.#requireAppletScope(ctx, entry.content, entry.scope);
            await this.#requireScopeTarget(ctx, entry);
            await slotEntryCreate(ctx, entry);
            return querySlotEntry(ctx, entry.id);
        });
        await this.#publishChanged(ctx);
        return created ?? entry;
    }

    async list(ctx: Context, filter: SlotEntryFilter = {}): Promise<readonly SlotEntry[]> {
        ctx = withDatabase(ctx, this.#database);
        return querySlotEntries(ctx, filter);
    }

    async remove(ctx: Context, id: string): Promise<SlotEntry> {
        ctx = withDatabase(ctx, this.#database);
        const removed = await inTx(ctx, "rig.sql.slots.store_remove", async (ctx) => {
            const entry = await querySlotEntry(ctx, id);
            if (entry === undefined) {
                throw new SlotEntryNotFoundError(`No slot entry with the id ${id} exists.`);
            }
            await slotEntryRemove(ctx, id);
            return entry;
        });
        await this.#publishChanged(ctx);
        return removed;
    }

    /** Removes the entries whose author disappeared with an uninstalled plugin. */
    async removeByPluginAuthor(ctx: Context, folder: string): Promise<number> {
        ctx = withDatabase(ctx, this.#database);
        const removed = await inTx(ctx, "rig.sql.slots.store_remove_by_plugin", (ctx) =>
            slotEntriesRemoveByPluginAuthor(ctx, folder),
        );
        if (removed > 0) await this.#publishChanged(ctx);
        return removed;
    }

    async update(ctx: Context, id: string, request: UpdateSlotEntryRequest): Promise<SlotEntry> {
        ctx = withDatabase(ctx, this.#database);
        if (!Value.Check(updateSlotEntryRequestSchema, request)) {
            throw new SlotEntryInvalidError(describeInvalid(updateSlotEntryRequestSchema, request));
        }
        const updated = await inTx(ctx, "rig.sql.slots.store_update", async (ctx) => {
            const existing = await querySlotEntry(ctx, id);
            if (existing === undefined) {
                throw new SlotEntryNotFoundError(`No slot entry with the id ${id} exists.`);
            }
            const entry: SlotEntry = {
                ...existing,
                ...(request.slot === undefined ? {} : { slot: request.slot }),
                ...(request.content === undefined ? {} : { content: request.content }),
                ...(request.description === undefined ? {} : { description: request.description }),
                ...(request.purpose === undefined ? {} : { purpose: request.purpose }),
                updatedAt: this.#now(),
            };
            if (request.slot !== undefined) {
                requireAllowedSlotScope(entry.slot, entry.scope);
            }
            if (request.slot !== undefined || request.content !== undefined) {
                await this.#requireAppletScope(ctx, entry.content, entry.scope);
            }
            await slotEntryUpdate(ctx, entry);
            return entry;
        });
        await this.#publishChanged(ctx);
        return updated;
    }

    async #publishChanged(ctx: Context): Promise<void> {
        const entries = await this.list(ctx);
        await this.#publish(ctx, {
            createdAt: this.#now(),
            data: { entries },
            id: this.#createEventId(),
            type: "slots_changed",
        });
    }

    async #requireScopeTarget(ctx: Context, entry: SlotEntry): Promise<void> {
        if (entry.scope === "everywhere") return;
        const id =
            entry.scope === "project"
                ? entry.projectId
                : entry.scope === "workspace"
                  ? entry.workspaceId
                  : entry.sessionId;
        if (id === undefined) {
            throw new SlotEntryInvalidError(
                `A ${entry.scope}-scoped slot entry needs the matching ${entry.scope} id.`,
            );
        }
        const exists =
            entry.scope === "session"
                ? await this.#sessionExists(ctx, id)
                : await querySlotScopeTargetExists(ctx, entry.scope, id);
        if (!exists) {
            throw new SlotEntryInvalidError(
                `The ${entry.scope} ${id} the slot entry points at does not exist.`,
            );
        }
    }

    async #requireAppletScope(
        ctx: Context,
        content: SlotEntry["content"],
        scope: SlotEntry["scope"],
    ): Promise<void> {
        if (content.type !== "button" || content.action.type !== "open-applet") return;
        const applet = await this.#applets.get(ctx, content.action.applet);
        if (applet === undefined || applet.allowedScopes.includes(scope)) return;
        throw new SlotEntryInvalidError(describeAppletScopeNotAllowed(applet, scope));
    }
}

/** Exactly the reference matching the scope is kept; the others are rejected. */
function scopeReference(
    request: CreateSlotEntryRequest,
): Pick<SlotEntry, "projectId" | "sessionId" | "workspaceId"> {
    const provided = [
        ...(request.projectId === undefined ? [] : (["project"] as const)),
        ...(request.workspaceId === undefined ? [] : (["workspace"] as const)),
        ...(request.sessionId === undefined ? [] : (["session"] as const)),
    ];
    const expected = request.scope === "everywhere" ? [] : [request.scope];
    if (
        provided.length !== expected.length ||
        (expected[0] !== undefined && provided[0] !== expected[0])
    ) {
        throw new SlotEntryInvalidError(
            request.scope === "everywhere"
                ? "An everywhere-scoped slot entry must not reference a project, workspace, or session."
                : `A ${request.scope}-scoped slot entry must reference exactly its ${request.scope}.`,
        );
    }
    if (request.scope === "project") return { projectId: request.projectId! };
    if (request.scope === "workspace") return { workspaceId: request.workspaceId! };
    if (request.scope === "session") return { sessionId: request.sessionId! };
    return {};
}

function describeInvalid(schema: Parameters<typeof Value.Errors>[0], value: unknown): string {
    const first = Value.Errors(schema, value).First();
    if (first === undefined) return "The slot entry is invalid.";
    const where = first.path === "" ? "" : ` at ${first.path}`;
    return `The slot entry is invalid${where}: ${first.message}.`;
}

function requireAllowedSlotScope(slot: SlotEntry["slot"], scope: SlotEntry["scope"]): void {
    if (allowedSlotScopes[slot].some((allowedScope) => allowedScope === scope)) return;
    throw new SlotEntryInvalidError(describeAllowedScopesForSlot(slot));
}
