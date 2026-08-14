import type {
    AgentBaseAcceptedMessage,
    AgentBaseInference,
    AgentBasePersistedEvent,
    AgentFeature,
    AgentFeatureScope,
    AnyAgentTool,
} from "@slopus/happy-agent-base";
import type {
    SessionOutputBlock,
    SessionToolCallBlock,
    SessionToolResultMessage,
} from "@slopus/happy-providers";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

import {
    historyBlockSchema,
    historyMessageSchema,
    historyMessageInputSchema,
    historyMessageWithinPersistenceBounds,
    historyAgentIdSchema,
    MAX_HISTORY_BLOCKS_PER_PAGE,
    MAX_HISTORY_MESSAGES_PER_APPEND,
    MAX_HISTORY_PAGE_SIZE,
    MAX_HISTORY_PENDING_BLOCKS,
    MAX_HISTORY_POSITION,
    historyRecordIdSchema,
    historyToolArgumentsSchema,
    historyToolCallBlockSchema,
    historyToolResultBlockSchema,
    historyToolArgumentsWithinByteLimit,
    MAX_HISTORY_TOOL_OUTPUT_LENGTH,
    type HistoryBlock,
    type HistoryMessage,
    type HistoryMessageInput,
} from "./HistoryMessage.js";
import {
    historyPageSchema,
    historyQuerySchema,
    type HistoryPage,
    type HistoryQuery,
} from "./HistoryPage.js";
import {
    historyContextSchema,
    historyRecordSchema,
    historyStoreSchema,
    historyStoreQuerySchema,
    type HistoryRecord,
    type HistoryStore,
    type HistoryStoreQuery,
} from "./HistoryStore.js";
import { summarizeHistory, type HistoryStats } from "./impl/summarizeHistory.js";
import { readAgentHistoryTool } from "./tools/read_agent_history.js";

type HistoryToolArguments = Static<typeof historyToolArgumentsSchema>;

const PENDING_BLOCKS_KEY = "pending_blocks";
const PENDING_RECORD_ID_KEY = "pending_record_id";
const TOOL_NAME_KEY = "tool_name";
const TOOL_IDENTITY_KEY = "tool_identity";
const toolIdentitySchema = Type.Object({
    createdAt: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    id: historyRecordIdSchema,
});
const pendingBlocksSchema = Type.Array(historyBlockSchema, { maxItems: 2_048 });
const DEFAULT_READER_LIMIT = 200;
const positiveIntegerSchema = Type.Integer({ minimum: 1 });
const nonNegativeIntegerSchema = Type.Integer({ maximum: 1_000_000, minimum: 0 });
/** How much tool output is recorded before the rest is dropped as not worth keeping. */
const DEFAULT_TOOL_OUTPUT_LIMIT = 16_000;

const historyFeatureOptionsSchema = Type.Object(
    {
        store: historyStoreSchema,
        resolveTarget: Type.Optional(
            Type.Function(
                [historyContextSchema, Type.String(), Type.String()],
                Type.Union([
                    Type.String({ maxLength: 256 }),
                    Type.Undefined(),
                    Type.Promise(Type.Union([Type.String({ maxLength: 256 }), Type.Undefined()])),
                ]),
            ),
        ),
        toolOutputLimit: Type.Optional(nonNegativeIntegerSchema),
        failureMode: Type.Optional(
            Type.Union([Type.Literal("best-effort"), Type.Literal("propagate")]),
        ),
    },
    { additionalProperties: false },
);

/** Runtime contract for a configured history feature. */
export { historyFeatureOptionsSchema };
/** What a history feature is built with. */
export type HistoryFeatureOptions = Static<typeof historyFeatureOptionsSchema>;

