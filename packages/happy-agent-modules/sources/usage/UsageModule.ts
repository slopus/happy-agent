import {
    agentId as contextAgentId,
    agentDatabaseRun,
    type AgentConfig,
    type AgentDatabase,
    type AgentDatabaseFacade,
    type AgentBaseInference,
    type AgentBaseInferenceStart,
    type AgentBaseTurn,
    type AgentBaseTurnStart,
    type AgentModule,
    type AgentModuleHooks,
    type AgentModuleScope,
    type AgentSystemRef,
    type AnyAgentTool,
} from "@slopus/happy-agent-base";
import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { SessionEvent, SessionUsage } from "@slopus/happy-providers";
import { afterCommit, type Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";

import { EventsModule } from "../events/index.js";
import {
    usageEventListenerSchema,
    usageEventSchema,
    type UsageEvent,
    type UsageEventListener,
} from "./UsageEvent.js";
import {
    MAX_USAGE_DURATION_MS,
    MAX_USAGE_TREE_PATH_LENGTH,
    MAX_USAGE_TREE_SESSIONS,
    MAX_USAGE_TREE_TITLE_LENGTH,
    MAX_USAGE_TOKEN_COUNT,
    MAX_USAGE_WINDOWS,
    usageAggregateQuerySchema,
    usageAgentIdSchema,
    usageAgentTreeSchema,
    usageIdSchema,
    usagePageQuerySchema,
    usageRunIdSchema,
    usageRunSummarySchema,
    usageSummarySchema,
    usageTimestampSchema,
    usageTokensSchema,
    type UsageAggregateQuery,
    type UsageAgentTree,
    type UsageAgentTreeRelation,
    type UsageAgentTreeSession,
    type UsageCurrentContext,
    type UsageInferenceRecord,
    type UsagePage,
    type UsagePageQuery,
    type UsageRecord,
    type UsageResetTarget,
    type UsageRunBreakdown,
    type UsageRunSummary,
    type UsageSummary,
    type UsageTurnRecord,
} from "./Usage.js";
import { usageVoidOrPromiseVoidSchema } from "./UsageContracts.js";
import { getAgentTreeUsageTool } from "./tools/get_agent_tree_usage.js";
import { getUsageTool } from "./tools/get_usage.js";
import { assertUsageRecord, assertUsageTokens } from "./impl/assertUsageRecord.js";
import { UsageDatabase } from "./impl/usageDatabase.js";

/**
 * How many raw records one page returns, and the largest page any caller may ask for.
 *
 * Paging exists so a reader can walk the records without holding all of them at once; how wide
 * one step is is a property of the feature rather than something a caller tunes.
 */
export const USAGE_PAGE_SIZE = 50;

/** How many provider/model/effort/tier groups one aggregate page holds. */
export const USAGE_GROUP_PAGE_SIZE = 100;

/** The character budget every rendering of a summary or an agent tree is cut to fit. */
export const USAGE_OUTPUT_CHARACTERS = 8_000;

/** How far the ancestry walk authorizing a subtree read climbs before it gives up. */
const MAX_USAGE_ANCESTRY_DEPTH = 64;

const INFERENCE_PENDING_KEY = "pending_inference";
const TURN_PENDING_KEY = "pending_turn";

const usagePendingKindSchema = Type.Union([Type.Literal("inference"), Type.Literal("turn")]);
const usagePendingSchema = Type.Object(
    {
        startedAt: usageTimestampSchema,
        runId: usageRunIdSchema,
        usage: Type.Optional(
            Type.Object(
                {
                    input: usageTokensSchema.properties.input,
                    output: usageTokensSchema.properties.output,
                    cacheRead: usageTokensSchema.properties.input,
                    cacheWrite: usageTokensSchema.properties.output,
                },
                { additionalProperties: false },
            ),
        ),
    },
    { additionalProperties: false },
);
const usageReadQuerySchema = Type.Object(
    {
        cursor: usageAggregateQuerySchema.properties.cursor,
        maxGroups: usageAggregateQuerySchema.properties.maxGroups,
    },
    { additionalProperties: false },
);

type UsagePendingKind = Static<typeof usagePendingKindSchema>;
type UsagePending = Static<typeof usagePendingSchema>;

/** One agent still to be visited while a subtree snapshot is being built. */
interface UsageTreeNode {
    readonly agentId: string;
    readonly parentAgentId?: string;
    readonly path: string;
}

/**
 * Advisory provider usage accounting for one AgentSystem.
 *
 * The module owns its bounded records in a module-owned table. The host
 * uses the database carried by the context; Agent Base supplies the durable
 * inference and turn identities used as record IDs.
 */
export class UsageModule implements AgentModule {
    readonly name = "usage";
    readonly migrations = [
        [
            "001-usage-records",
            async (_ctx: Context, database: AgentDatabaseFacade<AgentDatabase>): Promise<void> => {
                await agentDatabaseRun(
                    database,
                    sql`CREATE TABLE IF NOT EXISTS happy_agent_usage_records (
                        record_id TEXT PRIMARY KEY,
                        agent_id TEXT NOT NULL,
                        finished_at INTEGER NOT NULL,
                        kind TEXT NOT NULL,
                        record_json TEXT NOT NULL
                    )`,
                );
                await agentDatabaseRun(
                    database,
                    sql`CREATE INDEX IF NOT EXISTS happy_agent_usage_records_agent_time
                        ON happy_agent_usage_records (agent_id, finished_at, record_id)`,
                );
                await agentDatabaseRun(
                    database,
                    sql`CREATE TABLE IF NOT EXISTS happy_agent_usage_reset_receipts (
                        operation_id TEXT PRIMARY KEY,
                        created_at INTEGER NOT NULL,
                        receipt_json TEXT NOT NULL
                    )`,
                );
            },
        ],
        [
            "002-drop-usage-reset-receipts",
            async (_ctx: Context, database: AgentDatabaseFacade<AgentDatabase>): Promise<void> => {
                await agentDatabaseRun(
                    database,
                    sql`DROP TABLE IF EXISTS happy_agent_usage_reset_receipts`,
                );
            },
        ],
        [
            "003-usage-run-attribution",
            async (_ctx: Context, database: AgentDatabaseFacade<AgentDatabase>): Promise<void> => {
                await agentDatabaseRun(
                    database,
                    sql`ALTER TABLE happy_agent_usage_records ADD COLUMN run_id TEXT`,
                );
                await agentDatabaseRun(
                    database,
                    sql`CREATE INDEX happy_agent_usage_records_agent_run_time
                        ON happy_agent_usage_records (agent_id, run_id, finished_at, record_id)`,
                );
            },
        ],
        [
            "004-usage-current-context",
            async (_ctx: Context, database: AgentDatabaseFacade<AgentDatabase>): Promise<void> => {
                await agentDatabaseRun(
                    database,
                    sql`CREATE TABLE IF NOT EXISTS happy_agent_usage_contexts (
                        agent_id TEXT PRIMARY KEY,
                        updated_at INTEGER NOT NULL,
                        context_json TEXT
                    )`,
                );
            },
        ],
        [
            "005-usage-model-totals",
            async (_ctx: Context, database: AgentDatabaseFacade<AgentDatabase>): Promise<void> => {
                await agentDatabaseRun(
                    database,
                    sql`CREATE TABLE IF NOT EXISTS happy_agent_usage_model_totals (
                        agent_id TEXT NOT NULL,
                        provider TEXT NOT NULL,
                        model TEXT NOT NULL,
                        input_tokens INTEGER NOT NULL,
                        output_tokens INTEGER NOT NULL,
                        cache_read_tokens INTEGER NOT NULL,
                        cache_write_tokens INTEGER NOT NULL,
                        PRIMARY KEY (agent_id, provider, model)
                    )`,
                );
                await agentDatabaseRun(
                    database,
                    sql`INSERT INTO happy_agent_usage_model_totals
                            (agent_id, provider, model, input_tokens, output_tokens,
                             cache_read_tokens, cache_write_tokens)
                        SELECT agent_id,
                               json_extract(record_json, '$.provider'),
                               json_extract(record_json, '$.model'),
                               SUM(json_extract(record_json, '$.tokens.input')),
                               SUM(json_extract(record_json, '$.tokens.output')),
                               SUM(COALESCE(json_extract(record_json, '$.tokens.cacheRead'), 0)),
                               SUM(COALESCE(json_extract(record_json, '$.tokens.cacheWrite'), 0))
                        FROM happy_agent_usage_records
                        WHERE kind = 'inference' AND json_type(record_json, '$.model') = 'text'
                        GROUP BY agent_id,
                                 json_extract(record_json, '$.provider'),
                                 json_extract(record_json, '$.model')
                        ON CONFLICT(agent_id, provider, model) DO NOTHING`,
                );
            },
        ],
    ] as const;
    readonly #transactionalListeners = new Set<UsageEventListener>();
    readonly #listeners = new Set<UsageEventListener>();
    #agents: AgentSystemRef | undefined;

    constructor(private readonly events: EventsModule) {}

    /**
     * Watch committed usage inside the transaction that records it.
     *
     * A subscriber here runs before the change is durable, so a failure fails the mutation with
     * it. Returns the function that stops the subscription.
     */
    onEventTransactional(listener: UsageEventListener): () => void {
        assertUsageEventListener(listener);
        this.#transactionalListeners.add(listener);
        return () => this.#transactionalListeners.delete(listener);
    }

    /**
     * Watch usage that has already been recorded.
     *
     * A subscriber here runs after the change is durable. Usage accounting is advisory, so its
     * failure is logged and the next subscriber still hears about the change. Returns the
     * function that stops the subscription.
     */
    onEvent(listener: UsageEventListener): () => void {
        assertUsageEventListener(listener);
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }

    /** Read one agent's bounded aggregate. */
    async read(
        ctx: Context,
        agentId: string,
        query: Pick<UsageAggregateQuery, "cursor" | "maxGroups"> = {},
    ): Promise<UsageSummary> {
        this.#assertAgentAccess(ctx, agentId);
        if (!Value.Check(usageReadQuerySchema, query)) {
            throw new Error("Usage aggregate query is invalid.");
        }
        const fullQuery = {
            agentId,
            ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
            ...(query.maxGroups === undefined ? {} : { maxGroups: query.maxGroups }),
        };
        if (!Value.Check(usageAggregateQuerySchema, fullQuery)) {
            throw new Error("Usage aggregate query is invalid.");
        }
        return await this.aggregate(ctx, {
            ...fullQuery,
        });
    }

    /** Explicit alias for callers that prefer the per-agent name. */
    async readAgent(
        ctx: Context,
        agentId: string,
        query: Pick<UsageAggregateQuery, "cursor" | "maxGroups"> = {},
    ): Promise<UsageSummary> {
        return await this.read(ctx, agentId, query);
    }

    /** Descriptive alias for host APIs that name the aggregate explicitly. */
    async readAgentUsage(
        ctx: Context,
        agentId: string,
        query: Pick<UsageAggregateQuery, "cursor" | "maxGroups"> = {},
    ): Promise<UsageSummary> {
        return await this.readAgent(ctx, agentId, query);
    }

    /** Read one bounded raw page for a host that needs provider/model detail. */
    async readPage(ctx: Context, agentId: string, query: UsagePageQuery = {}): Promise<UsagePage> {
        this.#assertAgentAccess(ctx, agentId);
        if (!Value.Check(usagePageQuerySchema, query)) {
            throw new Error("Usage page query is invalid.");
        }
        const limit = query.limit ?? USAGE_PAGE_SIZE;
        if (limit > USAGE_PAGE_SIZE) {
            throw new Error(`Usage page limit cannot exceed ${USAGE_PAGE_SIZE}.`);
        }
        const cursor = query.cursor ?? 0;
        const page = await new UsageDatabase().read(
            ctx,
            agentId,
            { cursor, limit },
            USAGE_PAGE_SIZE,
        );
        assertUsagePage(page, agentId, cursor, limit);
        return cloneValue(page);
    }

    /** Read the exact bounded provider/model usage attributed to one run. */
    async readRun(ctx: Context, agentId: string, runId: string): Promise<UsageRunSummary> {
        this.#assertAgentAccess(ctx, agentId);
        if (!Value.Check(usageRunIdSchema, runId)) {
            throw new Error("Usage run ID is invalid.");
        }
        const summary = await new UsageDatabase().run(ctx, agentId, runId);
        if (!Value.Check(usageRunSummarySchema, summary)) {
            throw new Error("Usage store returned invalid run usage.");
        }
        return cloneValue(summary);
    }

    /**
     * Read provider/model inference totals for several rolling windows, across the whole
     * collection, in the order the cutoffs were given.
     *
     * Each window is summed by the database over the complete durable history, so it answers for
     * every agent that ever ran rather than for whatever detail a bounded page still holds. They
     * are read together because the widest window contains the rest, and asking one at a time
     * would scan the same history once per window. Only host code may ask, because the answer
     * spans every agent in the collection.
     */
    async readWindowUsage(
        ctx: Context,
        cutoffs: readonly number[],
    ): Promise<UsageRunBreakdown[]> {
        this.#assertAgentAccess(ctx, undefined);
        if (cutoffs.length > MAX_USAGE_WINDOWS) {
            throw new Error(`Usage cannot report more than ${MAX_USAGE_WINDOWS} windows at once.`);
        }
        for (const cutoff of cutoffs) {
            if (!Value.Check(usageTimestampSchema, cutoff)) {
                throw new Error("Usage window start is invalid.");
            }
        }
        return await new UsageDatabase().windowUsage(ctx, cutoffs);
    }

    /** Read lifetime provider/model inference totals for one agent. */
    async readAgentModelUsage(ctx: Context, agentId: string): Promise<UsageRunBreakdown> {
        this.#assertAgentAccess(ctx, agentId);
        return await new UsageDatabase().modelUsage(ctx, agentId);
    }

    /** Read a bounded aggregate for one agent or the whole collection. */
    async aggregate(ctx: Context, query: UsageAggregateQuery = {}): Promise<UsageSummary> {
        if (!Value.Check(usageAggregateQuerySchema, query)) {
            throw new Error("Usage aggregate query is invalid.");
        }
        this.#assertAgentAccess(ctx, query.agentId);
        const maxGroups = query.maxGroups ?? USAGE_GROUP_PAGE_SIZE;
        if (maxGroups > USAGE_GROUP_PAGE_SIZE) {
            throw new Error(`Usage group limit cannot exceed ${USAGE_GROUP_PAGE_SIZE}.`);
        }
        const cursor = query.cursor ?? 0;
        const summary = await new UsageDatabase().aggregate(
            ctx,
            {
                ...(query.agentId === undefined ? {} : { agentId: query.agentId }),
                cursor,
                maxGroups,
            },
            maxGroups,
        );
        assertUsageSummary(summary, query.agentId, cursor, maxGroups);
        return cloneValue(summary);
    }

    /** Explicit alias for collection readers. */
    async readAggregate(
        ctx: Context,
        query: Pick<UsageAggregateQuery, "cursor" | "maxGroups"> = {},
    ): Promise<UsageSummary> {
        return await this.aggregate(ctx, query);
    }

    /** Descriptive alias for host APIs that name the aggregate explicitly. */
    async readAggregateUsage(
        ctx: Context,
        query: Pick<UsageAggregateQuery, "cursor" | "maxGroups"> = {},
    ): Promise<UsageSummary> {
        return await this.readAggregate(ctx, query);
    }

    /**
     * The complete subtree rooted at one agent: what it started, how deep that goes, and what
     * every agent in it has cost.
     *
     * The shape comes from the collection of agents the module was started with, and every token
     * count comes from the module's own records, so the answer is the module's own rather than
     * something a host handed it. An agent may ask about itself and about the agents it started,
     * and about nothing else; a context that names no agent is host code, already outside
     * model-facing access policy.
     */
    async readAgentTreeUsage(ctx: Context, agentId: string): Promise<UsageAgentTree> {
        assertAgentId(agentId);
        const agents = this.#agents;
        if (agents === undefined) {
            throw new Error("The usage module was asked for an agent tree before it started.");
        }
        await this.#assertSubtreeAccess(ctx, agents, agentId);
        const tree = await this.#buildAgentTree(ctx, agents, agentId);
        assertUsageAgentTree(tree, agentId);
        return tree;
    }

    /** Alias retained for callers that use the shorter name. */
    async readAgentTree(ctx: Context, agentId: string): Promise<UsageAgentTree> {
        return await this.readAgentTreeUsage(ctx, agentId);
    }

    /** Reset one agent's usage. */
    async reset(ctx: Context, agentId: string): Promise<number> {
        this.#assertAgentAccess(ctx, agentId);
        return await this.#reset(ctx, agentId);
    }

    /** Descriptive alias for the per-agent reset operation. */
    async resetAgentUsage(ctx: Context, agentId: string): Promise<number> {
        return await this.reset(ctx, agentId);
    }

    /** Reset every agent's usage in one host transaction. */
    async resetAll(ctx: Context): Promise<number> {
        this.#assertAgentAccess(ctx, undefined);
        return await this.#reset(ctx, undefined);
    }

    /** Descriptive alias for the collection reset operation. */
    async resetAggregateUsage(ctx: Context): Promise<number> {
        return await this.resetAll(ctx);
    }

    /**
     * Render a bounded subtree snapshot for a model-facing tool result.
     *
     * `maxCharacters` is the budget one rendering has to fit; it defaults to the module's own and
     * exists so a caller with a tighter answer to fill can ask for less, never more.
     */
    formatAgentTreeUsageForModel(
        tree: UsageAgentTree,
        maxCharacters = USAGE_OUTPUT_CHARACTERS,
    ): string {
        assertUsageAgentTree(tree);
        if (
            !Number.isInteger(maxCharacters) ||
            maxCharacters < 256 ||
            maxCharacters > USAGE_OUTPUT_CHARACTERS
        ) {
            throw new Error("Usage output bound is invalid.");
        }
        const header = `Agent tree usage: ${tree.totalTokens} total tokens across ${tree.sessions.length} agents.`;
        const lines = [header];
        for (const session of tree.sessions) {
            const line = [
                session.agentId,
                session.relation,
                session.path,
                `${session.totalTokens} tokens`,
                ...(session.title === undefined ? [] : [session.title]),
            ].join(" | ");
            if (lines.join("\n").length + 1 + line.length > maxCharacters) {
                lines.push(
                    `- Output capped at ${maxCharacters} characters; structured result contains ${tree.sessions.length} validated agents.`,
                );
                break;
            }
            lines.push(line);
        }
        const output = lines.join("\n");
        if (output.length <= maxCharacters) return output;
        return truncate(
            `Agent tree usage: ${tree.totalTokens} total tokens across ${tree.sessions.length} agents.`,
            maxCharacters,
        );
    }

    /**
     * Render a bounded model-facing summary.  Group rows are admitted one at
     * a time and the continuation cursor is computed from the last visible
     * row, so output truncation never skips an unseen group.
     *
     * `maxCharacters` is the budget one rendering has to fit; it defaults to the module's own and
     * exists so a caller with a tighter answer to fill can ask for less, never more.
     */
    formatForModel(summary: UsageSummary, maxCharacters = USAGE_OUTPUT_CHARACTERS): string {
        assertUsageSummary(summary, summary.agentId, summary.cursor, USAGE_GROUP_PAGE_SIZE);
        if (
            !Number.isInteger(maxCharacters) ||
            maxCharacters < 256 ||
            maxCharacters > USAGE_OUTPUT_CHARACTERS
        ) {
            throw new Error("Usage output bound is invalid.");
        }
        const scope = summary.agentId === undefined ? "all agents" : `agent ${summary.agentId}`;
        const displayScope = truncate(scope, 96);
        const lines = [
            `Usage for ${displayScope}:`,
            `- ${summary.inferenceCount} inferences, ${summary.turnCount} turns`,
            `- ${summary.inputTokens} input tokens, ${summary.outputTokens} output tokens (${summary.totalTokens} total)`,
            `- ${summary.totalDurationMs} ms total (${summary.inferenceDurationMs} ms inference, ${summary.turnDurationMs} ms turn)`,
            summary.currentContext === undefined
                ? "- Current context: unavailable (no provider measurement yet)."
                : `- Current context: ${summary.currentContext.contextTokens} tokens${
                      summary.currentContext.approximate ? " (approximate)" : ""
                  }.`,
        ];
        const visibleGroups: string[] = [];
        for (const [index, group] of summary.groups.entries()) {
            const groupCursor = summary.cursor + index;
            const line = formatGroup(group, groupCursor, maxCharacters);
            const footer =
                "- More groups are available; call get_usage with aggregate=true and cursor=";
            const nextCursor = groupCursor + 1;
            const reserve =
                index + 1 < summary.groups.length || summary.nextCursor !== undefined
                    ? `\n${footer}${nextCursor}.`
                    : "";
            const candidate = [...lines, ...visibleGroups, line].join("\n");
            if (candidate.length + reserve.length > maxCharacters) {
                break;
            }
            visibleGroups.push(line);
        }
        lines.push(...visibleGroups);
        const hiddenInPage = visibleGroups.length < summary.groups.length;
        const continuation = hiddenInPage
            ? summary.cursor + Math.max(1, visibleGroups.length)
            : summary.nextCursor;
        if (continuation !== undefined) {
            lines.push(
                `- More groups are available; call get_usage with aggregate=true and cursor=${continuation}.`,
            );
        }
        const output = lines.join("\n");
        if (output.length <= maxCharacters && !(hiddenInPage && visibleGroups.length === 0)) {
            return output;
        }
        /*
         * The header is bounded well below the minimum output size.  A
         * pathological attribution can still consume the budget; retain the
         * header and an explicit cursor rather than slicing a group row.
         */
        const cursor =
            continuation ??
            (summary.groups.length > 0
                ? summary.cursor + Math.max(1, visibleGroups.length)
                : undefined);
        const fallback =
            cursor === undefined
                ? lines.slice(0, 4).join("\n")
                : [
                      `Usage for ${displayScope}:`,
                      `- ${summary.inferenceCount} inferences, ${summary.turnCount} turns`,
                      ...(summary.groups[0] === undefined
                          ? []
                          : [formatCompactGroup(summary.groups[0], summary.cursor)]),
                      `- More groups are available; call get_usage with aggregate=true and cursor=${cursor}.`,
                  ].join("\n");
        if (fallback.length <= maxCharacters) return fallback;
        if (cursor === undefined) {
            const compactSummary = [
                `Usage for ${truncate(scope, 32)}:`,
                `- ${summary.inferenceCount} inferences, ${summary.turnCount} turns`,
            ].join("\n");
            return compactSummary.length <= maxCharacters ? compactSummary : "Usage";
        }
        const compactFooter = `- More groups are available; call get_usage with aggregate=true and cursor=${cursor ?? summary.cursor}.`;
        const compact = [
            `Usage for ${truncate(scope, 32)}:`,
            ...(summary.groups[0] === undefined
                ? []
                : [formatCompactGroup(summary.groups[0], summary.cursor, maxCharacters)]),
            compactFooter,
        ].join("\n");
        if (compact.length <= maxCharacters) return compact;
        return ["Usage:", `- group ${summary.cursor}`, compactFooter].join("\n");
    }

    async #beginObservation(
        ctx: Context,
        scope: AgentModuleScope,
        kind: UsagePendingKind,
        loopId: string,
    ): Promise<void> {
        try {
            const key = kind === "inference" ? INFERENCE_PENDING_KEY : TURN_PENDING_KEY;
            const pending: UsagePending = {
                startedAt: this.#now(),
                runId: (await this.events.activeRunIdInTransaction(ctx, scope.agent.id)) ?? loopId,
            };
            await scope.runKV.write(ctx, key, cloneValue(pending));
        } catch (error: unknown) {
            this.#reportObserverError(ctx, "begin", error);
        }
    }

    async #finishInference(
        ctx: Context,
        scope: AgentModuleScope,
        inference: AgentBaseInference,
    ): Promise<void> {
        await this.#finish(
            ctx,
            scope,
            "inference",
            async (startedAt, finishedAt, durationMs, pending) => {
                if (inference.tokens === undefined) {
                    throw new Error("Inference did not report provider token counts.");
                }
                assertUsageTokens(inference.tokens);
                const record: UsageInferenceRecord = {
                    id: inference.inferenceId,
                    agentId: scope.agent.id,
                    provider: scope.agent.provider,
                    kind: "inference",
                    runId: pending.runId,
                    tokens: {
                        input: inference.tokens.input,
                        output: inference.tokens.output,
                        cacheRead: pending.usage?.cacheRead ?? 0,
                        cacheWrite: pending.usage?.cacheWrite ?? 0,
                    },
                    startedAt,
                    finishedAt,
                    durationMs,
                    ...(scope.agent.model === undefined ? {} : { model: scope.agent.model }),
                    ...(scope.agent.effort === undefined ? {} : { effort: scope.agent.effort }),
                    ...(scope.agent.tier === undefined ? {} : { tier: scope.agent.tier }),
                    ...(inference.state === undefined ? {} : { state: inference.state }),
                    ...(inference.errorMessage === undefined
                        ? {}
                        : { errorMessage: inference.errorMessage }),
                };
                assertUsageRecord(record);
                await this.#record(ctx, scope, record);
            },
        );
    }

    async #finishTurn(ctx: Context, scope: AgentModuleScope, turn: AgentBaseTurn): Promise<void> {
        await this.#finish(
            ctx,
            scope,
            "turn",
            async (startedAt, finishedAt, durationMs, pending) => {
                if (
                    turn.contextTokens !== undefined &&
                    (!Number.isInteger(turn.contextTokens) ||
                        turn.contextTokens < 0 ||
                        turn.contextTokens > MAX_USAGE_TOKEN_COUNT)
                ) {
                    throw new Error("Turn context tokens are invalid.");
                }
                const record: UsageTurnRecord = {
                    id: turn.turnId,
                    agentId: scope.agent.id,
                    provider: scope.agent.provider,
                    kind: "turn",
                    runId: pending.runId,
                    aborted: turn.aborted,
                    startedAt,
                    finishedAt,
                    durationMs,
                    ...(scope.agent.model === undefined ? {} : { model: scope.agent.model }),
                    ...(scope.agent.effort === undefined ? {} : { effort: scope.agent.effort }),
                    ...(scope.agent.tier === undefined ? {} : { tier: scope.agent.tier }),
                    ...(turn.contextTokens === undefined
                        ? {}
                        : { contextTokens: turn.contextTokens }),
                };
                assertUsageRecord(record);
                const contextChanged = await this.#record(ctx, scope, record);
                if (contextChanged) {
                    await this.#recordContextChange(
                        ctx,
                        record.agentId,
                        record.contextTokens === undefined
                            ? null
                            : {
                                  approximate: false,
                                  contextTokens: record.contextTokens,
                                  provider: record.provider,
                                  ...(record.model === undefined ? {} : { model: record.model }),
                                  ...(record.effort === undefined ? {} : { effort: record.effort }),
                                  ...(record.tier === undefined ? {} : { tier: record.tier }),
                              },
                        record.finishedAt,
                    );
                }
            },
        );
    }

    async #recordProviderUsage(
        ctx: Context,
        scope: AgentModuleScope,
        usage: SessionUsage,
    ): Promise<void> {
        try {
            const stored = await scope.runKV.read(ctx, INFERENCE_PENDING_KEY);
            if (stored === undefined) return;
            const pending = assertPending(stored);
            const updated: UsagePending = {
                ...pending,
                usage: {
                    input: usage.input,
                    output: usage.output,
                    cacheRead: usage.cacheRead,
                    cacheWrite: usage.cacheWrite,
                },
            };
            if (!Value.Check(usagePendingSchema, updated)) {
                throw new Error("Provider usage is outside its configured bounds.");
            }
            await scope.runKV.write(ctx, INFERENCE_PENDING_KEY, cloneValue(updated));
        } catch (error: unknown) {
            this.#reportObserverError(ctx, "provider_usage", error);
        }
    }

    async #finish(
        ctx: Context,
        scope: AgentModuleScope,
        kind: UsagePendingKind,
        write: (
            startedAt: number,
            finishedAt: number,
            durationMs: number,
            pending: UsagePending,
        ) => Promise<void>,
    ): Promise<void> {
        const key = kind === "inference" ? INFERENCE_PENDING_KEY : TURN_PENDING_KEY;
        try {
            const stored = await scope.runKV.read(ctx, key);
            if (stored === undefined) {
                throw new Error("Usage observation start is unavailable.");
            }
            const pending = assertPending(stored);
            const startedAt = pending.startedAt;
            const finishedAt = this.#now();
            if (finishedAt < startedAt) {
                throw new Error("Usage clock moved backwards.");
            }
            const durationMs = finishedAt - startedAt;
            if (
                !Number.isInteger(durationMs) ||
                durationMs < 0 ||
                durationMs > MAX_USAGE_DURATION_MS
            ) {
                throw new Error("Usage duration is outside its configured bounds.");
            }
            await write(startedAt, finishedAt, durationMs, pending);
            await scope.runKV.delete(ctx, key);
        } catch (error: unknown) {
            this.#reportObserverError(ctx, `after_${kind}`, error);
            try {
                await scope.runKV.delete(ctx, key);
            } catch (cleanupError: unknown) {
                this.#reportObserverError(ctx, `clear_${kind}`, cleanupError);
            }
        }
    }

    async #record(ctx: Context, scope: AgentModuleScope, record: UsageRecord): Promise<boolean> {
        assertUsageRecord(record);
        const detachedRecord = deepFreeze(cloneValue(record));
        const contextChanged = await new UsageDatabase().record(ctx, detachedRecord);
        const event = cloneAndFreezeEvent({
            type: "usage_recorded",
            eventId: detachedRecord.id,
            at: detachedRecord.finishedAt,
            record: cloneValue(detachedRecord),
        });
        await this.#notifyTransactional(ctx, event);
        this.#registerPostCommit(ctx, event);
        return contextChanged;
    }

    async #recordContextChange(
        ctx: Context,
        agentId: string,
        context: UsageCurrentContext | null,
        at: number,
    ): Promise<void> {
        const event = cloneAndFreezeEvent({
            type: "usage_context_changed",
            eventId: this.#newId(),
            at,
            agentId,
            context: context === null ? null : cloneValue(context),
        });
        await this.#notifyTransactional(ctx, event);
        this.#registerPostCommit(ctx, event);
    }

    async #reset(ctx: Context, agentId: string | undefined): Promise<number> {
        if (agentId !== undefined) assertAgentId(agentId);
        const target: UsageResetTarget = agentId ?? null;
        const eventId = this.#newId();
        return await ctx.inTx(async (txCtx) => {
            const removed = await new UsageDatabase().reset(txCtx, target);
            const event =
                removed > 0
                    ? cloneAndFreezeEvent({
                          type: "usage_reset",
                          eventId,
                          at: this.#now(),
                          agentId: target,
                          removed,
                      })
                    : undefined;
            if (event !== undefined) {
                await this.#notifyTransactional(txCtx, event);
                this.#registerPostCommit(txCtx, event);
            }
            return removed;
        });
    }

    #registerPostCommit(ctx: Context, event: UsageEvent): void {
        afterCommit(ctx, (postCommitCtx) => this.#notifyPostCommit(postCommitCtx, event));
    }

    async #notifyTransactional(ctx: Context, event: UsageEvent): Promise<void> {
        for (const listener of this.#transactionalListeners) {
            await invokeVoid(listener(ctx, event), "Usage transactional subscriber");
        }
    }

    async #notifyPostCommit(ctx: Context, event: UsageEvent): Promise<void> {
        for (const listener of this.#listeners) {
            try {
                await invokeVoid(listener(ctx, event), "Usage post-commit subscriber");
            } catch (error: unknown) {
                this.#reportObserverError(ctx, "post_commit_subscriber", error);
            }
        }
    }

    /**
     * Report an accounting failure without failing the work it was accounting for.
     *
     * Usage says what a turn cost. A turn that ran is not made to look failed because the number
     * could not be written down, so every one of these paths ends here rather than in a throw.
     */
    #reportObserverError(ctx: Context, phase: string, error: unknown): void {
        ctx.log.warn("Usage accounting failed and was skipped.", { phase }, error);
    }

    #newId(): string {
        const id = globalThis.crypto.randomUUID();
        if (!Value.Check(usageIdSchema, id)) {
            throw new Error("Usage produced an invalid event ID.");
        }
        return id;
    }

    #now(): number {
        const now = Date.now();
        if (!Value.Check(usageTimestampSchema, now)) {
            throw new Error("The system clock is outside the range a usage timestamp can hold.");
        }
        return now;
    }

    /**
     * Allow a subtree read only from inside that subtree's root.
     *
     * An agent may account for itself and for the work it started, however deep that goes. The
     * ancestry walk is what makes "the work it started" a fact about the collection rather than a
     * policy someone wired in, and it is bounded so a broken chain cannot spin.
     */
    async #assertSubtreeAccess(
        ctx: Context,
        agents: AgentSystemRef,
        agentId: string,
    ): Promise<void> {
        const owner = contextAgentId(ctx);
        if (owner === undefined || owner === agentId) return;
        let current = await agents.parentOf(ctx, agentId);
        for (let depth = 0; current !== null && depth < MAX_USAGE_ANCESTRY_DEPTH; depth += 1) {
            if (current === owner) return;
            current = await agents.parentOf(ctx, current);
        }
        throw new Error("Usage access is limited to the current agent and the agents it started.");
    }

    async #buildAgentTree(
        ctx: Context,
        agents: AgentSystemRef,
        rootAgentId: string,
    ): Promise<UsageAgentTree> {
        // One pass over the records answers every agent in the snapshot; asking per agent would
        // read the same bounded table once for each of them.
        const totals = await new UsageDatabase().totalTokensByAgent(ctx);
        const sessions: UsageAgentTreeSession[] = [];
        const visited = new Set<string>();
        let frontier: readonly UsageTreeNode[] = [
            { agentId: rootAgentId, path: `/${rootAgentId}` },
        ];
        while (frontier.length > 0) {
            const next: UsageTreeNode[] = [];
            for (const node of frontier) {
                if (visited.has(node.agentId)) continue;
                visited.add(node.agentId);
                if (sessions.length >= MAX_USAGE_TREE_SESSIONS) {
                    throw new Error("Usage agent tree is larger than one snapshot can hold.");
                }
                sessions.push(await this.#treeSession(ctx, agents, node, totals));
                for (const childAgentId of await agents.childOf(ctx, node.agentId)) {
                    const path = `${node.path}/${childAgentId}`;
                    if (path.length > MAX_USAGE_TREE_PATH_LENGTH) {
                        throw new Error("Usage agent tree is deeper than one snapshot can name.");
                    }
                    next.push({ agentId: childAgentId, parentAgentId: node.agentId, path });
                }
            }
            frontier = next;
        }
        return {
            sessions,
            totalTokens: sessions.reduce((sum, session) => sum + session.totalTokens, 0),
        };
    }

    async #treeSession(
        ctx: Context,
        agents: AgentSystemRef,
        node: UsageTreeNode,
        totals: ReadonlyMap<string, number>,
    ): Promise<UsageAgentTreeSession> {
        const config = await agents.config(ctx, node.agentId);
        const title = agentTitle(config);
        return {
            agentId: node.agentId,
            ...(title === undefined ? {} : { title }),
            ...(node.parentAgentId === undefined ? {} : { parentAgentId: node.parentAgentId }),
            path: node.path,
            relation: treeRelation(node.parentAgentId, config),
            totalTokens: totals.get(node.agentId) ?? 0,
        };
    }

    #assertAgentAccess(ctx: Context, requested: string | undefined): void {
        if (requested !== undefined) assertAgentId(requested);
        const owner = contextAgentId(ctx);
        if (owner !== undefined && owner !== requested) {
            throw new Error("Usage access is limited to the current agent.");
        }
        if (owner !== undefined && requested === undefined) {
            throw new Error("Usage collection access is not available to an agent context.");
        }
    }

    readonly #hooks: AgentModuleHooks = {
        /** The provider-neutral usage tool available to every agent. */
        tools: (_ctx: Context, scope: AgentModuleScope): readonly AnyAgentTool[] => [
            getUsageTool(this, scope.agent.id),
            getAgentTreeUsageTool(this, scope.agent.id),
        ],

        /** Persist the inference start time in Base's current transaction. */
        beforeInferenceTransact: async (
            ctx: Context,
            scope: AgentModuleScope,
            inference: AgentBaseInferenceStart,
        ): Promise<void> => {
            await this.#beginObservation(ctx, scope, "inference", inference.loopId);
        },

        /** Persist the turn start time in Base's current transaction. */
        beforeTurnTransact: async (
            ctx: Context,
            scope: AgentModuleScope,
            turn: AgentBaseTurnStart,
        ): Promise<void> => {
            await this.#beginObservation(ctx, scope, "turn", turn.loopId);
        },

        onEvent: async (
            ctx: Context,
            scope: AgentModuleScope,
            event: SessionEvent,
        ): Promise<void> => {
            if (event.type !== "token_usage") return;
            await this.#recordProviderUsage(ctx, scope, event.usage);
        },

        /** Record provider-measured tokens inside Base's inference completion transaction. */
        afterInferenceTransact: async (
            ctx: Context,
            scope: AgentModuleScope,
            inference: AgentBaseInference,
        ): Promise<void> => {
            await this.#finishInference(ctx, scope, inference);
        },

        /** Record turn timing inside Base's turn completion transaction. */
        afterTurnTransact: async (
            ctx: Context,
            scope: AgentModuleScope,
            turn: AgentBaseTurn,
        ): Promise<void> => {
            await this.#finishTurn(ctx, scope, turn);
        },

        /** A successful compaction invalidates the prior provider measurement atomically. */
        historyErasedTransact: async (ctx: Context, scope: AgentModuleScope): Promise<void> => {
            const at = this.#now();
            const changed = await new UsageDatabase().clearCurrentContext(ctx, scope.agent.id, at);
            if (changed) await this.#recordContextChange(ctx, scope.agent.id, null, at);
        },
    };

    readonly beforeStart = (_ctx: Context, agents: AgentSystemRef): AgentModuleHooks => {
        this.#agents = agents;
        return this.#hooks;
    };
}

