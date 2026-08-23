import type {
    AgentBaseAcceptedMessage,
    AgentBaseInference,
    AgentBasePersistedEvent,
    AgentBaseSettlement,
    AgentBaseToolOutcome,
    AgentBaseTurn,
    AgentModule,
    AgentModuleHooks,
    AgentModuleScope,
    AnyAgentTool,
} from "@slopus/happy-agent-base";
import type {
    SessionOutputBlock,
    SessionToolCallBlock,
    SessionToolResultMessage,
} from "@slopus/happy-providers";
import { sql, type SQL } from "drizzle-orm";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { afterCommit, withLogContext, type Context } from "@steve.kite/stdlib";
import {
    agentDatabaseRows,
    agentDatabaseRun,
    type AgentDatabase,
    type AgentDatabaseFacade,
    type AgentModuleMigration,
} from "@slopus/happy-agent-base";

import { isUserOriginMetadata, senderAgentIdOf } from "../impl/messageOrigin.js";
import type { EventsModule } from "../events/index.js";
import {
    toolPermissionReviewSchema,
    type ToolPermissionReview,
} from "../permissions/ToolPermissionReview.js";
import {
    historyBlockSchema,
    historyClientMetadataSchema,
    historyMessageSchema,
    historyMessageInputSchema,
    historyMessageModeSchema,
    historyMutationIdSchema,
    historyMessageWithinPersistenceBounds,
    historyAgentIdSchema,
    historyRecordIdSchema,
    historyRemoteMessageIdSchema,
    historyTimestampSchema,
    MAX_HISTORY_BLOCKS_PER_PAGE,
    MAX_HISTORY_MESSAGES_PER_APPEND,
    MAX_HISTORY_MESSAGE_JSON_BYTES,
    MAX_HISTORY_PAGE_SIZE,
    MAX_HISTORY_PENDING_BLOCKS,
    MAX_HISTORY_POSITION,
    MAX_HISTORY_RECORDED_TOOL_OUTPUT_LENGTH,
    MAX_HISTORY_TOTAL_MESSAGES,
    historyToolArgumentsSchema,
    historyToolCallBlockSchema,
    historyToolResultBlockSchema,
    historyToolPresentationSchema,
    historyToolArgumentsWithinByteLimit,
    MAX_HISTORY_TOOL_OUTPUT_LENGTH,
    type HistoryBlock,
    type HistoryClientMetadata,
    type HistoryMessage,
    type HistoryMessageInput,
    type HistoryMessageMode,
    type HistoryToolPresentation,
} from "./HistoryMessage.js";
import {
    historyPageSchema,
    historyQuerySchema,
    type HistoryPage,
    type HistoryQuery,
} from "./HistoryPage.js";
import {
    historyAgentSummariesSchema,
    historyAgentTargetSchema,
    type HistoryAgentSummaries,
} from "./HistoryAgent.js";
import {
    historyRecordSchema,
    historyStoreQuerySchema,
    type HistoryRecord,
    type HistoryStoreQuery,
} from "./HistoryStore.js";
import {
    historyPendingMessageSchema,
    historyRunReasonSchema,
    historyRunSchema,
    historyRunStateSchema,
    historyRunStatusSchema,
    historyRunsPageSchema,
    historyRunsQuerySchema,
    MAX_HISTORY_MESSAGES_PER_RUN,
    MAX_HISTORY_PENDING_MESSAGES,
    MAX_HISTORY_RUNS_PER_PAGE,
    type HistoryPendingMessage,
    type HistoryRun,
    type HistoryRunState,
    type HistoryRunsPage,
    type HistoryRunsQuery,
} from "./HistoryRun.js";
import { createHistoryExcerpt, type HistoryExcerpt } from "./impl/createHistoryExcerpt.js";
import {
    historyMessageSearchParts,
    foldHistorySearchText,
} from "./impl/messageMatchesHistoryFilters.js";
import {
    historyStatsSchema,
    summarizeHistory,
    type HistoryStats,
} from "./impl/summarizeHistory.js";
import { readAgentHistoryTool } from "./tools/read_agent_history.js";

type HistoryToolArguments = Static<typeof historyToolArgumentsSchema>;

const PENDING_BLOCKS_KEY = "pending_blocks";
const PENDING_INFERENCE_ID_KEY = "pending_inference_id";
const TOOL_NAME_KEY = "tool_name";
const TOOL_PRESENTATION_KEY = "tool_presentation";
const toolOutcomePresentationSchema = Type.Object(
    { presentation: historyToolPresentationSchema },
    { additionalProperties: true },
);
const pendingBlocksSchema = Type.Array(historyBlockSchema, { maxItems: 2_048 });
const happyMessageMetadataSchema = Type.Object(
    { remoteMessageId: historyRemoteMessageIdSchema },
    { additionalProperties: true },
);
type HappyMessageMetadata = Static<typeof happyMessageMetadataSchema>;
const DEFAULT_READER_LIMIT = 200;
const positiveIntegerSchema = Type.Integer({ minimum: 1 });
/** How many records one end of a two-ended excerpt may contribute. */
const EXCERPT_END_PAGE_SIZE = 100;
/** The most characters one excerpt may be asked to render into. */
export const MAX_HISTORY_EXCERPT_CHARACTERS = 200_000;
const excerptBudgetSchema = Type.Integer({
    minimum: 1,
    maximum: MAX_HISTORY_EXCERPT_CHARACTERS,
});
const HISTORY_TABLE = "happy_agent_module_history";
const HISTORY_RUNS_TABLE = "happy_agent_module_history_runs";
const HISTORY_PENDING_TABLE = "happy_agent_module_history_pending";
const HISTORY_TOOL_CALLS_TABLE = "happy_agent_module_history_tool_calls";

/**
 * What a subscriber is handed once an append has committed.
 *
 * It runs after the outermost commit, so the archive it describes is already durable and nothing
 * the subscriber does can undo it. Each subscriber receives its own copy of the messages.
 */
export type HistoryAppendListener = (
    ctx: Context,
    agentId: string,
    messages: readonly HistoryMessage[],
) => void | Promise<void>;

/**
 * The agent's own record of what happened, which it can read back.
 *
 * This is not the model's context. The context is what the provider is replaying right now, and
 * it is compacted, reset, and thrown away as the conversation moves; the history is what was
 * said and done, kept whether or not any model can still see it. The two are deliberately
 * separate: a conversation reset by an incompatible model switch loses its context entirely and
 * loses none of its history.
 *
 * The module writes as the agent works — every accepted user message, every completed assistant
 * response, every tool result, and every failed inference — from inside the transactions that
 * commit that work, so the record and the thing recorded become durable together. Completed
 * assistant blocks are kept in the run-scoped Agent KV rather than an in-memory map, so rollback
 * and restart do not leave the module with a second, contradictory notion of a run.
 *
 * Reading is the `read_agent_history` tool for the model, and `read` for everyone else, both
 * over the same paging, searching, and bounding.
 */
export class HistoryModule implements AgentModule {
    readonly name = "history";
    readonly #events: EventsModule | undefined;

    /** Who is watching the archive: the live subscriptions this module supervises. */
    readonly #appendListeners = new Set<HistoryAppendListener>();

    constructor(events?: EventsModule) {
        this.#events = events;
    }

    readonly migrations: readonly AgentModuleMigration[] = [
        [
            "001-history-records",
            async (_ctx, database) => {
                await agentDatabaseRun(
                    database,
                    sql.raw(`
                        CREATE TABLE IF NOT EXISTS ${HISTORY_TABLE} (
                            agent_id TEXT NOT NULL,
                            position BIGINT NOT NULL,
                            record_id TEXT NOT NULL,
                            role TEXT NOT NULL,
                            message_json TEXT NOT NULL,
                            search_text TEXT NOT NULL,
                            assistant_messages BIGINT NOT NULL,
                            user_messages BIGINT NOT NULL,
                            text_characters BIGINT NOT NULL,
                            thinking_blocks BIGINT NOT NULL,
                            tool_calls BIGINT NOT NULL,
                            tool_results BIGINT NOT NULL,
                            PRIMARY KEY (agent_id, position),
                            UNIQUE (agent_id, record_id)
                        )
                    `),
                );
            },
        ],
        [
            "002-history-runs-and-pending",
            async (_ctx, database) => {
                await agentDatabaseRun(
                    database,
                    sql.raw(`ALTER TABLE ${HISTORY_TABLE} ADD COLUMN run_id TEXT`),
                );
                await agentDatabaseRun(
                    database,
                    sql.raw(`
                        CREATE INDEX IF NOT EXISTS happy_agent_module_history_run_position
                        ON ${HISTORY_TABLE} (agent_id, run_id, position)
                    `),
                );
                await agentDatabaseRun(
                    database,
                    sql.raw(`
                        CREATE TABLE IF NOT EXISTS ${HISTORY_RUNS_TABLE} (
                            agent_id TEXT NOT NULL,
                            sequence BIGINT NOT NULL,
                            run_id TEXT NOT NULL,
                            status TEXT NOT NULL,
                            reason TEXT,
                            started_at BIGINT NOT NULL,
                            ended_at BIGINT,
                            PRIMARY KEY (agent_id, sequence),
                            UNIQUE (agent_id, run_id)
                        )
                    `),
                );
                await agentDatabaseRun(
                    database,
                    sql.raw(`
                        CREATE TABLE IF NOT EXISTS ${HISTORY_PENDING_TABLE} (
                            agent_id TEXT NOT NULL,
                            position BIGINT NOT NULL,
                            message_id TEXT NOT NULL,
                            message_json TEXT NOT NULL,
                            PRIMARY KEY (agent_id, position),
                            UNIQUE (agent_id, message_id)
                        )
                    `),
                );
            },
        ],
        [
            "003-history-tool-call-index",
            async (_ctx, database) => {
                await agentDatabaseRun(
                    database,
                    sql.raw(`
                        CREATE TABLE IF NOT EXISTS ${HISTORY_TOOL_CALLS_TABLE} (
                            agent_id TEXT NOT NULL,
                            call_id TEXT NOT NULL,
                            record_id TEXT NOT NULL,
                            PRIMARY KEY (agent_id, call_id)
                        )
                    `),
                );
                await agentDatabaseRun(
                    database,
                    sql.raw(`
                        INSERT INTO ${HISTORY_TOOL_CALLS_TABLE} (agent_id, call_id, record_id)
                        SELECT history.agent_id,
                               json_extract(block.value, '$.callId'),
                               history.record_id
                        FROM ${HISTORY_TABLE} AS history,
                             json_each(history.message_json, '$.blocks') AS block
                        WHERE json_extract(block.value, '$.type') = 'tool_call'
                    `),
                );
            },
        ],
    ];

    /**
     * Watch every append this module commits, and stop watching by calling what is returned.
     *
     * A subscriber is called once the outermost transaction has committed, so what it is told
     * about is already durable. A subscriber that fails is reported through the context log and
     * never turns a committed archive into a failure.
     */
    onAppend(listener: HistoryAppendListener): () => void {
        this.#appendListeners.add(listener);
        return () => {
            this.#appendListeners.delete(listener);
        };
    }

