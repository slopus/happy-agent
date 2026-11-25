import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
    agentDatabase,
    agentDatabaseRows,
    agentDatabaseRun,
    type AgentModuleMigration,
} from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";

const instantSchema = Type.Integer({ minimum: 0 });

/** The latest refused or failed renewal of an account's login in its current failure streak. */
export const providerAccountRefreshErrorSchema = Type.Object(
    {
        status: Type.Union([Type.Integer({ minimum: 100, maximum: 599 }), Type.Null()]),
        code: Type.Union([Type.String({ pattern: "^[a-z0-9_]{1,64}$" }), Type.Null()]),
        permanent: Type.Boolean(),
        since: instantSchema,
        at: instantSchema,
    },
    { additionalProperties: false },
);
export type ProviderAccountRefreshError = Static<typeof providerAccountRefreshErrorSchema>;

/** What the daemon remembers about one account across restarts. */
export interface ProviderAccountActivity {
    readonly lastUsedAt: number | null;
    readonly refreshError: ProviderAccountRefreshError | null;
}

const rowSchema = Type.Object({
    provider_id: Type.String({ minLength: 1 }),
    last_used_at: Type.Union([instantSchema, Type.Null()]),
    refresh_error: Type.Union([Type.String(), Type.Null()]),
});

export const providerAccountActivityMigrations: readonly AgentModuleMigration[] = [
    [
        "001-provider-account-activity",
        async (_ctx, database) => {
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE happy_agent_provider_account_activity (
                    provider_id TEXT PRIMARY KEY,
                    last_used_at INTEGER,
                    refresh_error TEXT
                )`,
            );
        },
    ],
];

/**
 * The remembered activity of the given accounts. Rows of accounts no longer configured are
 * deleted, so the table never outgrows the configuration. Empty without a database.
 */
export async function readProviderAccountActivity(
    ctx: Context,
    providerIds: readonly string[],
): Promise<Map<string, ProviderAccountActivity>> {
    const activity = new Map<string, ProviderAccountActivity>();
    if (agentDatabase(ctx) === undefined) return activity;
    const configured = new Set(providerIds);
    await ctx.inTx(async (txCtx) => {
        const rows = await agentDatabaseRows<unknown>(
            txCtx.db,
            sql`SELECT provider_id, last_used_at, refresh_error
                FROM happy_agent_provider_account_activity`,
        );
        for (const row of rows) {
            if (!Value.Check(rowSchema, row)) continue;
            if (!configured.has(row.provider_id)) {
                await agentDatabaseRun(
                    txCtx.db,
                    sql`DELETE FROM happy_agent_provider_account_activity
                        WHERE provider_id = ${row.provider_id}`,
                );
                continue;
            }
            activity.set(row.provider_id, {
                lastUsedAt: row.last_used_at,
                refreshError: parseRefreshError(row.refresh_error),
            });
        }
    });
    return activity;
}

/** Remember one account's activity, replacing what was remembered. Nothing without a database. */
export async function writeProviderAccountActivity(
    ctx: Context,
    providerId: string,
    activity: ProviderAccountActivity,
): Promise<void> {
    if (agentDatabase(ctx) === undefined) return;
    const refreshError =
        activity.refreshError === null ? null : JSON.stringify(activity.refreshError);
    await ctx.inTx(async (txCtx) => {
        await agentDatabaseRun(
            txCtx.db,
            sql`INSERT INTO happy_agent_provider_account_activity
                    (provider_id, last_used_at, refresh_error)
                VALUES (${providerId}, ${activity.lastUsedAt}, ${refreshError})
                ON CONFLICT (provider_id) DO UPDATE SET
                    last_used_at = excluded.last_used_at,
                    refresh_error = excluded.refresh_error`,
        );
    });
}

function parseRefreshError(value: string | null): ProviderAccountRefreshError | null {
    if (value === null) return null;
    try {
        const parsed: unknown = JSON.parse(value);
        return Value.Check(providerAccountRefreshErrorSchema, parsed) ? parsed : null;
    } catch {
        return null;
    }
}
