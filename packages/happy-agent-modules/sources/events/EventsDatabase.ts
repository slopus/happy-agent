import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
    agentDatabaseRows,
    agentDatabaseRun,
    type AgentDatabase,
    type AgentModuleMigration,
} from "@slopus/happy-agent-base";
import { sql } from "drizzle-orm";

import {
    appendEventInputSchema,
    eventIdSchema,
    eventSchema,
    type AgentEvent,
    type AppendEventInput,
} from "./types.js";

const MAX_EVENT_PAYLOAD_BYTES = 5 * 1_024 * 1_024;
/** Replay is expendable; canonical conversation history lives in History. */
export const EVENTS_PAYLOAD_BYTE_CAPACITY = 32 * 1_024 * 1_024;

/**
 * A structured clone keeps a key whose value is `undefined`; JSON drops it. Payloads are recorded
 * as clones, so the durable form tags those values and restores them on the way back rather than
 * quietly losing a key the recorder set.
 */
const UNDEFINED_TAG = "$happyUndefined";

const eventRowSchema = Type.Object(
    {
        agent_id: Type.Union([Type.String(), Type.Null()]),
        event_id: Type.String(),
        occurred_at: Type.Integer(),
        payload_json: Type.String(),
        type: Type.String(),
    },
    { additionalProperties: false },
);
type EventRow = Static<typeof eventRowSchema>;

const stateRowSchema = Type.Object(
    {
        key: Type.String(),
        value: Type.String(),
    },
    { additionalProperties: false },
);
type StateRow = Static<typeof stateRowSchema>;

export const eventsMigrations: readonly AgentModuleMigration[] = [
    [
        "001-durable-events",
        async (_ctx, database) => {
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE IF NOT EXISTS happy_agent_events (
                    event_id TEXT PRIMARY KEY,
                    agent_id TEXT,
                    occurred_at INTEGER NOT NULL,
                    type TEXT NOT NULL,
                    payload_json TEXT NOT NULL
                )`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE INDEX IF NOT EXISTS happy_agent_events_agent_id_event_id
                    ON happy_agent_events(agent_id, event_id)`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE IF NOT EXISTS happy_agent_event_state (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                )`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE IF NOT EXISTS happy_agent_active_runs (
                    agent_id TEXT PRIMARY KEY,
                    state_json TEXT NOT NULL
                )`,
            );
        },
    ],
    [
        "002-latest-agent-events",
        async (_ctx, database) => {
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE IF NOT EXISTS happy_agent_latest_events (
                    agent_id TEXT PRIMARY KEY,
                    event_id TEXT NOT NULL,
                    occurred_at INTEGER NOT NULL,
                    previous_event_id TEXT
                )`,
            );
        },
    ],
    [
        "003-event-payload-bytes",
        async (_ctx, database) => {
            await agentDatabaseRun(
                database,
                sql`ALTER TABLE happy_agent_events
                ADD COLUMN payload_bytes INTEGER NOT NULL DEFAULT 0`,
            );
            await agentDatabaseRun(
                database,
                sql`UPDATE happy_agent_events
                SET payload_bytes = length(CAST(payload_json AS BLOB))`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE INDEX happy_agent_events_retention
                ON happy_agent_events(event_id DESC, payload_bytes)`,
            );
        },
    ],
];

