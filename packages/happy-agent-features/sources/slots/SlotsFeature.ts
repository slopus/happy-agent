import { createHash } from "node:crypto";

import {
    agentKV,
    type AgentFeature,
    type AgentFeatureScope,
    type AnyAgentTool,
} from "@slopus/happy-agent-base";
import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

import {
    allowedSlotScopes,
    MAX_SLOT_ENTRIES,
    MAX_SLOT_OUTPUT_CHARACTERS,
    MAX_SLOT_PAGE_SIZE,
    scopeReferenceFromEntry,
    slotAgentIdSchema,
    slotContentSchema,
    slotCreateInputSchema,
    slotDescriptionSchema,
    slotEntrySchema,
    slotIdSchema,
    slotMutationOperationSchema,
    slotMutationOptionsSchema,
    slotOperationFingerprintSchema,
    slotOperationIdSchema,
    slotOperationStateSchema,
    slotPurposeSchema,
    slotReorderInputSchema,
    slotTimestampSchema,
    slotUpdateInputSchema,
    type SlotContent,
    type SlotCreateInput,
    type SlotEntry,
    type SlotName,
    type SlotMutationOperation,
    type SlotMutationOptions,
    type SlotReorderInput,
    type SlotScopeReference,
    type SlotUpdateInput,
} from "./Slot.js";
import {
    slotEventIdSchema,
    slotEventSchema,
    slotFeatureListenerSchema,
    slotListenerValidationView,
    type SlotEvent,
    type SlotFeatureListener,
} from "./SlotEvent.js";
import {
    slotPageQuerySchema,
    slotPageSchema,
    type SlotList,
    type SlotPage,
    type SlotPageQuery,
} from "./SlotPage.js";
import {
    MAX_SLOT_DETAIL_PAGE_SIZE,
    slotDetailCursorSchema,
    slotDetailPageSchema,
    slotDetailQuerySchema,
    type SlotDetailPage,
    type SlotDetailQuery,
} from "./SlotDetailPage.js";
import {
    assertSlotMutationRequest,
    assertSlotMutationProof,
    assertSlotOperationReceipt,
    assertSlotStoreEntry,
    assertSlotStoreList,
    assertSlotStoreMutationResult,
    assertSlotStorePage,
    slotStoreValidationView,
    slotOperationReceiptSchema,
    slotPublisherSchema,
    slotReadAuthorizationSchema,
    slotScopeResolverSchema,
    slotStoreSchema,
    type SlotStore,
    type SlotMutationRequest,
    type SlotMutationProof,
    type SlotOperationReceipt,
    type SlotRemoveProof,
    type SlotReadAuthorization,
    type SlotReadOperation,
    type SlotStoreCreateInput,
    type SlotStoreCreateResult,
    type SlotStoreMutationResult,
    type SlotStoreRemoveResult,
    type SlotStoreReorderResult,
    type SlotStoreUpdateResult,
} from "./SlotStore.js";
import { createSlotTool } from "./tools/create_slot.js";
import { getSlotTool } from "./tools/get_slot.js";
import { listSlotsTool } from "./tools/list_slots.js";
import { removeSlotTool } from "./tools/remove_slot.js";
import { reorderSlotsTool } from "./tools/reorder_slots.js";
import { updateSlotTool } from "./tools/update_slot.js";

const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_MAX_OUTPUT_CHARACTERS = 12_000;
const REORDER_RESULT_PREFIX = "Slot entries reordered.\n";
const CREATE_ID_KEY = "create_slot_id";
const CREATE_OPERATION_KEY = "create_slot_operation";
const UPDATE_OPERATION_KEY = "update_slot_operation";
const REORDER_OPERATION_KEY = "reorder_slot_operation";
const REMOVE_OPERATION_KEY = "remove_slot_operation";

const DEFAULT_MAX_ENTRIES = MAX_SLOT_ENTRIES;
/**
 * Operation inputs are already bounded by Slot's TypeBox schemas. This bound leaves room for
 * the largest legal reorder (500 maximum-length IDs) and the largest legal applet query while
 * still preventing an untrusted object from consuming unbounded memory before hashing. Six
 * bytes per UTF-16 code unit is conservative for JSON escaping.
 */
const MAX_SLOT_OPERATION_CANONICAL_BYTES = 1_000_000;
const MAX_SLOT_OPERATION_CANONICAL_DEPTH = 8;
const maxEntriesSchema = Type.Integer({ minimum: 1, maximum: MAX_SLOT_ENTRIES });
const maxPageSizeSchema = Type.Integer({ minimum: 1, maximum: MAX_SLOT_PAGE_SIZE });
const maxOutputCharactersSchema = Type.Integer({
    minimum: 256,
    maximum: MAX_SLOT_OUTPUT_CHARACTERS,
});
const opaqueContextSchema = Type.Unsafe<Context>(Type.Object({}, { additionalProperties: true }));
const asyncIdFactorySchema = Type.Unsafe<
    (ctx: Context, agentId: string) => string | Promise<string>
>(
    Type.Function(
        [opaqueContextSchema, slotAgentIdSchema],
        Type.Union([slotOperationIdSchema, Type.Promise(slotOperationIdSchema)]),
    ),
);
const asyncEventIdFactorySchema = Type.Unsafe<
    (ctx: Context, agentId: string) => string | Promise<string>
>(
    Type.Function(
        [opaqueContextSchema, slotAgentIdSchema],
        Type.Union([slotEventIdSchema, Type.Promise(slotEventIdSchema)]),
    ),
);
const clockSchema = Type.Unsafe<() => number>(Type.Function([], slotTimestampSchema));
const postCommitErrorHandlerSchema = Type.Unsafe<
    (ctx: Context, event: SlotEvent, error: unknown) => void | Promise<void>
>(
    Type.Function(
        [opaqueContextSchema, slotEventSchema, Type.Unknown()],
        Type.Union([Type.Void(), Type.Promise(Type.Unknown())]),
    ),
);

export const slotFeatureOptionsSchema = Type.Object(
    {
        store: slotStoreSchema,
        scopeResolver: slotScopeResolverSchema,
        publisher: slotPublisherSchema,
        readAuthorization: Type.Optional(slotReadAuthorizationSchema),
        idFactory: Type.Optional(asyncIdFactorySchema),
        eventIdFactory: Type.Optional(asyncEventIdFactorySchema),
        clock: Type.Optional(clockSchema),
        listener: Type.Optional(slotFeatureListenerSchema),
        maxEntries: Type.Optional(maxEntriesSchema),
        maxPageSize: Type.Optional(maxPageSizeSchema),
        maxOutputCharacters: Type.Optional(maxOutputCharactersSchema),
        onPostCommitError: Type.Optional(postCommitErrorHandlerSchema),
    },
    { additionalProperties: false },
);

export type SlotsFeatureOptions = Static<typeof slotFeatureOptionsSchema>;

type SlotChange<Result> = {
    readonly result: Result;
    readonly event?: SlotEvent;
};

type SlotOperation = {
    readonly kind: SlotMutationOperation;
    readonly operationId: string;
    readonly fingerprint: string;
};

type SlotCreateRequest = SlotStoreCreateInput;

/**
 * Host-backed UI slot catalog for every agent in an AgentSystem.
 *
 * The feature owns validation, durable operation identity, and event
 * construction. The injected store owns persistence and transaction
 * serialization; the scope resolver owns opaque target existence; the
 * publisher owns live application projection.
 */
export class SlotsFeature implements AgentFeature {
    readonly name = "slots";

    readonly #store: SlotStore;
    readonly #scopeResolver: Static<typeof slotScopeResolverSchema>;
    readonly #publisher: Static<typeof slotPublisherSchema>;
    readonly #readAuthorization: SlotReadAuthorization | undefined;
    readonly #idFactory: (ctx: Context, agentId: string) => string | Promise<string>;
    readonly #eventIdFactory: (ctx: Context, agentId: string) => string | Promise<string>;
    readonly #clock: () => number;
    readonly #listener: SlotFeatureListener | undefined;
    readonly #maxEntries: number;
    readonly #maxPageSize: number;
    readonly #maxOutputCharacters: number;
    readonly #onPostCommitError:
        | ((ctx: Context, event: SlotEvent, error: unknown) => void | Promise<void>)
        | undefined;

    constructor(options: SlotsFeatureOptions) {
        assertSlotsFeatureOptions(options);
        this.#store = options.store;
        this.#scopeResolver = options.scopeResolver;
        this.#publisher = options.publisher;
        this.#readAuthorization = options.readAuthorization;
        this.#idFactory = options.idFactory ?? (() => globalThis.crypto.randomUUID());
        this.#eventIdFactory = options.eventIdFactory ?? (() => globalThis.crypto.randomUUID());
        this.#clock = options.clock ?? (() => Date.now());
        this.#listener = options.listener;
        this.#maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
        this.#maxPageSize = options.maxPageSize ?? DEFAULT_PAGE_SIZE;
        this.#maxOutputCharacters = options.maxOutputCharacters ?? DEFAULT_MAX_OUTPUT_CHARACTERS;
        this.#onPostCommitError = options.onPostCommitError;
        this.#assertConfiguredBounds();
    }

