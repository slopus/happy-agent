import { sql } from "drizzle-orm";
import { agentDatabaseRows, agentDatabaseRun } from "@slopus/happy-agent-base";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

import {
    MAX_USAGE_RECORDS,
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

export class UsageDatabase {
    async run(ctx: Context, agentId: string, runId: string): Promise<UsageRunSummary> {
        if (!Value.Check(usageRunIdSchema, runId)) {
            throw new Error("Usage run ID is invalid.");
        }
        const rows = await agentDatabaseRows<{ record_json: string }>(
            ctx.db,
            sql`SELECT record_json
                FROM ${sql.raw(RECORDS_TABLE)}
                WHERE agent_id = ${agentId} AND run_id = ${runId} AND kind = 'inference'
                ORDER BY finished_at, record_id
                LIMIT ${MAX_USAGE_RECORDS}`,
        );
        const usage: UsageRunSummary["usage"] = {};
        for (const row of rows) {
            const record = this.#parseRecord(row.record_json);
            if (record.kind !== "inference" || record.model === undefined) continue;
            const models = usage[record.provider] ?? {};
            const previous = models[record.model] ?? {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
            };
            models[record.model] = {
                input: previous.input + record.tokens.input,
                output: previous.output + record.tokens.output,
                cacheRead: previous.cacheRead + (record.tokens.cacheRead ?? 0),
                cacheWrite: previous.cacheWrite + (record.tokens.cacheWrite ?? 0),
            };
            usage[record.provider] = models;
        }
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
            totalRecords: Math.min(MAX_USAGE_RECORDS, totalRecords),
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

    async aggregate(
        ctx: Context,
        query: UsageAggregateQuery,
        maxGroups: number,
    ): Promise<UsageSummary> {
        if (!Value.Check(usageAggregateQuerySchema, query)) {
            throw new Error("Usage aggregate query is invalid.");
        }
        const rows = await agentDatabaseRows<{ record_json: string }>(
            ctx.db,
            query.agentId === undefined
                ? sql`SELECT record_json
                      FROM ${sql.raw(RECORDS_TABLE)}
                      ORDER BY finished_at, record_id
                      LIMIT ${MAX_USAGE_RECORDS}`
                : sql`SELECT record_json
                      FROM ${sql.raw(RECORDS_TABLE)}
                      WHERE agent_id = ${query.agentId}
                      ORDER BY finished_at, record_id
                      LIMIT ${MAX_USAGE_RECORDS}`,
        );
        const records = rows.map((row) => this.#parseRecord(row.record_json));
        const groups = new Map<string, UsageSummary["groups"][number]>();
        for (const record of records) {
            const key = JSON.stringify([
                record.provider,
                record.model ?? null,
                record.effort ?? null,
                record.tier ?? null,
            ]);
            const previous = groups.get(key);
            const next =
                previous === undefined
                    ? {
                          provider: record.provider,
                          ...(record.model === undefined ? {} : { model: record.model }),
                          ...(record.effort === undefined ? {} : { effort: record.effort }),
                          ...(record.tier === undefined ? {} : { tier: record.tier }),
                          inferenceCount: 0,
                          turnCount: 0,
                          inputTokens: 0,
                          outputTokens: 0,
                          totalTokens: 0,
                          inferenceDurationMs: 0,
                          turnDurationMs: 0,
                          totalDurationMs: 0,
                      }
                    : { ...previous };
            if (record.kind === "inference") {
                next.inferenceCount += 1;
                next.inputTokens += record.tokens.input;
                next.outputTokens += record.tokens.output;
                next.totalTokens += record.tokens.input + record.tokens.output;
                next.inferenceDurationMs += record.durationMs;
            } else {
                next.turnCount += 1;
                next.turnDurationMs += record.durationMs;
            }
            next.totalDurationMs = next.inferenceDurationMs + next.turnDurationMs;
            groups.set(key, next);
        }
        const allGroups = [...groups.values()];
        const cursor = query.cursor ?? 0;
        const page = allGroups.slice(cursor, cursor + maxGroups);
        const currentContext = await this.currentContext(ctx, query.agentId);
        const summary: UsageSummary = {
            ...(query.agentId === undefined ? {} : { agentId: query.agentId }),
            cursor,
            totalGroups: allGroups.length,
            inferenceCount: records.filter((record) => record.kind === "inference").length,
            turnCount: records.filter((record) => record.kind === "turn").length,
            inputTokens: records.reduce(
                (sum, record) => sum + (record.kind === "inference" ? record.tokens.input : 0),
                0,
            ),
            outputTokens: records.reduce(
                (sum, record) => sum + (record.kind === "inference" ? record.tokens.output : 0),
                0,
            ),
            totalTokens: records.reduce(
                (sum, record) =>
                    sum +
                    (record.kind === "inference" ? record.tokens.input + record.tokens.output : 0),
                0,
            ),
            inferenceDurationMs: records.reduce(
                (sum, record) => sum + (record.kind === "inference" ? record.durationMs : 0),
                0,
            ),
            turnDurationMs: records.reduce(
                (sum, record) => sum + (record.kind === "turn" ? record.durationMs : 0),
                0,
            ),
            totalDurationMs: records.reduce((sum, record) => sum + record.durationMs, 0),
            ...(currentContext === undefined ? {} : { currentContext }),
            groups: page,
            ...(cursor + page.length < allGroups.length
                ? { nextCursor: cursor + page.length }
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
        await agentDatabaseRun(
            ctx.db,
            sql`DELETE FROM ${sql.raw(RECORDS_TABLE)}
                WHERE record_id IN (
                    SELECT record_id FROM ${sql.raw(RECORDS_TABLE)}
                    ORDER BY finished_at DESC, record_id DESC
                    LIMIT 9223372036854775807 OFFSET ${MAX_USAGE_RECORDS}
                )`,
        );
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
        const count = Math.min(MAX_USAGE_RECORDS, Number(rows[0]?.count ?? 0));
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
