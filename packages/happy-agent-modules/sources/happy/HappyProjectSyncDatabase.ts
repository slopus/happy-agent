import {
    agentDatabaseRows,
    agentDatabaseRun,
    type AgentModuleMigration,
} from "@slopus/happy-agent-base";
import { Value } from "@sinclair/typebox/value";
import { sql } from "drizzle-orm";
import type { Context } from "@steve.kite/stdlib";

import {
    happyProjectSyncStateSchema,
    type HappyProjectSyncInput,
    type HappyProjectSyncState,
} from "./HappyProjectSync.js";

export const HAPPY_PROJECT_SYNC_MIGRATION_KEY = "003-happy-project-sync";
const PROJECTS_TABLE = "happy_agent_happy_projects";

export const happyProjectSyncMigrations: readonly AgentModuleMigration[] = [
    [
        HAPPY_PROJECT_SYNC_MIGRATION_KEY,
        async (_ctx, database) => {
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE IF NOT EXISTS ${sql.raw(PROJECTS_TABLE)} (
                    local_project_id TEXT PRIMARY KEY,
                    credential_fingerprint TEXT NOT NULL,
                    remote_project_id TEXT,
                    encryption_variant TEXT NOT NULL,
                    encryption_key_base64 TEXT NOT NULL,
                    metadata_fingerprint TEXT,
                    avatar_fingerprint TEXT,
                    avatar_version INTEGER,
                    created_at_ms INTEGER NOT NULL,
                    updated_at_ms INTEGER NOT NULL
                )`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE INDEX IF NOT EXISTS happy_agent_happy_projects_account
                    ON ${sql.raw(PROJECTS_TABLE)}(credential_fingerprint, updated_at_ms)`,
            );
        },
    ],
];

interface HappyProjectSyncRow {
    local_project_id: string;
    credential_fingerprint: string;
    remote_project_id: string | null;
    encryption_variant: string;
    encryption_key_base64: string;
    metadata_fingerprint: string | null;
    avatar_fingerprint: string | null;
    avatar_version: number | string | null;
    created_at_ms: number | string;
    updated_at_ms: number | string;
}

/** Durable local-to-remote project identity and upload high-water marks. */
export function createHappyProjectSyncDatabase() {
    async function read(
        ctx: Context,
        localProjectId: string,
    ): Promise<HappyProjectSyncState | undefined> {
        const rows = await agentDatabaseRows<HappyProjectSyncRow>(
            ctx.db,
            sql`SELECT * FROM ${sql.raw(PROJECTS_TABLE)}
                WHERE local_project_id = ${localProjectId} LIMIT 1`,
        );
        const row = rows[0];
        return row === undefined ? undefined : parse(row);
    }

    return {
        read,

        async ensure(
            ctx: Context,
            input: HappyProjectSyncInput,
            now: number,
        ): Promise<HappyProjectSyncState> {
            const existing = await read(ctx, input.localProjectId);
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
                    sql`DELETE FROM ${sql.raw(PROJECTS_TABLE)}
                        WHERE local_project_id = ${input.localProjectId}`,
                );
            }
            await agentDatabaseRun(
                ctx.db,
                sql`INSERT INTO ${sql.raw(PROJECTS_TABLE)}
                    (local_project_id, credential_fingerprint, remote_project_id,
                     encryption_variant, encryption_key_base64, metadata_fingerprint,
                     avatar_fingerprint, avatar_version, created_at_ms, updated_at_ms)
                    VALUES (${input.localProjectId}, ${input.credentialFingerprint}, NULL,
                            ${input.encryptionVariant}, ${input.encryptionKeyBase64}, NULL,
                            NULL, NULL, ${now}, ${now})
                    ON CONFLICT (local_project_id) DO NOTHING`,
            );
            const created = await read(ctx, input.localProjectId);
            if (created === undefined) {
                throw new Error("Happy could not record the project it just attached.");
            }
            return created;
        },

        async setRemoteProject(
            ctx: Context,
            localProjectId: string,
            remoteProjectId: string,
            now: number,
        ): Promise<void> {
            await agentDatabaseRun(
                ctx.db,
                sql`UPDATE ${sql.raw(PROJECTS_TABLE)}
                    SET remote_project_id = ${remoteProjectId}, metadata_fingerprint = NULL,
                        avatar_fingerprint = NULL, avatar_version = NULL,
                        updated_at_ms = ${now}
                    WHERE local_project_id = ${localProjectId}`,
            );
        },

        async clearRemoteProject(ctx: Context, localProjectId: string, now: number): Promise<void> {
            await agentDatabaseRun(
                ctx.db,
                sql`UPDATE ${sql.raw(PROJECTS_TABLE)}
                    SET remote_project_id = NULL, metadata_fingerprint = NULL,
                        avatar_fingerprint = NULL, avatar_version = NULL,
                        updated_at_ms = ${now}
                    WHERE local_project_id = ${localProjectId}`,
            );
        },

        async setMetadataFingerprint(
            ctx: Context,
            localProjectId: string,
            fingerprint: string,
            now: number,
        ): Promise<void> {
            await agentDatabaseRun(
                ctx.db,
                sql`UPDATE ${sql.raw(PROJECTS_TABLE)}
                    SET metadata_fingerprint = ${fingerprint}, updated_at_ms = ${now}
                    WHERE local_project_id = ${localProjectId}`,
            );
        },

        async setAvatarFingerprint(
            ctx: Context,
            localProjectId: string,
            fingerprint: string,
            version: number,
            now: number,
        ): Promise<void> {
            await agentDatabaseRun(
                ctx.db,
                sql`UPDATE ${sql.raw(PROJECTS_TABLE)}
                    SET avatar_fingerprint = ${fingerprint}, avatar_version = ${version},
                        updated_at_ms = ${now}
                    WHERE local_project_id = ${localProjectId}`,
            );
        },
    };
}

export type HappyProjectSyncDatabase = ReturnType<typeof createHappyProjectSyncDatabase>;

function parse(row: HappyProjectSyncRow): HappyProjectSyncState {
    const state = {
        ...(row.avatar_fingerprint === null ? {} : { avatarFingerprint: row.avatar_fingerprint }),
        ...(row.avatar_version === null ? {} : { avatarVersion: Number(row.avatar_version) }),
        credentialFingerprint: row.credential_fingerprint,
        createdAt: Number(row.created_at_ms),
        encryptionKeyBase64: row.encryption_key_base64,
        encryptionVariant: row.encryption_variant,
        localProjectId: row.local_project_id,
        ...(row.metadata_fingerprint === null
            ? {}
            : { metadataFingerprint: row.metadata_fingerprint }),
        ...(row.remote_project_id === null ? {} : { remoteProjectId: row.remote_project_id }),
        updatedAt: Number(row.updated_at_ms),
    };
    if (!Value.Check(happyProjectSyncStateSchema, state)) {
        throw new Error("The Happy project table contains a row Happy Agent cannot read.");
    }
    return structuredClone(state);
}