    /** Return one bounded page from the host's storage boundary. */
    async listPage(ctx: Context, agentId: string, query: SlotPageQuery = {}): Promise<SlotPage> {
        this.#assertAgentId(agentId);
        this.#assertInput(slotPageQuerySchema, query, "page query");
        const normalized = this.#normalizePageQuery(query);

        /*
         * The host owns cursor semantics. If a long row would hide an ID or
         * the next cursor from the model, ask the host for a smaller page
         * instead of truncating the returned identity.
         */
        for (let limit = normalized.limit; limit >= 1; limit -= 1) {
            const page = await this.#readPage(ctx, agentId, {
                ...normalized,
                limit,
            });
            await this.#authorizeEntries(ctx, agentId, page.entries, "list");
            await this.#validateScopeReferences(ctx, agentId, page.entries);
            if (
                this.#formatPageForModel(page, this.#maxOutputCharacters).length <=
                this.#maxOutputCharacters
            ) {
                return page;
            }
        }
        throw new Error("Slot list output cannot fit a complete entry identity and cursor.");
    }

    /** Return the entries in one bounded page for simple host callers. */
    async list(
        ctx: Context,
        agentId: string,
        query: SlotPageQuery = {},
    ): Promise<readonly SlotEntry[]> {
        return (await this.listPage(ctx, agentId, query)).entries;
    }

    /** Read one complete entry by stable ID. */
    async get(ctx: Context, agentId: string, id: string): Promise<SlotEntry | undefined> {
        this.#assertAgentId(agentId);
        this.#assertId(id);
        const raw = await requirePromise(this.#store.get(ctx, agentId, id), "Slot store get");
        if (raw === undefined) return undefined;
        assertSlotStoreEntry(raw);
        this.#validateEntry(raw);
        if (raw.id !== id) {
            throw new Error("Slot store get returned a different entry identity.");
        }
        await this.#authorizeRead(ctx, agentId, raw.authorAgentId, "get");
        await this.#assertScope(ctx, agentId, raw.slot, raw);
        return structuredClone(raw);
    }

    /** Read one slot entry with a bounded, cursor-addressable detail stream. */
    async getPage(
        ctx: Context,
        agentId: string,
        id: string,
        query: SlotDetailQuery = {},
    ): Promise<SlotDetailPage> {
        this.#assertAgentId(agentId);
        this.#assertId(id);
        if (!Value.Check(slotDetailQuerySchema, query)) {
            throw new Error("Invalid slot detail query.");
        }
        const entry = await this.get(ctx, agentId, id);
        if (entry === undefined) return { entry: null };

        const detail = slotDetailText(entry);
        if (!Value.Check(slotDetailCursorSchema, detail.length)) {
            throw new Error("Slot detail exceeds its bounded traversal length.");
        }
        const detailOffset = query.detailOffset ?? 0;
        const detailLimit = query.detailLimit ?? MAX_SLOT_DETAIL_PAGE_SIZE;
        const page: SlotDetailPage = {
            entry,
            detail: detail.slice(detailOffset, detailOffset + detailLimit),
            detailOffset,
            detailTotal: detail.length,
            ...(detailOffset + detailLimit < detail.length
                ? { nextDetailOffset: detailOffset + detailLimit }
                : {}),
        };
        return this.#fitDetailPage(page);
    }

    /** Create one entry, reusing its operation and entry identities on tool replay. */
    async create(
        ctx: Context,
        agentId: string,
        input: SlotCreateInput,
        options: SlotMutationOptions = {},
    ): Promise<SlotEntry> {
        this.#assertAgentId(agentId);
        this.#assertInput(slotCreateInputSchema, input, "creation");
        this.#assertOptions(options);
        const normalized = normalizeCreateInput(input);
        const id = await this.#createId(
            ctx,
            agentId,
            normalized.id,
            fingerprint({
                kind: "create-entry",
                agentId,
                input: withoutCreateId(normalized),
            }),
        );
        const operation = await this.#operation(
            ctx,
            agentId,
            "create",
            CREATE_OPERATION_KEY,
            options.operationId,
            { id, input: withoutCreateId(normalized) },
        );
        const request = withCreateIdentity(normalized, id, agentId);

        return await this.#runTransaction(ctx, "create", async (txCtx) => {
            const receipt = await this.#readReceipt(txCtx, agentId, operation);
            if (receipt !== undefined) {
                return {
                    result: await this.#replayCreate(txCtx, agentId, operation, receipt, request),
                };
            }

            const before = await this.#readAll(txCtx, agentId);
            const existing = before.find((entry) => entry.id === id);
            if (existing !== undefined) {
                if (!sameCreation(existing, request)) {
                    throw new Error(`Slot entry "${id}" already exists with different values.`);
                }
                const result = this.#createResult(operation, existing, false);
                await this.#writeReceipt(txCtx, agentId, operation, result);
                return { result: existing };
            }
            if (before.length >= this.#maxEntries) {
                throw new Error(
                    `The slot catalog already has the maximum of ${this.#maxEntries} entries.`,
                );
            }

            await this.#assertScope(txCtx, agentId, request.slot, request);
            const raw = await requirePromise(
                this.#store.create(
                    txCtx,
                    agentId,
                    structuredClone(request),
                    this.#metadata(operation),
                ),
                "Slot store create",
            );
            assertSlotStoreMutationResult(raw);
            const mutation = this.#asCreateResult(raw, operation);
            const after = await this.#readAll(txCtx, agentId);
            const reconciled = this.#reconcileCreate(mutation, request, before, after);
            const created = reconciled.entry;
            const result = this.#createResult(operation, created, reconciled.changed);
            await this.#writeReceipt(txCtx, agentId, operation, result);
            const event = await this.#event(
                {
                    type: "slot_entry_created",
                    agentId,
                    entry: created,
                },
                txCtx,
            );
            await this.#observe(txCtx, event);
            return { result: created, event };
        });
    }

    /** Update mutable fields while retaining scope, target, author, and creation identity. */
    async update(
        ctx: Context,
        agentId: string,
        id: string,
        changes: SlotUpdateInput,
        options: SlotMutationOptions = {},
    ): Promise<SlotEntry> {
        this.#assertAgentId(agentId);
        this.#assertId(id);
        this.#assertInput(slotUpdateInputSchema, changes, "update");
        this.#assertOptions(options);
        const normalized = normalizeUpdateInput(changes);
        const operation = await this.#operation(
            ctx,
            agentId,
            "update",
            UPDATE_OPERATION_KEY,
            options.operationId,
            { id, changes: normalized },
        );

        return await this.#runTransaction(ctx, "update", async (txCtx) => {
            const receipt = await this.#readReceipt(txCtx, agentId, operation);
            if (receipt !== undefined) {
                return {
                    result: await this.#replayUpdate(txCtx, agentId, operation, receipt, id),
                };
            }

            const before = await this.#readAll(txCtx, agentId);
            const existing = before.find((entry) => entry.id === id);
            if (existing === undefined) {
                throw new Error(`Slot entry "${id}" does not exist.`);
            }
            this.#assertOwner(agentId, existing);
            const candidate = { ...existing, ...normalized };
            this.#validateEntry(candidate);
            await this.#assertScope(txCtx, agentId, candidate.slot, candidate);

            if (sameMutable(existing, candidate)) {
                const result = this.#updateResult(operation, existing, false);
                await this.#writeReceipt(txCtx, agentId, operation, result);
                return { result: existing };
            }

            const raw = await requirePromise(
                this.#store.update(
                    txCtx,
                    agentId,
                    id,
                    structuredClone(normalized),
                    this.#metadata(operation),
                ),
                "Slot store update",
            );
            assertSlotStoreMutationResult(raw);
            const mutation = this.#asUpdateResult(raw, operation);
            const after = await this.#readAll(txCtx, agentId);
            const updated = this.#reconcileUpdate(mutation, existing, candidate, after);
            await this.#writeReceipt(txCtx, agentId, operation, mutation);
            const event = await this.#event(
                {
                    type: "slot_entry_updated",
                    agentId,
                    entry: updated,
                    changes: normalized,
                },
                txCtx,
            );
            await this.#observe(txCtx, event);
            return { result: updated, event };
        });
    }

    /** Set the exact order of every persisted entry. */
    async reorder(
        ctx: Context,
        agentId: string,
        entryIds: SlotReorderInput,
        options: SlotMutationOptions = {},
    ): Promise<readonly SlotEntry[]> {
        this.#assertAgentId(agentId);
        this.#assertInput(slotReorderInputSchema, entryIds, "reorder");
        this.#assertOptions(options);
        const normalizedIds = [...entryIds];
        const operation = await this.#operation(
            ctx,
            agentId,
            "reorder",
            REORDER_OPERATION_KEY,
            options.operationId,
            { entryIds: normalizedIds },
        );

        return await this.#runTransaction(ctx, "reorder", async (txCtx) => {
            const receipt = await this.#readReceipt(txCtx, agentId, operation);
            if (receipt !== undefined) {
                return {
                    result: await this.#replayReorder(txCtx, agentId, operation, receipt),
                };
            }

            const before = await this.#readAll(txCtx, agentId);
            this.#assertCompleteOrder(before, normalizedIds);
            for (const entry of before) this.#assertOwner(agentId, entry);
            if (
                sameIds(
                    before.map((entry) => entry.id),
                    normalizedIds,
                )
            ) {
                const result = this.#reorderResult(operation, before, false);
                await this.#writeReceipt(txCtx, agentId, operation, result);
                return { result: before };
            }

            const raw = await requirePromise(
                this.#store.reorder(txCtx, agentId, normalizedIds, this.#metadata(operation)),
                "Slot store reorder",
            );
            assertSlotStoreMutationResult(raw);
            const mutation = this.#asReorderResult(raw, operation);
            const after = await this.#readAll(txCtx, agentId);
            const reordered = this.#reconcileReorder(mutation, before, normalizedIds, after);
            await this.#writeReceipt(txCtx, agentId, operation, mutation);
            const event = await this.#event(
                {
                    type: "slot_entries_reordered",
                    agentId,
                    entryIds: normalizedIds,
                    entries: reordered,
                },
                txCtx,
            );
            await this.#observe(txCtx, event);
            return { result: reordered, event };
        });
    }

    /**
     * Reorder the complete catalog, then expose a bounded first page for the common tool. The
     * mutation itself remains authoritative and durable; the page is only the model-facing
     * traversal of its result. A numeric cursor is also valid for the default list query, so every
     * entry omitted from this receipt remains reachable through list_slots.
     */
    async reorderPage(
        ctx: Context,
        agentId: string,
        entryIds: SlotReorderInput,
        options: SlotMutationOptions = {},
    ): Promise<SlotPage> {
        const entries = await this.reorder(ctx, agentId, entryIds, options);
        return this.#fitReorderPage(entries);
    }

    /** Remove one entry. Repeating the operation after commit is a durable no-op. */
    async remove(
        ctx: Context,
        agentId: string,
        id: string,
        options: SlotMutationOptions = {},
    ): Promise<boolean> {
        this.#assertAgentId(agentId);
        this.#assertId(id);
        this.#assertOptions(options);
        const operation = await this.#operation(
            ctx,
            agentId,
            "remove",
            REMOVE_OPERATION_KEY,
            options.operationId,
            { id },
        );

        return await this.#runTransaction(ctx, "remove", async (txCtx) => {
            const receipt = await this.#readReceipt(txCtx, agentId, operation);
            if (receipt !== undefined) {
                return {
                    result: await this.#replayRemove(txCtx, agentId, operation, receipt, id),
                };
            }

            const persistedProof = await this.#readMutationProof(txCtx, agentId, operation);
            if (persistedProof !== undefined) {
                throw new Error("Slot store has an immutable remove proof without its receipt.");
            }

            const before = await this.#readAll(txCtx, agentId);
            const existing = before.find((entry) => entry.id === id);
            if (existing !== undefined) this.#assertOwner(agentId, existing);

            const raw = await requirePromise(
                this.#store.remove(txCtx, agentId, id, this.#metadata(operation)),
                "Slot store remove",
            );
            assertSlotStoreMutationResult(raw);
            const mutation = this.#asRemoveResult(raw, operation, id);
            const after = await this.#readAll(txCtx, agentId);
            this.#reconcileRemove(mutation, existing, after);
            const proof = this.#removeProof(operation, agentId, id, existing, mutation);
            await this.#writeMutationProof(txCtx, agentId, proof);
            const result = this.#removeResult(operation, id, mutation);
            await this.#writeReceipt(txCtx, agentId, operation, result);
            if (!mutation.removed) return { result: false };
            if (existing === undefined) {
                throw new Error("Slot remove result omitted its authoritative before state.");
            }

            const event = await this.#event(
                {
                    type: "slot_entry_removed",
                    agentId,
                    entry: existing,
                    entryId: id,
                },
                txCtx,
            );
            await this.#observe(txCtx, event);
            return { result: true, event };
        });
    }

    /** Common provider-neutral tools available to every model. */
    readonly tools = (_ctx: Context, scope: AgentFeatureScope): readonly AnyAgentTool[] => [
        createSlotTool(this, scope.agent.id),
        listSlotsTool(this, scope.agent.id),
        getSlotTool(this, scope.agent.id),
        updateSlotTool(this, scope.agent.id),
        reorderSlotsTool(this, scope.agent.id),
        removeSlotTool(this, scope.agent.id),
    ];

    /**
     * Render complete bounded entry detail. Every entry identity is placed
     * before optional detail, and the compact fallback never hides IDs.
     */
    formatForModel(entries: readonly SlotEntry[]): string {
        return this.#formatEntriesForModel(entries, this.#maxOutputCharacters);
    }

    /** Render a mutation receipt without allowing its human-readable label to exceed the bound. */
    formatOperationForModel(label: string, entry: SlotEntry): string {
        const prefix = `${label}\n`;
        const body = this.#formatEntriesForModel(
            [entry],
            this.#maxOutputCharacters - prefix.length,
        );
        const output = `${prefix}${body}`;
        if (output.length > this.#maxOutputCharacters) {
            throw new Error("Slot operation output cannot fit the complete entry identity.");
        }
        return output;
    }

    /** Render one bounded slot lookup page without hiding detail or its cursor. */
    formatDetailPageForModel(page: SlotDetailPage): string {
        if (!Value.Check(slotDetailPageSchema, page)) {
            throw new Error("Cannot format an invalid slot detail page.");
        }
        if (page.entry === null) return "That slot entry does not exist.";
        const output = formatSlotDetailPage(page, this.#maxOutputCharacters);
        if (output.length > this.#maxOutputCharacters) {
            throw new Error("Slot detail page exceeds its model-output bound.");
        }
        return output;
    }

    /** Render a list page without hiding any entry ID or its continuation cursor. */
    formatPageForModel(page: SlotPage): string {
        if (!Value.Check(slotPageSchema, page)) {
            throw new Error("Cannot format an invalid slot page.");
        }
        this.#validatePageEntries(page.entries, page);
        const output = this.#formatPageForModel(page, this.#maxOutputCharacters);
        if (output.length > this.#maxOutputCharacters) {
            throw new Error("Slot page output cannot fit every returned identity and cursor.");
        }
        return output;
    }

    /**
     * Render a bounded reorder receipt, including its operation prefix. Keeping the prefix inside
     * this method prevents a tool from spending the entire budget on rows and then overflowing
     * when it adds its human-readable result label.
     */
    formatReorderPageForModel(page: SlotPage): string {
        if (!Value.Check(slotPageSchema, page)) {
            throw new Error("Cannot format an invalid slot reorder page.");
        }
        this.#validatePageEntries(page.entries, page);
        const output = this.#formatReorderPageForModel(page);
        if (output.length > this.#maxOutputCharacters) {
            throw new Error("Slot reorder output cannot fit every returned identity and cursor.");
        }
        return output;
    }

    #formatReorderPageForModel(page: SlotPage): string {
        const available = this.#maxOutputCharacters - REORDER_RESULT_PREFIX.length;
        const body = this.#formatPageForModel(page, available);
        return `${REORDER_RESULT_PREFIX}${body}`;
    }

    #formatPageForModel(page: SlotPage, maxCharacters: number): string {
        const compactRows = this.#formatCompactEntries(page.entries);
        const actionableRows = this.#formatIdentityEntries(page.entries);
        const withCursor = (rows: string): string =>
            page.nextCursor === undefined ? rows : `${rows}\nNext cursor: ${page.nextCursor}`;
        const compact = withCursor(compactRows);
        return compact.length <= maxCharacters ? compact : withCursor(actionableRows);
    }

    #formatCompactEntries(entries: readonly SlotEntry[]): string {
        if (entries.length === 0) return "No slot entries.";
        return entries
            .map((entry) => `${entry.id} [${entry.slot}, ${describeScope(entry)}]`)
            .join("\n");
    }

    #formatEntriesForModel(entries: readonly SlotEntry[], maxCharacters: number): string {
        this.#validateEntriesForOutput(entries);
        const ordered = [...entries].sort(compareEntries);
        const actionable = this.#formatIdentityEntries(ordered);
        if (actionable.length > maxCharacters) {
            throw new Error("Slot model output cannot fit every returned entry identity.");
        }
        if (ordered.length === 0) return "No slot entries.";

        const detailed = ordered
            .map((entry) => {
                const content =
                    entry.content.type === "text"
                        ? `text: ${entry.content.markdown}`
                        : `button "${entry.content.label}" → ${JSON.stringify(entry.content.action)}`;
                return [
                    `${entry.id} [${entry.slot}, ${describeScope(entry)}]`,
                    `  ${content}`,
                    `  Description: ${entry.description}`,
                    `  Purpose: ${entry.purpose}`,
                    `  Author agent: ${entry.authorAgentId}`,
                ].join("\n");
            })
            .join("\n");
        return detailed.length <= maxCharacters ? detailed : actionable;
    }

    #formatIdentityEntries(entries: readonly SlotEntry[]): string {
        if (entries.length === 0) return "No slot entries.";
        return entries.map((entry) => entry.id).join("\n");
    }

    #fitDetailPage(page: SlotDetailPage): SlotDetailPage {
        if (page.entry === null) return page;
        let detail = page.detail;
        for (;;) {
            const candidate: SlotDetailPage = {
                entry: page.entry,
                detail,
                detailOffset: page.detailOffset,
                detailTotal: page.detailTotal,
                ...(page.detailOffset + detail.length < page.detailTotal
                    ? { nextDetailOffset: page.detailOffset + detail.length }
                    : {}),
            };
            if (
                formatSlotDetailPage(candidate, this.#maxOutputCharacters).length <=
                this.#maxOutputCharacters
            ) {
                return candidate;
            }
            if (detail.length > 1) {
                const excess = Math.max(
                    1,
                    formatSlotDetailPage(candidate, this.#maxOutputCharacters).length -
                        this.#maxOutputCharacters,
                );
                detail = detail.slice(0, Math.max(1, detail.length - excess));
                continue;
            }
            throw new Error("Slots maxOutputCharacters is too small to expose slot detail.");
        }
    }

    #fitReorderPage(entries: readonly SlotEntry[]): SlotPage {
        const maximumVisible = Math.min(entries.length, this.#maxPageSize);
        if (maximumVisible === 0) {
            return { entries: [], limit: 1 };
        }

        for (let visibleCount = maximumVisible; visibleCount >= 1; visibleCount -= 1) {
            const page: SlotPage = {
                entries: entries.slice(0, visibleCount),
                limit: visibleCount,
                ...(visibleCount < entries.length ? { nextCursor: visibleCount } : {}),
            };
            if (this.#formatReorderPageForModel(page).length <= this.#maxOutputCharacters) {
                return page;
            }
        }
        throw new Error("Slot reorder output cannot fit a complete entry identity and cursor.");
    }

    async #readPage(
        ctx: Context,
        agentId: string,
        query: SlotPageQuery & { readonly limit: number },
    ): Promise<SlotPage> {
        const raw = await requirePromise(this.#store.list(ctx, agentId, query), "Slot store list");
        const page = this.#normalizeReturnedPage(
            raw as SlotPage | SlotList,
            query.limit,
            query.cursor,
        );
        this.#validatePageEntries(page.entries, page, query);
        return page;
    }

    #normalizeReturnedPage(
        raw: SlotPage | SlotList,
        requestedLimit: number,
        requestedCursor: number | undefined,
    ): SlotPage {
        if (Array.isArray(raw)) {
            assertSlotStoreList(raw);
            if (requestedCursor !== undefined || raw.length > requestedLimit) {
                throw new Error("Slot store returned an unbounded or cursor-incompatible list.");
            }
            return {
                entries: raw.map((entry) => structuredClone(entry)),
                limit: requestedLimit,
            };
        }
        assertSlotStorePage(raw);
        if (raw.entries.length > requestedLimit) {
            throw new Error("Slot store returned more entries than requested.");
        }
        if (
            raw.limit !== requestedLimit ||
            (raw.nextCursor !== undefined &&
                (raw.entries.length === 0 ||
                    !cursorProgressed(requestedCursor, raw.nextCursor, raw.entries.length)))
        ) {
            if (
                raw.nextCursor !== undefined &&
                !cursorProgressed(requestedCursor, raw.nextCursor, raw.entries.length)
            ) {
                throw new Error("Slot store returned a non-progressing cursor.");
            }
            throw new Error("Slot store returned a page outside the requested bounds.");
        }
        return {
            entries: raw.entries.map((entry) => structuredClone(entry)),
            limit: requestedLimit,
            ...(raw.nextCursor === undefined ? {} : { nextCursor: raw.nextCursor }),
        };
    }

    #normalizePageQuery(query: SlotPageQuery): SlotPageQuery & { readonly limit: number } {
        const limit = query.limit ?? Math.min(this.#maxPageSize, this.#maxEntries);
        if (limit > this.#maxPageSize) {
            throw new Error(`Slot page limit cannot exceed ${this.#maxPageSize}.`);
        }
        if (limit > this.#maxEntries) {
            throw new Error(`Slot page limit cannot exceed ${this.#maxEntries}.`);
        }
        const common = {
            ...(query.slot === undefined ? {} : { slot: query.slot }),
            ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
            limit,
        };
        if (!("scope" in query)) return common;
        switch (query.scope) {
            case "everywhere":
                return { ...common, scope: "everywhere" };
            case "project":
                return { ...common, scope: "project", projectId: query.projectId };
            case "workspace":
                return { ...common, scope: "workspace", workspaceId: query.workspaceId };
            case "session":
                return { ...common, scope: "session", sessionId: query.sessionId };
        }
    }

    async #readAll(ctx: Context, agentId: string): Promise<readonly SlotEntry[]> {
        const entries: SlotEntry[] = [];
        const seenCursors = new Set<number>();
        let cursor: number | undefined;
        for (let pageCount = 0; ; pageCount += 1) {
            if (pageCount > MAX_SLOT_ENTRIES) {
                throw new Error("Slot store returned too many pages.");
            }
            const query = {
                ...(cursor === undefined ? {} : { cursor }),
                limit: Math.min(this.#maxPageSize, this.#maxEntries),
            } as const;
            const raw = await requirePromise(
                this.#store.list(ctx, agentId, query),
                "Slot store list",
            );
            const page = this.#normalizeReturnedPage(
                raw as SlotPage | SlotList,
                query.limit,
                cursor,
            );
            this.#validatePageEntries(page.entries, page, query);
            await this.#validateScopeReferences(ctx, agentId, page.entries);
            entries.push(...page.entries);
            if (entries.length > this.#maxEntries) {
                throw new Error("Slot store returned more entries than configured.");
            }
            if (page.nextCursor === undefined) break;
            if (seenCursors.has(page.nextCursor)) {
                throw new Error("Slot store returned a repeating slot cursor.");
            }
            seenCursors.add(page.nextCursor);
            cursor = page.nextCursor;
        }
        this.#validateEntries(entries);
        return [...entries].sort(compareEntries);
    }

    #validatePageEntries(
        entries: readonly SlotEntry[],
        page?: SlotPage,
        query?: SlotPageQuery,
    ): void {
        if (entries.length > this.#maxEntries) {
            throw new Error("Slot page exceeds the configured catalog bound.");
        }
        const ids = new Set<string>();
        let previousOrdering = -1;
        for (const entry of entries) {
            this.#validateEntry(entry);
            if (ids.has(entry.id)) {
                throw new Error("Slot page contains duplicate entry IDs.");
            }
            ids.add(entry.id);
            if (entry.ordering < previousOrdering) {
                throw new Error("Slot page is not in deterministic ordering.");
            }
            previousOrdering = entry.ordering;
            if (query !== undefined && !matchesQuery(entry, query)) {
                throw new Error("Slot store returned an entry outside the requested filter.");
            }
        }
        if (page !== undefined && entries.length > page.limit) {
            throw new Error("Slot page exceeds its declared limit.");
        }
    }

    #validateEntries(entries: readonly SlotEntry[]): void {
        if (entries.length > this.#maxEntries || entries.length > MAX_SLOT_ENTRIES) {
            throw new Error("Slot catalog exceeds its configured bounds.");
        }
        const ids = new Set<string>();
        const orderings = new Set<number>();
        for (const entry of entries) {
            this.#validateEntry(entry);
            if (ids.has(entry.id)) throw new Error("Slot entry IDs must be unique.");
            ids.add(entry.id);
            if (orderings.has(entry.ordering)) {
                throw new Error("Slot entry ordering values must be unique.");
            }
            orderings.add(entry.ordering);
        }
        const sorted = [...orderings].sort((left, right) => left - right);
        if (!sorted.every((ordering, index) => ordering === index)) {
            throw new Error("Slot entry ordering must be contiguous from zero.");
        }
    }

    #validateEntriesForOutput(entries: readonly SlotEntry[]): void {
        if (entries.length > this.#maxEntries) {
            throw new Error("Slot model output received more entries than configured.");
        }
        const ids = new Set<string>();
        for (const entry of entries) {
            this.#validateEntry(entry);
            if (ids.has(entry.id)) throw new Error("Slot model output contains duplicate IDs.");
            ids.add(entry.id);
        }
    }

    #validateEntry(entry: SlotEntry): void {
        if (!Value.Check(slotEntrySchema, entry)) {
            throw new Error("Persisted slot entry has an invalid shape.");
        }
        if (!allowedSlotScopes[entry.slot].includes(entry.scope)) {
            throw new Error("Persisted slot entry uses an incompatible slot and scope.");
        }
        if (entry.updatedAt < entry.createdAt) {
            throw new Error("Persisted slot entry has an invalid timestamp order.");
        }
        if (entry.description !== normalizeRequired(entry.description, slotDescriptionSchema)) {
            throw new Error("Persisted slot entry has unnormalized descriptive text.");
        }
        if (entry.purpose !== normalizeRequired(entry.purpose, slotPurposeSchema)) {
            throw new Error("Persisted slot entry has unnormalized purpose text.");
        }
    }

    async #authorizeEntries(
        ctx: Context,
        requesterAgentId: string,
        entries: readonly SlotEntry[],
        operation: SlotReadOperation,
    ): Promise<void> {
        for (const entry of entries) {
            await this.#authorizeRead(ctx, requesterAgentId, entry.authorAgentId, operation);
        }
    }

    async #authorizeRead(
        ctx: Context,
        requesterAgentId: string,
        ownerAgentId: string,
        operation: SlotReadOperation,
    ): Promise<void> {
        if (requesterAgentId === ownerAgentId) return;
        if (this.#readAuthorization === undefined) {
            throw new Error(
                `Agent "${requesterAgentId}" is not authorized to ${operation} slot entries owned by "${ownerAgentId}".`,
            );
        }
        const raw = this.#readAuthorization(ctx, requesterAgentId, ownerAgentId, operation);
        const allowed = isPromiseLike(raw) ? await raw : raw;
        if (typeof allowed !== "boolean") {
            throw new Error("Slot read authorization returned an invalid result.");
        }
        if (!allowed) {
            throw new Error(
                `Agent "${requesterAgentId}" is not authorized to ${operation} slot entries owned by "${ownerAgentId}".`,
            );
        }
    }

    async #assertScope(
        ctx: Context,
        agentId: string,
        slot: SlotName,
        entry: SlotScopeReference,
    ): Promise<void> {
        if (!allowedSlotScopes[slot].includes(entry.scope)) {
            throw new Error(`The ${slot} slot does not allow the ${entry.scope} scope.`);
        }
        const reference = scopeReferenceFromEntry(entry);
        const raw = this.#scopeResolver(ctx, agentId, reference);
        const resolved = isPromiseLike(raw) ? await raw : raw;
        if (typeof resolved !== "boolean") {
            throw new Error("Slot scope resolver returned an invalid result.");
        }
        if (resolved === false) {
            throw new Error(`The ${entry.scope} scope target does not exist.`);
        }
    }

    async #validateScopeReferences(
        ctx: Context,
        agentId: string,
        entries: readonly SlotEntry[],
    ): Promise<void> {
        for (const entry of entries) {
            await this.#assertScope(ctx, agentId, entry.slot, entry);
        }
    }

    #assertCompleteOrder(entries: readonly SlotEntry[], entryIds: readonly string[]): void {
        if (entryIds.length !== entries.length) {
            throw new Error("Slot reorder must include every current entry exactly once.");
        }
        const known = new Set(entries.map((entry) => entry.id));
        for (const id of entryIds) {
            if (!known.has(id)) throw new Error(`Slot entry "${id}" does not exist.`);
        }
    }

    #assertOwner(agentId: string, entry: SlotEntry): void {
        if (entry.authorAgentId !== agentId) {
            throw new Error(`Agent "${agentId}" is not the owner of slot entry "${entry.id}".`);
        }
    }

    async #operation(
        ctx: Context,
        agentId: string,
        kind: SlotMutationOperation,
        key: string,
        requestedOperationId: string | undefined,
        request: unknown,
    ): Promise<SlotOperation> {
        const requestFingerprint = fingerprint({ kind, agentId, request });
        const operationId = await this.#durableOperationId(
            ctx,
            agentId,
            key,
            requestedOperationId,
            requestFingerprint,
        );
        const operation = {
            kind,
            operationId,
            fingerprint: requestFingerprint,
        };
        if (
            !Value.Check(slotMutationOperationSchema, operation.kind) ||
            !Value.Check(slotOperationIdSchema, operation.operationId) ||
            !Value.Check(slotOperationFingerprintSchema, operation.fingerprint)
        ) {
            throw new Error("Slots feature created an invalid operation.");
        }
        return operation;
    }

    async #durableOperationId(
        ctx: Context,
        agentId: string,
        key: string,
        requested: string | undefined,
        requestFingerprint: string,
    ): Promise<string> {
        if (requested !== undefined) {
            this.#assertOperationId(requested);
            return requested;
        }
        const kv = agentKV(ctx);
        if (kv === undefined) return await this.#newId(ctx, agentId);
        const next = await kv.update(
            ctx,
            durableStateKey(key, requestFingerprint),
            async (current) => {
                if (current !== undefined) {
                    if (!Value.Check(slotOperationStateSchema, current)) {
                        throw new Error("Stored slot operation identity is invalid.");
                    }
                    if (current.fingerprint !== requestFingerprint) {
                        throw new Error(
                            "The slot operation identity was already used for different input.",
                        );
                    }
                    return current;
                }
                return {
                    id: await this.#newId(ctx, agentId),
                    fingerprint: requestFingerprint,
                };
            },
        );
        if (!Value.Check(slotOperationStateSchema, next)) {
            throw new Error("Slots feature stored an invalid operation identity.");
        }
        return next.id;
    }

    async #createId(
        ctx: Context,
        agentId: string,
        requested: string | undefined,
        requestFingerprint: string,
    ): Promise<string> {
        if (requested !== undefined) {
            this.#assertId(requested);
            return requested;
        }
        const kv = agentKV(ctx);
        if (kv === undefined) return await this.#newId(ctx, agentId);
        const next = await kv.update(
            ctx,
            durableStateKey(CREATE_ID_KEY, requestFingerprint),
            async (current) => {
                if (current !== undefined) {
                    if (!Value.Check(slotOperationStateSchema, current)) {
                        throw new Error("Stored slot entry identity is invalid.");
                    }
                    if (current.fingerprint !== requestFingerprint) {
                        throw new Error(
                            "The slot entry identity was already used for different input.",
                        );
                    }
                    return current;
                }
                return {
                    id: await this.#newId(ctx, agentId),
                    fingerprint: requestFingerprint,
                };
            },
        );
        if (!Value.Check(slotOperationStateSchema, next)) {
            throw new Error("Slots feature stored an invalid entry identity.");
        }
        return next.id;
    }

    async #newId(ctx: Context, agentId: string): Promise<string> {
        const raw = this.#idFactory(ctx, agentId);
        const id = isPromiseLike(raw) ? await raw : raw;
        this.#assertOperationId(id);
        return id;
    }

    async #event(
        payload:
            | {
                  readonly type: "slot_entry_created";
                  readonly agentId: string;
                  readonly entry: SlotEntry;
              }
            | {
                  readonly type: "slot_entry_updated";
                  readonly agentId: string;
                  readonly entry: SlotEntry;
                  readonly changes: SlotUpdateInput;
              }
            | {
                  readonly type: "slot_entries_reordered";
                  readonly agentId: string;
                  readonly entryIds: SlotReorderInput;
                  readonly entries: readonly SlotEntry[];
              }
            | {
                  readonly type: "slot_entry_removed";
                  readonly agentId: string;
                  readonly entry: SlotEntry;
                  readonly entryId: string;
              },
        ctx: Context,
    ): Promise<SlotEvent> {
        const rawEventId = this.#eventIdFactory(ctx, payload.agentId);
        const eventId = isPromiseLike(rawEventId) ? await rawEventId : rawEventId;
        if (!Value.Check(slotEventIdSchema, eventId)) {
            throw new Error("Slot event ID factory returned an invalid ID.");
        }
        const at = this.#clock();
        if (!Value.Check(slotTimestampSchema, at)) {
            throw new Error("Slots clock must return a non-negative integer timestamp.");
        }
        const event = { ...payload, eventId, at };
        if (!Value.Check(slotEventSchema, event)) {
            throw new Error("Slots feature created an invalid event.");
        }
        return deepFreeze(structuredClone(event));
    }

    async #observe(ctx: Context, event: SlotEvent): Promise<void> {
        if (!Value.Check(slotEventSchema, event) || !isDeepFrozen(event)) {
            throw new Error("Slots feature created an invalid unfrozen event.");
        }
        const transactional = this.#listener?.onEventTransactional;
        if (transactional !== undefined) {
            await transactional.call(this.#listener, ctx, event);
        }
        const registration = this.#store.afterCommit(ctx, (postCommitCtx) =>
            this.#notifyPostCommit(postCommitCtx, event),
        );
        if (registration !== undefined) {
            throw new Error("Slot store afterCommit must register synchronously.");
        }
    }

    async #notifyPostCommit(ctx: Context, event: SlotEvent): Promise<void> {
        const listener = this.#listener?.onEvent;
        if (listener !== undefined) {
            await this.#notifyObserver(ctx, event, () => listener.call(this.#listener, ctx, event));
        }
        await this.#notifyObserver(ctx, event, () => this.#publisher(ctx, event));
    }

    async #notifyObserver(
        ctx: Context,
        event: SlotEvent,
        observer: () => void | Promise<void>,
    ): Promise<void> {
        try {
            await observer();
        } catch (error: unknown) {
            try {
                if (this.#onPostCommitError !== undefined) {
                    await this.#onPostCommitError(ctx, event, error);
                }
            } catch {
                // Reporting is advisory after durable state has settled.
            }
        }
    }

    async #runTransaction<Result>(
        ctx: Context,
        operation: string,
        work: (txCtx: Context) => Promise<SlotChange<Result>>,
    ): Promise<Result> {
        let expected: SlotChange<Result> | undefined;
        const raw = await requirePromise(
            this.#store.transaction(ctx, async (txCtx) => {
                const change = await work(txCtx);
                expected = deepFreeze(structuredClone(change));
                return change;
            }),
            `Slot ${operation} transaction`,
        );
        if (expected === undefined || !sameJson(raw, expected)) {
            throw new Error(`Slot ${operation} transaction returned a substituted result.`);
        }
        return structuredClone(expected.result);
    }

    async #readReceipt(
        ctx: Context,
        agentId: string,
        operation: SlotOperation,
    ): Promise<SlotOperationReceipt | undefined> {
        const raw = await requirePromise(
            this.#store.readReceipt(ctx, agentId, operation.operationId),
            "Slot store readReceipt",
        );
        if (raw === undefined) return undefined;
        assertSlotOperationReceipt(raw);
        this.#assertReceiptIdentity(raw, agentId, operation);
        return structuredClone(raw);
    }

    async #writeReceipt(
        ctx: Context,
        agentId: string,
        operation: SlotOperation,
        result: SlotStoreMutationResult,
    ): Promise<void> {
        this.#assertResultIdentity(result, operation);
        const receipt: SlotOperationReceipt = {
            agentId,
            operation: operation.kind,
            operationId: operation.operationId,
            fingerprint: operation.fingerprint,
            result: structuredClone(result),
        };
        if (!Value.Check(slotOperationReceiptSchema, receipt)) {
            throw new Error("Slots feature created an invalid operation receipt.");
        }
        const expectedReceipt = structuredClone(receipt);
        const returned = await requirePromise(
            this.#store.writeReceipt(ctx, agentId, structuredClone(expectedReceipt)),
            "Slot store writeReceipt",
        );
        if (returned !== undefined) {
            throw new Error("Slot store writeReceipt must resolve to undefined.");
        }
        const persistedRaw = await requirePromise(
            this.#store.readReceipt(ctx, agentId, operation.operationId),
            "Slot store readReceipt after writeReceipt",
        );
        if (persistedRaw === undefined) {
            throw new Error("Slot store writeReceipt did not persist a readable receipt.");
        }
        assertSlotOperationReceipt(persistedRaw);
        this.#assertReceiptIdentity(persistedRaw, agentId, operation);
        if (!sameJson(persistedRaw, expectedReceipt)) {
            throw new Error("Slot store writeReceipt persisted different receipt content.");
        }
    }

    async #readMutationProof(
        ctx: Context,
        agentId: string,
        operation: SlotOperation,
    ): Promise<SlotMutationProof | undefined> {
        const raw = await requirePromise(
            this.#store.readMutationProof(ctx, agentId, operation.operationId),
            "Slot store readMutationProof",
        );
        if (raw === undefined) return undefined;
        assertSlotMutationProof(raw);
        this.#assertMutationProofIdentity(raw, agentId, operation);
        return structuredClone(raw);
    }

    async #writeMutationProof(
        ctx: Context,
        agentId: string,
        proof: SlotMutationProof,
    ): Promise<void> {
        assertSlotMutationProof(proof);
        const operation: SlotOperation = {
            kind: proof.operation,
            operationId: proof.operationId,
            fingerprint: proof.fingerprint,
        };
        this.#assertMutationProofIdentity(proof, agentId, operation);
        const expectedProof = structuredClone(proof);
        const returned = await requirePromise(
            this.#store.writeMutationProof(ctx, agentId, structuredClone(expectedProof)),
            "Slot store writeMutationProof",
        );
        if (returned !== undefined) {
            throw new Error("Slot store writeMutationProof must resolve to undefined.");
        }
        const persistedRaw = await requirePromise(
            this.#store.readMutationProof(ctx, agentId, proof.operationId),
            "Slot store readMutationProof after writeMutationProof",
        );
        if (persistedRaw === undefined) {
            throw new Error("Slot store did not persist the immutable mutation proof.");
        }
        assertSlotMutationProof(persistedRaw);
        this.#assertMutationProofIdentity(persistedRaw, agentId, operation);
        if (!sameJson(persistedRaw, expectedProof)) {
            throw new Error("Slot store persisted a different immutable mutation proof.");
        }
    }

    #metadata(operation: SlotOperation): SlotMutationRequest {
        const metadata = {
            operationId: operation.operationId,
            fingerprint: operation.fingerprint,
        };
        assertSlotMutationRequest(metadata);
        return metadata;
    }

    #createResult(
        operation: SlotOperation,
        entry: SlotEntry,
        changed: boolean,
    ): SlotStoreCreateResult {
        return {
            operation: "create",
            operationId: operation.operationId,
            fingerprint: operation.fingerprint,
            changed,
            entry: structuredClone(entry),
        };
    }

    #updateResult(
        operation: SlotOperation,
        entry: SlotEntry,
        changed: boolean,
    ): SlotStoreUpdateResult {
        return {
            operation: "update",
            operationId: operation.operationId,
            fingerprint: operation.fingerprint,
            changed,
            entry: structuredClone(entry),
        };
    }

    #reorderResult(
        operation: SlotOperation,
        entries: readonly SlotEntry[],
        changed: boolean,
    ): SlotStoreReorderResult {
        return {
            operation: "reorder",
            operationId: operation.operationId,
            fingerprint: operation.fingerprint,
            changed,
            entryIds: entries.map((entry) => entry.id),
            entries: structuredClone([...entries]),
        };
    }

    #removeResult(
        operation: SlotOperation,
        entryId: string,
        mutation: SlotStoreRemoveResult,
    ): SlotStoreRemoveResult {
        if (mutation.entryId !== entryId) {
            throw new Error("Slot remove mutation has a different entry identity.");
        }
        return structuredClone(mutation);
    }

    #asCreateResult(
        raw: SlotStoreMutationResult,
        operation: SlotOperation,
    ): Extract<SlotStoreMutationResult, { operation: "create" }> {
        this.#assertResultIdentity(raw, operation);
        if (raw.operation !== "create") {
            throw new Error("Slot store create returned the wrong operation.");
        }
        return raw;
    }

    #asUpdateResult(raw: SlotStoreMutationResult, operation: SlotOperation): SlotStoreUpdateResult {
        this.#assertResultIdentity(raw, operation);
        if (raw.operation !== "update") {
            throw new Error("Slot store update returned the wrong operation.");
        }
        return raw;
    }

    #asReorderResult(
        raw: SlotStoreMutationResult,
        operation: SlotOperation,
    ): SlotStoreReorderResult {
        this.#assertResultIdentity(raw, operation);
        if (raw.operation !== "reorder") {
            throw new Error("Slot store reorder returned the wrong operation.");
        }
        return raw;
    }

    #asRemoveResult(
        raw: SlotStoreMutationResult,
        operation: SlotOperation,
        entryId: string,
    ): SlotStoreRemoveResult {
        this.#assertResultIdentity(raw, operation);
        if (raw.operation !== "remove" || raw.entryId !== entryId) {
            throw new Error("Slot store remove returned a different entry identity.");
        }
        return raw;
    }

    #assertResultIdentity(result: SlotStoreMutationResult, operation: SlotOperation): void {
        if (
            result.operation !== operation.kind ||
            result.operationId !== operation.operationId ||
            result.fingerprint !== operation.fingerprint
        ) {
            throw new Error("Slot store returned a different requested operation.");
        }
    }

    #assertReceiptIdentity(
        receipt: SlotOperationReceipt,
        agentId: string,
        operation: SlotOperation,
    ): void {
        if (
            receipt.agentId !== agentId ||
            receipt.operation !== operation.kind ||
            receipt.operationId !== operation.operationId ||
            receipt.fingerprint !== operation.fingerprint
        ) {
            throw new Error("Slot operation identity was reused with different input.");
        }
        assertSlotStoreMutationResult(receipt.result);
        this.#assertResultIdentity(receipt.result, operation);
    }

    #assertMutationProofIdentity(
        proof: SlotMutationProof,
        agentId: string,
        operation: SlotOperation,
    ): void {
        if (
            proof.agentId !== agentId ||
            proof.operation !== operation.kind ||
            proof.operationId !== operation.operationId ||
            proof.fingerprint !== operation.fingerprint
        ) {
            throw new Error("Slot immutable mutation proof has a different operation identity.");
        }
    }

    #reconcileCreate(
        mutation: Extract<SlotStoreMutationResult, { operation: "create" }>,
        request: SlotCreateRequest,
        before: readonly SlotEntry[],
        after: readonly SlotEntry[],
    ): { readonly changed: boolean; readonly entry: SlotEntry } {
        const actual = after.find((entry) => entry.id === request.id);
        if (actual === undefined || !sameJson(actual, mutation.entry)) {
            throw new Error("Slot store did not authoritatively persist the created entry.");
        }
        const beforeEntry = before.find((entry) => entry.id === request.id);
        const changed = beforeEntry === undefined;
        if (
            mutation.changed !== changed ||
            !sameCreation(actual, request) ||
            (beforeEntry !== undefined && !sameJson(beforeEntry, actual))
        ) {
            throw new Error("Slot store create result does not match authoritative before/after.");
        }
        return { changed, entry: actual };
    }

    #reconcileUpdate(
        mutation: SlotStoreUpdateResult,
        before: SlotEntry,
        candidate: SlotEntry,
        after: readonly SlotEntry[],
    ): SlotEntry {
        if (!mutation.changed) {
            throw new Error("Slot store update unexpectedly reported no change.");
        }
        const actual = after.find((entry) => entry.id === before.id);
        if (actual === undefined || !sameJson(actual, mutation.entry)) {
            throw new Error("Slot store did not authoritatively persist the update.");
        }
        this.#assertStableIdentity(before, actual);
        if (!sameMutable(actual, candidate) || actual.updatedAt < before.updatedAt) {
            throw new Error("Slot store update did not apply the exact requested content.");
        }
        return actual;
    }

    #reconcileReorder(
        mutation: SlotStoreReorderResult,
        before: readonly SlotEntry[],
        requestedIds: readonly string[],
        after: readonly SlotEntry[],
    ): readonly SlotEntry[] {
        if (!mutation.changed || !sameIds(mutation.entryIds, requestedIds)) {
            throw new Error("Slot store reorder result does not match the request.");
        }
        if (
            mutation.entries.length !== after.length ||
            !sameIds(
                after.map((entry) => entry.id),
                requestedIds,
            ) ||
            !sameJson(mutation.entries, after)
        ) {
            throw new Error("Slot store did not authoritatively persist the requested order.");
        }
        const beforeById = new Map(before.map((entry) => [entry.id, entry]));
        for (const [ordering, id] of requestedIds.entries()) {
            const previous = beforeById.get(id);
            const actual = after[ordering];
            if (
                previous === undefined ||
                actual === undefined ||
                actual.id !== id ||
                actual.ordering !== ordering ||
                !sameReorderStableFields(previous, actual) ||
                actual.updatedAt < previous.updatedAt
            ) {
                throw new Error("Slot store changed a non-ordering slot field during reorder.");
            }
        }
        return after;
    }

    #reconcileRemove(
        mutation: SlotStoreRemoveResult,
        before: SlotEntry | undefined,
        after: readonly SlotEntry[],
    ): void {
        const actual = after.find((entry) => entry.id === mutation.entryId);
        const expectedRemoved = before !== undefined;
        if (mutation.removed !== expectedRemoved) {
            throw new Error("Slot store remove result is not authoritative.");
        }
        if (mutation.removed) {
            if (
                before === undefined ||
                actual !== undefined ||
                mutation.entry === undefined ||
                !sameJson(mutation.entry, before)
            ) {
                throw new Error("Slot store remove result is not authoritative.");
            }
            return;
        }
        if (("entry" in mutation && mutation.entry !== undefined) || actual !== undefined) {
            throw new Error("Slot store remove result is not authoritative.");
        }
    }

    #removeProof(
        operation: SlotOperation,
        agentId: string,
        entryId: string,
        before: SlotEntry | undefined,
        mutation: SlotStoreRemoveResult,
    ): SlotRemoveProof {
        const proof: SlotRemoveProof = {
            agentId,
            operation: "remove",
            operationId: operation.operationId,
            fingerprint: operation.fingerprint,
            entryId,
            before: before === undefined ? null : structuredClone(before),
            removed: mutation.removed,
        };
        assertSlotMutationProof(proof);
        return proof;
    }

    async #replayCreate(
        ctx: Context,
        agentId: string,
        operation: SlotOperation,
        receipt: SlotOperationReceipt,
        request: SlotCreateRequest,
    ): Promise<SlotEntry> {
        this.#assertReceiptIdentity(receipt, agentId, operation);
        if (receipt.result.operation !== "create" || receipt.result.entry.id !== request.id) {
            throw new Error("Slot create receipt has a different entry identity.");
        }
        const current = (await this.#readAll(ctx, agentId)).find(
            (entry) => entry.id === request.id,
        );
        if (current === undefined) {
            throw new Error("Slot create receipt has no authoritative catalog entry.");
        }
        this.#assertCreateStableIdentity(request, current);
        return current;
    }

    async #replayUpdate(
        ctx: Context,
        agentId: string,
        operation: SlotOperation,
        receipt: SlotOperationReceipt,
        id: string,
    ): Promise<SlotEntry> {
        this.#assertReceiptIdentity(receipt, agentId, operation);
        if (receipt.result.operation !== "update" || receipt.result.entry.id !== id) {
            throw new Error("Slot update receipt has a different entry identity.");
        }
        const current = (await this.#readAll(ctx, agentId)).find((entry) => entry.id === id);
        if (current === undefined) {
            throw new Error("Slot update receipt has no authoritative catalog entry.");
        }
        this.#assertOwnerFromReceipt(receipt.result.entry, current);
        return current;
    }

    async #replayReorder(
        ctx: Context,
        agentId: string,
        operation: SlotOperation,
        receipt: SlotOperationReceipt,
    ): Promise<readonly SlotEntry[]> {
        this.#assertReceiptIdentity(receipt, agentId, operation);
        if (receipt.result.operation !== "reorder") {
            throw new Error("Slot reorder receipt has the wrong operation.");
        }
        const result = receipt.result;
        if (
            result.entries.length !== result.entryIds.length ||
            result.entries.some((entry, index) => entry.id !== result.entryIds[index])
        ) {
            throw new Error("Slot reorder receipt has incomplete entry identities.");
        }
        const current = await this.#readAll(ctx, agentId);
        if (
            !sameIdSet(
                current.map((entry) => entry.id),
                result.entryIds,
            )
        ) {
            throw new Error("Slot reorder receipt cannot be reconciled with the catalog.");
        }
        const byId = new Map(current.map((entry) => [entry.id, entry]));
        for (const receiptEntry of result.entries) {
            const currentEntry = byId.get(receiptEntry.id);
            if (currentEntry === undefined) {
                throw new Error("Slot reorder receipt references a missing catalog entry.");
            }
            this.#assertOwnerFromReceipt(receiptEntry, currentEntry);
        }
        return current;
    }

    async #replayRemove(
        ctx: Context,
        agentId: string,
        operation: SlotOperation,
        receipt: SlotOperationReceipt,
        id: string,
    ): Promise<boolean> {
        this.#assertReceiptIdentity(receipt, agentId, operation);
        if (receipt.result.operation !== "remove" || receipt.result.entryId !== id) {
            throw new Error("Slot remove receipt has a different entry identity.");
        }
        if (receipt.result.removed) {
            this.#validateEntry(receipt.result.entry);
            this.#assertOwner(agentId, receipt.result.entry);
        }
        const proof = await this.#readMutationProof(ctx, agentId, operation);
        if (proof === undefined) {
            throw new Error("Slot remove replay has no immutable mutation proof.");
        }
        if (proof.operation !== "remove") {
            throw new Error("Slot remove replay has the wrong immutable proof.");
        }
        const receiptEntry = receipt.result.removed ? receipt.result.entry : undefined;
        if (
            receipt.result.removed !== proof.removed ||
            (proof.before === null
                ? receiptEntry !== undefined
                : receiptEntry === undefined || !sameJson(receiptEntry, proof.before))
        ) {
            throw new Error("Slot remove receipt does not match its immutable mutation proof.");
        }
        this.#assertRemoveProof(agentId, operation, proof, id);
        return proof.removed;
    }

    #assertRemoveProof(
        agentId: string,
        operation: SlotOperation,
        proof: SlotMutationProof,
        entryId: string,
    ): void {
        this.#assertMutationProofIdentity(proof, agentId, operation);
        if (
            proof.operation !== "remove" ||
            proof.entryId !== entryId ||
            proof.removed !== (proof.before !== null) ||
            (proof.before !== null && proof.before.id !== entryId)
        ) {
            throw new Error("Slot remove immutable mutation proof is not authoritative.");
        }
        if (proof.before !== null) {
            this.#validateEntry(proof.before);
            this.#assertOwner(agentId, proof.before);
        }
    }

    #assertOwnerFromReceipt(receiptEntry: SlotEntry, current: SlotEntry): void {
        if (
            receiptEntry.id !== current.id ||
            receiptEntry.authorAgentId !== current.authorAgentId ||
            receiptEntry.createdAt !== current.createdAt ||
            !sameJson(scopeReferenceFromEntry(receiptEntry), scopeReferenceFromEntry(current))
        ) {
            throw new Error("Slot operation receipt does not match authoritative ownership.");
        }
    }

    #assertStableIdentity(before: SlotEntry, after: SlotEntry): void {
        if (
            before.id !== after.id ||
            before.authorAgentId !== after.authorAgentId ||
            before.createdAt !== after.createdAt ||
            before.ordering !== after.ordering ||
            !sameJson(scopeReferenceFromEntry(before), scopeReferenceFromEntry(after))
        ) {
            throw new Error("Slot store changed immutable entry identity.");
        }
    }

    #assertCreateStableIdentity(request: SlotCreateRequest, after: SlotEntry): void {
        if (
            request.id !== after.id ||
            request.authorAgentId !== after.authorAgentId ||
            !sameJson(scopeReferenceFromEntry(request), scopeReferenceFromEntry(after))
        ) {
            throw new Error("Slot create receipt does not match authoritative identity.");
        }
    }

    #assertOptions(options: SlotMutationOptions): void {
        this.#assertInput(slotMutationOptionsSchema, options, "mutation options");
    }

    #assertConfiguredBounds(): void {
        if (!Value.Check(maxEntriesSchema, this.#maxEntries)) {
            throw new Error(`Slots maxEntries must be from 1 to ${MAX_SLOT_ENTRIES}.`);
        }
        if (!Value.Check(maxPageSizeSchema, this.#maxPageSize)) {
            throw new Error(`Slots maxPageSize must be from 1 to ${MAX_SLOT_PAGE_SIZE}.`);
        }
        if (!Value.Check(maxOutputCharactersSchema, this.#maxOutputCharacters)) {
            throw new Error(
                `Slots maxOutputCharacters must be between 256 and ${MAX_SLOT_OUTPUT_CHARACTERS}.`,
            );
        }
    }

    #assertInput(schema: TSchema, value: unknown, label: string): void {
        if (!Value.Check(schema, value)) throw new Error(`Slot ${label} input is invalid.`);
    }

    #assertAgentId(agentId: string): void {
        if (!Value.Check(slotAgentIdSchema, agentId)) {
            throw new Error("Slot acting agent ID is invalid.");
        }
    }

    #assertId(id: string): void {
        if (!Value.Check(slotIdSchema, id)) throw new Error("Slot entry ID is invalid.");
    }

    #assertOperationId(id: string): void {
        if (!Value.Check(slotOperationIdSchema, id)) {
            throw new Error("Slot operation ID is invalid.");
        }
    }
}