function assertUsageEventListener(value: unknown): asserts value is UsageEventListener {
    if (!Value.Check(usageEventListenerSchema, value)) {
        throw new Error("A usage subscriber must be a function taking a context and an event.");
    }
}

/**
 * How an agent came to sit under its parent.
 *
 * An agent whose creation names its parent was started by that parent, with a tool: a subagent
 * doing part of the parent's own work. One that sits under an agent it does not name as its
 * creator was put there by someone else, and that is what "delegated" means here.
 */
function treeRelation(
    parentAgentId: string | undefined,
    config: AgentConfig | undefined,
): UsageAgentTreeRelation {
    if (parentAgentId === undefined) return "root";
    return config?.provenance?.createdBy === parentAgentId ? "subagent" : "delegated";
}

/** An agent's own title, bounded and on one line, when its metadata carries one. */
function agentTitle(config: AgentConfig | undefined): string | undefined {
    const title = config?.metadata?.title;
    if (typeof title !== "string") return undefined;
    const oneLine = title
        .replaceAll("\u0000", " ")
        .replaceAll("\r", " ")
        .replaceAll("\n", " ")
        .trim();
    if (oneLine.length === 0) return undefined;
    return truncate(oneLine, MAX_USAGE_TREE_TITLE_LENGTH);
}