/**
 * The agent's own record of what happened, which it can read back.
 *
 * This is not the model's context. The context is what the provider is replaying right now, and
 * it is compacted, reset, and thrown away as the conversation moves; the history is what was
 * said and done, kept whether or not any model can still see it. The two are deliberately
 * separate: a conversation reset by an incompatible model switch loses its context entirely and
 * loses none of its history.
 *
 * The feature writes as the agent works — every accepted user message, every completed assistant
 * response, every tool result, and every failed inference — from inside the transactions that
 * commit that work, so the record and the thing recorded become durable together. Completed
 * assistant blocks are kept in the run-scoped Agent KV rather than an in-memory map, so rollback
 * and restart do not leave the feature with a second, contradictory notion of a run.
 *
 * Reading is the `read_agent_history` tool for the model, and `read` for everyone else, both
 * over the same paging, searching, and bounding.
 */
export class HistoryFeature implements AgentFeature {
    readonly name = "history";

    /** Where the history is kept. */
    readonly #store: HistoryStore;
    readonly #resolveTarget:
        | ((
              ctx: Context,
              requesterAgentId: string,
              requestedTarget: string,
          ) => string | undefined | Promise<string | undefined>)
        | undefined;
    /** How much of a tool's output is worth recording. */
    readonly #toolOutputLimit: number;
    /** Whether archive failures are deliberately contained. */
    readonly #failureMode: "best-effort" | "propagate";

    constructor(options: HistoryFeatureOptions) {
        if (!Value.Check(historyFeatureOptionsSchema, options)) {
            throw new Error("History feature options are invalid.");
        }
        this.#store = options.store;
        this.#resolveTarget = options.resolveTarget;
        const toolOutputLimit = options.toolOutputLimit ?? DEFAULT_TOOL_OUTPUT_LIMIT;
        if (!Value.Check(nonNegativeIntegerSchema, toolOutputLimit)) {
            throw new Error("History tool output retention must be a non-negative integer.");
        }
        this.#toolOutputLimit = toolOutputLimit;
        this.#failureMode = options.failureMode ?? "propagate";
    }