function slotDetailText(entry: SlotEntry): string {
    return [
        `Content: ${JSON.stringify(entry.content)}`,
        `Description: ${entry.description}`,
        `Purpose: ${entry.purpose}`,
    ].join("\n");
}

function formatSlotDetailPage(
    page: Extract<SlotDetailPage, { readonly entry: SlotEntry }>,
    maxOutputCharacters: number,
): string {
    const header = `${page.entry.id} [${page.entry.slot}, ${describeScope(page.entry)}]`;
    const full = [
        header,
        `Detail [${page.detailOffset}/${page.detailTotal}]: ${page.detail}`,
        ...(page.nextDetailOffset === undefined
            ? []
            : [`More detail starts at offset ${page.nextDetailOffset}.`]),
    ].join("\n");
    if (full.length <= maxOutputCharacters) return full;

    const compactWithHeader = [
        page.entry.id,
        `Detail: ${page.detail}`,
        ...(page.nextDetailOffset === undefined ? [] : [`More detail: ${page.nextDetailOffset}.`]),
    ].join("\n");
    if (compactWithHeader.length <= maxOutputCharacters) return compactWithHeader;

    return [
        `Detail: ${page.detail}`,
        ...(page.nextDetailOffset === undefined ? [] : [`More detail: ${page.nextDetailOffset}.`]),
    ].join("\n");
}