    /** Add a message to an agent's history. This is how a caller records what it sent. */
    async record(ctx: Context, agentId: string, message: HistoryMessageInput): Promise<void> {
        if (
            !Value.Check(historyAgentIdSchema, agentId) ||
            !Value.Check(historyMessageInputSchema, message)
        ) {
            throw new Error("The history module received an invalid message.");
        }
        const activeRunId = this.#events?.activeRunId(agentId);
        const normalized = {
            ...message,
            at: message.at ?? Date.now(),
            recordId: message.recordId ?? createRecordId(),
            ...(message.runId !== undefined
                ? {}
                : activeRunId === undefined
                  ? {}
                  : { runId: activeRunId }),
        };
        if (!Value.Check(historyMessageSchema, normalized)) {
            throw new Error("The history module produced an invalid message.");
        }
        await this.#direct(ctx, (txCtx) => this.#append(txCtx, agentId, normalized));
    }

    /** Replace one durable message under its stable identity. */
    async replace(ctx: Context, agentId: string, message: HistoryMessage): Promise<void> {
        if (
            !Value.Check(historyAgentIdSchema, agentId) ||
            !historyMessageWithinPersistenceBounds(message)
        ) {
            throw new Error("The history module received an invalid message replacement.");
        }
        await this.#direct(ctx, async (txCtx) => {
            const rows = await agentDatabaseRows<HistoryRow>(
                txCtx.db,
                sql`SELECT ${sql.raw(HISTORY_ROW_COLUMNS)}
                    FROM ${sql.raw(HISTORY_TABLE)}
                    WHERE agent_id = ${agentId} AND record_id = ${message.recordId}
                    LIMIT 1`,
            );
            const row = rows[0];
            if (row === undefined) {
                throw new Error("The history message to replace does not exist.");
            }
            const existing = toHistoryRecord(row).message;
            if (existing.role !== message.role || existing.runId !== message.runId) {
                throw new Error("A history replacement cannot change message ownership.");
            }
            const encoded = JSON.stringify(message);
            const stats = summarizeHistory([message]);
            const searchText = foldHistorySearchText(historyMessageSearchParts(message).join("\n"));
            await agentDatabaseRun(
                txCtx.db,
                sql`UPDATE ${sql.raw(HISTORY_TABLE)}
                    SET message_json = ${encoded},
                        search_text = ${searchText},
                        assistant_messages = ${stats.assistantMessages},
                        user_messages = ${stats.userMessages},
                        text_characters = ${stats.textCharacters},
                        thinking_blocks = ${stats.thinkingBlocks},
                        tool_calls = ${stats.toolCalls},
                        tool_results = ${stats.toolResults}
                    WHERE agent_id = ${agentId} AND record_id = ${message.recordId}`,
            );
            await indexHistoryToolCalls(txCtx.db, agentId, message);
        });
    }

    /** Open the standalone run that owns an explicit compaction message. */
    async beginMaintenanceRun(
        ctx: Context,
        agentId: string,
        runId: string,
        startedAt: number,
    ): Promise<void> {
        if (
            !Value.Check(historyAgentIdSchema, agentId) ||
            !Value.Check(historyRecordIdSchema, runId) ||
            !Value.Check(historyTimestampSchema, startedAt)
        ) {
            throw new Error("The history module received an invalid maintenance run.");
        }
        await this.#direct(
            ctx,
            async (txCtx) => await this.#beginRun(txCtx, agentId, runId, "send", startedAt),
        );
    }

    /** Settle one standalone maintenance run by its stable identity. */
    async finishMaintenanceRun(
        ctx: Context,
        agentId: string,
        runId: string,
        status: "completed" | "aborted" | "failed",
        endedAt: number,
    ): Promise<void> {
        if (
            !Value.Check(historyAgentIdSchema, agentId) ||
            !Value.Check(historyRecordIdSchema, runId) ||
            !Value.Check(historyTimestampSchema, endedAt)
        ) {
            throw new Error("The history module received an invalid maintenance settlement.");
        }
        const reason =
            status === "completed" ? "completed" : status === "aborted" ? "abort" : "error";
        await this.#direct(ctx, async (txCtx) => {
            await agentDatabaseRun(
                txCtx.db,
                sql`UPDATE ${sql.raw(HISTORY_RUNS_TABLE)}
                    SET status = ${status}, reason = ${reason}, ended_at = ${endedAt}
                    WHERE agent_id = ${agentId} AND run_id = ${runId} AND status = 'running'`,
            );
        });
    }

    /**
     * Persist a user message before offering it to Agent Base.
     *
     * Callers that need the pending row and Base's queue admission to be one commit run this and
     * `AgentSystemRef.send` or `steer` inside the same outer `ctx.inTx` operation. Reusing an ID is
     * a conflict: the ID is not an idempotency key.
     */
    async queuePending(ctx: Context, message: HistoryPendingMessage): Promise<void> {
        if (!Value.Check(historyPendingMessageSchema, message)) {
            throw new Error("The history module received an invalid pending message.");
        }
        await this.#direct(ctx, async (txCtx) => {
            const countRows = await agentDatabaseRows<{ count: number | string }>(
                txCtx.db,
                sql`SELECT COUNT(*) AS count
                    FROM ${sql.raw(HISTORY_PENDING_TABLE)}
                    WHERE agent_id = ${message.agentId}`,
            );
            const count = toSafeInteger(countRows[0]?.count, "pending message count");
            if (count >= MAX_HISTORY_PENDING_MESSAGES) {
                throw new Error("The history module reached its pending message limit.");
            }
            const positionRows = await agentDatabaseRows<{ position: number | string }>(
                txCtx.db,
                sql`SELECT COALESCE(MAX(position), -1) + 1 AS position
                    FROM ${sql.raw(HISTORY_PENDING_TABLE)}
                    WHERE agent_id = ${message.agentId}`,
            );
            const position = toSafeInteger(positionRows[0]?.position, "pending message position");
            const encoded = JSON.stringify(message);
            if (new TextEncoder().encode(encoded).byteLength > MAX_HISTORY_MESSAGE_JSON_BYTES) {
                throw new Error("The pending history message exceeds its durable size limit.");
            }
            await agentDatabaseRun(
                txCtx.db,
                sql`INSERT INTO ${sql.raw(HISTORY_PENDING_TABLE)} (
                        agent_id, position, message_id, message_json
                    ) VALUES (
                        ${message.agentId}, ${position}, ${message.id}, ${encoded}
                    )`,
            );
        });
    }

    /** Remove a message whose Base queue admission failed or was otherwise rolled back. */
    async removePending(ctx: Context, agentId: string, messageId: string): Promise<boolean> {
        if (
            !Value.Check(historyAgentIdSchema, agentId) ||
            !Value.Check(historyRecordIdSchema, messageId)
        ) {
            throw new Error("The history module received an invalid pending message identity.");
        }
        return await this.#direct(ctx, async (txCtx) => {
            const existing = await readPendingMessage(txCtx.db, agentId, messageId);
            if (existing === undefined) return false;
            await agentDatabaseRun(
                txCtx.db,
                sql`DELETE FROM ${sql.raw(HISTORY_PENDING_TABLE)}
                    WHERE agent_id = ${agentId} AND message_id = ${messageId}`,
            );
            return true;
        });
    }

    /** The complete durable composer queue, oldest first. */
    async pending(ctx: Context, agentId: string): Promise<HistoryPendingMessage[]> {
        if (!Value.Check(historyAgentIdSchema, agentId)) {
            throw new Error("The history module received an invalid pending-message agent ID.");
        }
        return await this.#direct(ctx, async (txCtx) => {
            const rows = await agentDatabaseRows<HistoryPendingRow>(
                txCtx.db,
                sql`SELECT position, message_id, message_json
                    FROM ${sql.raw(HISTORY_PENDING_TABLE)}
                    WHERE agent_id = ${agentId}
                    ORDER BY position ASC
                    LIMIT ${MAX_HISTORY_PENDING_MESSAGES + 1}`,
            );
            if (rows.length > MAX_HISTORY_PENDING_MESSAGES) {
                throw new Error("The history module found too many pending messages.");
            }
            return rows.map((row) => parsePendingRow(row, agentId));
        });
    }

    /** One accepted durable message by its stable identity, including inside its commit. */
    async message(
        ctx: Context,
        agentId: string,
        messageId: string,
    ): Promise<HistoryMessage | undefined> {
        if (
            !Value.Check(historyAgentIdSchema, agentId) ||
            !Value.Check(historyRecordIdSchema, messageId)
        ) {
            throw new Error("The history module received an invalid message lookup.");
        }
        return await this.#direct(ctx, async (txCtx) => {
            const rows = await agentDatabaseRows<HistoryRow>(
                txCtx.db,
                sql`SELECT ${sql.raw(HISTORY_ROW_COLUMNS)}
                    FROM ${sql.raw(HISTORY_TABLE)}
                    WHERE agent_id = ${agentId} AND record_id = ${messageId}
                    LIMIT 1`,
            );
            return rows[0] === undefined ? undefined : toHistoryRecord(rows[0]).message;
        });
    }

    /** The most recent durable assistant message for one run, when that run has produced one. */
    async assistantMessage(
        ctx: Context,
        agentId: string,
        runId: string,
    ): Promise<HistoryMessage | undefined> {
        if (
            !Value.Check(historyAgentIdSchema, agentId) ||
            !Value.Check(historyRecordIdSchema, runId)
        ) {
            throw new Error("The history module received an invalid run-message lookup.");
        }
        return await this.#direct(ctx, async (txCtx) => {
            const rows = await agentDatabaseRows<HistoryRow>(
                txCtx.db,
                sql`SELECT ${sql.raw(HISTORY_ROW_COLUMNS)}
                    FROM ${sql.raw(HISTORY_TABLE)}
                    WHERE agent_id = ${agentId} AND run_id = ${runId} AND role = 'assistant'
                    ORDER BY position DESC
                    LIMIT 1`,
            );
            return rows[0] === undefined ? undefined : toHistoryRecord(rows[0]).message;
        });
    }

    /**
     * Attach one automatic-review result to the durable tool call clients render.
     *
     * Review happens after inference has committed the call, so this is a separate atomic update
     * under the call's stable index. Repeating the same result is harmless; contradicting a result
     * already recorded is rejected rather than silently rewriting the audit fact.
     */
    async recordToolPermissionReview(
        ctx: Context,
        agentId: string,
        callId: string,
        elevated: boolean,
        review: ToolPermissionReview,
    ): Promise<HistoryMessage | undefined> {
        if (
            !Value.Check(historyAgentIdSchema, agentId) ||
            !Value.Check(historyRecordIdSchema, callId) ||
            !Value.Check(toolPermissionReviewSchema, review)
        ) {
            throw new Error("The history module received an invalid tool review.");
        }
        return await this.#direct(ctx, async (txCtx) => {
            const rows = await agentDatabaseRows<HistoryRow>(
                txCtx.db,
                sql`SELECT ${sql.raw(HISTORY_ROW_COLUMNS)}
                    FROM ${sql.raw(HISTORY_TABLE)}
                    WHERE agent_id = ${agentId}
                      AND record_id = (
                          SELECT record_id
                          FROM ${sql.raw(HISTORY_TOOL_CALLS_TABLE)}
                          WHERE agent_id = ${agentId} AND call_id = ${callId}
                          LIMIT 1
                      )
                    LIMIT 1`,
            );
            const row = rows[0];
            if (row === undefined) return undefined;
            const existing = toHistoryRecord(row).message;
            let found = false;
            const blocks = existing.blocks.map((block): HistoryBlock => {
                if (block.type !== "tool_call" || block.callId !== callId) return block;
                found = true;
                if (block.review !== undefined || block.elevated !== undefined) {
                    if (
                        block.elevated !== elevated ||
                        JSON.stringify(block.review) !== JSON.stringify(review)
                    ) {
                        throw new Error("The tool call already has another permission review.");
                    }
                    return block;
                }
                return { ...block, elevated, review };
            });
            if (!found) {
                throw new Error("The tool-call index points to a message without that call.");
            }
            const updated: HistoryMessage = { ...existing, blocks };
            if (!historyMessageWithinPersistenceBounds(updated)) {
                throw new Error("The reviewed history message exceeds its durable bounds.");
            }
            await agentDatabaseRun(
                txCtx.db,
                sql`UPDATE ${sql.raw(HISTORY_TABLE)}
                    SET message_json = ${JSON.stringify(updated)}
                    WHERE agent_id = ${agentId} AND record_id = ${updated.recordId}`,
            );
            return updated;
        });
    }

    /**
     * Read accepted history in whole-run pages and always include the complete pending queue.
     *
     * `limit` is a message lower bound: once it is reached no new run is begun, while the run
     * already selected is returned whole. `after` is the sole exception to whole-run loading and
     * extends only a still-running newest run from the named message.
     */
    async runs(
        ctx: Context,
        agentId: string,
        query: HistoryRunsQuery = {},
    ): Promise<HistoryRunsPage> {
        if (
            !Value.Check(historyAgentIdSchema, agentId) ||
            !Value.Check(historyRunsQuerySchema, query) ||
            (query.before !== undefined && query.after !== undefined)
        ) {
            throw new Error("The history run reader received an invalid query.");
        }
        return await this.#direct(ctx, async (txCtx) => {
            const limit = query.limit ?? 50;
            const anchor = await resolveRunAnchor(txCtx.db, agentId, query);
            const candidates = await candidateRuns(txCtx.db, agentId, anchor);
            const selected: { row: HistoryRunRow; afterPosition?: number }[] = [];
            let selectedMessages = 0;
            let hasMore = candidates.length > MAX_HISTORY_RUNS_PER_PAGE;
            const boundedCandidates = candidates.slice(0, MAX_HISTORY_RUNS_PER_PAGE);
            for (let index = 0; index < boundedCandidates.length; index += 1) {
                const row = boundedCandidates[index] as HistoryRunRow;
                const afterPosition =
                    anchor.kind === "after" &&
                    anchor.includeAnchorRun &&
                    row.run_id === anchor.runId
                        ? anchor.position
                        : undefined;
                const count = await countHistoryRows(
                    txCtx.db,
                    afterPosition === undefined
                        ? sql`agent_id = ${agentId} AND run_id = ${row.run_id}`
                        : sql`agent_id = ${agentId}
                            AND run_id = ${row.run_id}
                            AND position > ${afterPosition}`,
                );
                if (count === 0) continue;
                selected.push({
                    row,
                    ...(afterPosition === undefined ? {} : { afterPosition }),
                });
                selectedMessages += count;
                if (selectedMessages >= limit) {
                    hasMore = hasMore || index < boundedCandidates.length - 1;
                    break;
                }
            }
            const chronological = anchor.kind === "after" ? selected : [...selected].reverse();
            const runs: HistoryRun[] = [];
            for (const selectedRun of chronological) {
                const records = await readRunMessages(
                    txCtx.db,
                    agentId,
                    selectedRun.row.run_id,
                    selectedRun.afterPosition,
                );
                const messages = records.map((record) => record.message);
                runs.push(
                    runFromRow(
                        selectedRun.row,
                        query.omitToolData === true ? omitPresentedToolData(messages) : messages,
                    ),
                );
            }
            const pending = await readPendingMessages(txCtx.db, agentId);
            const page: HistoryRunsPage = {
                agentId,
                runs,
                pending,
                hasMore,
            };
            if (!Value.Check(historyRunsPageSchema, page)) {
                throw new Error("The history module produced an invalid run page.");
            }
            return page;
        });
    }

    /** Read one exact run's lifecycle state, including a run that has no messages. */
    async run(ctx: Context, agentId: string, runId: string): Promise<HistoryRunState | undefined> {
        if (
            !Value.Check(historyAgentIdSchema, agentId) ||
            !Value.Check(historyRecordIdSchema, runId)
        ) {
            throw new Error("The history module received an invalid run lookup.");
        }
        return await this.#direct(ctx, async (txCtx) => {
            const rows = await agentDatabaseRows<HistoryRunRow>(
                txCtx.db,
                sql`SELECT agent_id, sequence, run_id, status, reason, started_at, ended_at
                    FROM ${sql.raw(HISTORY_RUNS_TABLE)}
                    WHERE agent_id = ${agentId} AND run_id = ${runId}
                    LIMIT 1`,
            );
            return rows[0] === undefined ? undefined : runStateFromRow(rows[0]);
        });
    }

    /** Read the one run an agent is durably working on, including standalone maintenance. */
    async runningRun(ctx: Context, agentId: string): Promise<HistoryRunState | undefined> {
        if (!Value.Check(historyAgentIdSchema, agentId)) {
            throw new Error("The history module received an invalid running-run lookup.");
        }
        return await this.#direct(ctx, async (txCtx) => {
            const rows = await agentDatabaseRows<HistoryRunRow>(
                txCtx.db,
                sql`SELECT agent_id, sequence, run_id, status, reason, started_at, ended_at
                    FROM ${sql.raw(HISTORY_RUNS_TABLE)}
                    WHERE agent_id = ${agentId} AND status = 'running'
                    ORDER BY sequence DESC
                    LIMIT 2`,
            );
            if (rows.length > 1) {
                throw new Error("The history module found multiple running runs for one agent.");
            }
            return rows[0] === undefined ? undefined : runStateFromRow(rows[0]);
        });
    }

    /** Read the run immediately preceding one exact run in the agent's durable sequence. */
    async previousRun(
        ctx: Context,
        agentId: string,
        runId: string,
    ): Promise<HistoryRunState | undefined> {
        if (
            !Value.Check(historyAgentIdSchema, agentId) ||
            !Value.Check(historyRecordIdSchema, runId)
        ) {
            throw new Error("The history module received an invalid previous-run lookup.");
        }
        return await this.#direct(ctx, async (txCtx) => {
            const rows = await agentDatabaseRows<HistoryRunRow>(
                txCtx.db,
                sql`SELECT agent_id, sequence, run_id, status, reason, started_at, ended_at
                    FROM ${sql.raw(HISTORY_RUNS_TABLE)}
                    WHERE agent_id = ${agentId}
                      AND sequence < (
                          SELECT sequence
                          FROM ${sql.raw(HISTORY_RUNS_TABLE)}
                          WHERE agent_id = ${agentId} AND run_id = ${runId}
                          LIMIT 1
                      )
                    ORDER BY sequence DESC
                    LIMIT 1`,
            );
            return rows[0] === undefined ? undefined : runStateFromRow(rows[0]);
        });
    }

    /** Everything an agent's history holds, oldest first. */
    async messages(
        ctx: Context,
        agentId: string,
        query: Pick<HistoryQuery, "from" | "limit">,
    ): Promise<HistoryRecord[]> {
        const input = {
            ...(query.from === undefined ? {} : { from: query.from }),
            ...(query.limit === undefined ? {} : { limit: query.limit }),
        };
        if (!Value.Check(historyQuerySchema, input)) {
            throw new Error("The history reader received an invalid page query.");
        }
        const page = await this.#direct(ctx, (txCtx) =>
            this.#readPage(txCtx, agentId, {
                limit: boundedLimit(query.limit ?? DEFAULT_READER_LIMIT),
                ...(query.from === undefined ? {} : { from: query.from }),
            }),
        );
        return [...page.messages];
    }

    /**
     * Return exact archive statistics through the store's bounded page operation.
     *
     * The module deliberately does not derive this from the records returned by a page: callers
     * such as model handoff may only retain a two-ended sample while still needing the archive's
     * full totals.
     */
    async stats(ctx: Context, agentId: string): Promise<HistoryStats> {
        const page = await this.#direct(ctx, (txCtx) =>
            this.#readPage(txCtx, agentId, {
                from: "start",
                limit: 1,
            }),
        );
        return page.totalStats;
    }

    /**
     * One page of an agent's history, filtered and paged the same way for every reader. The
     * page carries the messages themselves; rendering them within a size is `formatHistoryPage`.
     */
    async read(ctx: Context, agentId: string, query: HistoryQuery = {}): Promise<HistoryPage> {
        if (!Value.Check(historyQuerySchema, query)) {
            throw new Error("The history reader received an invalid page query.");
        }
        return await this.#direct(ctx, (txCtx) =>
            this.#readPage(txCtx, agentId, toStoreQuery(query)),
        );
    }

    /**
     * The agents a reader may be told about: itself, and the agent it is reading.
     *
     * Every agent may read every agent's history, so this describes the two the request actually
     * concerns, each with the size of its own archive. An agent that has never recorded anything
     * is still described, with a count of zero, rather than left out of the answer.
     */
    async listAgents(
        ctx: Context,
        requesterAgentId: string,
        targetAgentId = requesterAgentId,
    ): Promise<HistoryAgentSummaries> {
        if (
            !Value.Check(historyAgentIdSchema, requesterAgentId) ||
            !Value.Check(historyAgentIdSchema, targetAgentId)
        ) {
            throw new Error("The history roster identity is invalid.");
        }
        return await this.#direct(ctx, async (txCtx) => {
            const summaries: HistoryAgentSummaries = [];
            for (const agentId of new Set([requesterAgentId, targetAgentId])) {
                const stats = await readHistoryStats(txCtx.db, sql`agent_id = ${agentId}`);
                summaries.push({
                    agentId,
                    messageCount: stats.messages,
                    path: agentId,
                    status: "unknown",
                });
            }
            summaries.sort(
                (left, right) =>
                    left.path.localeCompare(right.path) ||
                    left.agentId.localeCompare(right.agentId),
            );
            if (!Value.Check(historyAgentSummariesSchema, summaries)) {
                throw new Error("The history module produced an invalid agent roster.");
            }
            return summaries;
        });
    }

    /**
     * Resolve a tool target. Any agent may read any agent's history, so a target is simply the
     * Agent ID to read: its own, or another's. A target that exists nowhere is still a valid
     * request and simply has an empty archive — reading grants nothing and reaches nothing
     * outside the collection's own store. Anything that is not a well-formed Agent ID is refused
     * rather than guessed at.
     */
    async resolveTarget(
        _ctx: Context,
        requesterAgentId: string,
        requestedTarget: string,
    ): Promise<string> {
        if (
            !Value.Check(historyAgentIdSchema, requesterAgentId) ||
            !Value.Check(historyAgentTargetSchema, requestedTarget)
        ) {
            throw new Error("The history target identity is invalid.");
        }
        if (requestedTarget === requesterAgentId) return requestedTarget;
        if (!Value.Check(historyAgentIdSchema, requestedTarget)) {
            throw new Error(`Target '${requestedTarget}' is not an Agent ID.`);
        }
        return requestedTarget;
    }

    /**
     * The two ends of an agent's history, rendered within a character budget, with what the whole
     * archive amounts to.
     *
     * Both ends matter and the middle rarely does: the beginning is where the work was asked for,
     * and the end is where it was left. The two bounded reads are merged and deduplicated, so a
     * history short enough to appear in both is quoted once. The counts are the archive's exact
     * totals, and fall back to counting only the sample — saying so — in the degenerate case where
     * the totals cannot account for what was sampled.
     *
     * Returns nothing when the agent has no history at all, which is not an error: an agent that
     * recorded nothing has nothing to excerpt.
     */
    async readExcerpt(
        ctx: Context,
        agentId: string,
        maxCharacters: number,
    ): Promise<HistoryExcerpt | undefined> {
        if (!Value.Check(historyAgentIdSchema, agentId)) {
            throw new Error("The history excerpt received an invalid agent ID.");
        }
        if (!Value.Check(excerptBudgetSchema, maxCharacters)) {
            throw new Error("A history excerpt budget must be a bounded positive integer.");
        }
        return await this.#direct(ctx, async (txCtx) => {
            const beginning = await this.#readPage(txCtx, agentId, {
                from: "start",
                limit: EXCERPT_END_PAGE_SIZE,
            });
            const recent = await this.#readPage(txCtx, agentId, {
                from: "end",
                limit: EXCERPT_END_PAGE_SIZE,
            });
            const records = mergeHistoryRecords(beginning.messages, recent.messages);
            if (records.length === 0) return undefined;
            const sampled = summarizeHistory(records.map((record) => record.message));
            const total = beginning.totalStats;
            return createHistoryExcerpt(
                records,
                maxCharacters,
                statsAtLeast(total, sampled) ? total : undefined,
            );
        });
    }

    async #afterToolCall(
        ctx: Context,
        scope: AgentModuleScope,
        result: SessionToolResultMessage,
    ): Promise<void> {
        const storedName = await scope.runKV.read(ctx, TOOL_NAME_KEY);
        const toolName = typeof storedName === "string" ? storedName : "unknown tool";
        const storedPresentation =
            result.isError === true
                ? undefined
                : await scope.runKV.read(ctx, TOOL_PRESENTATION_KEY);
        if (
            storedPresentation !== undefined &&
            !Value.Check(historyToolPresentationSchema, storedPresentation)
        ) {
            throw new Error("History module received an invalid tool presentation.");
        }
        const presentation = storedPresentation as HistoryToolPresentation | undefined;
        const output = renderOutput(result.content, MAX_HISTORY_RECORDED_TOOL_OUTPUT_LENGTH);
        const toolResultBlock: HistoryBlock = {
            type: "tool_result",
            callId: result.callId,
            display: toolDisplay(toolName, output, result.isError === true),
            output,
            toolName,
            ...(result.isError === true ? { isError: true } : {}),
            ...(presentation === undefined ? {} : { presentation }),
        };
        if (!Value.Check(historyToolResultBlockSchema, toolResultBlock)) {
            throw new Error("History module received an invalid tool result.");
        }
        await this.#appendToolResult(ctx, scope.agent.id, toolResultBlock);
    }

    async #afterInference(
        ctx: Context,
        scope: AgentModuleScope,
        inference: AgentBaseInference,
    ): Promise<void> {
        const blocks = await this.#pendingBlocks(ctx, scope);
        const runId = this.#events?.activeRunId(scope.agent.id);
        const attribution = {
            at: Date.now(),
            ...(runId === undefined ? {} : { runId }),
            ...(scope.agent.model === undefined ? {} : { model: scope.agent.model }),
            provider: scope.agent.provider,
        };
        const messages: HistoryMessage[] = [];
        if (blocks.length > 0) {
            messages.push({
                role: "assistant",
                blocks,
                recordId: inference.inferenceId,
                ...attribution,
            });
        }
        if (inference.errorMessage !== undefined) {
            messages.push({
                role: "error",
                blocks: [{ type: "text", text: inference.errorMessage }],
                recordId: createRecordId(),
                ...attribution,
            });
        }
        if (messages.length === 0) {
            await scope.runKV.delete(ctx, PENDING_BLOCKS_KEY);
            await scope.runKV.delete(ctx, PENDING_INFERENCE_ID_KEY);
            return;
        }
        await this.#append(ctx, scope.agent.id, ...messages);
        await scope.runKV.delete(ctx, PENDING_BLOCKS_KEY);
        await scope.runKV.delete(ctx, PENDING_INFERENCE_ID_KEY);
    }

    async #appendPendingBlock(
        ctx: Context,
        scope: AgentModuleScope,
        block: HistoryBlock,
    ): Promise<void> {
        const pending = await this.#pendingBlocks(ctx, scope);
        if (pending.length >= MAX_HISTORY_PENDING_BLOCKS) {
            throw new Error("History module reached its pending block limit.");
        }
        if (
            !Value.Check(historyBlockSchema, block) ||
            (block.type === "tool_call" &&
                block.arguments !== undefined &&
                !historyToolArgumentsWithinByteLimit(block.arguments))
        ) {
            throw new Error("History module received an invalid pending block.");
        }
        await scope.runKV.write(ctx, PENDING_BLOCKS_KEY, [...pending, block]);
    }

    async #pendingBlocks(ctx: Context, scope: AgentModuleScope): Promise<HistoryBlock[]> {
        const value = await scope.runKV.read(ctx, PENDING_BLOCKS_KEY);
        if (value === undefined) return [];
        if (!Value.Check(pendingBlocksSchema, value)) {
            throw new Error("History module found invalid pending blocks.");
        }
        return value as HistoryBlock[];
    }

    async #beginRun(
        ctx: Context,
        agentId: string,
        runId: string,
        kind: AgentBaseAcceptedMessage["kind"],
        startedAt: number,
    ): Promise<void> {
        const exact = await agentDatabaseRows<{ run_id: string }>(
            ctx.db,
            sql`SELECT run_id
                FROM ${sql.raw(HISTORY_RUNS_TABLE)}
                WHERE agent_id = ${agentId} AND run_id = ${runId}
                LIMIT 1`,
        );
        if (exact.length > 0) return;
        const running = await agentDatabaseRows<{ run_id: string }>(
            ctx.db,
            sql`SELECT run_id
                FROM ${sql.raw(HISTORY_RUNS_TABLE)}
                WHERE agent_id = ${agentId} AND status = 'running'
                ORDER BY sequence DESC
                LIMIT 1`,
        );
        if (running[0] !== undefined) {
            await agentDatabaseRun(
                ctx.db,
                sql`UPDATE ${sql.raw(HISTORY_RUNS_TABLE)}
                    SET status = ${kind === "steering" ? "aborted" : "completed"},
                        reason = ${kind === "steering" ? "steering" : "completed"},
                        ended_at = ${startedAt}
                    WHERE agent_id = ${agentId} AND run_id = ${running[0].run_id}`,
            );
        }
        const sequenceRows = await agentDatabaseRows<{ sequence: number | string }>(
            ctx.db,
            sql`SELECT COALESCE(MAX(sequence), -1) + 1 AS sequence
                FROM ${sql.raw(HISTORY_RUNS_TABLE)}
                WHERE agent_id = ${agentId}`,
        );
        const sequence = toSafeInteger(sequenceRows[0]?.sequence, "history run sequence");
        await agentDatabaseRun(
            ctx.db,
            sql`INSERT INTO ${sql.raw(HISTORY_RUNS_TABLE)} (
                    agent_id, sequence, run_id, status, reason, started_at, ended_at
                ) VALUES (
                    ${agentId}, ${sequence}, ${runId}, 'running', NULL, ${startedAt}, NULL
                )`,
        );
    }

    async #finishRun(
        ctx: Context,
        agentId: string,
        status: HistoryRun["status"],
        reason: HistoryRun["reason"],
        endedAt: number,
    ): Promise<void> {
        const runId = this.#events?.activeRunId(agentId);
        if (runId === undefined) return;
        await agentDatabaseRun(
            ctx.db,
            sql`UPDATE ${sql.raw(HISTORY_RUNS_TABLE)}
                SET status = ${status}, reason = ${reason}, ended_at = ${endedAt}
                WHERE agent_id = ${agentId} AND run_id = ${runId} AND status = 'running'`,
        );
    }

    /**
     * Record a run failure that happened before Agent Base could commit an inference outcome.
     *
     * Provider construction, credential refresh, and an iterator throwing before its first event
     * all settle the run with an error without reaching `afterInferenceTransact`. A normal failed
     * inference already owns this stable record, so settlement is only the atomic fallback: it
     * fills the missing record and never repeats an error the inference hook persisted.
     */
    async #recordSettlementFailure(
        ctx: Context,
        scope: AgentModuleScope,
        error: string,
        settlementId: string,
    ): Promise<void> {
        const runId = this.#events?.activeRunId(scope.agent.id);
        if (runId === undefined) return;
        const existing = await agentDatabaseRows<{ record_id: string }>(
            ctx.db,
            sql`SELECT record_id
                FROM ${sql.raw(HISTORY_TABLE)}
                WHERE agent_id = ${scope.agent.id} AND run_id = ${runId} AND role = 'error'
                LIMIT 1`,
        );
        if (existing[0] !== undefined) return;
        await this.#append(ctx, scope.agent.id, {
            at: Date.now(),
            blocks: [{ type: "text", text: error }],
            recordId: settlementId,
            role: "error",
            runId,
            ...(scope.agent.model === undefined ? {} : { model: scope.agent.model }),
            provider: scope.agent.provider,
        });
    }

    /** Append a tool result only to the durable message that owns its matching call. */
    async #appendToolResult(
        ctx: Context,
        agentId: string,
        result: Extract<HistoryBlock, { type: "tool_result" }>,
    ): Promise<void> {
        const rows = await agentDatabaseRows<HistoryRow>(
            ctx.db,
            sql`SELECT ${sql.raw(HISTORY_ROW_COLUMNS)}
                FROM ${sql.raw(HISTORY_TABLE)}
                WHERE agent_id = ${agentId}
                  AND record_id = (
                      SELECT record_id
                      FROM ${sql.raw(HISTORY_TOOL_CALLS_TABLE)}
                      WHERE agent_id = ${agentId} AND call_id = ${result.callId}
                      LIMIT 1
                  )
                LIMIT 1`,
        );
        const row = rows[0];
        if (row === undefined) {
            throw new Error("The completed tool call is missing from durable history.");
        }
        const existing = toHistoryRecord(row).message;
        if (
            !existing.blocks.some(
                (block) => block.type === "tool_call" && block.callId === result.callId,
            )
        ) {
            throw new Error("The tool-call index points to a message without that call.");
        }
        if (
            existing.blocks.some(
                (block) => block.type === "tool_result" && block.callId === result.callId,
            )
        ) {
            throw new Error("The durable tool call already has a result.");
        }
        const updated: HistoryMessage = {
            ...existing,
            blocks: [...existing.blocks, result],
        };
        if (!historyMessageWithinPersistenceBounds(updated)) {
            throw new Error("The tool result exceeds its durable history message bounds.");
        }
        const encoded = JSON.stringify(updated);
        const stats = summarizeHistory([updated]);
        const searchText = foldHistorySearchText(historyMessageSearchParts(updated).join("\n"));
        await agentDatabaseRun(
            ctx.db,
            sql`UPDATE ${sql.raw(HISTORY_TABLE)}
                SET message_json = ${encoded},
                    search_text = ${searchText},
                    assistant_messages = ${stats.assistantMessages},
                    user_messages = ${stats.userMessages},
                    text_characters = ${stats.textCharacters},
                    thinking_blocks = ${stats.thinkingBlocks},
                    tool_calls = ${stats.toolCalls},
                    tool_results = ${stats.toolResults}
                WHERE agent_id = ${agentId} AND record_id = ${updated.recordId}`,
        );
        this.#scheduleAppendNotification(ctx, agentId, [updated]);
    }

    async #append(
        ctx: Context,
        agentId: string,
        ...messages: readonly HistoryMessage[]
    ): Promise<void> {
        if (
            !Value.Check(historyAgentIdSchema, agentId) ||
            messages.length > MAX_HISTORY_MESSAGES_PER_APPEND ||
            messages.some((message) => !historyMessageWithinPersistenceBounds(message))
        ) {
            throw new Error("The history module produced an invalid archive append.");
        }
        const countRows = await agentDatabaseRows<{ count: number | string }>(
            ctx.db,
            sql`SELECT COUNT(*) AS count
                FROM ${sql.raw(HISTORY_TABLE)}
                WHERE agent_id = ${agentId}`,
        );
        const count = toSafeInteger(countRows[0]?.count, "history record count");
        if (count + messages.length > MAX_HISTORY_TOTAL_MESSAGES) {
            throw new Error("The history module reached its record limit.");
        }
        const runIds = new Set(
            messages.flatMap((message) => (message.runId === undefined ? [] : [message.runId])),
        );
        for (const runId of runIds) {
            const existing = await countHistoryRows(
                ctx.db,
                sql`agent_id = ${agentId} AND run_id = ${runId}`,
            );
            const incoming = messages.filter((message) => message.runId === runId).length;
            if (existing + incoming > MAX_HISTORY_MESSAGES_PER_RUN) {
                throw new Error("The history module reached its per-run message limit.");
            }
        }
        const positionRows = await agentDatabaseRows<{ position: number | string }>(
            ctx.db,
            sql`SELECT COALESCE(MAX(position), -1) + 1 AS position
                FROM ${sql.raw(HISTORY_TABLE)}
                WHERE agent_id = ${agentId}`,
        );
        let position = toSafeInteger(positionRows[0]?.position, "history record position");
        for (const message of messages) {
            const encoded = JSON.stringify(message);
            if (encoded === undefined) {
                throw new Error("The history module could not serialize a message.");
            }
            const stats = summarizeHistory([message]);
            const searchText = foldHistorySearchText(historyMessageSearchParts(message).join("\n"));
            await agentDatabaseRun(
                ctx.db,
                sql`INSERT INTO ${sql.raw(HISTORY_TABLE)} (
                        agent_id,
                        position,
                        record_id,
                        run_id,
                        role,
                        message_json,
                        search_text,
                        assistant_messages,
                        user_messages,
                        text_characters,
                        thinking_blocks,
                        tool_calls,
                        tool_results
                    ) VALUES (
                        ${agentId},
                        ${position},
                        ${message.recordId},
                        ${message.runId ?? null},
                        ${message.role},
                        ${encoded},
                        ${searchText},
                        ${stats.assistantMessages},
                        ${stats.userMessages},
                        ${stats.textCharacters},
                        ${stats.thinkingBlocks},
                        ${stats.toolCalls},
                        ${stats.toolResults}
                    )`,
            );
            await indexHistoryToolCalls(ctx.db, agentId, message);
            position += 1;
        }
        this.#scheduleAppendNotification(ctx, agentId, messages);
    }

    async #readPage(ctx: Context, agentId: string, query: HistoryStoreQuery): Promise<HistoryPage> {
        if (
            !Value.Check(historyAgentIdSchema, agentId) ||
            !Value.Check(historyStoreQuerySchema, query)
        ) {
            throw new Error("The history reader received an invalid store query.");
        }
        const requestedLimit = boundedLimit(query.limit);
        const filters = historyWhere(agentId, query);
        const totalStats = await readHistoryStats(ctx.db, sql`agent_id = ${agentId}`);
        const matchedStats = await readHistoryStats(ctx.db, filters);
        const totalMessages = totalStats.messages;
        const matchedMessages = matchedStats.messages;
        const maxRows = await agentDatabaseRows<{ position: number | string | null }>(
            ctx.db,
            sql`SELECT MAX(position) AS position
                FROM ${sql.raw(HISTORY_TABLE)}
                WHERE agent_id = ${agentId}`,
        );
        const archiveLastPosition =
            maxRows[0]?.position === null || maxRows[0]?.position === undefined
                ? undefined
                : toSafeInteger(maxRows[0].position, "history last position");
        const archiveEnd =
            archiveLastPosition === undefined
                ? 0
                : archiveLastPosition >= MAX_HISTORY_POSITION
                  ? MAX_HISTORY_POSITION
                  : archiveLastPosition + 1;
        const anchor = query.cursor ?? 0;
        const selectedRows =
            query.from === "end"
                ? await agentDatabaseRows<HistoryRow>(
                      ctx.db,
                      sql`SELECT ${sql.raw(HISTORY_ROW_COLUMNS)}
                          FROM ${sql.raw(HISTORY_TABLE)}
                          WHERE ${filters}
                          ORDER BY position DESC
                          LIMIT ${requestedLimit}`,
                  )
                : await agentDatabaseRows<HistoryRow>(
                      ctx.db,
                      sql`SELECT ${sql.raw(HISTORY_ROW_COLUMNS)}
                          FROM ${sql.raw(HISTORY_TABLE)}
                          WHERE ${sql.join([filters, sql`position >= ${anchor}`], sql` AND `)}
                          ORDER BY position ASC
                          LIMIT ${requestedLimit}`,
                  );
        const selectedRowsChronological =
            query.from === "end" ? [...selectedRows].reverse() : [...selectedRows];
        const messages = selectedRowsChronological.map(toHistoryRecord);
        const startIndex =
            query.from === "end"
                ? Math.max(0, matchedMessages - requestedLimit)
                : await countHistoryRows(ctx.db, sql`(${filters}) AND position < ${anchor}`);
        const selectedFirstPosition = messages[0]?.position;
        const lastSelectedPosition = messages.at(-1)?.position;
        const nextCursor =
            query.from === "end" || lastSelectedPosition === undefined
                ? undefined
                : await firstHistoryPosition(
                      ctx.db,
                      sql`(${filters}) AND position > ${lastSelectedPosition}`,
                  );
        const previousOffset = Math.max(0, startIndex - requestedLimit);
        const previousCursor =
            matchedMessages > messages.length &&
            (query.from === "end" || query.cursor !== undefined || startIndex > 0)
                ? await historyPositionAt(ctx.db, filters, previousOffset)
                : undefined;
        const cursor =
            selectedFirstPosition ?? (query.from === "end" ? archiveEnd : (query.cursor ?? 0));
        const page: HistoryPage = {
            agentId,
            cursor,
            matchedMessages,
            matchedStats,
            messages,
            ...(nextCursor === undefined ? {} : { nextCursor }),
            ...(previousCursor === undefined ? {} : { previousCursor }),
            totalMessages,
            totalStats,
        };
        if (!Value.Check(historyPageSchema, page) || page.agentId !== agentId) {
            throw new Error("The history module produced an invalid history page.");
        }
        if (page.messages.length > requestedLimit) {
            throw new Error("The history module returned more records than requested.");
        }
        if (page.messages.length > page.matchedMessages) {
            throw new Error("The history module returned more records than matched.");
        }
        // Only matches at or after the anchor can still be reached going forward: the ones before
        // it were already passed, and comparing against the archive-wide total would demand a next
        // cursor from a page that genuinely ends the archive.
        const matchedFromAnchor = matchedMessages - startIndex;
        if (
            query.from !== "end" &&
            page.messages.length > 0 &&
            matchedFromAnchor > page.messages.length &&
            page.nextCursor === undefined
        ) {
            throw new Error("The history module omitted a cursor for a nonterminal page.");
        }
        if (page.matchedMessages > 0 && page.messages.length === 0 && query.cursor === undefined) {
            throw new Error("The history module returned an empty nonterminal page.");
        }
        const requiresPreviousCursor =
            (query.from === "end" && page.matchedMessages > page.messages.length) ||
            (query.cursor !== undefined && page.messages.length === 0 && page.matchedMessages > 0);
        if (requiresPreviousCursor && page.previousCursor === undefined) {
            throw new Error("The history module omitted a cursor for an older page.");
        }
        if (
            page.matchedMessages < page.messages.length ||
            page.totalMessages < page.matchedMessages ||
            page.matchedStats.messages !== page.matchedMessages ||
            page.totalStats.messages !== page.totalMessages ||
            !statsCountsConsistent(page.matchedStats) ||
            !statsCountsConsistent(page.totalStats) ||
            !statsAtLeast(page.totalStats, page.matchedStats)
        ) {
            throw new Error("The history module returned inconsistent page statistics.");
        }
        const selectedStats = summarizeHistory(page.messages.map((record) => record.message));
        const selectedBlockCount = page.messages.reduce(
            (total, record) => total + record.message.blocks.length,
            0,
        );
        if (selectedBlockCount > MAX_HISTORY_BLOCKS_PER_PAGE) {
            throw new Error("The history module returned too many blocks for one page.");
        }
        if (!statsAtLeast(page.matchedStats, selectedStats)) {
            throw new Error("The history module returned inconsistent selected statistics.");
        }
        if (
            query.roles === undefined &&
            (query.query === undefined || query.query.trim().length === 0) &&
            !statsEqual(page.matchedStats, page.totalStats)
        ) {
            throw new Error("The history module returned inconsistent unfiltered statistics.");
        }
        const recordIds = new Set<string>();
        let previousPosition = -1;
        for (const record of page.messages) {
            if (
                !Value.Check(historyRecordSchema, record) ||
                record.position <= previousPosition ||
                recordIds.has(record.message.recordId)
            ) {
                throw new Error("The history module returned an invalid record.");
            }
            recordIds.add(record.message.recordId);
            previousPosition = record.position;
        }
        const firstPosition = page.messages[0]?.position;
        const lastPosition = page.messages.at(-1)?.position;
        if (firstPosition !== undefined && page.cursor !== firstPosition) {
            throw new Error("The history store returned an invalid page cursor.");
        }
        if (query.cursor !== undefined && page.cursor < query.cursor) {
            throw new Error("The history module moved the cursor backwards.");
        }
        if (page.nextCursor !== undefined) {
            if (
                page.messages.length === 0 ||
                lastPosition === undefined ||
                page.nextCursor <= lastPosition ||
                page.nextCursor <= (query.cursor ?? -1)
            ) {
                throw new Error("The history module returned a stalled next cursor.");
            }
        }
        if (page.previousCursor !== undefined) {
            const lowerBound = firstPosition ?? query.cursor;
            if (lowerBound !== undefined && page.previousCursor >= lowerBound) {
                throw new Error("The history module returned a stalled previous cursor.");
            }
        }
        if (
            page.nextCursor !== undefined &&
            page.messages.length > 0 &&
            page.nextCursor > MAX_HISTORY_POSITION
        ) {
            throw new Error("The history module returned an out-of-bounds next cursor.");
        }
        return page;
    }

    async #direct<Result>(
        ctx: Context,
        work: (txCtx: Context) => Promise<Result>,
    ): Promise<Result> {
        return await ctx.inTx(work);
    }

    #scheduleAppendNotification(
        ctx: Context,
        agentId: string,
        messages: readonly HistoryMessage[],
    ): void {
        if (this.#appendListeners.size === 0) return;
        // Who is subscribed is settled here, before the commit, so a subscription taken or dropped
        // while the transaction was still open decides this notification once rather than racing it.
        const listeners = [...this.#appendListeners];
        const snapshot = structuredClone(messages) as HistoryMessage[];
        afterCommit(ctx, async (postCommitCtx) => {
            for (const listener of listeners) {
                try {
                    // Each subscriber gets its own copy, so one that keeps or edits what it was
                    // handed cannot change what the next one sees, or what the archive holds.
                    await listener(postCommitCtx, agentId, structuredClone(snapshot));
                } catch (error: unknown) {
                    // The archive is already durable. Observation cannot undo it, so a failing
                    // subscriber is reported and the rest are still told.
                    withLogContext(postCommitCtx, { agentId }).log.error(
                        "A history append subscriber failed.",
                        error,
                    );
                }
            }
        });
    }

    readonly #hooks: AgentModuleHooks = {
        tools: (_ctx: Context, scope: AgentModuleScope): readonly AnyAgentTool[] => [
            readAgentHistoryTool(this, scope.agent.id),
        ],

        /**
         * Keep each completed block of the response in the run-scoped Agent KV.
         *
         * The event runs inside the transaction that appends the block to the agent's own
         * durable state. A block whose commit is rolled back is therefore never retained by this
         * module, and a process restart can resume from the same pending blocks without relying
         * on heap state.
         */
        onEventTransact: (
            ctx: Context,
            scope: AgentModuleScope,
            event: AgentBasePersistedEvent,
        ): Promise<void> => {
            return this.#appendPendingBlock(ctx, scope, toHistoryBlock(event));
        },

        /**
         * Record an accepted incoming message beside the Agent Base message transaction. An
         * actual system-role message stays `role: "system"`. For user-role messages, provenance
         * metadata records who sent it while that metadata still exists: only a message positively
         * stamped as an end-user submission is recorded as `role: "user"`; everything else — a
         * goal continuation, a collaboration delivery, an unstamped message — is recorded as
         * `role: "agent"`, naming the specific sender when the metadata named one. This fails
         * closed: a forgetful path under-attributes rather than a synthetic message impersonating
         * the person.
         */
        messageAcceptedTransact: async (
            ctx: Context,
            scope: AgentModuleScope,
            accepted: AgentBaseAcceptedMessage,
        ): Promise<void> => {
            if (this.#events === undefined) {
                throw new Error(
                    "History message acceptance requires the Events module for run identity.",
                );
            }
            const runId = await this.#events.runIdForAccepted(ctx, scope.agent.id, accepted);
            const pending = await readPendingMessage(ctx.db, scope.agent.id, accepted.id);
            const acceptedAt = pending?.createdAt ?? Date.now();
            const metadataMutationId = accepted.metadata?.["mutationId"];
            const mutationId =
                pending?.mutationId ??
                (Value.Check(historyMutationIdSchema, metadataMutationId)
                    ? (metadataMutationId as string)
                    : undefined);
            const metadataClientMetadata = accepted.metadata?.["clientMetadata"];
            const clientMetadata =
                pending?.clientMetadata ??
                (Value.Check(historyClientMetadataSchema, metadataClientMetadata)
                    ? (metadataClientMetadata as HistoryClientMetadata)
                    : undefined);
            // A message sent from outside the API — a phone, another module — has no pending
            // row, but still runs with a composer selection; it may stamp that selection on
            // its metadata the way the API does.
            const metadataMode = accepted.metadata?.["mode"];
            const mode =
                pending?.mode ??
                (Value.Check(historyMessageModeSchema, metadataMode)
                    ? (metadataMode as HistoryMessageMode)
                    : undefined);
            const happyMetadata = accepted.metadata?.["happy"];
            const remoteMessageId = Value.Check(happyMessageMetadataSchema, happyMetadata)
                ? (happyMetadata as HappyMessageMetadata).remoteMessageId
                : undefined;
            await this.#beginRun(ctx, scope.agent.id, runId, accepted.kind, acceptedAt);
            const isSystem = accepted.message.role === "system";
            const fromUser = !isSystem && isUserOriginMetadata(accepted.metadata);
            const sender = fromUser ? undefined : senderAgentIdOf(accepted.metadata);
            // A message from another agent may carry the reasoning that agent exposed. It is
            // recorded as thinking, the way this module records any other reasoning; reasoning
            // that is only an opaque provider payload has nothing to show and is left out.
            const blocks = accepted.message.content.flatMap((block): HistoryBlock[] => {
                if (block.type !== "reasoning") return [toHistoryOutputBlock(block)];
                return block.text === undefined ? [] : [{ type: "thinking", thinking: block.text }];
            });
            await this.#append(ctx, scope.agent.id, {
                at: acceptedAt,
                blocks,
                recordId: accepted.id,
                role: isSystem ? "system" : fromUser ? "user" : "agent",
                runId,
                ...(fromUser
                    ? {
                          delivery:
                              pending?.delivery ??
                              (accepted.kind === "steering" ? "steer" : "queue"),
                          ...(mode === undefined ? {} : { mode }),
                          ...(mutationId === undefined ? {} : { mutationId }),
                          ...(clientMetadata === undefined ? {} : { clientMetadata }),
                      }
                    : {}),
                ...(sender === undefined ? {} : { senderAgentId: sender }),
                ...(accepted.metadata?.hideFromUser === undefined
                    ? {}
                    : { hideFromUser: accepted.metadata.hideFromUser }),
                ...(remoteMessageId === undefined ? {} : { remoteMessageId }),
            });
            if (pending !== undefined) {
                await agentDatabaseRun(
                    ctx.db,
                    sql`DELETE FROM ${sql.raw(HISTORY_PENDING_TABLE)}
                        WHERE agent_id = ${scope.agent.id} AND message_id = ${accepted.id}`,
                );
            }
        },

        /** Keep the current inference identity durable until its completed blocks are appended. */
        beforeInferenceTransact: async (ctx, scope, inference): Promise<void> => {
            await scope.runKV.write(ctx, PENDING_INFERENCE_ID_KEY, inference.inferenceId);
        },

        /**
         * Remember the name before the base dispatches a tool. The call-scoped run KV survives
         * the dispatch and is visible to `afterToolCallTransact`, including after a restart.
         */
        beforeToolCallTransact: async (
            ctx: Context,
            scope: AgentModuleScope,
            call: SessionToolCallBlock,
        ): Promise<void> => {
            const callBlock: HistoryBlock = {
                arguments: parseArguments(call.arguments),
                callId: call.callId,
                name: call.name,
                type: "tool_call",
            };
            if (
                !Value.Check(historyToolCallBlockSchema, callBlock) ||
                !historyToolArgumentsWithinByteLimit(callBlock.arguments)
            ) {
                throw new Error("History module received an invalid tool call.");
            }
            await scope.runKV.write(ctx, TOOL_NAME_KEY, call.name);
        },

        /**
         * Keep a successful tool result's bounded presentation in this call's durable run KV.
         * The transactional result hook below then records it beside the result itself. If the
         * process stops between these hooks, the call-scoped value survives for result recovery;
         * failed results deliberately ignore it.
         */
        afterToolCall: async (
            ctx: Context,
            scope: AgentModuleScope,
            outcome: AgentBaseToolOutcome,
        ): Promise<void> => {
            if (
                outcome.isError ||
                outcome.result === undefined ||
                !Value.Check(toolOutcomePresentationSchema, outcome.result)
            ) {
                return;
            }
            await scope.runKV.write(
                ctx,
                TOOL_PRESENTATION_KEY,
                structuredClone(outcome.result.presentation),
            );
        },

        /** Record each tool result in the same transaction as the result in Agent Base history. */
        afterToolCallTransact: (
            ctx: Context,
            scope: AgentModuleScope,
            result: SessionToolResultMessage,
        ): Promise<void> => this.#afterToolCall(ctx, scope, result),

        /**
         * Write the finished response as one message, and the failure as one of its own when the
         * response failed. Both land in the transaction that commits the inference, so the
         * record and the thing recorded become durable together. A response that produced
         * nothing records nothing. A store failure propagates and rolls back the inference
         * transaction, because a conversation the archive could not record is not one the agent
         * should go on to claim it remembers.
         */
        afterInferenceTransact: (
            ctx: Context,
            scope: AgentModuleScope,
            inference: AgentBaseInference,
        ): Promise<void> => this.#afterInference(ctx, scope, inference),

        afterTurnTransact: async (
            ctx: Context,
            scope: AgentModuleScope,
            turn: AgentBaseTurn,
        ): Promise<void> => {
            if (!turn.aborted) return;
            await this.#finishRun(ctx, scope.agent.id, "aborted", "abort", Date.now());
        },

        /**
         * Finish an archive that was interrupted after its response blocks were committed.
         *
         * The settling transaction is the last place the run KV is available. An archive failure
         * therefore rolls settlement back and leaves the pending blocks for the next restart.
         */
        afterAgentSettledTransact: async (
            ctx: Context,
            scope: AgentModuleScope,
            settlement: AgentBaseSettlement,
        ): Promise<void> => {
            const blocks = await this.#pendingBlocks(ctx, scope);
            if (blocks.length > 0) {
                const runId = this.#events?.activeRunId(scope.agent.id);
                const pendingInferenceId = await scope.runKV.read(ctx, PENDING_INFERENCE_ID_KEY);
                if (
                    pendingInferenceId !== undefined &&
                    !Value.Check(historyRecordIdSchema, pendingInferenceId)
                ) {
                    throw new Error("History module found an invalid pending inference identity.");
                }
                const message: HistoryMessage = {
                    at: Date.now(),
                    blocks,
                    recordId:
                        pendingInferenceId === undefined
                            ? createRecordId()
                            : (pendingInferenceId as string),
                    ...(scope.agent.model === undefined ? {} : { model: scope.agent.model }),
                    provider: scope.agent.provider,
                    role: "assistant",
                    ...(runId === undefined ? {} : { runId }),
                };
                await this.#append(ctx, scope.agent.id, message);
                await scope.runKV.delete(ctx, PENDING_BLOCKS_KEY);
            }
            await scope.runKV.delete(ctx, PENDING_INFERENCE_ID_KEY);
            if (settlement.error !== undefined) {
                await this.#recordSettlementFailure(
                    ctx,
                    scope,
                    settlement.error,
                    settlement.settlementId,
                );
                await this.#finishRun(ctx, scope.agent.id, "failed", "error", Date.now());
            } else if (!(await hasPendingSteering(ctx.db, scope.agent.id))) {
                await this.#finishRun(ctx, scope.agent.id, "completed", "completed", Date.now());
            }
        },
    };

    readonly beforeStart = (): AgentModuleHooks => this.#hooks;
}

