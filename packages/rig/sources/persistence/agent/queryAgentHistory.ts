import {
    historyAgentIdSchema,
    historyMessageWithinPersistenceBounds,
    historyPageSchema,
    historyRecordSchema,
    historyStatsSchema,
    historyStoreQuerySchema,
    MAX_HISTORY_PAGE_SIZE,
    MAX_HISTORY_POSITION,
    MAX_HISTORY_TOTAL_MESSAGES,
    messageMatchesHistoryFilters,
    summarizeHistory,
    type HistoryMessage,
    type HistoryPage,
    type HistoryStats,
    type HistoryStoreQuery,
} from "@slopus/happy-agent-features";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";
import { and, asc, desc, eq, gt, gte, lt, sql, type SQL } from "drizzle-orm";

import { agentHistory } from "../database/schema.js";
import type { DrizzleSessionTx } from "../database/SessionDatabase.js";
import { inReadTx } from "../inReadTx.js";

/**
 * Unicode search is intentionally evaluated in bounded host batches. SQLite's built-in case
 * folding only understands ASCII, while the feature's JavaScript matcher has explicit Unicode
 * semantics. A batch is never larger than one public page.
 */
const SEARCH_SCAN_BATCH_SIZE = MAX_HISTORY_PAGE_SIZE;

type HistoryWhere = SQL<unknown>;

type AggregateRow = {
    assistant_messages: number | null;
    messages: number | null;
    text_characters: number | null;
    thinking_blocks: number | null;
    tool_calls: number | null;
    tool_results: number | null;
    user_messages: number | null;
};

/** Read one bounded, coherent feature-history page from the caller's database scope. */
export async function queryAgentHistory(
    ctx: Context,
    agentId: string,
    query: HistoryStoreQuery,
): Promise<HistoryPage> {
    if (
        !Value.Check(historyAgentIdSchema, agentId) ||
        !Value.Check(historyStoreQuerySchema, query)
    ) {
        throw new Error("History page query is invalid.");
    }
    if (query.cursor !== undefined && query.from !== undefined) {
        throw new Error("Use either cursor or from, not both.");
    }
    return await inReadTx(ctx, "rig.sql.agent_history.read", async (ctx) => {
        const source = await ctx.tx
            .select({
                count: sql<number>`COUNT(*)`,
                firstPosition: sql<number | null>`MIN(${agentHistory.position})`,
                lastPosition: sql<number | null>`MAX(${agentHistory.position})`,
            })
            .from(agentHistory)
            .where(eq(agentHistory.agentId, agentId))
            .get();
        const totalMessages = readCount(source?.count, "total message count");
        const sourceFirst = source?.firstPosition ?? undefined;
        const sourceLast = source?.lastPosition ?? undefined;
        const totalStats = await historyStats(ctx.tx, eq(agentHistory.agentId, agentId));
        if (totalMessages > MAX_HISTORY_TOTAL_MESSAGES) {
            throw new Error("The agent history archive exceeds its record limit.");
        }

        const hasSearch = query.query !== undefined && query.query.trim().length > 0;
        const searchPage = hasSearch
            ? await readUnicodeSearchPage(ctx.tx, agentId, query, sourceFirst, sourceLast)
            : await readSqlPage(ctx.tx, agentId, query, sourceFirst, sourceLast);
        const page: HistoryPage = {
            agentId,
            cursor: searchPage.cursor,
            matchedMessages: searchPage.matchedMessages,
            matchedStats: searchPage.matchedStats,
            messages: searchPage.messages,
            ...(searchPage.nextCursor === undefined ? {} : { nextCursor: searchPage.nextCursor }),
            ...(searchPage.previousCursor === undefined
                ? {}
                : { previousCursor: searchPage.previousCursor }),
            totalMessages,
            totalStats,
        };
        if (!Value.Check(historyPageSchema, page)) {
            throw new Error("The agent history archive produced an invalid page.");
        }
        return page;
    });
}