function normalizeCreateInput(input: SlotCreateInput): SlotCreateInput {
    const common = {
        ...(input.id === undefined ? {} : { id: input.id.trim() }),
        slot: input.slot,
        content: normalizeContent(input.content),
        description: normalizeRequired(input.description, slotDescriptionSchema),
        purpose: normalizeRequired(input.purpose, slotPurposeSchema),
    };
    const normalized: SlotCreateInput =
        input.scope === "everywhere"
            ? { ...common, scope: "everywhere" }
            : input.scope === "project"
              ? { ...common, scope: "project", projectId: input.projectId.trim() }
              : input.scope === "workspace"
                ? { ...common, scope: "workspace", workspaceId: input.workspaceId.trim() }
                : { ...common, scope: "session", sessionId: input.sessionId.trim() };
    if (!Value.Check(slotCreateInputSchema, normalized)) {
        throw new Error("Slot creation input is invalid after normalization.");
    }
    return normalized;
}

function withCreateIdentity(
    input: SlotCreateInput,
    id: string,
    authorAgentId: string,
): SlotCreateRequest {
    const common = {
        id,
        authorAgentId,
        slot: input.slot,
        content: input.content,
        description: input.description,
        purpose: input.purpose,
    };
    return input.scope === "everywhere"
        ? { ...common, scope: "everywhere" }
        : input.scope === "project"
          ? { ...common, scope: "project", projectId: input.projectId }
          : input.scope === "workspace"
            ? { ...common, scope: "workspace", workspaceId: input.workspaceId }
            : { ...common, scope: "session", sessionId: input.sessionId };
}