interface HistoryRow {
    readonly position: number | string;
    readonly record_id: string;
    readonly run_id: string | null;
    readonly role: string;
    readonly message_json: string;
    readonly assistant_messages: number | string;
    readonly user_messages: number | string;
    readonly text_characters: number | string;
    readonly thinking_blocks: number | string;
    readonly tool_calls: number | string;
    readonly tool_results: number | string;
}

interface HistoryPendingRow {
    readonly position: number | string;
    readonly message_id: string;
    readonly message_json: string;
}

interface HistoryRunRow {
    readonly agent_id: string;
    readonly sequence: number | string;
    readonly run_id: string;
    readonly status: string;
    readonly reason: string | null;
    readonly started_at: number | string;
    readonly ended_at: number | string | null;
}

type HistoryRunAnchor =
    | { readonly kind: "latest"; readonly sequence: number }
    | { readonly kind: "before"; readonly sequence: number }
    | {
          readonly kind: "after";
          readonly sequence: number;
          readonly runId: string;
          readonly position: number;
          readonly includeAnchorRun: boolean;
      };

/** Every column a selected archive row is read back with, so all of it can be checked. */
const HISTORY_ROW_COLUMNS = `position,
                             record_id,
                             run_id,
                             role,
                             message_json,
                             assistant_messages,
                             user_messages,
                             text_characters,
                             thinking_blocks,
                             tool_calls,
                             tool_results`;