interface SelectedPage {
    readonly cursor: number;
    readonly matchedMessages: number;
    readonly matchedStats: HistoryStats;
    readonly messages: {
        readonly message: HistoryMessage;
        readonly position: number;
    }[];
    readonly nextCursor?: number | undefined;
    readonly previousCursor?: number | undefined;
}

async function readSqlPage(
    tx: DrizzleSessionTx,
    agentId: string,
    query: HistoryStoreQuery,
    sourceFirst: number | undefined,
    sourceLast: number | undefined,
): Promise<SelectedPage> {
    const matchWhere = historyWhere(agentId, query);
    const matchedRow = await tx
        .select({ count: sql<number>`COUNT(*)` })
        .from(agentHistory)
        .where(matchWhere)
        .get();
    const rangeWhere =
        query.cursor === undefined ? undefined : gte(agentHistory.position, query.cursor);
    const rows = await tx
        .select({
            messageJson: agentHistory.messageJson,
            position: agentHistory.position,
            recordId: agentHistory.recordId,
        })
        .from(agentHistory)
        .where(rangeWhere === undefined ? matchWhere : and(matchWhere, rangeWhere))
        .orderBy(query.from === "end" ? desc(agentHistory.position) : asc(agentHistory.position))
        .limit(query.limit)
        .all();
    const records = rows.map(decodeRecord);
    if (query.from === "end") records.reverse();
    const first = records[0]?.position;
    const last = records.at(-1)?.position;
    const next =
        last === undefined || last >= MAX_HISTORY_POSITION
            ? undefined
            : await tx
                  .select({ position: agentHistory.position })
                  .from(agentHistory)
                  .where(and(matchWhere, gte(agentHistory.position, last + 1)))
                  .orderBy(asc(agentHistory.position))
                  .limit(1)
                  .get();
    const previousAnchor = first ?? query.cursor;
    const previousRows =
        previousAnchor === undefined
            ? []
            : await tx
                  .select({ position: agentHistory.position })
                  .from(agentHistory)
                  .where(and(matchWhere, lt(agentHistory.position, previousAnchor)))
                  .orderBy(desc(agentHistory.position))
                  .limit(query.limit)
                  .all();
    const previous = previousRows.at(-1);
    const matchedStats = await historyStats(tx, matchWhere);
    const emptyCursor =
        first ??
        (query.cursor === undefined
            ? query.from === "end"
                ? safeCursorAfter(sourceLast)
                : (sourceFirst ?? 0)
            : Math.max(query.cursor, sourceFirst ?? query.cursor));
    return {
        cursor: emptyCursor,
        matchedMessages: readCount(matchedRow?.count, "matched message count"),
        matchedStats,
        messages: records,
        ...(next === undefined ? {} : { nextCursor: next.position }),
        ...(previous === undefined ? {} : { previousCursor: previous.position }),
    };
}

/**
 * Search in bounded SQL batches, then apply the feature's Unicode matcher to each decoded
 * message. Only the selected page and the immediately preceding page's cursor candidates are
 * retained; statistics are accumulated one message at a time.
 */