function withoutCreateId(input: SlotCreateInput): SlotCreateInput {
    const withoutId = structuredClone(input);
    delete withoutId.id;
    return withoutId;
}

function normalizeUpdateInput(input: SlotUpdateInput): SlotUpdateInput {
    const normalized = {
        ...(input.slot === undefined ? {} : { slot: input.slot }),
        ...(input.content === undefined ? {} : { content: normalizeContent(input.content) }),
        ...(input.description === undefined
            ? {}
            : { description: normalizeRequired(input.description, slotDescriptionSchema) }),
        ...(input.purpose === undefined
            ? {}
            : { purpose: normalizeRequired(input.purpose, slotPurposeSchema) }),
    };
    if (!Value.Check(slotUpdateInputSchema, normalized)) {
        throw new Error("Slot update input is invalid after normalization.");
    }
    return normalized;
}

function normalizeContent(content: SlotContent): SlotContent {
    const clone = structuredClone(content);
    if (!Value.Check(slotContentSchema, clone)) {
        throw new Error("Slot content is invalid.");
    }
    return clone;
}

function normalizeRequired(value: string, schema: TSchema): string {
    const normalized = value.trim();
    if (!Value.Check(schema, normalized)) {
        throw new Error("Slot descriptive text is invalid.");
    }
    return normalized;
}