function assertPending(value: unknown): UsagePending {
    if (!Value.Check(usagePendingSchema, value)) {
        throw new Error("Stored usage observation is invalid.");
    }
    return value as UsagePending;
}

function assertAgentId(agentId: string): void {
    if (!Value.Check(usageAgentIdSchema, agentId)) {
        throw new Error("Usage agent ID is invalid.");
    }
}

function assertUsageAgentTree(
    value: unknown,
    expectedRootAgentId?: string,
): asserts value is UsageAgentTree {
    if (!Value.Check(usageAgentTreeSchema, value)) {
        throw new Error("Usage agent tree is invalid.");
    }
    const tree = value as UsageAgentTree;
    if (tree.sessions.length === 0 || tree.sessions.length > MAX_USAGE_TREE_SESSIONS) {
        throw new Error("Usage agent tree is outside its bounds.");
    }
    const byAgentId = new Map<string, UsageAgentTree["sessions"][number]>();
    for (const session of tree.sessions) {
        if (byAgentId.has(session.agentId)) {
            throw new Error("Usage agent tree contains duplicate agent IDs.");
        }
        if (!session.path.startsWith("/") || session.path.length > MAX_USAGE_TREE_PATH_LENGTH) {
            throw new Error("Usage agent tree contains an invalid canonical path.");
        }
        byAgentId.set(session.agentId, session);
    }
    const roots = tree.sessions.filter((session) => session.relation === "root");
    if (roots.length !== 1 || roots[0]!.parentAgentId !== undefined) {
        throw new Error("Usage agent tree must contain exactly one parentless root.");
    }
    const root = roots[0]!;
    if (expectedRootAgentId !== undefined && root.agentId !== expectedRootAgentId) {
        throw new Error("Usage agent tree is rooted at the wrong agent.");
    }
    for (const session of tree.sessions) {
        if (session.relation === "root") continue;
        const parentAgentId = session.parentAgentId;
        if (parentAgentId === undefined || !byAgentId.has(parentAgentId)) {
            throw new Error("Usage agent tree contains an unavailable parent.");
        }
        if (parentAgentId === session.agentId) {
            throw new Error("Usage agent tree contains a self-parenting agent.");
        }
        const visited = new Set<string>();
        let current: UsageAgentTree["sessions"][number] | undefined = session;
        while (current !== undefined && current.relation !== "root") {
            if (visited.has(current.agentId)) {
                throw new Error("Usage agent tree contains a parent cycle.");
            }
            visited.add(current.agentId);
            current =
                current.parentAgentId === undefined
                    ? undefined
                    : byAgentId.get(current.parentAgentId);
        }
        if (current === undefined) {
            throw new Error("Usage agent tree does not connect every agent to its root.");
        }
    }
    const totalTokens = tree.sessions.reduce((sum, session) => sum + session.totalTokens, 0);
    if (totalTokens !== tree.totalTokens) {
        throw new Error("Usage agent tree total tokens are inconsistent.");
    }
}