interface HistoryStatsRow {
    readonly messages: number | string;
    readonly assistant_messages: number | string;
    readonly user_messages: number | string;
    readonly text_characters: number | string;
    readonly thinking_blocks: number | string;
    readonly tool_calls: number | string;
    readonly tool_results: number | string;
}

function historyWhere(agentId: string, query: HistoryStoreQuery): SQL {
    const conditions: SQL[] = [sql`agent_id = ${agentId}`];
    if (query.roles !== undefined) {
        // Asking for no roles at all asks for nothing, exactly as the in-memory selector reads it.
        // Dropping the condition instead would quietly turn that into an unfiltered read.
        conditions.push(
            query.roles.length === 0
                ? sql`1 = 0`
                : sql`role IN (${sql.join(
                      query.roles.map((role) => sql`${role}`),
                      sql`, `,
                  )})`,
        );
    }
    const foldedQuery = query.query === undefined ? "" : foldHistorySearchText(query.query.trim());
    if (foldedQuery.length > 0) {
        const escaped = foldedQuery.replace(/[!%_]/g, (character) => `!${character}`);
        conditions.push(sql`search_text LIKE ${`%${escaped}%`} ESCAPE '!'`);
    }
    return sql.join(conditions, sql` AND `);
}

async function readHistoryStats(
    database: AgentDatabaseFacade<AgentDatabase>,
    where: SQL,
): Promise<HistoryStats> {
    const rows = await agentDatabaseRows<HistoryStatsRow>(
        database,
        sql`SELECT
                COUNT(*) AS messages,
                COALESCE(SUM(assistant_messages), 0) AS assistant_messages,
                COALESCE(SUM(user_messages), 0) AS user_messages,
                COALESCE(SUM(text_characters), 0) AS text_characters,
                COALESCE(SUM(thinking_blocks), 0) AS thinking_blocks,
                COALESCE(SUM(tool_calls), 0) AS tool_calls,
                COALESCE(SUM(tool_results), 0) AS tool_results
            FROM ${sql.raw(HISTORY_TABLE)}
            WHERE ${where}`,
    );
    const row = rows[0];
    if (row === undefined) throw new Error("The history module could not read archive statistics.");
    const stats: HistoryStats = {
        assistantMessages: toSafeInteger(row.assistant_messages, "assistant message count"),
        messages: toSafeInteger(row.messages, "history message count"),
        textCharacters: toSafeInteger(row.text_characters, "history text count"),
        thinkingBlocks: toSafeInteger(row.thinking_blocks, "history thinking count"),
        toolCalls: toSafeInteger(row.tool_calls, "history tool-call count"),
        toolResults: toSafeInteger(row.tool_results, "history tool-result count"),
        userMessages: toSafeInteger(row.user_messages, "user message count"),
    };
    if (!Value.Check(historyStatsSchema, stats) || !statsCountsConsistent(stats)) {
        throw new Error("The history module read inconsistent archive statistics.");
    }
    return stats;
}

