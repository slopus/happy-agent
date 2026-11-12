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
    type UsageRunTokens,
    type UsageSummary,
} from "../Usage.js";
import { assertUsageRecord } from "./assertUsageRecord.js";
import { currentContextFromRecord } from "./currentContextFromRecord.js";
import type { OffsetSegment } from "./localCalendar.js";
import { USAGE_BUCKET_MS, USAGE_INDEXED_STARTED_AT } from "./usageHourlyTotalsMigration.js";

const RECORDS_TABLE = "happy_agent_usage_records";
const CONTEXTS_TABLE = "happy_agent_usage_contexts";
const MODEL_TOTALS_TABLE = "happy_agent_usage_model_totals";
const HOURLY_TOTALS_TABLE = "happy_agent_usage_hourly_totals";
const DAY_MS = 24 * USAGE_BUCKET_MS;

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

    /** Every listed run's usage from one grouped pass, in the order the runs were given. */
    async runs(
        ctx: Context,
        agentId: string,
        runIds: readonly string[],
    ): Promise<UsageRunSummary[]> {
        for (const runId of runIds) {
            if (!Value.Check(usageRunIdSchema, runId)) {
                throw new Error("Usage run ID is invalid.");
            }
        }
        const unique = [...new Set(runIds)];
        const usageByRun = new Map<string, UsageRunBreakdown>(unique.map((runId) => [runId, {}]));
        if (unique.length > 0) {
            const rows = await agentDatabaseRows<Record<string, number | string | null>>(
                ctx.db,
                sql`SELECT run_id, ${PROVIDER} AS provider, ${MODEL} AS model,
                           COALESCE(SUM(${INPUT_TOKENS}), 0) AS input,
                           COALESCE(SUM(${OUTPUT_TOKENS}), 0) AS output,
                           COALESCE(SUM(${CACHE_READ_TOKENS}), 0) AS cache_read,
                           COALESCE(SUM(${CACHE_WRITE_TOKENS}), 0) AS cache_write,
                           ${USAGE_INTEGRITY_COLUMNS}
                    FROM ${sql.raw(RECORDS_TABLE)}
                    WHERE agent_id = ${agentId}
                      AND run_id IN (${sql.join(
                          unique.map((runId) => sql`${runId}`),
                          sql`, `,
                      )})
                      AND kind = 'inference' AND ${MODEL} IS NOT NULL
                    GROUP BY run_id, provider, model
                    ORDER BY run_id, provider, model`,
            );
            for (const row of rows) {
                if (Number(row["inconsistent_duration"] ?? 0) > 0) {
                    throw new Error(
                        "Usage storage holds a record whose duration contradicts its span.",
                    );
                }
                const tokens = {
                    input: Number(row["input"] ?? 0),
                    output: Number(row["output"] ?? 0),
                    cacheRead: Number(row["cache_read"] ?? 0),
                    cacheWrite: Number(row["cache_write"] ?? 0),
                };
                // Matches the single-run breakdown, which leaves out models that spent nothing.
                if (Object.values(tokens).every((count) => count === 0)) continue;
                const usage = usageByRun.get(String(row["run_id"])) as UsageRunBreakdown;
                const provider = String(row["provider"]);
                const models = usage[provider] ?? {};
                models[String(row["model"])] = tokens;
                usage[provider] = models;
            }
        }
        const summaries = runIds.map<UsageRunSummary>((runId) => ({
            agentId,
            runId,
            usage: structuredClone(usageByRun.get(runId) as UsageRunBreakdown),
            costUsd: null,
        }));
        for (const summary of summaries) {
            if (!Value.Check(usageRunSummarySchema, summary)) {
                throw new Error("Usage database returned invalid run usage.");
            }
        }
        return summaries;
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
     * Every whole hour of a window comes from the hourly totals, all windows in one pass over
     * them, since the widest contains the rest. The partial hour before a window's first whole
     * one comes from the records started inside it, found through the start-time index, so each
     * window still begins at its exact millisecond. Neither read grows with history: the totals
     * hold one row per model per hour, and an edge holds less than an hour of records.
     *
     * The buckets count the records whose duration contradicts their span, and the edge reads
     * check their own rows, so a window over a record that contradicts itself is still refused.
     * Both reads share one transaction, so every window describes the same moment.
     */
    async windowUsage(ctx: Context, cutoffs: readonly number[]): Promise<UsageRunBreakdown[]> {
        if (cutoffs.length === 0) return [];
        return await ctx.inTx(async (txCtx) => await this.#windowUsage(txCtx, cutoffs));
    }

    /**
     * Sum hourly totals from `from` onward into local days, and find the first hour that spent
     * any tokens at all. Each run of `segments` shares one offset from UTC, so the database
     * shifts every hour by its run's offset and groups by the resulting day number.
     */
    async dailyUsage(
        ctx: Context,
        from: number,
        segments: readonly OffsetSegment[],
    ): Promise<{
        readonly days: readonly {
            readonly day: number;
            readonly provider: string;
            readonly model: string;
            readonly tokens: UsageRunTokens;
        }[];
        readonly firstBucket: number | null;
    }> {
        return await ctx.inTx(async (txCtx) => {
            const offset = sql.join(
                [
                    sql`CASE`,
                    ...segments
                        .map(
                            (segment) =>
                                sql`WHEN bucket_start >= ${segment.start} THEN ${segment.offsetMs}`,
                        )
                        .reverse(),
                    sql`ELSE ${segments[0]?.offsetMs ?? 0} END`,
                ],
                sql` `,
            );
            const spent = sql`(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) > 0`;
            const rows = await agentDatabaseRows<Record<string, number | string | null>>(
                txCtx.db,
                sql`SELECT CAST((bucket_start + ${offset}) / ${sql.raw(String(DAY_MS))} AS INTEGER) AS day, provider, model,
                           SUM(input_tokens) AS input, SUM(output_tokens) AS output,
                           SUM(cache_read_tokens) AS cache_read,
                           SUM(cache_write_tokens) AS cache_write,
                           SUM(inconsistent_records) AS inconsistent_duration
                    FROM ${sql.raw(HOURLY_TOTALS_TABLE)}
                    WHERE bucket_start >= ${from} AND ${spent}
                    GROUP BY day, provider, model
                    ORDER BY day, provider, model`,
            );
            const first = await agentDatabaseRows<{ bucket: number | null }>(
                txCtx.db,
                sql`SELECT bucket_start AS bucket FROM ${sql.raw(HOURLY_TOTALS_TABLE)}
                    WHERE ${spent} ORDER BY bucket_start LIMIT 1`,
            );
            const days = rows.map((row) => {
                if (Number(row["inconsistent_duration"] ?? 0) > 0) {
                    throw new Error(
                        "Usage storage holds a record whose duration contradicts its span.",
                    );
                }
                return {
                    day: Number(row["day"]),
                    provider: String(row["provider"]),
                    model: String(row["model"]),
                    tokens: {
                        input: Number(row["input"] ?? 0),
                        output: Number(row["output"] ?? 0),
                        cacheRead: Number(row["cache_read"] ?? 0),
                        cacheWrite: Number(row["cache_write"] ?? 0),
                    },
                };
            });
            const bucket = first[0]?.bucket;
            return {
                days,
                firstBucket: bucket === null || bucket === undefined ? null : Number(bucket),
            };
        });
    }

    async #windowUsage(ctx: Context, cutoffs: readonly number[]): Promise<UsageRunBreakdown[]> {
        const firstBuckets = cutoffs.map((cutoff) =>
            cutoff % USAGE_BUCKET_MS === 0
                ? cutoff
                : cutoff - (cutoff % USAGE_BUCKET_MS) + USAGE_BUCKET_MS,
        );
        // The window starts cut the buckets into segments. Each bucket is summed into its segment
        // once, and a window is the segments from its own start onward.
        const segments = [...new Set(firstBuckets)].sort((a, b) => a - b);
        const segment = sql.join(
            [
                sql`CASE`,
                ...segments
                    .map((start, index) => sql`WHEN bucket_start >= ${start} THEN ${index}`)
                    .reverse(),
                sql`END`,
            ],
            sql` `,
        );
        const rows = await agentDatabaseRows<Record<string, number | string | null>>(
            ctx.db,
            sql`SELECT provider, model, ${segment} AS segment,
                       SUM(input_tokens) AS input, SUM(output_tokens) AS output,
                       SUM(cache_read_tokens) AS cache_read, SUM(cache_write_tokens) AS cache_write,
                       SUM(inconsistent_records) AS inconsistent_duration
                FROM ${sql.raw(HOURLY_TOTALS_TABLE)}
                WHERE bucket_start >= ${segments[0] as number}
                GROUP BY provider, model, segment`,
        );
        const windows = cutoffs.map(() => new Map<string, UsageRunTokens>());
        const add = (index: number, provider: string, model: string, tokens: UsageRunTokens) => {
            const key = JSON.stringify([provider, model]);
            const window = windows[index] as Map<string, UsageRunTokens>;
            const sum = window.get(key) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
            window.set(key, {
                input: sum.input + tokens.input,
                output: sum.output + tokens.output,
                cacheRead: sum.cacheRead + tokens.cacheRead,
                cacheWrite: sum.cacheWrite + tokens.cacheWrite,
            });
        };
        for (const row of rows) {
            if (Number(row["inconsistent_duration"] ?? 0) > 0) {
                throw new Error(
                    "Usage storage holds a record whose duration contradicts its span.",
                );
            }
            const start = segments[Number(row["segment"])] as number;
            const tokens = {
                input: Number(row["input"] ?? 0),
                output: Number(row["output"] ?? 0),
                cacheRead: Number(row["cache_read"] ?? 0),
                cacheWrite: Number(row["cache_write"] ?? 0),
            };
            firstBuckets.forEach((firstBucket, index) => {
                if (start >= firstBucket) {
                    add(index, String(row["provider"]), String(row["model"]), tokens);
                }
            });
        }
        for (const [index, cutoff] of cutoffs.entries()) {
            const firstBucket = firstBuckets[index] as number;
            if (cutoff === firstBucket) continue;
            const edge = await this.#tokensByModel(
                ctx,
                sql`WHERE kind = 'inference'
                      AND ${sql.raw(USAGE_INDEXED_STARTED_AT)} >= ${cutoff}
                      AND ${sql.raw(USAGE_INDEXED_STARTED_AT)} < ${firstBucket}
                      AND json_type(record_json, '$.startedAt') = 'integer'`,
            );
            for (const [provider, models] of Object.entries(edge)) {
                for (const [model, tokens] of Object.entries(models)) {
                    add(index, provider, model, tokens);
                }
            }
        }
        const breakdowns = windows.map((window) => {
            const breakdown: UsageRunBreakdown = {};
            const entries = [...window.entries()]
                .map(([key, tokens]) => [JSON.parse(key) as [string, string], tokens] as const)
                .sort(([a], [b]) => compareKeys(a, b));
            for (const [[provider, model], tokens] of entries) {
                // A model that spent nothing inside this window does not belong to it.
                if (Object.values(tokens).every((count) => count === 0)) continue;
                const models = breakdown[provider] ?? {};
                models[model] = tokens;
                breakdown[provider] = models;
            }
            return breakdown;
        });
        for (const breakdown of breakdowns) {
            if (!Value.Check(usageRunBreakdownSchema, breakdown)) {
                throw new Error("Usage database returned an invalid model breakdown.");
            }
        }
        return breakdowns;
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
        const currentContext = currentContextFromRecord(record);
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
        return await this.#writeCurrentContext(
            ctx,
            record.agentId,
            record.finishedAt,
            currentContext,
        );
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

/** Provider, then model, in the order the record-scanning reads have always returned them. */
function compareKeys(a: readonly [string, string], b: readonly [string, string]): number {
    if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
    if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
    return 0;
}