export async function loadEventState(
    database: AgentDatabase,
    capacity: number,
): Promise<{
    readonly events: readonly AgentEvent[];
    readonly originCursor?: string;
}> {
    const boundary = await eventRetentionBoundary(database, capacity);
    const rows = await agentDatabaseRows<EventRow>(
        database,
        sql`SELECT event_id, agent_id, occurred_at, type, payload_json
            FROM happy_agent_events WHERE event_id > ${boundary ?? ""}
            ORDER BY event_id DESC LIMIT ${capacity}`,
    );
    const state = await agentDatabaseRows<StateRow>(
        database,
        sql`SELECT key, value FROM happy_agent_event_state WHERE key = 'origin_cursor'`,
    );
    const storedOrigin = state[0]?.value;
    if (storedOrigin !== undefined && !Value.Check(eventIdSchema, storedOrigin)) {
        throw new Error("The durable agent event origin cursor is invalid.");
    }
    const events = [...rows].reverse().map(eventFromRow);
    let previousOccurredAt = 0;
    for (const event of events) {
        if (event.occurredAt < previousOccurredAt) {
            throw new Error("The durable agent events are not ordered in time.");
        }
        previousOccurredAt = event.occurredAt;
    }
    const first = events[0];
    if (first === undefined) {
        return storedOrigin === undefined ? { events } : { events, originCursor: storedOrigin };
    }
    if (storedOrigin === undefined) {
        throw new Error("The durable agent event origin cursor is missing.");
    }
    // A smaller configured capacity leaves durable events below the retained window. The origin is
    // the newest of those, so a replay from the origin describes exactly what is still here.
    const dropped = await agentDatabaseRows<{ event_id: string }>(
        database,
        sql`SELECT event_id FROM happy_agent_events
            WHERE event_id < ${first.id} ORDER BY event_id DESC LIMIT 1`,
    );
    const originCursor = dropped[0]?.event_id ?? storedOrigin;
    if (originCursor >= first.id) {
        throw new Error("The durable agent event origin cursor is inside the retained window.");
    }
    return { events, originCursor };
}

export async function loadActiveRuns<State>(
    database: AgentDatabase,
    parse: (value: unknown) => State,
): Promise<ReadonlyMap<string, State>> {
    const rows = await agentDatabaseRows<{ agent_id: string; state_json: string }>(
        database,
        sql`SELECT agent_id, state_json FROM happy_agent_active_runs`,
    );
    return new Map(rows.map((row) => [row.agent_id, parse(deserializePayload(row.state_json))]));
}

/**
 * The run of one agent as the current transaction sees it, so work committing together shares one
 * run identity even before that transaction's post-commit state lands.
 */
export async function loadActiveRun<State>(
    database: AgentDatabase,
    agentId: string,
    parse: (value: unknown) => State,
): Promise<State | undefined> {
    const rows = await agentDatabaseRows<{ state_json: string }>(
        database,
        sql`SELECT state_json FROM happy_agent_active_runs WHERE agent_id = ${agentId} LIMIT 1`,
    );
    const row = rows[0];
    return row === undefined ? undefined : parse(deserializePayload(row.state_json));
}

/** The newest event for one agent strictly before `beforeId`, or simply the newest when omitted. */
export async function loadPreviousEventCursor(
    database: AgentDatabase,
    agentId: string,
    beforeId?: string,
): Promise<string | undefined> {
    const rows = await agentDatabaseRows<{ event_id: string }>(
        database,
        beforeId === undefined
            ? sql`SELECT event_id
                FROM happy_agent_events
                WHERE agent_id = ${agentId}
                ORDER BY event_id DESC
                LIMIT 1`
            : sql`SELECT event_id
                FROM happy_agent_events
                WHERE agent_id = ${agentId} AND event_id < ${beforeId}
                ORDER BY event_id DESC
                LIMIT 1`,
    );
    if (rows[0] !== undefined) return rows[0].event_id;
    const retained = await agentDatabaseRows<{
        event_id: string;
        previous_event_id: string | null;
    }>(
        database,
        beforeId === undefined
            ? sql`SELECT event_id, previous_event_id
                FROM happy_agent_latest_events
                WHERE agent_id = ${agentId}
                LIMIT 1`
            : sql`SELECT event_id, previous_event_id
                FROM happy_agent_latest_events
                WHERE agent_id = ${agentId} AND event_id = ${beforeId}
                LIMIT 1`,
    );
    const latest = retained[0];
    if (latest === undefined) return undefined;
    return beforeId === undefined ? latest.event_id : (latest.previous_event_id ?? undefined);
}