async function countHistoryRows(
    database: AgentDatabaseFacade<AgentDatabase>,
    where: SQL,
): Promise<number> {
    const rows = await agentDatabaseRows<{ count: number | string }>(
        database,
        sql`SELECT COUNT(*) AS count
            FROM ${sql.raw(HISTORY_TABLE)}
            WHERE ${where}`,
    );
    return toSafeInteger(rows[0]?.count, "history row count");
}

async function firstHistoryPosition(
    database: AgentDatabaseFacade<AgentDatabase>,
    where: SQL,
): Promise<number | undefined> {
    const rows = await agentDatabaseRows<{ position: number | string }>(
        database,
        sql`SELECT position
            FROM ${sql.raw(HISTORY_TABLE)}
            WHERE ${where}
            ORDER BY position ASC
            LIMIT 1`,
    );
    return rows[0] === undefined ? undefined : toSafeInteger(rows[0].position, "history cursor");
}

async function historyPositionAt(
    database: AgentDatabaseFacade<AgentDatabase>,
    where: SQL,
    offset: number,
): Promise<number | undefined> {
    const rows = await agentDatabaseRows<{ position: number | string }>(
        database,
        sql`SELECT position
            FROM ${sql.raw(HISTORY_TABLE)}
            WHERE ${where}
            ORDER BY position ASC
            LIMIT 1 OFFSET ${offset}`,
    );
    return rows[0] === undefined ? undefined : toSafeInteger(rows[0].position, "history cursor");
}

