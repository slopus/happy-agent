import {
    agentDatabaseRows,
    agentDatabaseRun,
    cuid2Schema,
    type AgentDatabase,
    type AgentDatabaseFacade,
    type AgentModule,
    type AgentModuleHooks,
    type AgentModuleScope,
    type AgentSystemRef,
    type AnyAgentTool,
} from "@slopus/happy-agent-base";
import { Value } from "@sinclair/typebox/value";
import { afterCommit, type Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";

import type { BotsModule } from "../bots/index.js";
import type { ConfigModule } from "../config/index.js";
import { createUuidV7Factory } from "../events/index.js";
import type { ProjectsModule } from "../projects/index.js";
import type { WorkspacesModule } from "../workspaces/index.js";
import {
    assertSliceLines,
    assertSlicePath,
    MAX_SLICES_PER_WORKSPACE,
    SliceError,
    sliceCreateInputSchema,
    sliceListSchema,
    sliceSchema,
    type Slice,
    type SliceCreateInput,
    type SliceEvent,
    type SliceEventListener,
} from "./Slice.js";
import { createSliceTool } from "./tools/create_slice.js";

const SLICE_STATE_TABLE = "happy_agent_slice_state";

/**
 * Slices: named attention masks over a workspace's files, built by agents.
 *
 * The module stores every slice under the workspace it belongs to, newest first and bounded, and
 * gives every model the common `create_slice` tool. It validates shape and bounds only; which
 * files matter is the model's judgement. A slice names paths, never content, so the app reads the
 * files live through the workspace file and git routes.
 */
export class SlicesModule implements AgentModule {
    readonly name = "slices";
    readonly migrations = [
        [
            "001-slice-state",
            async (_ctx: Context, database: AgentDatabaseFacade<AgentDatabase>): Promise<void> => {
                await agentDatabaseRun(
                    database,
                    sql`CREATE TABLE IF NOT EXISTS happy_agent_slice_state (
                        workspace_id TEXT PRIMARY KEY,
                        slices_json TEXT NOT NULL
                    )`,
                );
            },
        ],
    ] as const;

    readonly #bots: BotsModule;
    readonly #config: ConfigModule;
    readonly #projects: ProjectsModule;
    readonly #workspaces: WorkspacesModule;
    readonly #listeners = new Set<SliceEventListener>();
    readonly #nextVersion = createUuidV7Factory();
    #agents: AgentSystemRef | undefined;

    constructor(
        config: ConfigModule,
        bots: BotsModule,
        projects: ProjectsModule,
        workspaces: WorkspacesModule,
    ) {
        this.#config = config;
        this.#bots = bots;
        this.#projects = projects;
        this.#workspaces = workspaces;
    }

    readonly #hooks: AgentModuleHooks = {
        tools: (_ctx: Context, scope: AgentModuleScope): readonly AnyAgentTool[] => [
            createSliceTool(this, scope.agent.id),
        ],
    };

    readonly beforeStart = (_ctx: Context, agents: AgentSystemRef): AgentModuleHooks => {
        this.#agents = agents;
        return this.#hooks;
    };

    /** Watch slices once they are durable. Returns the function that stops the subscription. */
    onEvent(listener: SliceEventListener): () => void {
        if (typeof listener !== "function") throw new Error("A slice listener must be a function.");
        this.#listeners.add(listener);
        return () => {
            this.#listeners.delete(listener);
        };
    }

    /** Every retained slice of a workspace, newest first. The workspace itself is not checked. */
    async list(ctx: Context, workspaceId: string): Promise<readonly Slice[]> {
        this.#assertWorkspaceId(workspaceId);
        return await this.#read(ctx, workspaceId);
    }

    /** One slice, or undefined when it never existed, belongs elsewhere, or has been dropped. */
    async get(ctx: Context, workspaceId: string, sliceId: string): Promise<Slice | undefined> {
        this.#assertWorkspaceId(workspaceId);
        if (!Value.Check(cuid2Schema, sliceId)) return undefined;
        return (await this.#read(ctx, workspaceId)).find((slice) => slice.id === sliceId);
    }

    /**
     * Removes one slice the person no longer needs. Answers the slice as it was, or undefined
     * when the workspace's list does not hold it — never existed, dropped, or already removed.
     */
    async delete(ctx: Context, workspaceId: string, sliceId: string): Promise<Slice | undefined> {
        this.#assertWorkspaceId(workspaceId);
        if (!Value.Check(cuid2Schema, sliceId)) return undefined;
        const at = Date.now();
        return await ctx.inTx(async (txCtx): Promise<Slice | undefined> => {
            const existing = await this.#read(txCtx, workspaceId);
            const slice = existing.find((candidate) => candidate.id === sliceId);
            if (slice === undefined) return undefined;
            await this.#write(
                txCtx,
                workspaceId,
                existing.filter((candidate) => candidate.id !== sliceId),
            );
            const event: SliceEvent = { type: "slice_deleted", slice, at };
            afterCommit(txCtx, () => this.#notify(event));
            return structuredClone(slice);
        });
    }

    /**
     * Create a slice in the workspace the acting agent belongs to.
     *
     * Membership comes from durable placement, never from a workspace ID the model supplies: the
     * agent's bot, its workspace, or its project root, walking up to the parent agent for a
     * collaborator that has no placement of its own.
     *
     * The caller names the slice ID — the tool uses its stable invocation ID — so a durable call
     * run again after a crash or a retried turn finds the slice it already made and returns it
     * instead of storing a second copy.
     */
    async create(
        ctx: Context,
        agentId: string,
        input: SliceCreateInput,
        sliceId: string,
    ): Promise<Slice> {
        if (!Value.Check(cuid2Schema, agentId)) {
            throw new SliceError("invalid_request", "The slice author is not a valid agent.");
        }
        if (!Value.Check(cuid2Schema, sliceId)) {
            throw new SliceError("invalid_request", "The slice ID is not a valid identifier.");
        }
        if (!Value.Check(sliceCreateInputSchema, input)) {
            throw new SliceError("invalid_request", "The slice does not fit its bounds.");
        }
        const title = input.title.trim();
        if (title.length === 0) {
            throw new SliceError("invalid_request", "A slice needs a title.");
        }
        const note = input.note?.trim();
        const seen = new Set<string>();
        const files = input.files.map((file) => {
            assertSlicePath(file.path);
            if (seen.has(file.path)) {
                throw new SliceError(
                    "invalid_request",
                    `Slice path "${file.path}" is listed more than once.`,
                );
            }
            seen.add(file.path);
            const lines = file.lines ?? [];
            assertSliceLines(file.path, lines);
            const reason = file.reason?.trim();
            return {
                path: file.path,
                reason: reason === undefined || reason.length === 0 ? null : reason,
                lines: lines.map((range) => ({ start: range.start, end: range.end })),
            };
        });
        const workspaceId = await this.#workspaceForAgent(ctx, agentId);
        const slice: Slice = {
            id: sliceId,
            workspaceId,
            agentId,
            title,
            note: note === undefined || note.length === 0 ? null : note,
            files,
            version: this.#nextVersion(),
            createdAt: Date.now(),
        };
        if (!Value.Check(sliceSchema, slice)) {
            throw new SliceError("invalid_request", "The slice does not fit its bounds.");
        }
        const event: SliceEvent = { type: "slice_created", slice, at: slice.createdAt };
        const stored = await ctx.inTx(async (txCtx): Promise<Slice> => {
            const existing = await this.#read(txCtx, workspaceId);
            // A durable call run twice finds its own slice here; nothing is written or announced
            // again. Slices are immutable, so the first copy is the whole answer.
            const known = existing.find((candidate) => candidate.id === sliceId);
            if (known !== undefined) return known;
            const retained = [slice, ...existing].slice(0, MAX_SLICES_PER_WORKSPACE);
            await this.#write(txCtx, workspaceId, retained);
            // The observer is told about a change that has already landed, so it runs after the
            // transaction context has ended rather than inside it.
            afterCommit(txCtx, () => this.#notify(event));
            return slice;
        });
        return structuredClone(stored);
    }

    async #workspaceForAgent(ctx: Context, agentId: string): Promise<string> {
        const agents = this.#requireAgents();
        const visited = new Set<string>();
        let current: string | null = agentId;
        while (current !== null) {
            if (visited.has(current) || visited.size >= 64) {
                throw new SliceError(
                    "invalid_request",
                    "The agent's ancestry is invalid or too deep.",
                );
            }
            visited.add(current);
            const bot = await this.#bots.forAgent(ctx, current);
            if (bot !== undefined) {
                if (bot.status !== "active") {
                    throw new SliceError("unavailable", "The bot workspace is not available.");
                }
                return bot.workspaceId;
            }
            if (this.#config.configuration.values.features.workspaces) {
                const workspaceId = await this.#workspaces.workspaceForAgent(ctx, current);
                if (workspaceId !== undefined) {
                    const workspace = await this.#workspaces.get(ctx, workspaceId);
                    if (workspace?.status !== "ready") {
                        throw new SliceError("unavailable", "The workspace is not ready.");
                    }
                    return workspaceId;
                }
            }
            const project = await this.#projects.projectForAgent(ctx, current);
            if (project !== undefined) {
                if (project.status !== "active" || project.initializationStatus !== "ready") {
                    throw new SliceError("unavailable", "The project root is not ready.");
                }
                return project.id;
            }
            current = await agents.parentOf(ctx, current);
        }
        throw new SliceError("not_found", "This agent does not belong to a workspace.");
    }

    async #notify(event: SliceEvent): Promise<void> {
        for (const listener of [...this.#listeners]) {
            try {
                await listener(event);
            } catch {
                // The slice is already durable; one subscriber cannot make it look failed.
            }
        }
    }

    async #read(ctx: Context, workspaceId: string): Promise<readonly Slice[]> {
        const rows = await agentDatabaseRows<{ slices_json: string }>(
            ctx.db,
            sql`SELECT slices_json
                FROM ${sql.raw(SLICE_STATE_TABLE)}
                WHERE workspace_id = ${workspaceId}
                LIMIT 1`,
        );
        const encoded = rows[0]?.slices_json;
        if (encoded === undefined) return [];
        const value: unknown = JSON.parse(encoded);
        if (!Value.Check(sliceListSchema, value)) {
            throw new Error("The stored slice list is invalid.");
        }
        return value;
    }

    async #write(ctx: Context, workspaceId: string, slices: readonly Slice[]): Promise<void> {
        if (!Value.Check(sliceListSchema, slices)) {
            throw new Error("The slice list does not fit its bounds.");
        }
        const encoded = JSON.stringify(slices);
        await agentDatabaseRun(
            ctx.db,
            sql`INSERT INTO ${sql.raw(SLICE_STATE_TABLE)} (workspace_id, slices_json)
                VALUES (${workspaceId}, ${encoded})
                ON CONFLICT (workspace_id)
                DO UPDATE SET slices_json = EXCLUDED.slices_json`,
        );
    }

    #assertWorkspaceId(workspaceId: string): void {
        if (!Value.Check(cuid2Schema, workspaceId)) {
            throw new SliceError("not_found", "The workspace was not found.");
        }
    }

    #requireAgents(): AgentSystemRef {
        if (this.#agents === undefined) throw new Error("The slices module has not started.");
        return this.#agents;
    }
}