function sameCreation(entry: SlotEntry, request: SlotCreateRequest): boolean {
    return (
        entry.id === request.id &&
        entry.slot === request.slot &&
        entry.authorAgentId === request.authorAgentId &&
        sameJson(entry.content, request.content) &&
        entry.description === request.description &&
        entry.purpose === request.purpose &&
        sameJson(scopeReferenceFromEntry(entry), scopeReferenceFromEntry(request))
    );
}

/** Reorder may change only ordering and move updatedAt forward; all other entry fields are fixed. */
function sameReorderStableFields(left: SlotEntry, right: SlotEntry): boolean {
    return (
        left.id === right.id &&
        left.slot === right.slot &&
        left.authorAgentId === right.authorAgentId &&
        left.description === right.description &&
        left.purpose === right.purpose &&
        left.createdAt === right.createdAt &&
        sameJson(left.content, right.content) &&
        sameJson(scopeReferenceFromEntry(left), scopeReferenceFromEntry(right))
    );
}

function sameMutable(left: SlotEntry, right: SlotEntry): boolean {
    return (
        left.slot === right.slot &&
        sameJson(left.content, right.content) &&
        left.description === right.description &&
        left.purpose === right.purpose
    );
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((id, index) => id === right[index]);
}

function sameIdSet(left: readonly string[], right: readonly string[]): boolean {
    return (
        left.length === right.length &&
        new Set(left).size === left.length &&
        left.every((id) => right.includes(id))
    );
}

