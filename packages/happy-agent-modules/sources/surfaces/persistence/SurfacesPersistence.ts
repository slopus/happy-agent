import {
    AgentKV,
    agentDatabaseRows,
    agentDatabaseRun,
    type AgentDatabase,
    type AgentPersistence,
    type AgentRecord,
    type AgentModuleMigration,
} from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";

/** Module-owned AgentKV storage. Current values and immutable revisions use disjoint prefixes. */
export class SurfacesPersistence implements AgentPersistence {
    constructor(readonly database: AgentDatabase) {}
    transaction<T>(ctx: Context, work: (ctx: Context) => Promise<T>): Promise<T> {
        return ctx.inTx(work);
    }
    async load(_ctx: Context): Promise<readonly AgentRecord[]> {
        throw new Error("Surfaces do not store agent records.");
    }
    async append(_ctx: Context, _record: AgentRecord): Promise<void> {
        throw new Error("Surfaces do not store agent records.");
    }
    async clearRecords(_ctx: Context): Promise<void> {
        throw new Error("Surfaces do not store agent records.");
    }
    async readValues(ctx: Context, prefix: string) {
        const rows = await agentDatabaseRows<{ key: string; value_json: string }>(
            ctx.db,
            sql`SELECT key, value_json FROM happy_agent_surfaces WHERE key >= ${prefix} AND key < ${prefix + "\uffff"} ORDER BY key`,
        );
        return rows.map((row) => ({ key: row.key, value: JSON.parse(row.value_json) as unknown }));
    }
    async queryPage(
        ctx: Context,
        prefix: string,
        after: string,
        limit: number,
    ): Promise<unknown[]> {
        const rows = await agentDatabaseRows<{ value_json: string }>(
            ctx.db,
            sql`SELECT value_json FROM happy_agent_surfaces WHERE key >= ${prefix} AND key < ${prefix + "\uffff"} AND key > ${prefix + after} ORDER BY key LIMIT ${limit}`,
        );
        return rows.map((row) => JSON.parse(row.value_json) as unknown);
    }
    async writeValue(ctx: Context, key: string, value: unknown): Promise<void> {
        await agentDatabaseRun(
            ctx.db,
            sql`INSERT INTO happy_agent_surfaces (key, value_json) VALUES (${key}, ${JSON.stringify(value)}) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
        );
    }
    async writeValueIfAbsent(ctx: Context, key: string, value: unknown): Promise<boolean> {
        const rows = await agentDatabaseRows<{ key: string }>(
            ctx.db,
            sql`INSERT INTO happy_agent_surfaces (key, value_json) VALUES (${key}, ${JSON.stringify(value)}) ON CONFLICT(key) DO NOTHING RETURNING key`,
        );
        return rows.length === 1;
    }
    async deleteValue(ctx: Context, key: string): Promise<void> {
        await agentDatabaseRun(ctx.db, sql`DELETE FROM happy_agent_surfaces WHERE key = ${key}`);
    }
    kv(): AgentKV {
        return new AgentKV(this, "");
    }
    /** Append one change to a document's permanent log; a taken `seq` is an error. */
    async appendDocumentChange(ctx: Context, change: StoredDocumentChange): Promise<void> {
        await agentDatabaseRun(
            ctx.db,
            sql`INSERT INTO happy_agent_surface_document_changes (surface_id, seq, change, entry_json, mutation_id) VALUES (${change.surfaceId}, ${change.seq}, ${change.change}, ${JSON.stringify(change.entry)}, ${change.mutationId})`,
        );
    }
    async documentSeqForMutation(
        ctx: Context,
        surfaceId: string,
        mutationId: string,
    ): Promise<number | undefined> {
        const rows = await agentDatabaseRows<{ seq: number }>(
            ctx.db,
            sql`SELECT seq FROM happy_agent_surface_document_changes WHERE surface_id = ${surfaceId} AND mutation_id = ${mutationId}`,
        );
        return rows[0] === undefined ? undefined : Number(rows[0].seq);
    }
    /** The change bytes of `after < seq <= through`, oldest first. */
    async documentChanges(
        ctx: Context,
        surfaceId: string,
        after: number,
        through: number,
    ): Promise<string[]> {
        const rows = await agentDatabaseRows<{ change: string }>(
            ctx.db,
            sql`SELECT change FROM happy_agent_surface_document_changes WHERE surface_id = ${surfaceId} AND seq > ${after} AND seq <= ${through} ORDER BY seq`,
        );
        return rows.map((row) => row.change);
    }
    /** Log entries without change bytes, oldest first. */
    async documentEntries(
        ctx: Context,
        surfaceId: string,
        after: number,
        limit: number,
    ): Promise<unknown[]> {
        const rows = await agentDatabaseRows<{ entry_json: string }>(
            ctx.db,
            sql`SELECT entry_json FROM happy_agent_surface_document_changes WHERE surface_id = ${surfaceId} AND seq > ${after} ORDER BY seq LIMIT ${limit}`,
        );
        return rows.map((row) => JSON.parse(row.entry_json) as unknown);
    }
    async writeDocumentSnapshot(
        ctx: Context,
        surfaceId: string,
        seq: number,
        state: string,
    ): Promise<void> {
        await agentDatabaseRun(
            ctx.db,
            sql`INSERT INTO happy_agent_surface_document_snapshots (surface_id, seq, state) VALUES (${surfaceId}, ${seq}, ${state})`,
        );
    }
    /** The latest snapshot taken at or before `seq`. */
    async documentSnapshot(
        ctx: Context,
        surfaceId: string,
        seq: number,
    ): Promise<{ seq: number; state: string } | undefined> {
        const rows = await agentDatabaseRows<{ seq: number; state: string }>(
            ctx.db,
            sql`SELECT seq, state FROM happy_agent_surface_document_snapshots WHERE surface_id = ${surfaceId} AND seq <= ${seq} ORDER BY seq DESC LIMIT 1`,
        );
        const row = rows[0];
        return row === undefined ? undefined : { seq: Number(row.seq), state: row.state };
    }
    /** One calendar event's current record, with the instant bounds the range read filters on. */
    async writeCalendarEvent(ctx: Context, row: StoredCalendarEvent): Promise<void> {
        await agentDatabaseRun(
            ctx.db,
            sql`INSERT INTO happy_agent_surface_calendar_events (surface_id, event_id, status, lower_bound, upper_bound, event_json) VALUES (${row.surfaceId}, ${row.eventId}, ${row.status}, ${row.lower}, ${row.upper}, ${JSON.stringify(row.event)}) ON CONFLICT(surface_id, event_id) DO UPDATE SET status = excluded.status, lower_bound = excluded.lower_bound, upper_bound = excluded.upper_bound, event_json = excluded.event_json`,
        );
    }
    async readCalendarEvent(
        ctx: Context,
        surfaceId: string,
        eventId: string,
    ): Promise<unknown | undefined> {
        const rows = await agentDatabaseRows<{ event_json: string }>(
            ctx.db,
            sql`SELECT event_json FROM happy_agent_surface_calendar_events WHERE surface_id = ${surfaceId} AND event_id = ${eventId}`,
        );
        return rows[0] === undefined ? undefined : (JSON.parse(rows[0].event_json) as unknown);
    }
    /** Active events whose bounds overlap `[from, to)`; only these are decoded and expanded. */
    async calendarEventsOverlapping(
        ctx: Context,
        surfaceId: string,
        from: number,
        to: number,
    ): Promise<unknown[]> {
        const rows = await agentDatabaseRows<{ event_json: string }>(
            ctx.db,
            sql`SELECT event_json FROM happy_agent_surface_calendar_events WHERE surface_id = ${surfaceId} AND status = 'active' AND lower_bound < ${to} AND (upper_bound IS NULL OR upper_bound > ${from}) ORDER BY event_id`,
        );
        return rows.map((row) => JSON.parse(row.event_json) as unknown);
    }
}

export type StoredDocumentChange = {
    readonly surfaceId: string;
    readonly seq: number;
    /** The Yjs update, base64. */
    readonly change: string;
    readonly entry: unknown;
    readonly mutationId: string | null;
};

export type StoredCalendarEvent = {
    readonly surfaceId: string;
    readonly eventId: string;
    readonly status: "active" | "deleted";
    /** Padded instant bounds of everything the series can cover; null means it never ends. */
    readonly lower: number;
    readonly upper: number | null;
    readonly event: unknown;
};

export const surfacesMigrations: readonly AgentModuleMigration[] = [
    [
        "001-surfaces",
        async (_ctx, database) => {
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE happy_agent_surfaces (key TEXT PRIMARY KEY, value_json TEXT NOT NULL)`,
            );
        },
    ],
    [
        "002-surface-documents",
        async (_ctx, database) => {
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE happy_agent_surface_document_changes (surface_id TEXT NOT NULL, seq INTEGER NOT NULL, change TEXT NOT NULL, entry_json TEXT NOT NULL, mutation_id TEXT, PRIMARY KEY (surface_id, seq))`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE UNIQUE INDEX happy_agent_surface_document_mutations ON happy_agent_surface_document_changes (surface_id, mutation_id) WHERE mutation_id IS NOT NULL`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE happy_agent_surface_document_snapshots (surface_id TEXT NOT NULL, seq INTEGER NOT NULL, state TEXT NOT NULL, PRIMARY KEY (surface_id, seq))`,
            );
        },
    ],
    [
        "003-surface-calendar-events",
        async (_ctx, database) => {
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE happy_agent_surface_calendar_events (surface_id TEXT NOT NULL, event_id TEXT NOT NULL, status TEXT NOT NULL, lower_bound BIGINT NOT NULL, upper_bound BIGINT, event_json TEXT NOT NULL, PRIMARY KEY (surface_id, event_id))`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE INDEX happy_agent_surface_calendar_event_ranges ON happy_agent_surface_calendar_events (surface_id, status, lower_bound)`,
            );
        },
    ],
    [
        "004-surface-explicit-leaves",
        async (_ctx, database) => {
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE happy_agent_surface_leaves (user_id TEXT NOT NULL, surface_id TEXT NOT NULL, PRIMARY KEY (user_id, surface_id))`,
            );
        },
    ],
    [
        "005-surface-prompt-documents",
        async (_ctx, database) => {
            // The installation's important documents; a null name follows the Surface's own.
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE happy_agent_surface_prompt_documents (surface_id TEXT PRIMARY KEY, name TEXT, description TEXT NOT NULL, marked_at BIGINT NOT NULL, marked_by_agent_id TEXT NOT NULL, updated_at BIGINT NOT NULL)`,
            );
        },
    ],
];