/**
 * Rebuild one record from its row, and check its canonical denormalized fields.
 *
 * Identity, role, and the per-message counts are denormalized copies of what the stored message
 * already says. Search text is a deliberately lossy index and is not an integrity boundary.
 */
function toHistoryRecord(row: HistoryRow): HistoryRecord {
    const message = parseStoredMessage(row.message_json);
    const position = toSafeInteger(row.position, "history position");
    if (row.record_id !== message.recordId) {
        throw new Error("The history module found a mismatched record identity.");
    }
    if (row.run_id !== (message.runId ?? null)) {
        throw new Error("The history module found a mismatched run identity.");
    }
    if (row.role !== message.role) {
        throw new Error("The history module found a mismatched persisted role.");
    }
    const stored: HistoryStats = {
        assistantMessages: toSafeInteger(row.assistant_messages, "assistant message count"),
        messages: 1,
        textCharacters: toSafeInteger(row.text_characters, "history text count"),
        thinkingBlocks: toSafeInteger(row.thinking_blocks, "history thinking count"),
        toolCalls: toSafeInteger(row.tool_calls, "history tool-call count"),
        toolResults: toSafeInteger(row.tool_results, "history tool-result count"),
        userMessages: toSafeInteger(row.user_messages, "user message count"),
    };
    if (!statsEqual(stored, summarizeHistory([message]))) {
        throw new Error("The history module found mismatched persisted statistics.");
    }
    const record: HistoryRecord = { message, position };
    if (!Value.Check(historyRecordSchema, record)) {
        throw new Error("The history module found an invalid persisted record.");
    }
    return record;
}

