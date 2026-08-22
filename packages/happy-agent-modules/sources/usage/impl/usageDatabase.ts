import { sql, type SQL } from "drizzle-orm";
import { agentDatabaseRows, agentDatabaseRun } from "@slopus/happy-agent-base";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

import {
    usageAggregateQuerySchema,
    usageCurrentContextSchema,
    usagePageQuerySchema,
    usagePageSchema,
    usageRunIdSchema,
    usageRunBreakdownSchema,
    usageRunSummarySchema,
    usageSummarySchema,
    type UsageAggregateQuery,
    type UsageCurrentContext,
    type UsageGroup,
    type UsagePage,
    type UsagePageQuery,
    type UsageRecord,
    type UsageRunBreakdown,
    type UsageRunSummary,
    type UsageSummary,
} from "../Usage.js";
import { assertUsageRecord } from "./assertUsageRecord.js";

const RECORDS_TABLE = "happy_agent_usage_records";
const CONTEXTS_TABLE = "happy_agent_usage_contexts";
const MODEL_TOTALS_TABLE = "happy_agent_usage_model_totals";

/**
 * The record's own fields, read out of the stored JSON.
 *
 * Records keep the shape they have always had: one JSON document per row. Totals are summed by
 * the database rather than by reading every record into memory, because history is unbounded, so
 * the sums reach into that document instead of into columns beside it.
 */
const PROVIDER = sql`json_extract(record_json, '$.provider')`;
const MODEL = sql`json_extract(record_json, '$.model')`;
const EFFORT = sql`json_extract(record_json, '$.effort')`;
const TIER = sql`json_extract(record_json, '$.tier')`;
const STARTED_AT = sql`json_extract(record_json, '$.startedAt')`;
const FINISHED_AT = sql`json_extract(record_json, '$.finishedAt')`;
const DURATION_MS = sql`json_extract(record_json, '$.durationMs')`;
/** A turn carries no token counts, so its contribution to a token sum is zero. */
const INPUT_TOKENS = sql`COALESCE(json_extract(record_json, '$.tokens.input'), 0)`;
const OUTPUT_TOKENS = sql`COALESCE(json_extract(record_json, '$.tokens.output'), 0)`;
const CACHE_READ_TOKENS = sql`COALESCE(json_extract(record_json, '$.tokens.cacheRead'), 0)`;
const CACHE_WRITE_TOKENS = sql`COALESCE(json_extract(record_json, '$.tokens.cacheWrite'), 0)`;

/** The running totals every scoped read reports, summed by the database. */
const USAGE_SUM_COLUMNS = sql`
    COUNT(*) FILTER (WHERE kind = 'inference') AS inference_count,
    COUNT(*) FILTER (WHERE kind = 'turn') AS turn_count,
    COALESCE(SUM(${INPUT_TOKENS}), 0) AS input_tokens,
    COALESCE(SUM(${OUTPUT_TOKENS}), 0) AS output_tokens,
    COALESCE(SUM(${DURATION_MS}) FILTER (WHERE kind = 'inference'), 0) AS inference_duration_ms,
    COALESCE(SUM(${DURATION_MS}) FILTER (WHERE kind = 'turn'), 0) AS turn_duration_ms`;

/**
 * The invariant every row must still hold for a total over it to be trustworthy.
 *
 * Totals are summed by the database rather than parsed row by row, so the check that parsing used
 * to perform rides along on the very same scan: a row whose measured duration disagrees with its
 * own timestamps fails the read instead of quietly becoming part of a trusted number. A record
 * that is not valid JSON fails the read too, because reading its fields is what the scan does.
 *
 * Every field compared here comes out of the record itself. Comparing the record's duration
 * against the indexed `finished_at` column instead would let a row whose column and document
 * disagree pass a check about the document.
 */
const USAGE_INTEGRITY_COLUMNS = sql`
    COUNT(*) FILTER (WHERE ${STARTED_AT} IS NULL OR ${DURATION_MS} IS NULL
                        OR ${FINISHED_AT} IS NULL
                        OR ${DURATION_MS} != ${FINISHED_AT} - ${STARTED_AT}) AS inconsistent_duration`;

type UsageTotals = Pick<
    UsageSummary,
    | "inferenceCount"
    | "turnCount"
    | "inputTokens"
    | "outputTokens"
    | "totalTokens"
    | "inferenceDurationMs"
    | "turnDurationMs"
    | "totalDurationMs"
>;