async function readUnicodeSearchPage(
    tx: DrizzleSessionTx,
    agentId: string,
    query: HistoryStoreQuery,
    sourceFirst: number | undefined,
    sourceLast: number | undefined,
): Promise<SelectedPage> {
    const where = historyWhere(agentId, query);
    const fromEnd = query.from === "end";
    const limit = query.limit;
    const matchedStats = emptyStats();
    let matchedMessages = 0;
    let boundary: number | undefined;
    const selected: Array<{ message: HistoryMessage; position: number }> = [];
    const previousCandidates: Array<{ message: HistoryMessage; position: number }> = [];
    const olderCandidates: Array<{ message: HistoryMessage; position: number }> = [];
    let nextCursor: number | undefined;

    const anchor =
        query.cursor === undefined
            ? (sourceFirst ?? 0)
            : Math.max(query.cursor, sourceFirst ?? query.cursor);
    while (true) {
        const range =
            boundary === undefined
                ? undefined
                : fromEnd
                  ? lt(agentHistory.position, boundary)
                  : gt(agentHistory.position, boundary);
        const rows = await tx
            .select({
                messageJson: agentHistory.messageJson,
                position: agentHistory.position,
                recordId: agentHistory.recordId,
            })
            .from(agentHistory)
            .where(range === undefined ? where : and(where, range))
            .orderBy(fromEnd ? desc(agentHistory.position) : asc(agentHistory.position))
            .limit(SEARCH_SCAN_BATCH_SIZE)
            .all();
        if (rows.length === 0) break;
        for (const row of rows) {
            const record = decodeRecord(row);
            if (!messageMatchesHistoryFilters(record.message, query)) continue;
            matchedMessages += 1;
            addStats(matchedStats, summarizeHistory([record.message]));
            if (fromEnd) {
                if (selected.length < limit) {
                    selected.push(record);
                } else if (olderCandidates.length < limit) {
                    olderCandidates.push(record);
                }
                continue;
            }
            if (record.position < anchor) {
                pushRing(previousCandidates, record, limit);
            } else if (selected.length < limit) {
                selected.push(record);
            } else if (nextCursor === undefined) {
                nextCursor = record.position;
            }
        }
        const lastPosition = rows.at(-1)?.position;
        if (
            lastPosition === undefined ||
            rows.length < SEARCH_SCAN_BATCH_SIZE ||
            (fromEnd ? lastPosition <= 0 : lastPosition >= MAX_HISTORY_POSITION)
        ) {
            break;
        }
        boundary = lastPosition;
    }

    if (matchedMessages > MAX_HISTORY_TOTAL_MESSAGES) {
        throw new Error("The agent history archive exceeds its record limit.");
    }
    if (fromEnd) {
        selected.reverse();
        return {
            cursor:
                selected[0]?.position ??
                (query.cursor === undefined
                    ? safeCursorAfter(sourceLast)
                    : Math.max(query.cursor, sourceFirst ?? query.cursor)),
            matchedMessages,
            matchedStats,
            messages: selected,
            ...(olderCandidates.at(-1) === undefined
                ? {}
                : { previousCursor: olderCandidates.at(-1)?.position }),
        };
    }
    const first = selected[0]?.position;
    return {
        cursor:
            first ??
            (query.cursor === undefined
                ? (sourceFirst ?? 0)
                : Math.max(query.cursor, sourceFirst ?? query.cursor)),
        matchedMessages,
        matchedStats,
        messages: selected,
        ...(nextCursor === undefined ? {} : { nextCursor }),
        ...(previousCandidates[0] === undefined
            ? {}
            : { previousCursor: previousCandidates[0].position }),
    };
}

function pushRing(
    ring: Array<{ message: HistoryMessage; position: number }>,
    record: { message: HistoryMessage; position: number },
    limit: number,
): void {
    ring.push(record);
    if (ring.length > limit) ring.shift();
}

function historyWhere(agentId: string, query: HistoryStoreQuery): HistoryWhere {
    const clauses: SQL<unknown>[] = [eq(agentHistory.agentId, agentId)];
    if (query.roles !== undefined) {
        if (query.roles.length === 0) return sql`0`;
        clauses.push(
            sql`json_extract(${agentHistory.messageJson}, '$.role') IN (${sql.join(
                query.roles.map((role) => sql`${role}`),
                sql`, `,
            )})`,
        );
    }
    return and(...clauses) as HistoryWhere;
}

/**
 * Aggregate directly in SQLite. No archive message JSON crosses the host boundary here.
 *
 * SQLite's `length(TEXT)` stops at the first NUL and counts Unicode code points rather than
 * JavaScript UTF-16 code units. The text fields are valid UTF-8 by the history schema, so count
 * code units from their BLOB bytes instead: bytes minus UTF-8 continuation bytes gives code
 * points, and each four-byte lead byte adds one surrogate code unit. `replace` operates on the
 * BLOB value with exact byte literals; casting its TEXT result back to BLOB keeps embedded NULs
 * in the length calculation. The staged replacements avoid both TEXT NUL truncation and a
 * recursive per-byte archive expansion.
 */