function assertUsagePage(page: UsagePage, agentId: string, cursor: number, limit: number): void {
    if (page.agentId !== agentId || page.cursor !== cursor) {
        throw new Error("Usage store returned a page for the wrong agent or cursor.");
    }
    if (page.records.length > limit || page.cursor > page.totalRecords) {
        throw new Error("Usage store returned a page outside its configured bounds.");
    }
    if (page.records.length > 0 && page.cursor >= page.totalRecords) {
        throw new Error("Usage store returned records beyond its total.");
    }
    const ids = new Set<string>();
    for (const record of page.records) {
        assertUsageRecord(record);
        if (record.agentId !== agentId || ids.has(record.id)) {
            throw new Error("Usage store returned invalid or duplicate page records.");
        }
        ids.add(record.id);
    }
    if (page.nextCursor !== undefined) {
        if (
            page.records.length === 0 ||
            page.nextCursor !== page.cursor + page.records.length ||
            page.nextCursor > page.totalRecords
        ) {
            throw new Error("Usage store returned a non-progressing or skipping record cursor.");
        }
    } else if (page.cursor + page.records.length < page.totalRecords) {
        throw new Error("Usage store omitted a record continuation cursor.");
    }
}

function assertUsageSummary(
    summary: UsageSummary,
    expectedAgentId: string | undefined,
    cursor: number,
    maxGroups: number,
): void {
    if (!Value.Check(usageSummarySchema, summary)) {
        throw new Error("Usage store returned an invalid summary.");
    }
    if (
        summary.agentId !== expectedAgentId ||
        summary.cursor !== cursor ||
        summary.groups.length > maxGroups ||
        summary.totalGroups < summary.groups.length ||
        summary.cursor > summary.totalGroups ||
        (summary.groups.length > 0 && summary.cursor >= summary.totalGroups)
    ) {
        throw new Error("Usage store returned a summary for the wrong scope or page.");
    }
    if (summary.totalTokens !== summary.inputTokens + summary.outputTokens) {
        throw new Error("Usage summary token totals are inconsistent.");
    }
    if (summary.totalDurationMs !== summary.inferenceDurationMs + summary.turnDurationMs) {
        throw new Error("Usage summary duration totals are inconsistent.");
    }
    const keys = new Set<string>();
    for (const group of summary.groups) {
        const key = groupKey(group);
        if (keys.has(key)) {
            throw new Error("Usage store returned duplicate aggregate groups.");
        }
        keys.add(key);
        if (group.totalTokens !== group.inputTokens + group.outputTokens) {
            throw new Error("Usage aggregate token totals are inconsistent.");
        }
        if (group.totalDurationMs !== group.inferenceDurationMs + group.turnDurationMs) {
            throw new Error("Usage aggregate duration totals are inconsistent.");
        }
    }
    if (summary.nextCursor !== undefined) {
        if (
            summary.groups.length === 0 ||
            summary.nextCursor !== summary.cursor + summary.groups.length ||
            summary.nextCursor > summary.totalGroups
        ) {
            throw new Error("Usage store returned a non-progressing or skipping aggregate cursor.");
        }
    } else if (summary.cursor + summary.groups.length < summary.totalGroups) {
        throw new Error("Usage store omitted an aggregate continuation cursor.");
    }
}