/** Turn one summed row into the totals shape, deriving the two totals that are pure sums. */
function usageTotals(row: Record<string, number | string | null>): UsageTotals {
    const value = (name: string): number => Number(row[name] ?? 0);
    const inputTokens = value("input_tokens");
    const outputTokens = value("output_tokens");
    const inferenceDurationMs = value("inference_duration_ms");
    const turnDurationMs = value("turn_duration_ms");
    return {
        inferenceCount: value("inference_count"),
        turnCount: value("turn_count"),
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        inferenceDurationMs,
        turnDurationMs,
        totalDurationMs: inferenceDurationMs + turnDurationMs,
    };
}

export class UsageDatabase {
    async run(ctx: Context, agentId: string, runId: string): Promise<UsageRunSummary> {
        if (!Value.Check(usageRunIdSchema, runId)) {
            throw new Error("Usage run ID is invalid.");
        }
        const usage = await this.#tokensByModel(
            ctx,
            sql`WHERE agent_id = ${agentId} AND run_id = ${runId}`,
        );
        const summary: UsageRunSummary = {
            agentId,
            runId,
            usage,
            costUsd: null,
        };
        if (!Value.Check(usageRunSummarySchema, summary)) {
            throw new Error("Usage database returned invalid run usage.");
        }
        return structuredClone(summary);
    }

    async modelUsage(ctx: Context, agentId: string): Promise<UsageRunBreakdown> {
        const rows = await agentDatabaseRows<{
            provider: string;
            model: string;
            input_tokens: number | string;
            output_tokens: number | string;
            cache_read_tokens: number | string;
            cache_write_tokens: number | string;
        }>(
            ctx.db,
            sql`SELECT provider, model, input_tokens, output_tokens,
                       cache_read_tokens, cache_write_tokens
                FROM ${sql.raw(MODEL_TOTALS_TABLE)}
                WHERE agent_id = ${agentId}
                ORDER BY provider, model`,
        );
        const usage: UsageRunBreakdown = {};
        for (const row of rows) {
            const models = usage[row.provider] ?? {};
            models[row.model] = {
                input: Number(row.input_tokens),
                output: Number(row.output_tokens),
                cacheRead: Number(row.cache_read_tokens),
                cacheWrite: Number(row.cache_write_tokens),
            };
            usage[row.provider] = models;
        }
        if (!Value.Check(usageRunBreakdownSchema, usage)) {
            throw new Error("Usage database returned invalid model totals.");
        }
        return structuredClone(usage);
    }

    async read(
        ctx: Context,
        agentId: string,
        query: UsagePageQuery,
        maxPageSize: number,
    ): Promise<UsagePage> {
        if (!Value.Check(usagePageQuerySchema, query)) {
            throw new Error("Usage page query is invalid.");
        }
        const cursor = query.cursor ?? 0;
        const limit = query.limit ?? maxPageSize;
        const rows = await agentDatabaseRows<{ record_json: string; total: number | string }>(
            ctx.db,
            sql`SELECT record_json,
                       (SELECT COUNT(*) FROM ${sql.raw(RECORDS_TABLE)}
                        WHERE agent_id = ${agentId}) AS total
                FROM ${sql.raw(RECORDS_TABLE)}
                WHERE agent_id = ${agentId}
                ORDER BY finished_at, record_id
                LIMIT ${limit + 1} OFFSET ${cursor}`,
        );
        const records = rows.slice(0, limit).map((row) => this.#parseRecord(row.record_json));
        const totalRecords = Number(rows[0]?.total ?? 0);
        const page: UsagePage = {
            agentId,
            records,
            cursor,
            totalRecords,
            ...(cursor + records.length < totalRecords
                ? { nextCursor: cursor + records.length }
                : {}),
        };
        if (!Value.Check(usagePageSchema, page)) {
            throw new Error("Usage database returned an invalid page.");
        }
        return structuredClone(page);
    }

    /** Lifetime tokens per agent, in one pass over the durable model totals. */
    async totalTokensByAgent(ctx: Context): Promise<ReadonlyMap<string, number>> {
        const rows = await agentDatabaseRows<{ agent_id: string; total_tokens: number | string }>(
            ctx.db,
            sql`SELECT agent_id, SUM(input_tokens + output_tokens) AS total_tokens
                FROM ${sql.raw(MODEL_TOTALS_TABLE)}
                GROUP BY agent_id`,
        );
        const totals = new Map<string, number>();
        for (const row of rows) {
            totals.set(row.agent_id, Number(row.total_tokens));
        }
        return totals;
    }

    /**
     * Inference tokens per provider and model over some scope.
     *
     * The scope must already be a non-empty `WHERE` clause, because this narrows it further. The
     * breakdown is keyed by model, so inference the provider never attributed to one has no place
     * in it and is left out, exactly as the lifetime model totals leave it out.
     */
    async #tokensByModel(ctx: Context, scope: SQL): Promise<UsageRunBreakdown> {
        const [usage] = await this.#tokensByModelWindows(ctx, scope, [undefined]);
        if (usage === undefined) throw new Error("Usage database returned no model breakdown.");
        return usage;
    }

    /**
     * The same breakdown for several start cutoffs at once.
     *
     * Every cutoff is answered from one pass, because each is a suffix of the same history and
     * scanning it once per window would repeat the same work with only the boundary moved. A
     * cutoff of `undefined` means the whole scope. The integrity of the rows being summed is
     * counted on that same pass, so a total is never built out of a record that contradicts
     * itself.
     */
    async #tokensByModelWindows(
        ctx: Context,
        scope: SQL,
        cutoffs: readonly (number | undefined)[],
    ): Promise<UsageRunBreakdown[]> {
        const sums = cutoffs.flatMap((cutoff, index) =>
            [
                [INPUT_TOKENS, "input"],
                [OUTPUT_TOKENS, "output"],
                [CACHE_READ_TOKENS, "cache_read"],
                [CACHE_WRITE_TOKENS, "cache_write"],
            ].map(([value, name]) =>
                cutoff === undefined
                    ? sql`COALESCE(SUM(${value as SQL}), 0) AS ${sql.raw(`${String(name)}_${index}`)}`
                    : sql`COALESCE(SUM(${value as SQL}) FILTER (WHERE ${STARTED_AT} >= ${cutoff}), 0)
                              AS ${sql.raw(`${String(name)}_${index}`)}`,
            ),
        );
        const rows = await agentDatabaseRows<Record<string, number | string | null>>(
            ctx.db,
            sql`SELECT ${PROVIDER} AS provider, ${MODEL} AS model,
                       ${sql.join(sums, sql`, `)},
                       ${USAGE_INTEGRITY_COLUMNS}
                FROM ${sql.raw(RECORDS_TABLE)}
                ${scope} AND kind = 'inference' AND ${MODEL} IS NOT NULL
                GROUP BY provider, model
                ORDER BY provider, model`,
        );
        const breakdowns = cutoffs.map<UsageRunBreakdown>(() => ({}));
        for (const row of rows) {
            if (Number(row["inconsistent_duration"] ?? 0) > 0) {
                throw new Error(
                    "Usage storage holds a record whose duration contradicts its span.",
                );
            }
            const provider = String(row["provider"]);
            const model = String(row["model"]);
            const value = (name: string, index: number): number =>
                Number(row[`${name}_${index}`] ?? 0);
            cutoffs.forEach((_cutoff, index) => {
                const tokens = {
                    input: value("input", index),
                    output: value("output", index),
                    cacheRead: value("cache_read", index),
                    cacheWrite: value("cache_write", index),
                };
                // A model that spent nothing inside this window does not belong to it.
                if (Object.values(tokens).every((count) => count === 0)) return;
                const breakdown = breakdowns[index] as UsageRunBreakdown;
                const models = breakdown[provider] ?? {};
                models[model] = tokens;
                breakdown[provider] = models;
            });
        }
        for (const breakdown of breakdowns) {
            if (!Value.Check(usageRunBreakdownSchema, breakdown)) {
                throw new Error("Usage database returned an invalid model breakdown.");
            }
        }
        return structuredClone(breakdowns);
    }

    /**
     * Inference tokens per provider and model for several rolling windows.
     *
     * The windows are answered together because the widest of them contains all the others.
     */
    async windowUsage(
        ctx: Context,
        cutoffs: readonly number[],
    ): Promise<UsageRunBreakdown[]> {
        if (cutoffs.length === 0) return [];
        const widest = Math.min(...cutoffs);
        return await this.#tokensByModelWindows(
            ctx,
            sql`WHERE ${STARTED_AT} >= ${widest}`,
            cutoffs,
        );
    }

    /** Running totals over a scope, summed by the database rather than by reading records. */
    async #totals(ctx: Context, scope: SQL): Promise<UsageTotals> {
        const rows = await agentDatabaseRows<Record<string, number | string | null>>(
            ctx.db,
            sql`SELECT ${USAGE_SUM_COLUMNS}, ${USAGE_INTEGRITY_COLUMNS}
                FROM ${sql.raw(RECORDS_TABLE)}
                ${scope}`,
        );
        const row = rows[0] ?? {};
        if (Number(row["inconsistent_duration"] ?? 0) > 0) {
            throw new Error("Usage storage holds a record whose duration contradicts its span.");
        }
        return usageTotals(row);
    }

    /** How many provider/model/effort/tier groups a scope has, for paging. */
    async #groupCount(ctx: Context, scope: SQL): Promise<number> {
        const rows = await agentDatabaseRows<{ count: number | string }>(
            ctx.db,
            sql`SELECT COUNT(*) AS count FROM (
                    SELECT 1 FROM ${sql.raw(RECORDS_TABLE)}
                    ${scope}
                    GROUP BY ${PROVIDER}, ${MODEL}, ${EFFORT}, ${TIER}
                )`,
        );
        return Number(rows[0]?.count ?? 0);
    }

    /** One ordered page of provider/model/effort/tier groups. */
    async #groups(
        ctx: Context,
        scope: SQL,
        cursor: number,
        maxGroups: number,
    ): Promise<UsageSummary["groups"]> {
        const rows = await agentDatabaseRows<
            Record<string, number | string | null> & {
                provider: string;
                model: string | null;
                effort: string | null;
                tier: string | null;
            }
        >(
            ctx.db,
            sql`SELECT ${PROVIDER} AS provider, ${MODEL} AS model,
                       ${EFFORT} AS effort, ${TIER} AS tier, ${USAGE_SUM_COLUMNS}
                FROM ${sql.raw(RECORDS_TABLE)}
                ${scope}
                GROUP BY provider, model, effort, tier
                ORDER BY provider, model, effort, tier
                LIMIT ${maxGroups} OFFSET ${cursor}`,
        );
        return rows.map((row) => ({
            provider: row.provider,
            ...(row.model === null ? {} : { model: row.model }),
            ...(row.effort === null
                ? {}
                : { effort: row.effort as NonNullable<UsageGroup["effort"]> }),
            ...(row.tier === null ? {} : { tier: row.tier as NonNullable<UsageGroup["tier"]> }),
            ...usageTotals(row),
        }));
    }

    async aggregate(
        ctx: Context,
        query: UsageAggregateQuery,
        maxGroups: number,
    ): Promise<UsageSummary> {
        if (!Value.Check(usageAggregateQuerySchema, query)) {
            throw new Error("Usage aggregate query is invalid.");
        }
        // History is kept forever, so every total is summed by the database. Reading the records
        // themselves would grow without bound while answering a question about their sums.
        const scope =
            query.agentId === undefined
                ? sql`` // The whole collection.
                : sql`WHERE agent_id = ${query.agentId}`;
        const cursor = query.cursor ?? 0;
        const [totals, groupCount, groupRows, currentContext] = await Promise.all([
            this.#totals(ctx, scope),
            this.#groupCount(ctx, scope),
            this.#groups(ctx, scope, cursor, maxGroups),
            this.currentContext(ctx, query.agentId),
        ]);
        const summary: UsageSummary = {
            ...(query.agentId === undefined ? {} : { agentId: query.agentId }),
            cursor,
            totalGroups: groupCount,
            ...totals,
            ...(currentContext === undefined ? {} : { currentContext }),
            groups: groupRows,
            ...(cursor + groupRows.length < groupCount
                ? { nextCursor: cursor + groupRows.length }
                : {}),
        };
        if (!Value.Check(usageSummarySchema, summary)) {
            throw new Error("Usage database returned an invalid aggregate.");
        }
        return structuredClone(summary);
    }

    async record(ctx: Context, record: UsageRecord): Promise<boolean> {
        assertUsageRecord(record);
        await agentDatabaseRun(
            ctx.db,
            sql`INSERT INTO ${sql.raw(RECORDS_TABLE)}
                    (record_id, agent_id, run_id, finished_at, kind, record_json)
                VALUES (${record.id}, ${record.agentId}, ${record.runId ?? null}, ${record.finishedAt}, ${record.kind}, ${JSON.stringify(record)})`,
        );
        if (record.kind === "inference" && record.model !== undefined) {
            await agentDatabaseRun(
                ctx.db,
                sql`INSERT INTO ${sql.raw(MODEL_TOTALS_TABLE)}
                        (agent_id, provider, model, input_tokens, output_tokens,
                         cache_read_tokens, cache_write_tokens)
                    VALUES (${record.agentId}, ${record.provider}, ${record.model},
                            ${record.tokens.input}, ${record.tokens.output},
                            ${record.tokens.cacheRead ?? 0}, ${record.tokens.cacheWrite ?? 0})
                    ON CONFLICT(agent_id, provider, model) DO UPDATE SET
                        input_tokens = input_tokens + excluded.input_tokens,
                        output_tokens = output_tokens + excluded.output_tokens,
                        cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
                        cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens`,
            );
        }
        if (record.kind === "turn") {
            return await this.#writeCurrentContext(
                ctx,
                record.agentId,
                record.finishedAt,
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
            );
        }
        return false;
    }

    async currentContext(ctx: Context, agentId?: string): Promise<UsageCurrentContext | undefined> {
        const rows = await agentDatabaseRows<{ context_json: string | null }>(
            ctx.db,
            agentId === undefined
                ? sql`SELECT context_json
                      FROM ${sql.raw(CONTEXTS_TABLE)}
                      ORDER BY updated_at DESC, agent_id DESC
                      LIMIT 1`
                : sql`SELECT context_json
                      FROM ${sql.raw(CONTEXTS_TABLE)}
                      WHERE agent_id = ${agentId}
                      LIMIT 1`,
        );
        const encoded = rows[0]?.context_json;
        if (encoded === undefined || encoded === null) return undefined;
        const value: unknown = JSON.parse(encoded);
        if (!Value.Check(usageCurrentContextSchema, value)) {
            throw new Error("Usage database returned an invalid current context.");
        }
        return structuredClone(value);
    }

    async clearCurrentContext(ctx: Context, agentId: string, updatedAt: number): Promise<boolean> {
        return await this.#writeCurrentContext(ctx, agentId, updatedAt, null);
    }

    async reset(ctx: Context, agentId: string | null): Promise<number> {
        const rows = await agentDatabaseRows<{ count: number | string }>(
            ctx.db,
            agentId === null
                ? sql`SELECT COUNT(*) AS count FROM ${sql.raw(RECORDS_TABLE)}`
                : sql`SELECT COUNT(*) AS count FROM ${sql.raw(RECORDS_TABLE)}
                      WHERE agent_id = ${agentId}`,
        );
        const count = Number(rows[0]?.count ?? 0);
        await agentDatabaseRun(
            ctx.db,
            agentId === null
                ? sql`DELETE FROM ${sql.raw(RECORDS_TABLE)}`
                : sql`DELETE FROM ${sql.raw(RECORDS_TABLE)} WHERE agent_id = ${agentId}`,
        );
        await agentDatabaseRun(
            ctx.db,
            agentId === null
                ? sql`DELETE FROM ${sql.raw(MODEL_TOTALS_TABLE)}`
                : sql`DELETE FROM ${sql.raw(MODEL_TOTALS_TABLE)} WHERE agent_id = ${agentId}`,
        );
        await agentDatabaseRun(
            ctx.db,
            agentId === null
                ? sql`DELETE FROM ${sql.raw(CONTEXTS_TABLE)}`
                : sql`DELETE FROM ${sql.raw(CONTEXTS_TABLE)} WHERE agent_id = ${agentId}`,
        );
        return count;
    }

    async #writeCurrentContext(
        ctx: Context,
        agentId: string,
        updatedAt: number,
        context: UsageCurrentContext | null,
    ): Promise<boolean> {
        if (context !== null && !Value.Check(usageCurrentContextSchema, context)) {
            throw new Error("Usage current context is invalid.");
        }
        const encoded = context === null ? null : JSON.stringify(context);
        const previous = await agentDatabaseRows<{ context_json: string | null }>(
            ctx.db,
            sql`SELECT context_json
                FROM ${sql.raw(CONTEXTS_TABLE)}
                WHERE agent_id = ${agentId}
                LIMIT 1`,
        );
        const changed = (previous[0]?.context_json ?? null) !== encoded;
        await agentDatabaseRun(
            ctx.db,
            sql`INSERT INTO ${sql.raw(CONTEXTS_TABLE)} (agent_id, updated_at, context_json)
                VALUES (${agentId}, ${updatedAt}, ${encoded})
                ON CONFLICT(agent_id) DO UPDATE SET
                    updated_at = excluded.updated_at,
                    context_json = excluded.context_json`,
        );
        return changed;
    }

    #parseRecord(encoded: string): UsageRecord {
        const value: unknown = JSON.parse(encoded);
        assertUsageRecord(value);
        return structuredClone(value);
    }
}