async function historyStats(tx: DrizzleSessionTx, where: HistoryWhere): Promise<HistoryStats> {
    const rawBlockBytes = sql`CAST(COALESCE(block_text, '') AS BLOB)`;
    const continuationRanges = [
        byteRange(0x80, 0x8f),
        byteRange(0x90, 0x9f),
        byteRange(0xa0, 0xaf),
        byteRange(0xb0, 0xbf),
    ] as const;
    const continuationStages = continuationRanges.map((bytes, index) => ({
        name: `continuation_${index}`,
        expression: stripBlobBytes(sql.raw(index === 0 ? "raw_bytes" : "stripped_bytes"), bytes),
    }));
    const continuationCtes = continuationStages.map(
        ({ name, expression }, index) => sql`
            ${sql.raw(name)} AS (
                SELECT
                    position,
                    block_index,
                    raw_bytes,
                    ${expression} AS stripped_bytes
                FROM ${sql.raw(index === 0 ? "block_bytes" : continuationStages[index - 1]!.name)}
            )
        `,
    );
    const astralExpression = stripBlobBytes(sql.raw("raw_bytes"), [0xf0, 0xf1, 0xf2, 0xf3, 0xf4]);
    let row: AggregateRow | undefined;
    try {
        row = await tx.get<AggregateRow>(sql`
            WITH matching_messages(position, message_json) AS (
                SELECT ${agentHistory.position}, ${agentHistory.messageJson}
                FROM ${agentHistory}
                WHERE ${where}
            ),
            message_stats AS (
                SELECT
                    COUNT(*) AS messages,
                    COALESCE(SUM(CASE
                        WHEN json_extract(message_json, '$.role') = 'assistant' THEN 1
                        ELSE 0
                    END), 0) AS assistant_messages,
                    COALESCE(SUM(CASE
                        WHEN json_extract(message_json, '$.role') = 'user' THEN 1
                        ELSE 0
                    END), 0) AS user_messages
                FROM matching_messages
            ),
            blocks AS (
                SELECT
                    matching_messages.position AS position,
                    block.key AS block_index,
                    json_extract(block.value, '$.type') AS block_type,
                    CASE json_extract(block.value, '$.type')
                        WHEN 'text' THEN json_extract(block.value, '$.text')
                        WHEN 'thinking' THEN json_extract(block.value, '$.thinking')
                        ELSE NULL
                    END AS block_text
                FROM matching_messages
                CROSS JOIN json_each(matching_messages.message_json, '$.blocks') AS block
            ),
            block_bytes AS (
                SELECT
                    position,
                    block_index,
                    ${rawBlockBytes} AS raw_bytes
                FROM blocks
                WHERE block_type IN ('text', 'thinking')
            ),
            ${sql.join(continuationCtes, sql`, `)},
            astral AS (
                SELECT
                    position,
                    block_index,
                    ${astralExpression} AS stripped_bytes
                FROM block_bytes
            ),
            text_block_stats AS (
                SELECT
                    block_bytes.position AS position,
                    block_bytes.block_index AS block_index,
                    length(CAST(${sql.raw("continuation_3")}.stripped_bytes AS BLOB)) +
                        length(CAST(block_bytes.raw_bytes AS BLOB)) -
                        length(CAST(astral.stripped_bytes AS BLOB)) AS text_characters
                FROM block_bytes
                INNER JOIN ${sql.raw("continuation_3")}
                    ON ${sql.raw("continuation_3")}.position = block_bytes.position
                    AND ${sql.raw("continuation_3")}.block_index = block_bytes.block_index
                INNER JOIN astral
                    ON astral.position = block_bytes.position
                    AND astral.block_index = block_bytes.block_index
            ),
            block_counts AS (
                SELECT
                    COALESCE(SUM(CASE WHEN block_type = 'thinking' THEN 1 ELSE 0 END), 0)
                        AS thinking_blocks,
                    COALESCE(SUM(CASE WHEN block_type = 'tool_call' THEN 1 ELSE 0 END), 0)
                        AS tool_calls,
                    COALESCE(SUM(CASE WHEN block_type = 'tool_result' THEN 1 ELSE 0 END), 0)
                        AS tool_results
                FROM blocks
            ),
            text_counts AS (
                SELECT COALESCE(SUM(text_characters), 0) AS text_characters
                FROM text_block_stats
            ),
            block_stats AS (
                SELECT
                    text_counts.text_characters AS text_characters,
                    block_counts.thinking_blocks AS thinking_blocks,
                    block_counts.tool_calls AS tool_calls,
                    block_counts.tool_results AS tool_results
                FROM block_counts
                CROSS JOIN text_counts
            )
            SELECT
                message_stats.messages AS messages,
                message_stats.assistant_messages AS assistant_messages,
                message_stats.user_messages AS user_messages,
                block_stats.text_characters AS text_characters,
                block_stats.thinking_blocks AS thinking_blocks,
                block_stats.tool_calls AS tool_calls,
                block_stats.tool_results AS tool_results
            FROM message_stats
            CROSS JOIN block_stats
        `);
    } catch {
        throw new Error("The agent history archive contains an invalid record.");
    }
    if (row === undefined) throw new Error("The agent history archive produced no statistics.");
    const stats: HistoryStats = {
        assistantMessages: readCount(row.assistant_messages, "assistant message count"),
        messages: readCount(row.messages, "message count"),
        textCharacters: readCount(row.text_characters, "text character count"),
        thinkingBlocks: readCount(row.thinking_blocks, "thinking block count"),
        toolCalls: readCount(row.tool_calls, "tool call count"),
        toolResults: readCount(row.tool_results, "tool result count"),
        userMessages: readCount(row.user_messages, "user message count"),
    };
    if (!Value.Check(historyStatsSchema, stats)) {
        throw new Error("The agent history archive exceeds its statistics bounds.");
    }
    return stats;
}