    /** Add a message to an agent's history. This is how a host records what it sent. */
    async record(ctx: Context, agentId: string, message: HistoryMessageInput): Promise<void> {
        if (
            !Value.Check(historyAgentIdSchema, agentId) ||
            !Value.Check(historyMessageInputSchema, message)
        ) {
            throw new Error("The history feature received an invalid message.");
        }
        const normalized = {
            ...message,
            at: message.at ?? Date.now(),
            recordId: message.recordId ?? createRecordId(),
        };
        if (!Value.Check(historyMessageSchema, normalized)) {
            throw new Error("The history feature produced an invalid message.");
        }
        await this.#append(ctx, agentId, normalized);
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
        const page = await this.#readPage(ctx, agentId, {
            limit: boundedLimit(query.limit ?? DEFAULT_READER_LIMIT),
            ...(query.from === undefined ? {} : { from: query.from }),
        });
        return [...page.messages];
    }

    /**
     * Return exact archive statistics through the store's bounded page operation.
     *
     * The feature deliberately does not derive this from the records returned by a page: callers
     * such as model handoff may only retain a two-ended sample while still needing the archive's
     * full totals.
     */
    async stats(ctx: Context, agentId: string): Promise<HistoryStats> {
        const page = await this.#readPage(ctx, agentId, {
            from: "start",
            limit: 1,
        });
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
        return await this.#readPage(ctx, agentId, toStoreQuery(query));
    }

    readonly tools = (_ctx: Context, scope: AgentFeatureScope): readonly AnyAgentTool[] => [
        readAgentHistoryTool(this, scope.agent.id),
    ];

    /** Resolve a tool target while keeping self-access available without host wiring. */
    async resolveTarget(
        ctx: Context,
        requesterAgentId: string,
        requestedTarget: string,
    ): Promise<string | undefined> {
        if (
            !Value.Check(historyAgentIdSchema, requesterAgentId) ||
            !Value.Check(historyAgentIdSchema, requestedTarget)
        ) {
            throw new Error("The history target identity is invalid.");
        }
        if (requestedTarget === requesterAgentId) return requestedTarget;
        const resolved = await this.#resolveTarget?.(ctx, requesterAgentId, requestedTarget);
        if (resolved !== undefined && !Value.Check(historyAgentIdSchema, resolved)) {
            throw new Error("The history target resolver returned an invalid agent ID.");
        }
        return resolved;
    }

    /**
     * Keep each completed block of the response in the run-scoped Agent KV.
     *
     * The event runs inside the transaction that appends the block to the agent's own durable
     * state. A block whose commit is rolled back is therefore never retained by this feature, and
     * a process restart can resume from the same pending blocks without relying on heap state.
     */
    readonly onEventTransact = (
        ctx: Context,
        scope: AgentFeatureScope,
        event: AgentBasePersistedEvent,
    ): Promise<void> => {
        return this.#appendPendingBlock(ctx, scope, toHistoryBlock(event));
    };

    /** Record an accepted user message beside the Agent Base message transaction. */
    readonly messageAcceptedTransact = async (
        ctx: Context,
        scope: AgentFeatureScope,
        accepted: AgentBaseAcceptedMessage,
    ): Promise<void> => {
        await this.#append(ctx, scope.agent.id, {
            at: Date.now(),
            blocks: accepted.message.content.map(toHistoryOutputBlock),
            recordId: createRecordId(),
            role: "user",
        });
    };

    /**
     * Remember the name before the base dispatches a tool. The call-scoped run KV survives the
     * dispatch and is visible to `afterToolCallTransact`, including after a restart.
     */
    readonly beforeToolCallTransact = async (
        ctx: Context,
        scope: AgentFeatureScope,
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
            throw new Error("History feature received an invalid tool call.");
        }
        // Fresh dispatches always receive a new identity, even when a provider reuses its call ID.
        // A restart resumes the durable call without running this hook again, so the identity
        // remains stable for that retry.
        await scope.runKV.write(ctx, TOOL_IDENTITY_KEY, {
            createdAt: Date.now(),
            id: createRecordId(),
        });
        await scope.runKV.write(ctx, TOOL_NAME_KEY, call.name);
    };

    /** Record each tool result in the same transaction as the result in Agent Base history. */
    readonly afterToolCallTransact = async (
        ctx: Context,
        scope: AgentFeatureScope,
        result: SessionToolResultMessage,
    ): Promise<void> => {
        const storedName = await scope.runKV.read(ctx, TOOL_NAME_KEY);
        const toolName = typeof storedName === "string" ? storedName : "unknown tool";
        const storedIdentity = await scope.runKV.read(ctx, TOOL_IDENTITY_KEY);
        const identity =
            storedIdentity === undefined
                ? { createdAt: Date.now(), id: createRecordId() }
                : storedIdentity;
        if (!Value.Check(toolIdentitySchema, identity)) {
            throw new Error("History feature found an invalid tool identity.");
        }
        if (storedIdentity === undefined) {
            await scope.runKV.write(ctx, TOOL_IDENTITY_KEY, identity);
        }
        const toolResultBlock: HistoryBlock = {
            type: "tool_result",
            callId: result.callId,
            output: renderOutput(result.content, this.#toolOutputLimit),
            toolName,
            ...(result.isError === true ? { isError: true } : {}),
        };
        if (!Value.Check(historyToolResultBlockSchema, toolResultBlock)) {
            throw new Error("History feature received an invalid tool result.");
        }
        await this.#append(ctx, scope.agent.id, {
            at: identity.createdAt,
            blocks: [toolResultBlock],
            recordId: `tool:${identity.id}`,
            role: "assistant",
        });
    };

    /**
     * Write the finished response as one message, and the failure as one of its own when the
     * response failed. Both land in the transaction that commits the inference, so the record and
     * the thing recorded become durable together. A response that produced nothing records
     * nothing. In strict mode a store failure propagates and rolls back the inference transaction;
     * best-effort mode is an explicit opt-in and drops the record.
     */
    readonly afterInferenceTransact = async (
        ctx: Context,
        scope: AgentFeatureScope,
        inference: AgentBaseInference,
    ): Promise<void> => {
        const blocks = await this.#pendingBlocks(ctx, scope);
        const responseId =
            blocks.length > 0 || inference.errorMessage !== undefined
                ? await this.#pendingRecordId(ctx, scope)
                : undefined;
        const attribution = {
            at: Date.now(),
            ...(scope.agent.model === undefined ? {} : { model: scope.agent.model }),
            provider: scope.agent.provider,
        };
        const messages: HistoryMessage[] = [];
        if (blocks.length > 0) {
            messages.push({
                role: "assistant",
                blocks,
                recordId: `${responseId}:assistant`,
                ...attribution,
            });
        }
        if (inference.errorMessage !== undefined) {
            messages.push({
                role: "error",
                blocks: [{ type: "text", text: inference.errorMessage }],
                recordId: `${responseId}:error`,
                ...attribution,
            });
        }
        if (messages.length === 0) {
            await scope.runKV.delete(ctx, PENDING_BLOCKS_KEY);
            await scope.runKV.delete(ctx, PENDING_RECORD_ID_KEY);
            return;
        }
        await this.#append(ctx, scope.agent.id, ...messages);
        await scope.runKV.delete(ctx, PENDING_BLOCKS_KEY);
        await scope.runKV.delete(ctx, PENDING_RECORD_ID_KEY);
    };

    /**
     * Finish an archive that was interrupted after its response blocks were committed.
     *
     * The settling transaction is the last place the run KV is available. A strict archive
     * failure therefore rolls settlement back and leaves the pending blocks for the next restart.
     */
    readonly afterAgentSettledTransact = async (
        ctx: Context,
        scope: AgentFeatureScope,
    ): Promise<void> => {
        const blocks = await this.#pendingBlocks(ctx, scope);
        if (blocks.length === 0) {
            await scope.runKV.delete(ctx, PENDING_RECORD_ID_KEY);
            return;
        }
        await this.#append(ctx, scope.agent.id, {
            at: Date.now(),
            blocks,
            recordId: `${await this.#pendingRecordId(ctx, scope)}:assistant`,
            ...(scope.agent.model === undefined ? {} : { model: scope.agent.model }),
            provider: scope.agent.provider,
            role: "assistant",
        });
        await scope.runKV.delete(ctx, PENDING_BLOCKS_KEY);
        await scope.runKV.delete(ctx, PENDING_RECORD_ID_KEY);
    };

    async #appendPendingBlock(
        ctx: Context,
        scope: AgentFeatureScope,
        block: HistoryBlock,
    ): Promise<void> {
        const pending = await this.#pendingBlocks(ctx, scope);
        if (pending.length >= MAX_HISTORY_PENDING_BLOCKS) {
            throw new Error("History feature reached its pending block limit.");
        }
        if (
            !Value.Check(historyBlockSchema, block) ||
            (block.type === "tool_call" && !historyToolArgumentsWithinByteLimit(block.arguments))
        ) {
            throw new Error("History feature received an invalid pending block.");
        }
        await this.#pendingRecordId(ctx, scope);
        await scope.runKV.write(ctx, PENDING_BLOCKS_KEY, [...pending, block]);
    }

    async #pendingBlocks(ctx: Context, scope: AgentFeatureScope): Promise<HistoryBlock[]> {
        const value = await scope.runKV.read(ctx, PENDING_BLOCKS_KEY);
        if (value === undefined) return [];
        if (!Value.Check(pendingBlocksSchema, value)) {
            throw new Error("History feature found invalid pending blocks.");
        }
        return value as HistoryBlock[];
    }

    async #pendingRecordId(ctx: Context, scope: AgentFeatureScope): Promise<string> {
        const value = await scope.runKV.read(ctx, PENDING_RECORD_ID_KEY);
        if (value !== undefined) {
            if (!Value.Check(historyRecordIdSchema, value)) {
                throw new Error("History feature found an invalid pending record ID.");
            }
            return value;
        }
        const recordId = createRecordId();
        await scope.runKV.write(ctx, PENDING_RECORD_ID_KEY, recordId);
        return recordId;
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
            throw new Error("The history feature produced an invalid archive append.");
        }
        if (this.#failureMode === "propagate") {
            const result = await this.#store.append(ctx, agentId, [...messages]);
            if (result !== undefined) {
                throw new Error("The history store append returned an invalid result.");
            }
            return;
        }
        let result: void;
        try {
            result = await this.#store.append(ctx, agentId, [...messages]);
        } catch {
            // Best-effort mode is explicit and advisory: the host asked not to make history
            // availability a condition of a successful run.
            return;
        }
        if (result !== undefined) {
            throw new Error("The history store append returned an invalid result.");
        }
    }

    async #readPage(ctx: Context, agentId: string, query: HistoryStoreQuery): Promise<HistoryPage> {
        if (
            !Value.Check(historyAgentIdSchema, agentId) ||
            !Value.Check(historyStoreQuerySchema, query)
        ) {
            throw new Error("The history reader received an invalid store query.");
        }
        const page = await this.#store.read(ctx, agentId, query);
        if (!Value.Check(historyPageSchema, page) || page.agentId !== agentId) {
            throw new Error("The history store returned a page for the wrong agent.");
        }
        const requestedLimit = boundedLimit(query.limit);
        if (page.messages.length > requestedLimit) {
            throw new Error("The history store returned more records than requested.");
        }
        if (page.messages.length > page.matchedMessages) {
            throw new Error("The history store returned more records than matched.");
        }
        if (
            query.from !== "end" &&
            page.messages.length > 0 &&
            page.matchedMessages > page.messages.length &&
            page.nextCursor === undefined
        ) {
            throw new Error("The history store omitted a cursor for a nonterminal page.");
        }
        if (page.matchedMessages > 0 && page.messages.length === 0 && query.cursor === undefined) {
            throw new Error("The history store returned an empty nonterminal page.");
        }
        const requiresPreviousCursor =
            (query.from === "end" && page.matchedMessages > page.messages.length) ||
            (query.cursor !== undefined && page.messages.length === 0 && page.matchedMessages > 0);
        if (requiresPreviousCursor && page.previousCursor === undefined) {
            throw new Error("The history store omitted a cursor for an older page.");
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
            throw new Error("The history store returned inconsistent page statistics.");
        }
        const selectedStats = summarizeHistory(page.messages.map((record) => record.message));
        const selectedBlockCount = page.messages.reduce(
            (total, record) => total + record.message.blocks.length,
            0,
        );
        if (selectedBlockCount > MAX_HISTORY_BLOCKS_PER_PAGE) {
            throw new Error("The history store returned too many blocks for one page.");
        }
        if (!statsAtLeast(page.matchedStats, selectedStats)) {
            throw new Error("The history store returned inconsistent selected statistics.");
        }
        if (
            query.roles === undefined &&
            (query.query === undefined || query.query.trim().length === 0) &&
            !statsEqual(page.matchedStats, page.totalStats)
        ) {
            throw new Error("The history store returned inconsistent unfiltered statistics.");
        }
        const recordIds = new Set<string>();
        let previousPosition = -1;
        for (const record of page.messages) {
            if (
                !Value.Check(historyRecordSchema, record) ||
                record.position <= previousPosition ||
                recordIds.has(record.message.recordId)
            ) {
                throw new Error("The history store returned an invalid record.");
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
            throw new Error("The history store moved the cursor backwards.");
        }
        if (page.nextCursor !== undefined) {
            if (
                page.messages.length === 0 ||
                lastPosition === undefined ||
                page.nextCursor <= lastPosition ||
                page.nextCursor <= (query.cursor ?? -1)
            ) {
                throw new Error("The history store returned a stalled next cursor.");
            }
        }
        if (page.previousCursor !== undefined) {
            const lowerBound = firstPosition ?? query.cursor;
            if (lowerBound !== undefined && page.previousCursor >= lowerBound) {
                throw new Error("The history store returned a stalled previous cursor.");
            }
        }
        if (
            page.nextCursor !== undefined &&
            page.messages.length > 0 &&
            page.nextCursor > MAX_HISTORY_POSITION
        ) {
            throw new Error("The history store returned an out-of-bounds next cursor.");
        }
        return page;
    }
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
        : { mediaType: block.mimeType, type: "image" };
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