function matchesQuery(entry: SlotEntry, query: SlotPageQuery): boolean {
    if (query.slot !== undefined && entry.slot !== query.slot) return false;
    if (!("scope" in query)) return true;
    switch (query.scope) {
        case "everywhere":
            return entry.scope === "everywhere";
        case "project":
            return entry.scope === "project" && entry.projectId === query.projectId;
        case "workspace":
            return entry.scope === "workspace" && entry.workspaceId === query.workspaceId;
        case "session":
            return entry.scope === "session" && entry.sessionId === query.sessionId;
    }
}

function compareEntries(left: SlotEntry, right: SlotEntry): number {
    return left.ordering - right.ordering || left.id.localeCompare(right.id);
}

function describeScope(entry: SlotEntry): string {
    switch (entry.scope) {
        case "everywhere":
            return "everywhere";
        case "project":
            return `project ${entry.projectId}`;
        case "workspace":
            return `workspace ${entry.workspaceId}`;
        case "session":
            return `session ${entry.sessionId}`;
    }
}

function cursorProgressed(
    requested: number | undefined,
    next: number,
    visibleCount: number,
): boolean {
    return visibleCount > 0 && next === (requested ?? 0) + visibleCount;
}

function fingerprint(value: unknown): string {
    let encoded: string | undefined;
    try {
        encoded = JSON.stringify(canonicalizeOperationInput(value));
    } catch {
        throw new Error("Slot operation input is not canonicalizable.");
    }
    if (
        encoded === undefined ||
        encoded.length === 0 ||
        Buffer.byteLength(encoded, "utf8") > MAX_SLOT_OPERATION_CANONICAL_BYTES
    ) {
        throw new Error("Slot operation input exceeds the durable receipt bound.");
    }
    const digest = createHash("sha256").update(encoded, "utf8").digest("hex");
    if (!Value.Check(slotOperationFingerprintSchema, digest)) {
        throw new Error("Slot operation fingerprint is invalid.");
    }
    return digest;
}

