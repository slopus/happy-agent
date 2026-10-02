import {
    agentDatabaseRows,
    agentDatabaseRun,
    type AgentModuleMigration,
} from "@slopus/happy-agent-base";
import { liveSessionSchema, type LiveSession } from "@slopus/happy-agent-client";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";

export const liveMigrations: readonly AgentModuleMigration[] = [
    [
        "001-live-sessions",
        async (_ctx, db) => {
            await agentDatabaseRun(
                db,
                sql`CREATE TABLE happy_live_sessions (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, window_id TEXT NOT NULL,
        status TEXT NOT NULL, updated_at INTEGER NOT NULL, session_json TEXT NOT NULL
    )`,
            );
            await agentDatabaseRun(
                db,
                sql`CREATE INDEX happy_live_owner ON happy_live_sessions(owner_id, updated_at)`,
            );
            await agentDatabaseRun(
                db,
                sql`CREATE UNIQUE INDEX happy_live_window ON happy_live_sessions(owner_id, window_id)
        WHERE status IN ('starting', 'active', 'closing')`,
            );
        },
    ],
];

const storedSchema = Type.Object({ ownerId: Type.String(), session: liveSessionSchema });
export type StoredLiveSession = Static<typeof storedSchema>;

function decode(ownerId: string, json: string): StoredLiveSession {
    const value: unknown = { ownerId, session: JSON.parse(json) };
    if (!Value.Check(storedSchema, value)) throw new Error("The stored voice session is invalid.");
    return value;
}

export async function readLiveSession(
    ctx: Context,
    id: string,
    ownerId: string,
): Promise<LiveSession | undefined> {
    const rows = await agentDatabaseRows<{ session_json: string }>(
        ctx.db,
        sql`SELECT session_json FROM happy_live_sessions WHERE id = ${id} AND owner_id = ${ownerId}`,
    );
    return rows[0] === undefined ? undefined : decode(ownerId, rows[0].session_json).session;
}

export async function liveSessionExists(ctx: Context, id: string): Promise<boolean> {
    return (
        (await agentDatabaseRows(ctx.db, sql`SELECT id FROM happy_live_sessions WHERE id=${id}`))
            .length !== 0
    );
}

export async function activeLiveSessions(
    ctx: Context,
    ownerId?: string,
): Promise<StoredLiveSession[]> {
    const owner = ownerId === undefined ? sql`` : sql`AND owner_id = ${ownerId}`;
    const rows = await agentDatabaseRows<{ owner_id: string; session_json: string }>(
        ctx.db,
        sql`SELECT owner_id, session_json FROM happy_live_sessions WHERE status IN ('starting','active','closing') ${owner}`,
    );
    return rows.map((row) => decode(row.owner_id, row.session_json));
}

export async function saveLiveSession(
    ctx: Context,
    ownerId: string,
    session: LiveSession,
): Promise<void> {
    if (!Value.Check(liveSessionSchema, session)) throw new Error("The voice session is invalid.");
    await agentDatabaseRun(
        ctx.db,
        sql`INSERT INTO happy_live_sessions(id,owner_id,window_id,status,updated_at,session_json)
        VALUES (${session.id},${ownerId},${session.windowId},${session.status},${session.updatedAt},${JSON.stringify(session)})
        ON CONFLICT(id) DO UPDATE SET status=excluded.status,updated_at=excluded.updated_at,session_json=excluded.session_json`,
    );
}

/** Retention is selective in SQL: never deserialize another owner's terminal history. */
export async function pruneLiveSessions(ctx: Context, ownerId: string, now: number): Promise<void> {
    await agentDatabaseRun(
        ctx.db,
        sql`DELETE FROM happy_live_sessions WHERE owner_id=${ownerId}
        AND status IN ('closed','failed') AND (updated_at < ${now - 7 * 86400_000} OR id IN (
            SELECT id FROM happy_live_sessions WHERE owner_id=${ownerId} AND status IN ('closed','failed')
            ORDER BY updated_at DESC,id DESC LIMIT -1 OFFSET 1000
        ))`,
    );
}