function groupKey(group: UsageSummary["groups"][number]): string {
    return JSON.stringify([group.provider, group.model, group.effort, group.tier]);
}

function formatGroup(
    group: UsageSummary["groups"][number],
    cursor: number,
    maxCharacters: number,
): string {
    const attribution = groupIdentity(group);
    const complete = `- group ${cursor} ${attribution}: ${group.totalTokens} tokens, ${group.totalDurationMs} ms`;
    if (complete.length <= maxCharacters) return complete;
    const compact = `- group ${cursor} id=${opaqueGroupId(group)}: ${group.totalTokens} tokens`;
    if (compact.length <= maxCharacters) return compact;
    return `- group ${cursor} id=${opaqueGroupId(group)}`;
}

function formatCompactGroup(
    group: UsageSummary["groups"][number],
    cursor: number,
    maxCharacters = 96,
): string {
    const attribution = groupIdentity(group);
    const line = `- group ${cursor} ${attribution}`;
    if (line.length <= maxCharacters) return line;
    return `- group ${cursor} id=${opaqueGroupId(group)}`;
}

function groupIdentity(group: UsageSummary["groups"][number]): string {
    return [
        group.provider,
        ...(group.model === undefined ? [] : [group.model]),
        ...(group.effort === undefined ? [] : [`effort=${group.effort}`]),
        ...(group.tier === undefined ? [] : [`tier=${group.tier}`]),
    ].join("/");
}