/** The exact newest durable event identity and timestamp for one agent. */
export async function loadLatestAgentEvent(
    database: AgentDatabase,
    agentId: string,
): Promise<{ readonly cursor: string; readonly occurredAt: number } | undefined> {
    const rows = await agentDatabaseRows<{ event_id: string; occurred_at: number | string }>(
        database,
        sql`SELECT event_id, occurred_at
            FROM happy_agent_latest_events
            WHERE agent_id = ${agentId}
            LIMIT 1`,
    );
    const row = rows[0];
    if (row === undefined) return undefined;
    const occurredAt = Number(row.occurred_at);
    if (!Number.isSafeInteger(occurredAt) || occurredAt < 0) {
        throw new Error("The durable agent event timestamp is invalid.");
    }
    return { cursor: row.event_id, occurredAt };
}

export async function insertEvent(
    database: AgentDatabase,
    event: AgentEvent,
    capacity: number,
): Promise<string | undefined> {
    const payload = serializePayload(event.payload);
    const previous =
        event.agentId === undefined
            ? undefined
            : (
                  await agentDatabaseRows<{ event_id: string }>(
                      database,
                      sql`SELECT event_id
                          FROM happy_agent_latest_events
                          WHERE agent_id = ${event.agentId}
                          LIMIT 1`,
                  )
              )[0]?.event_id;
    await agentDatabaseRun(
        database,
        sql`INSERT INTO happy_agent_events (
                event_id, agent_id, occurred_at, type, payload_json, payload_bytes
            ) VALUES (
                ${event.id}, ${event.agentId ?? null}, ${event.occurredAt}, ${event.type}, ${payload},
                ${Buffer.byteLength(payload, "utf8")}
            )`,
    );
    if (event.agentId !== undefined) {
        await agentDatabaseRun(
            database,
            sql`INSERT INTO happy_agent_latest_events (
                    agent_id, event_id, occurred_at, previous_event_id
                ) VALUES (
                    ${event.agentId}, ${event.id}, ${event.occurredAt}, ${previous ?? null}
                )
                ON CONFLICT(agent_id) DO UPDATE SET
                    event_id = excluded.event_id,
                    occurred_at = excluded.occurred_at,
                    previous_event_id = excluded.previous_event_id`,
        );
    }
    const through = await eventRetentionBoundary(database, capacity);
    if (through === undefined) return;
    await agentDatabaseRun(
        database,
        sql`DELETE FROM happy_agent_events WHERE event_id <= ${through}`,
    );
    await saveState(database, "origin_cursor", through);
    return through;
}

/** Inspect only the covering size index, never deserialize the discarded transcript payloads. */
async function eventRetentionBoundary(
    database: AgentDatabase,
    capacity: number,
): Promise<string | undefined> {
    const totals = await agentDatabaseRows<{ count: number; bytes: number | null }>(
        database,
        sql`SELECT count(*) AS count, sum(payload_bytes) AS bytes FROM happy_agent_events`,
    );
    if (totals[0]!.count <= capacity && (totals[0]!.bytes ?? 0) <= EVENTS_PAYLOAD_BYTE_CAPACITY)
        return undefined;
    const rows = await agentDatabaseRows<{ event_id: string }>(
        database,
        sql`
        SELECT event_id FROM (
            SELECT event_id,
                row_number() OVER (ORDER BY event_id DESC) AS position,
                sum(payload_bytes) OVER (ORDER BY event_id DESC) AS bytes
            FROM happy_agent_events
        ) WHERE position > ${capacity} OR bytes > ${EVENTS_PAYLOAD_BYTE_CAPACITY}
        ORDER BY event_id DESC LIMIT 1`,
    );
    return rows[0]?.event_id;
}