function byteRange(start: number, end: number): readonly number[] {
    return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

function stripBlobBytes(source: SQL<unknown>, bytes: readonly number[]): SQL<unknown> {
    return bytes.reduce(
        (expression, byte) =>
            sql`replace(${expression}, ${sql.raw(`X'${byte.toString(16).padStart(2, "0")}'`)}, X'')`,
        source,
    );
}

function decodeRecord(row: {
    readonly messageJson: string;
    readonly position: number;
    readonly recordId: string;
}): { message: HistoryMessage; position: number } {
    let message: unknown;
    try {
        message = JSON.parse(row.messageJson) as unknown;
    } catch {
        throw new Error("The agent history archive contains invalid JSON.");
    }
    const record = { message, position: row.position };
    if (
        !Value.Check(historyRecordSchema, record) ||
        !historyMessageWithinPersistenceBounds(message)
    ) {
        throw new Error("The agent history archive contains an invalid record.");
    }
    if (row.recordId !== (message as HistoryMessage).recordId) {
        throw new Error("The agent history archive contains an invalid record.");
    }
    return record as { message: HistoryMessage; position: number };
}

function emptyStats(): HistoryStats {
    return {
        assistantMessages: 0,
        messages: 0,
        textCharacters: 0,
        thinkingBlocks: 0,
        toolCalls: 0,
        toolResults: 0,
        userMessages: 0,
    };
}

function addStats(target: HistoryStats, source: HistoryStats): void {
    target.assistantMessages += source.assistantMessages;
    target.messages += source.messages;
    target.textCharacters += source.textCharacters;
    target.thinkingBlocks += source.thinkingBlocks;
    target.toolCalls += source.toolCalls;
    target.toolResults += source.toolResults;
    target.userMessages += source.userMessages;
}

function readCount(value: number | null | undefined, label: string): number {
    if (value === undefined || value === null || !Number.isSafeInteger(value) || value < 0) {
        throw new Error(`The agent history archive returned an invalid ${label}.`);
    }
    return value;
}

function safeCursorAfter(position: number | null | undefined): number {
    if (position === undefined || position === null) return 0;
    return position >= MAX_HISTORY_POSITION ? MAX_HISTORY_POSITION : position + 1;
}
