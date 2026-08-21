import {
    agentDatabaseRows,
    agentDatabaseRun,
    type AgentModuleMigration,
} from "@slopus/happy-agent-base";
import { Value } from "@sinclair/typebox/value";
import { sql } from "drizzle-orm";
import type { Context } from "@steve.kite/stdlib";

import {
    happyOutboxEntrySchema,
    happySessionTag,
    happySyncSessionSchema,
    MAX_HAPPY_MESSAGES_PER_EVENT,
    MAX_HAPPY_OUTBOX_MESSAGE_CHARACTERS,
    MAX_HAPPY_OUTBOX_MESSAGES,
    type HappyOutboxEntry,
    type HappyOutboxMessage,
    type HappyProjectionOutcome,
    type HappySyncSession,
    type HappySyncSessionInput,
} from "./HappySync.js";

export const HAPPY_SYNC_MIGRATION_KEY = "001-happy-sync";

const SESSIONS_TABLE = "happy_agent_happy_sessions";
const OUTBOX_TABLE = "happy_agent_happy_outbox";

/** How many messages may wait behind a full ready queue before projection stalls. */
export const MAX_HAPPY_OUTBOX_DEFERRED_MESSAGES = 10_000;

export const happySyncMigrations: readonly AgentModuleMigration[] = [
    [
        HAPPY_SYNC_MIGRATION_KEY,
        async (_ctx, database) => {
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE IF NOT EXISTS ${sql.raw(SESSIONS_TABLE)} (
                    agent_id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    credential_fingerprint TEXT NOT NULL,
                    tag TEXT NOT NULL,
                    remote_session_id TEXT,
                    encryption_variant TEXT NOT NULL,
                    encryption_key_base64 TEXT NOT NULL,
                    last_remote_seq INTEGER NOT NULL DEFAULT 0,
                    history_backfilled INTEGER NOT NULL DEFAULT 0,
                    projected_event_id TEXT,
                    projection_status TEXT NOT NULL DEFAULT 'active',
                    projection_stall_cause TEXT,
                    projection_error TEXT,
                    created_at_ms INTEGER NOT NULL,
                    updated_at_ms INTEGER NOT NULL
                )`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE IF NOT EXISTS ${sql.raw(OUTBOX_TABLE)} (
                    agent_id TEXT NOT NULL,
                    position INTEGER NOT NULL,
                    local_id TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    deferred INTEGER NOT NULL DEFAULT 0,
                    created_at_ms INTEGER NOT NULL,
                    PRIMARY KEY (agent_id, position),
                    UNIQUE (agent_id, local_id)
                )`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE INDEX IF NOT EXISTS happy_agent_happy_outbox_ready
                    ON ${sql.raw(OUTBOX_TABLE)}(agent_id, deferred, position)`,
            );
        },
    ],
];

interface SessionRow {
    agent_id: string;
    session_id: string;
    credential_fingerprint: string;
    tag: string;
    remote_session_id: string | null;
    encryption_variant: string;
    encryption_key_base64: string;
    last_remote_seq: number;
    history_backfilled: number;
    projected_event_id: string | null;
    projection_status: string;
    projection_stall_cause: string | null;
    projection_error: string | null;
    created_at_ms: number;
    updated_at_ms: number;
}

/**
 * The durable half of Happy synchronization: which agents are attached, how far
 * their history has been projected, and which messages still owe delivery.
 *
 * Every operation runs on the caller's transaction. Projection is written in the
 * same transaction as the event it projects, so the queue can never disagree
 * with the history it was built from.
 */
export function createHappySyncDatabase() {
    async function readSession(
        ctx: Context,
        agentId: string,
    ): Promise<HappySyncSession | undefined> {
        const rows = await agentDatabaseRows<SessionRow>(
            ctx.db,
            sql`SELECT * FROM ${sql.raw(SESSIONS_TABLE)} WHERE agent_id = ${agentId} LIMIT 1`,
        );
        return rows[0] === undefined ? undefined : parseSession(rows[0]);
    }

    async function writeCursor(
        ctx: Context,
        agentId: string,
        eventId: string,
        now: number,
    ): Promise<void> {
        await agentDatabaseRun(
            ctx.db,
            sql`UPDATE ${sql.raw(SESSIONS_TABLE)}
                SET projected_event_id = ${eventId},
                    projection_status = 'active',
                    projection_stall_cause = NULL,
                    projection_error = NULL,
                    updated_at_ms = ${now}
                WHERE agent_id = ${agentId}`,
        );
    }

    async function stall(
        ctx: Context,
        agentId: string,
        cause: "capacity" | "event_too_large",
        reason: string,
        now: number,
    ): Promise<HappyProjectionOutcome> {
        await agentDatabaseRun(
            ctx.db,
            sql`UPDATE ${sql.raw(SESSIONS_TABLE)}
                SET projection_status = 'stalled',
                    projection_stall_cause = ${cause},
                    projection_error = ${reason},
                    updated_at_ms = ${now}
                WHERE agent_id = ${agentId}`,
        );
        return { cause, kind: "stalled" };
    }

    async function countOutbox(
        ctx: Context,
        agentId: string,
    ): Promise<{ deferred: number; ready: number }> {
        const rows = await agentDatabaseRows<{ deferred: number; total: number }>(
            ctx.db,
            sql`SELECT deferred, COUNT(*) AS total FROM ${sql.raw(OUTBOX_TABLE)}
                WHERE agent_id = ${agentId} GROUP BY deferred`,
        );
        let deferred = 0;
        let ready = 0;
        for (const row of rows) {
            if (Number(row.deferred) === 1) deferred = Number(row.total);
            else ready = Number(row.total);
        }
        return { deferred, ready };
    }

    async function append(
        ctx: Context,
        agentId: string,
        messages: readonly HappyOutboxMessage[],
        deferred: boolean,
        now: number,
    ): Promise<void> {
        const rows = await agentDatabaseRows<{ highest: number | null }>(
            ctx.db,
            sql`SELECT MAX(position) AS highest FROM ${sql.raw(OUTBOX_TABLE)}
                WHERE agent_id = ${agentId}`,
        );
        let position = Number(rows[0]?.highest ?? 0);
        for (const message of messages) {
            position += 1;
            // A message the phone already holds must not be queued a second time.
            await agentDatabaseRun(
                ctx.db,
                sql`INSERT INTO ${sql.raw(OUTBOX_TABLE)}
                    (agent_id, position, local_id, payload_json, deferred, created_at_ms)
                    VALUES (${agentId}, ${position}, ${message.localId},
                            ${JSON.stringify(message.payload)}, ${deferred ? 1 : 0}, ${now})
                    ON CONFLICT (agent_id, local_id) DO NOTHING`,
            );
        }
    }

    return {
        /**
         * Attaches an agent to Happy, or confirms it is already attached.
         *
         * Credentials that no longer match the stored ones mean a different
         * account or server: the remote identity, the projection cursor and every
         * queued message belong to the old account and are discarded.
         */
        async ensureSession(
            ctx: Context,
            input: HappySyncSessionInput,
            now: number,
        ): Promise<HappySyncSession> {
            const existing = await readSession(ctx, input.agentId);
            if (
                existing !== undefined &&
                existing.credentialFingerprint === input.credentialFingerprint &&
                existing.encryptionVariant === input.encryptionVariant
            ) {
                return existing;
            }
            if (existing !== undefined) {
                await agentDatabaseRun(
                    ctx.db,
                    sql`DELETE FROM ${sql.raw(OUTBOX_TABLE)} WHERE agent_id = ${input.agentId}`,
                );
                await agentDatabaseRun(
                    ctx.db,
                    sql`DELETE FROM ${sql.raw(SESSIONS_TABLE)} WHERE agent_id = ${input.agentId}`,
                );
            }
            await agentDatabaseRun(
                ctx.db,
                sql`INSERT INTO ${sql.raw(SESSIONS_TABLE)}
                    (agent_id, session_id, credential_fingerprint, tag, remote_session_id,
                     encryption_variant, encryption_key_base64, last_remote_seq,
                     history_backfilled, projected_event_id, projection_status,
                     projection_stall_cause, projection_error, created_at_ms, updated_at_ms)
                    VALUES (${input.agentId}, ${input.sessionId}, ${input.credentialFingerprint},
                            ${happySessionTag(input.sessionId)}, NULL, ${input.encryptionVariant},
                            ${input.encryptionKeyBase64}, 0, 0, NULL, 'active', NULL, NULL,
                            ${now}, ${now})`,
            );
            const created = await readSession(ctx, input.agentId);
            if (created === undefined) {
                throw new Error("Happy could not record the session it just attached.");
            }
            return created;
        },

        readSession,

        /** Lists the agents attached to one Happy account, newest activity first. */
        async listAgentIds(
            ctx: Context,
            credentialFingerprint: string,
            limit: number,
        ): Promise<readonly string[]> {
            const rows = await agentDatabaseRows<{ agent_id: string }>(
                ctx.db,
                sql`SELECT agent_id FROM ${sql.raw(SESSIONS_TABLE)}
                    WHERE credential_fingerprint = ${credentialFingerprint}
                    ORDER BY updated_at_ms DESC, agent_id DESC
                    LIMIT ${limit}`,
            );
            return rows.map((row) => row.agent_id);
        },

        /** Records the session Happy created for this agent. */
        async setRemoteSession(
            ctx: Context,
            agentId: string,
            remoteSessionId: string,
            now: number,
        ): Promise<void> {
            await agentDatabaseRun(
                ctx.db,
                sql`UPDATE ${sql.raw(SESSIONS_TABLE)}
                    SET remote_session_id = ${remoteSessionId}, updated_at_ms = ${now}
                    WHERE agent_id = ${agentId}`,
            );
        },

        /** Advances how far this agent has read Happy's own message stream. */
        async advanceRemoteSequence(
            ctx: Context,
            agentId: string,
            lastRemoteSeq: number,
            now: number,
        ): Promise<void> {
            await agentDatabaseRun(
                ctx.db,
                sql`UPDATE ${sql.raw(SESSIONS_TABLE)}
                    SET last_remote_seq = ${lastRemoteSeq}, updated_at_ms = ${now}
                    WHERE agent_id = ${agentId} AND last_remote_seq < ${lastRemoteSeq}`,
            );
        },

        /** Queues the history that existed before Happy connected, once. */
        async backfillHistory(
            ctx: Context,
            agentId: string,
            messages: readonly HappyOutboxMessage[],
            projectedEventId: string | undefined,
            now: number,
        ): Promise<void> {
            const session = await readSession(ctx, agentId);
            if (session === undefined || session.historyBackfilled) return;
            await append(ctx, agentId, messages.slice(0, MAX_HAPPY_OUTBOX_MESSAGES), false, now);
            await agentDatabaseRun(
                ctx.db,
                sql`UPDATE ${sql.raw(SESSIONS_TABLE)}
                    SET history_backfilled = 1,
                        projected_event_id = ${projectedEventId ?? null},
                        updated_at_ms = ${now}
                    WHERE agent_id = ${agentId}`,
            );
        },

        /**
         * Projects one durable event into the delivery queue and advances the cursor.
         *
         * The cursor only ever moves forward, and only past an event whose
         * messages are queued, so a restart resumes exactly where it stopped.
         */
        async projectEvent(
            ctx: Context,
            options: {
                agentId: string;
                eventId: string;
                messages: readonly HappyOutboxMessage[];
                now: number;
            },
        ): Promise<HappyProjectionOutcome> {
            const { agentId, eventId, messages, now } = options;
            const session = await readSession(ctx, agentId);
            if (session === undefined) return { kind: "not_attached" };
            if (session.projectedEventId !== undefined && eventId <= session.projectedEventId) {
                return { kind: "already_projected" };
            }
            if (
                session.projectionStatus === "stalled" &&
                session.projectionStallCause === "event_too_large"
            ) {
                // The blocking message can never leave, so nothing behind it may pass it.
                return { cause: "event_too_large", kind: "stalled" };
            }
            if (messages.length > MAX_HAPPY_MESSAGES_PER_EVENT) {
                return await stall(
                    ctx,
                    agentId,
                    "event_too_large",
                    "One moment of this conversation produced more messages than Happy accepts.",
                    now,
                );
            }
            const encoded = messages.map((message) => JSON.stringify(message.payload));
            if (encoded.some((value) => value.length > MAX_HAPPY_OUTBOX_MESSAGE_CHARACTERS)) {
                return await stall(
                    ctx,
                    agentId,
                    "event_too_large",
                    "A message in this conversation is too large to send to Happy.",
                    now,
                );
            }
            if (messages.length === 0) {
                // Events that say nothing to Happy still keep the cursor in step.
                await writeCursor(ctx, agentId, eventId, now);
                return { deferred: false, kind: "projected" };
            }
            const counts = await countOutbox(ctx, agentId);
            // Once anything is deferred, everything after it defers too: order is the point.
            const deferred =
                counts.deferred > 0 || counts.ready + messages.length > MAX_HAPPY_OUTBOX_MESSAGES;
            if (
                deferred &&
                counts.deferred + messages.length > MAX_HAPPY_OUTBOX_DEFERRED_MESSAGES
            ) {
                return await stall(
                    ctx,
                    agentId,
                    "capacity",
                    "Happy has not accepted messages for long enough that this conversation stopped queueing them.",
                    now,
                );
            }
            await append(ctx, agentId, messages, deferred, now);
            await writeCursor(ctx, agentId, eventId, now);
            return { deferred, kind: "projected" };
        },

        /**
         * Reads the messages waiting to be delivered.
         *
         * Once the ready queue drains, messages that were deferred while it was
         * full take their turn, in the order they were produced.
         */
        async pending(
            ctx: Context,
            agentId: string,
            limit: number,
        ): Promise<readonly HappyOutboxEntry[]> {
            const ready = await readQueue(ctx, agentId, 0, limit);
            if (ready.length > 0) return ready;
            const promoted = await readQueue(ctx, agentId, 1, limit);
            if (promoted.length === 0) return [];
            for (const entry of promoted) {
                await agentDatabaseRun(
                    ctx.db,
                    sql`UPDATE ${sql.raw(OUTBOX_TABLE)} SET deferred = 0
                        WHERE agent_id = ${agentId} AND position = ${entry.position}`,
                );
            }
            return promoted;
        },

        /** Forgets the messages Happy has accepted, and clears a capacity stall. */
        async acknowledge(
            ctx: Context,
            agentId: string,
            localIds: readonly string[],
            now: number,
        ): Promise<void> {
            for (const localId of localIds) {
                await agentDatabaseRun(
                    ctx.db,
                    sql`DELETE FROM ${sql.raw(OUTBOX_TABLE)}
                        WHERE agent_id = ${agentId} AND local_id = ${localId}`,
                );
            }
            await agentDatabaseRun(
                ctx.db,
                sql`UPDATE ${sql.raw(SESSIONS_TABLE)}
                    SET projection_status = 'active',
                        projection_stall_cause = NULL,
                        projection_error = NULL,
                        updated_at_ms = ${now}
                    WHERE agent_id = ${agentId} AND projection_stall_cause = 'capacity'`,
            );
        },

        /** Detaches an agent, discarding anything still owed to Happy. */
        async removeSession(ctx: Context, agentId: string): Promise<void> {
            await agentDatabaseRun(
                ctx.db,
                sql`DELETE FROM ${sql.raw(OUTBOX_TABLE)} WHERE agent_id = ${agentId}`,
            );
            await agentDatabaseRun(
                ctx.db,
                sql`DELETE FROM ${sql.raw(SESSIONS_TABLE)} WHERE agent_id = ${agentId}`,
            );
        },
    };

    async function readQueue(
        ctx: Context,
        agentId: string,
        deferred: number,
        limit: number,
    ): Promise<HappyOutboxEntry[]> {
        const rows = await agentDatabaseRows<{
            local_id: string;
            payload_json: string;
            position: number;
        }>(
            ctx.db,
            sql`SELECT local_id, payload_json, position FROM ${sql.raw(OUTBOX_TABLE)}
                WHERE agent_id = ${agentId} AND deferred = ${deferred}
                ORDER BY position ASC
                LIMIT ${limit}`,
        );
        return rows.map((row) => {
            const entry = {
                localId: row.local_id,
                payload: parseJson(row.payload_json, "queued Happy message"),
                position: Number(row.position),
            };
            if (!Value.Check(happyOutboxEntrySchema, entry)) {
                throw new Error("The Happy outbox contains a message Happy Agent cannot read.");
            }
            return entry;
        });
    }
}

export type HappySyncDatabase = ReturnType<typeof createHappySyncDatabase>;

function parseSession(row: SessionRow): HappySyncSession {
    const session = {
        agentId: row.agent_id,
        createdAt: Number(row.created_at_ms),
        credentialFingerprint: row.credential_fingerprint,
        encryptionKeyBase64: row.encryption_key_base64,
        encryptionVariant: row.encryption_variant,
        historyBackfilled: Number(row.history_backfilled) === 1,
        lastRemoteSeq: Number(row.last_remote_seq),
        ...(row.projected_event_id === null ? {} : { projectedEventId: row.projected_event_id }),
        ...(row.projection_error === null ? {} : { projectionError: row.projection_error }),
        ...(row.projection_stall_cause === null
            ? {}
            : { projectionStallCause: row.projection_stall_cause }),
        projectionStatus: row.projection_status,
        ...(row.remote_session_id === null ? {} : { remoteSessionId: row.remote_session_id }),
        sessionId: row.session_id,
        tag: row.tag,
        updatedAt: Number(row.updated_at_ms),
    };
    if (!Value.Check(happySyncSessionSchema, session)) {
        throw new Error("The Happy session table contains a row Happy Agent cannot read.");
    }
    return session;
}

function parseJson(value: string, label: string): unknown {
    try {
        return JSON.parse(value) as unknown;
    } catch {
        throw new Error(`Happy Agent could not read a stored ${label}.`);
    }
}