export async function trimEvents(
    database: AgentDatabase,
    through: string,
): Promise<number | undefined> {
    const exact = await agentDatabaseRows<{ event_id: string }>(
        database,
        sql`SELECT event_id FROM happy_agent_events WHERE event_id = ${through} LIMIT 1`,
    );
    if (exact.length === 0) return undefined;
    const rows = await agentDatabaseRows<{ count: number | string }>(
        database,
        sql`SELECT COUNT(*) AS count FROM happy_agent_events WHERE event_id <= ${through}`,
    );
    const count = Number(rows[0]?.count ?? 0);
    if (count === 0) return undefined;
    await agentDatabaseRun(
        database,
        sql`DELETE FROM happy_agent_events WHERE event_id <= ${through}`,
    );
    await saveState(database, "origin_cursor", through);
    return count;
}

export async function saveOriginCursor(database: AgentDatabase, cursor: string): Promise<void> {
    await agentDatabaseRun(
        database,
        sql`INSERT INTO happy_agent_event_state (key, value)
            VALUES ('origin_cursor', ${cursor}) ON CONFLICT(key) DO NOTHING`,
    );
}

export async function saveActiveRun(
    database: AgentDatabase,
    agentId: string,
    state: unknown,
): Promise<void> {
    const encoded = serializePayload(state);
    await agentDatabaseRun(
        database,
        sql`INSERT INTO happy_agent_active_runs (agent_id, state_json)
            VALUES (${agentId}, ${encoded})
            ON CONFLICT(agent_id) DO UPDATE SET state_json = excluded.state_json`,
    );
}

export async function deleteActiveRun(database: AgentDatabase, agentId: string): Promise<void> {
    await agentDatabaseRun(
        database,
        sql`DELETE FROM happy_agent_active_runs WHERE agent_id = ${agentId}`,
    );
}

function eventFromRow(input: unknown): AgentEvent {
    if (!Value.Check(eventRowSchema, input)) throw new Error("A durable agent event is invalid.");
    const event = {
        ...(input.agent_id === null ? {} : { agentId: input.agent_id }),
        id: input.event_id,
        occurredAt: input.occurred_at,
        payload: deserializePayload(input.payload_json),
        type: input.type,
    };
    if (!Value.Check(eventSchema, event)) {
        throw new Error("A durable agent event payload is invalid.");
    }
    return event;
}

function serializePayload(payload: unknown): string {
    let encoded: string | undefined;
    try {
        encoded = JSON.stringify(payload, (_key, value: unknown) =>
            value === undefined
                ? { [UNDEFINED_TAG]: true }
                : typeof value === "bigint"
                  ? value.toString()
                  : value,
        );
    } catch {
        throw new Error("The agent event payload must be JSON serializable.");
    }
    if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > MAX_EVENT_PAYLOAD_BYTES) {
        throw new Error("The agent event payload exceeds the 5 MiB durable limit.");
    }
    return encoded;
}

function deserializePayload(encoded: string): unknown {
    if (Buffer.byteLength(encoded, "utf8") > MAX_EVENT_PAYLOAD_BYTES) {
        throw new Error("The agent event payload exceeds the 5 MiB durable limit.");
    }
    return restoreUndefined(JSON.parse(encoded));
}

function restoreUndefined(value: unknown): unknown {
    if (Array.isArray(value)) {
        const items = value as unknown[];
        for (let index = 0; index < items.length; index += 1) {
            items[index] = restoreUndefined(items[index]);
        }
        return items;
    }
    if (value === null || typeof value !== "object") return value;
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length === 1 && record[UNDEFINED_TAG] === true) return undefined;
    for (const key of keys) record[key] = restoreUndefined(record[key]);
    return record;
}

async function saveState(database: AgentDatabase, key: string, value: string): Promise<void> {
    await agentDatabaseRun(
        database,
        sql`INSERT INTO happy_agent_event_state (key, value) VALUES (${key}, ${value})
            ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    );
}

export function validateAppendEvent(input: AppendEventInput): void {
    if (!Value.Check(appendEventInputSchema, input)) {
        throw new Error("The event input is invalid.");
    }
    serializePayload(input.payload);
}