function parseStoredMessage(encoded: string): HistoryMessage {
    let parsed: unknown;
    try {
        parsed = JSON.parse(encoded);
    } catch {
        throw new Error("The history module found malformed persisted message JSON.");
    }
    if (
        !Value.Check(historyMessageSchema, parsed) ||
        !historyMessageWithinPersistenceBounds(parsed)
    ) {
        throw new Error("The history module found an invalid persisted message.");
    }
    return parsed;
}

async function readPendingMessage(
    database: AgentDatabaseFacade<AgentDatabase>,
    agentId: string,
    messageId: string,
): Promise<HistoryPendingMessage | undefined> {
    const rows = await agentDatabaseRows<HistoryPendingRow>(
        database,
        sql`SELECT position, message_id, message_json
            FROM ${sql.raw(HISTORY_PENDING_TABLE)}
            WHERE agent_id = ${agentId} AND message_id = ${messageId}
            LIMIT 1`,
    );
    return rows[0] === undefined ? undefined : parsePendingRow(rows[0], agentId);
}

function parsePendingRow(row: HistoryPendingRow, agentId: string): HistoryPendingMessage {
    let parsed: unknown;
    try {
        parsed = JSON.parse(row.message_json);
    } catch {
        throw new Error("The history module found malformed pending-message JSON.");
    }
    if (!Value.Check(historyPendingMessageSchema, parsed)) {
        throw new Error("The history module found an invalid pending message.");
    }
    const candidate = parsed as HistoryPendingMessage;
    if (candidate.agentId !== agentId || candidate.id !== row.message_id) {
        throw new Error("The history module found a mismatched pending message.");
    }
    toSafeInteger(row.position, "pending message position");
    return candidate;
}

async function readPendingMessages(
    database: AgentDatabaseFacade<AgentDatabase>,
    agentId: string,
): Promise<HistoryPendingMessage[]> {
    const rows = await agentDatabaseRows<HistoryPendingRow>(
        database,
        sql`SELECT position, message_id, message_json
            FROM ${sql.raw(HISTORY_PENDING_TABLE)}
            WHERE agent_id = ${agentId}
            ORDER BY position ASC
            LIMIT ${MAX_HISTORY_PENDING_MESSAGES + 1}`,
    );
    if (rows.length > MAX_HISTORY_PENDING_MESSAGES) {
        throw new Error("The history module found too many pending messages.");
    }
    return rows.map((row) => parsePendingRow(row, agentId));
}

/** Whether successful settlement must remain open for the user's next steering boundary. */
async function hasPendingSteering(
    database: AgentDatabaseFacade<AgentDatabase>,
    agentId: string,
): Promise<boolean> {
    const rows = await agentDatabaseRows<{ found: number | string }>(
        database,
        sql`SELECT 1 AS found
            FROM ${sql.raw(HISTORY_PENDING_TABLE)}
            WHERE agent_id = ${agentId}
              AND json_extract(message_json, '$.delivery') = 'steer'
            LIMIT 1`,
    );
    return rows.length > 0;
}

async function resolveRunAnchor(
    database: AgentDatabaseFacade<AgentDatabase>,
    agentId: string,
    query: HistoryRunsQuery,
): Promise<HistoryRunAnchor> {
    if (query.before !== undefined) {
        const rows = await agentDatabaseRows<{ sequence: number | string }>(
            database,
            sql`SELECT sequence
                FROM ${sql.raw(HISTORY_RUNS_TABLE)}
                WHERE agent_id = ${agentId} AND run_id = ${query.before}
                LIMIT 1`,
        );
        if (rows[0] === undefined) {
            throw new Error("The history run cursor was not found.");
        }
        return {
            kind: "before",
            sequence: toSafeInteger(rows[0].sequence, "history run sequence"),
        };
    }
    if (query.after !== undefined) {
        const messageRows = await agentDatabaseRows<{
            position: number | string;
            run_id: string | null;
        }>(
            database,
            sql`SELECT position, run_id
                FROM ${sql.raw(HISTORY_TABLE)}
                WHERE agent_id = ${agentId} AND record_id = ${query.after}
                LIMIT 1`,
        );
        const message = messageRows[0];
        if (message === undefined || message.run_id === null) {
            throw new Error("The history message cursor was not found.");
        }
        const runRows = await agentDatabaseRows<HistoryRunRow>(
            database,
            sql`SELECT agent_id, sequence, run_id, status, reason, started_at, ended_at
                FROM ${sql.raw(HISTORY_RUNS_TABLE)}
                WHERE agent_id = ${agentId} AND run_id = ${message.run_id}
                LIMIT 1`,
        );
        const run = runRows[0];
        if (run === undefined) {
            throw new Error("The history message cursor names no run.");
        }
        return {
            kind: "after",
            sequence: toSafeInteger(run.sequence, "history run sequence"),
            runId: run.run_id,
            position: toSafeInteger(message.position, "history message position"),
            includeAnchorRun: run.status === "running",
        };
    }
    const rows = await agentDatabaseRows<{ sequence: number | string }>(
        database,
        sql`SELECT COALESCE(MAX(sequence), -1) + 1 AS sequence
            FROM ${sql.raw(HISTORY_RUNS_TABLE)}
            WHERE agent_id = ${agentId}`,
    );
    return {
        kind: "latest",
        sequence: toSafeInteger(rows[0]?.sequence, "history run sequence"),
    };
}