function opaqueGroupId(group: UsageSummary["groups"][number]): string {
    const identity = JSON.stringify([
        group.provider,
        group.model ?? null,
        group.effort ?? null,
        group.tier ?? null,
    ]);
    let hash = 0xcbf29ce484222325n;
    for (let index = 0; index < identity.length; index++) {
        hash ^= BigInt(identity.charCodeAt(index));
        hash = BigInt.asUintN(64, hash * 0x100000001b3n);
    }
    return `g-${hash.toString(16).padStart(16, "0")}`;
}

function truncate(value: string, maxCharacters: number): string {
    if (value.length <= maxCharacters) return value;
    if (maxCharacters <= 1) return value.slice(0, maxCharacters);
    return `${value.slice(0, maxCharacters - 1)}…`;
}

function cloneAndFreezeEvent(event: UsageEvent): UsageEvent {
    if (!Value.Check(usageEventSchema, event)) {
        throw new Error("Usage module created an invalid event.");
    }
    const cloned = cloneValue(event);
    if (!Value.Check(usageEventSchema, cloned)) {
        throw new Error("Usage module created an invalid detached event.");
    }
    return deepFreeze(cloned);
}

function cloneValue<T>(value: T): T {
    return structuredClone(value);
}

function deepFreeze<T>(value: T): T {
    if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
        return value;
    }
    for (const child of Object.values(value as Record<string, unknown>)) {
        deepFreeze(child);
    }
    return Object.freeze(value);
}

async function resolvePromise<T>(value: unknown, schema: TSchema, operation: string): Promise<T> {
    if (!Value.Check(Type.Promise(Type.Void()), value)) {
        throw new Error(`${operation} must return a Promise.`);
    }
    const resolved = await (value as Promise<unknown>);
    if (!Value.Check(schema, resolved)) {
        throw new Error(`${operation} returned an invalid result.`);
    }
    return resolved as T;
}

async function invokeVoid(value: unknown, operation: string): Promise<void> {
    if (!Value.Check(usageVoidOrPromiseVoidSchema, value)) {
        throw new Error(`${operation} must return void or Promise<void>.`);
    }
    if (value === undefined) return;
    const resolved = await resolvePromise(value, Type.Void(), operation);
    if (resolved !== undefined) {
        throw new Error(`${operation} Promise must resolve to undefined.`);
    }
}