function canonicalizeOperationInput(value: unknown, seen = new Set<object>(), depth = 0): unknown {
    if (depth > MAX_SLOT_OPERATION_CANONICAL_DEPTH) {
        throw new Error("operation input is too deeply nested");
    }
    if (Array.isArray(value)) {
        if (seen.has(value)) throw new Error("cyclic input");
        seen.add(value);
        const result = value.map((nested) => canonicalizeOperationInput(nested, seen, depth + 1));
        seen.delete(value);
        return result;
    }
    if (typeof value !== "object" || value === null) return value;
    if (seen.has(value)) throw new Error("cyclic input");
    seen.add(value);
    const result = Object.fromEntries(
        Object.entries(value)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, nested]) => [key, canonicalizeOperationInput(nested, seen, depth + 1)]),
    );
    seen.delete(value);
    return result;
}

function canonicalize(value: unknown, seen = new Set<object>()): unknown {
    if (Array.isArray(value)) {
        if (seen.has(value)) throw new Error("cyclic input");
        seen.add(value);
        const result = value.map((nested) => canonicalize(nested, seen));
        seen.delete(value);
        return result;
    }
    if (typeof value !== "object" || value === null) return value;
    if (seen.has(value)) throw new Error("cyclic input");
    seen.add(value);
    const result = Object.fromEntries(
        Object.entries(value)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, nested]) => [key, canonicalize(nested, seen)]),
    );
    seen.delete(value);
    return result;
}

function sameJson(left: unknown, right: unknown): boolean {
    try {
        return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
    } catch {
        return false;
    }
}

function durableStateKey(prefix: string, fingerprintValue: string): string {
    return `${prefix}:${fingerprintValue}`;
}

function deepFreeze<T>(value: T): T {
    if (value !== null && typeof value === "object") {
        for (const nested of Object.values(value as Record<string, unknown>)) {
            deepFreeze(nested);
        }
        Object.freeze(value);
    }
    return value;
}

function isDeepFrozen(value: unknown, seen = new Set<object>()): boolean {
    if (value === null || typeof value !== "object") return true;
    if (seen.has(value)) return true;
    if (!Object.isFrozen(value)) return false;
    seen.add(value);
    return Object.values(value as Record<string, unknown>).every((nested) =>
        isDeepFrozen(nested, seen),
    );
}

function isPromiseLike<T>(value: unknown): value is PromiseLike<T> {
    return (
        ((typeof value === "object" && value !== null) || typeof value === "function") &&
        typeof (value as { then?: unknown }).then === "function"
    );
}

async function requirePromise<T>(value: unknown, label: string): Promise<T> {
    if (!isPromiseLike<T>(value)) {
        throw new Error(`${label} must return a Promise.`);
    }
    return await value;
}

export function assertSlotsFeatureOptions(value: unknown): asserts value is SlotsFeatureOptions {
    const candidate = featureOptionsValidationView(value);
    if (!Value.Check(slotFeatureOptionsSchema, candidate)) {
        throw new Error(
            "Slots feature options are invalid; check the closed store, resolver, publisher, listener, and callbacks.",
        );
    }
}

function featureOptionsValidationView(value: unknown): unknown {
    if (value === null || typeof value !== "object") return value;
    const object = value as Record<string, unknown>;
    return {
        ...object,
        store: slotStoreValidationView(object.store),
        ...(object.listener === undefined
            ? {}
            : { listener: slotListenerValidationView(object.listener) }),
    };
}