async function candidateRuns(
    database: AgentDatabaseFacade<AgentDatabase>,
    agentId: string,
    anchor: HistoryRunAnchor,
): Promise<readonly HistoryRunRow[]> {
    const limit = MAX_HISTORY_RUNS_PER_PAGE + 1;
    if (anchor.kind === "after") {
        return await agentDatabaseRows<HistoryRunRow>(
            database,
            anchor.includeAnchorRun
                ? sql`SELECT agent_id, sequence, run_id, status, reason, started_at, ended_at
                    FROM ${sql.raw(HISTORY_RUNS_TABLE)}
                    WHERE agent_id = ${agentId} AND sequence >= ${anchor.sequence}
                    ORDER BY sequence ASC
                    LIMIT ${limit}`
                : sql`SELECT agent_id, sequence, run_id, status, reason, started_at, ended_at
                    FROM ${sql.raw(HISTORY_RUNS_TABLE)}
                    WHERE agent_id = ${agentId} AND sequence > ${anchor.sequence}
                    ORDER BY sequence ASC
                    LIMIT ${limit}`,
        );
    }
    return await agentDatabaseRows<HistoryRunRow>(
        database,
        sql`SELECT agent_id, sequence, run_id, status, reason, started_at, ended_at
            FROM ${sql.raw(HISTORY_RUNS_TABLE)}
            WHERE agent_id = ${agentId} AND sequence < ${anchor.sequence}
            ORDER BY sequence DESC
            LIMIT ${limit}`,
    );
}

async function readRunMessages(
    database: AgentDatabaseFacade<AgentDatabase>,
    agentId: string,
    runId: string,
    afterPosition?: number,
): Promise<HistoryRecord[]> {
    const rows = await agentDatabaseRows<HistoryRow>(
        database,
        afterPosition === undefined
            ? sql`SELECT ${sql.raw(HISTORY_ROW_COLUMNS)}
                FROM ${sql.raw(HISTORY_TABLE)}
                WHERE agent_id = ${agentId} AND run_id = ${runId}
                ORDER BY position ASC
                LIMIT ${MAX_HISTORY_MESSAGES_PER_RUN + 1}`
            : sql`SELECT ${sql.raw(HISTORY_ROW_COLUMNS)}
                FROM ${sql.raw(HISTORY_TABLE)}
                WHERE agent_id = ${agentId}
                    AND run_id = ${runId}
                    AND position > ${afterPosition}
                ORDER BY position ASC
                LIMIT ${MAX_HISTORY_MESSAGES_PER_RUN + 1}`,
    );
    if (rows.length > MAX_HISTORY_MESSAGES_PER_RUN) {
        throw new Error("The history module found a run too large to read.");
    }
    return rows.map(toHistoryRecord);
}

function runStateFromRow(row: HistoryRunRow): HistoryRunState {
    const sequence = toSafeInteger(row.sequence, "history run sequence");
    const startedAt = toSafeInteger(row.started_at, "history run start");
    const endedAt = row.ended_at === null ? null : toSafeInteger(row.ended_at, "history run end");
    if (
        sequence > MAX_HISTORY_POSITION ||
        !Value.Check(historyAgentIdSchema, row.agent_id) ||
        !Value.Check(historyRecordIdSchema, row.run_id) ||
        !Value.Check(historyRunStatusSchema, row.status) ||
        !Value.Check(historyRunReasonSchema, row.reason)
    ) {
        throw new Error("The history module found invalid run metadata.");
    }
    const run: HistoryRunState = {
        id: row.run_id,
        agentId: row.agent_id,
        status: row.status as HistoryRun["status"],
        reason: row.reason as HistoryRun["reason"],
        startedAt,
        endedAt,
    };
    if (!Value.Check(historyRunStateSchema, run)) {
        throw new Error("The history module produced invalid run state.");
    }
    return run;
}

function runFromRow(row: HistoryRunRow, messages: HistoryMessage[]): HistoryRun {
    const run: HistoryRun = { ...runStateFromRow(row), messages };
    if (!Value.Check(historyRunSchema, run)) {
        throw new Error("The history module produced an invalid history run.");
    }
    return run;
}

/**
 * Drop raw tool payload only when a durable human-readable display exists for the same call.
 *
 * Calls without presentation keep their arguments and results because a client would otherwise
 * have nothing to render.
 */
function omitPresentedToolData(messages: readonly HistoryMessage[]): HistoryMessage[] {
    const presentedCallIds = new Set<string>();
    for (const message of messages) {
        for (const block of message.blocks) {
            if (block.type === "tool_result" && block.display !== undefined) {
                presentedCallIds.add(block.callId);
            }
        }
    }
    return messages.map((message) => ({
        ...message,
        blocks: message.blocks.map((block): HistoryBlock => {
            const clone = structuredClone(block) as HistoryBlock;
            if (clone.type === "tool_call" && presentedCallIds.has(clone.callId)) {
                delete clone.arguments;
            }
            if (clone.type === "tool_result" && clone.display !== undefined) {
                delete clone.output;
            }
            return clone;
        }),
    }));
}

/** Keep a narrow durable lookup from a Base call identity to its public history message. */
async function indexHistoryToolCalls(
    database: AgentDatabase,
    agentId: string,
    message: HistoryMessage,
): Promise<void> {
    for (const block of message.blocks) {
        if (block.type !== "tool_call") continue;
        await agentDatabaseRun(
            database,
            sql`INSERT INTO ${sql.raw(HISTORY_TOOL_CALLS_TABLE)} (agent_id, call_id, record_id)
                VALUES (${agentId}, ${block.callId}, ${message.recordId})
                ON CONFLICT (agent_id, call_id) DO NOTHING`,
        );
        const rows = await agentDatabaseRows<{ record_id: string }>(
            database,
            sql`SELECT record_id
                FROM ${sql.raw(HISTORY_TOOL_CALLS_TABLE)}
                WHERE agent_id = ${agentId} AND call_id = ${block.callId}
                LIMIT 1`,
        );
        if (rows[0]?.record_id !== message.recordId) {
            throw new Error("A tool-call identity is already indexed by another history message.");
        }
    }
}

function toSafeInteger(value: unknown, label: string): number {
    const number = typeof value === "bigint" ? Number(value) : Number(value);
    if (!Number.isSafeInteger(number) || number < 0) {
        throw new Error(`The history module received an invalid ${label}.`);
    }
    return number;
}

function statsAtLeast(actual: HistoryStats, expected: HistoryStats): boolean {
    return (
        actual.assistantMessages >= expected.assistantMessages &&
        actual.messages >= expected.messages &&
        actual.textCharacters >= expected.textCharacters &&
        actual.thinkingBlocks >= expected.thinkingBlocks &&
        actual.toolCalls >= expected.toolCalls &&
        actual.toolResults >= expected.toolResults &&
        actual.userMessages >= expected.userMessages
    );
}

function statsCountsConsistent(stats: HistoryStats): boolean {
    return (
        stats.assistantMessages + stats.userMessages <= stats.messages &&
        (stats.messages > 0 ||
            (stats.assistantMessages === 0 &&
                stats.textCharacters === 0 &&
                stats.thinkingBlocks === 0 &&
                stats.toolCalls === 0 &&
                stats.toolResults === 0 &&
                stats.userMessages === 0))
    );
}

function statsEqual(left: HistoryStats, right: HistoryStats): boolean {
    return (
        left.assistantMessages === right.assistantMessages &&
        left.messages === right.messages &&
        left.textCharacters === right.textCharacters &&
        left.thinkingBlocks === right.thinkingBlocks &&
        left.toolCalls === right.toolCalls &&
        left.toolResults === right.toolResults &&
        left.userMessages === right.userMessages
    );
}

/** The block a persisted event carries. */
function toHistoryBlock(event: AgentBasePersistedEvent): HistoryBlock {
    if (event.type === "text_end") return { type: "text", text: event.block.text };
    if (event.type === "reasoning_end") {
        // A provider that signs or encrypts its reasoning exposes none of it. That the model
        // thought is worth recording; pretending to know what it thought is not.
        return event.block.text === undefined
            ? { type: "thinking", thinking: "", redacted: true }
            : { type: "thinking", thinking: event.block.text };
    }
    return {
        type: "tool_call",
        callId: event.block.callId,
        name: event.block.name,
        arguments: parseArguments(event.block.arguments),
    };
}

/** The call's arguments as data when they parse, and as the raw text when they do not. */
function parseArguments(value: string): HistoryToolArguments {
    try {
        const parsed: unknown = JSON.parse(value);
        if (
            Value.Check(historyToolArgumentsSchema, parsed) &&
            historyToolArgumentsWithinByteLimit(parsed)
        ) {
            return parsed as HistoryToolArguments;
        }
    } catch {
        // Keep malformed provider JSON as its original bounded text. The block schema below
        // still rejects an over-sized value before it can enter pending KV.
    }
    return value;
}

function createRecordId(): string {
    return globalThis.crypto.randomUUID();
}

function toHistoryOutputBlock(block: SessionOutputBlock): HistoryBlock {
    return block.type === "text"
        ? { text: block.text, type: "text" }
        : { data: block.data, mediaType: block.mimeType, type: "image" };
}

function renderOutput(blocks: readonly SessionOutputBlock[], limit: number): string {
    const text = blocks
        .map((block) => (block.type === "text" ? block.text : `[${block.mimeType} image output]`))
        .join("\n");
    if (text.length <= limit && text.length <= MAX_HISTORY_TOOL_OUTPUT_LENGTH) return text;
    const suffix = `\n...[truncated ${Math.max(0, text.length - limit)} chars]`;
    const retained = Math.max(0, Math.min(limit, MAX_HISTORY_TOOL_OUTPUT_LENGTH - suffix.length));
    return `${text.slice(0, retained)}${suffix}`;
}

/** The one line a person reading the history sees in place of a tool's whole answer. */
function toolDisplay(toolName: string, output: string, isError: boolean): string {
    return isError
        ? `Tool ${toolName} failed.`
        : `Tool ${toolName} returned ${output.length} characters.`;
}

/**
 * Join bounded pages read from opposite ends of one archive, in position order.
 *
 * A history short enough to appear in both pages is kept once. Both pages come from this module's
 * own validated read, so a position identifies the same record in either of them.
 */
function mergeHistoryRecords(...pages: readonly (readonly HistoryRecord[])[]): HistoryRecord[] {
    const byPosition = new Map<number, HistoryRecord>();
    for (const page of pages) {
        for (const record of page) byPosition.set(record.position, record);
    }
    return [...byPosition.values()].sort((left, right) => left.position - right.position);
}

function boundedLimit(limit: number): number {
    if (!Value.Check(positiveIntegerSchema, limit)) {
        throw new Error("History page limit must be a positive integer.");
    }
    return Math.min(limit, MAX_HISTORY_PAGE_SIZE);
}

function toStoreQuery(query: HistoryQuery): HistoryStoreQuery {
    return {
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        ...(query.from === undefined ? {} : { from: query.from }),
        limit: boundedLimit(query.limit ?? 100),
        ...(query.query === undefined ? {} : { query: query.query }),
        ...(query.roles === undefined ? {} : { roles: query.roles }),
    };
}
