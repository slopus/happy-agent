import {
    agentDatabaseRun,
    type AgentDatabase,
    type AgentDatabaseFacade,
} from "@slopus/happy-agent-base";
import { sql } from "drizzle-orm";
import type { Context } from "@steve.kite/stdlib";

export const ARTIFACTS_TABLE = "happy_agent_module_artifacts";
export const ARTIFACT_VERSIONS_TABLE = "happy_agent_module_artifact_versions";
export const ARTIFACT_FILES_TABLE = "happy_agent_module_artifact_files";
export const ARTIFACT_UPLOADS_TABLE = "happy_agent_module_artifact_uploads";

/**
 * The `artifacts` module's migrations.
 *
 * The catalog row keeps its latest version's entry, file count, and size so a list reads one row
 * per artifact, and splits the source and creator into indexed columns for filtering beside their
 * full JSON. Every version's manifest is rows of its own, keyed by path, so serving one file is one
 * keyed lookup and whether stored content is still used is one indexed lookup by digest. An upload
 * without a digest is still receiving its bytes. A version's background, mirrored on the catalog
 * row for its latest version, is `NULL` for a transparent slot, and its display preference, mirrored
 * the same way, is `NULL` when it leaves the choice to the client. Every version carries its
 * `major.minor` label beside its number, and the catalog row mirrors the latest one's; versions
 * made before labels existed read as 1.0, 1.1, and so on.
 */
export const artifactMigrations = [
    [
        "001-artifact-catalog",
        async (_ctx: Context, database: AgentDatabaseFacade<AgentDatabase>): Promise<void> => {
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE ${sql.raw(ARTIFACTS_TABLE)} (
                    id TEXT PRIMARY KEY,
                    type TEXT NOT NULL,
                    title TEXT NOT NULL,
                    status TEXT NOT NULL,
                    latest_version INTEGER NOT NULL,
                    entry_json TEXT NOT NULL,
                    file_count INTEGER NOT NULL,
                    size BIGINT NOT NULL,
                    source_json TEXT,
                    source_kind TEXT,
                    source_id TEXT,
                    source_agent_id TEXT,
                    created_by_json TEXT NOT NULL,
                    created_by_kind TEXT NOT NULL,
                    created_by_id TEXT,
                    created_at BIGINT NOT NULL,
                    updated_by_json TEXT NOT NULL,
                    updated_source_json TEXT,
                    updated_at BIGINT NOT NULL,
                    deleted_by_json TEXT,
                    deleted_source_json TEXT,
                    deleted_at BIGINT,
                    revision INTEGER NOT NULL
                )`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE INDEX ${sql.raw(`${ARTIFACTS_TABLE}_created`)}
                    ON ${sql.raw(ARTIFACTS_TABLE)} (created_at, id)`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE INDEX ${sql.raw(`${ARTIFACTS_TABLE}_source`)}
                    ON ${sql.raw(ARTIFACTS_TABLE)} (source_kind, source_id, created_at, id)`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE INDEX ${sql.raw(`${ARTIFACTS_TABLE}_source_agent`)}
                    ON ${sql.raw(ARTIFACTS_TABLE)} (source_agent_id, created_at, id)`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE INDEX ${sql.raw(`${ARTIFACTS_TABLE}_creator`)}
                    ON ${sql.raw(ARTIFACTS_TABLE)} (created_by_kind, created_by_id, created_at, id)`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE ${sql.raw(ARTIFACT_VERSIONS_TABLE)} (
                    artifact_id TEXT NOT NULL,
                    number INTEGER NOT NULL,
                    title TEXT NOT NULL,
                    entry_path TEXT NOT NULL,
                    created_by_json TEXT NOT NULL,
                    source_json TEXT,
                    created_at BIGINT NOT NULL,
                    operation_id TEXT,
                    PRIMARY KEY (artifact_id, number)
                )`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE UNIQUE INDEX ${sql.raw(`${ARTIFACT_VERSIONS_TABLE}_operation`)}
                    ON ${sql.raw(ARTIFACT_VERSIONS_TABLE)} (artifact_id, operation_id)
                    WHERE operation_id IS NOT NULL`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE ${sql.raw(ARTIFACT_FILES_TABLE)} (
                    artifact_id TEXT NOT NULL,
                    version_number INTEGER NOT NULL,
                    path TEXT NOT NULL,
                    mime_type TEXT NOT NULL,
                    size BIGINT NOT NULL,
                    sha256 TEXT NOT NULL,
                    PRIMARY KEY (artifact_id, version_number, path)
                )`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE INDEX ${sql.raw(`${ARTIFACT_FILES_TABLE}_sha256`)}
                    ON ${sql.raw(ARTIFACT_FILES_TABLE)} (sha256)`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE ${sql.raw(ARTIFACT_UPLOADS_TABLE)} (
                    id TEXT PRIMARY KEY,
                    size BIGINT,
                    sha256 TEXT,
                    utf8 INTEGER,
                    created_at BIGINT NOT NULL,
                    expires_at BIGINT NOT NULL
                )`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE INDEX ${sql.raw(`${ARTIFACT_UPLOADS_TABLE}_sha256`)}
                    ON ${sql.raw(ARTIFACT_UPLOADS_TABLE)} (sha256)`,
            );
        },
    ],
    [
        "002-artifact-background",
        async (_ctx: Context, database: AgentDatabaseFacade<AgentDatabase>): Promise<void> => {
            await agentDatabaseRun(
                database,
                sql`ALTER TABLE ${sql.raw(ARTIFACTS_TABLE)} ADD COLUMN background TEXT`,
            );
            await agentDatabaseRun(
                database,
                sql`ALTER TABLE ${sql.raw(ARTIFACT_VERSIONS_TABLE)} ADD COLUMN background TEXT`,
            );
        },
    ],
    [
        "003-artifact-display",
        async (_ctx: Context, database: AgentDatabaseFacade<AgentDatabase>): Promise<void> => {
            await agentDatabaseRun(
                database,
                sql`ALTER TABLE ${sql.raw(ARTIFACTS_TABLE)} ADD COLUMN display TEXT`,
            );
            await agentDatabaseRun(
                database,
                sql`ALTER TABLE ${sql.raw(ARTIFACT_VERSIONS_TABLE)} ADD COLUMN display TEXT`,
            );
        },
    ],
    [
        "004-artifact-version-labels",
        async (_ctx: Context, database: AgentDatabaseFacade<AgentDatabase>): Promise<void> => {
            await agentDatabaseRun(
                database,
                sql`ALTER TABLE ${sql.raw(ARTIFACTS_TABLE)}
                    ADD COLUMN latest_major INTEGER NOT NULL DEFAULT 1`,
            );
            await agentDatabaseRun(
                database,
                sql`ALTER TABLE ${sql.raw(ARTIFACTS_TABLE)}
                    ADD COLUMN latest_minor INTEGER NOT NULL DEFAULT 0`,
            );
            await agentDatabaseRun(
                database,
                sql`UPDATE ${sql.raw(ARTIFACTS_TABLE)} SET latest_minor = latest_version - 1`,
            );
            await agentDatabaseRun(
                database,
                sql`ALTER TABLE ${sql.raw(ARTIFACT_VERSIONS_TABLE)}
                    ADD COLUMN major INTEGER NOT NULL DEFAULT 1`,
            );
            await agentDatabaseRun(
                database,
                sql`ALTER TABLE ${sql.raw(ARTIFACT_VERSIONS_TABLE)}
                    ADD COLUMN minor INTEGER NOT NULL DEFAULT 0`,
            );
            await agentDatabaseRun(
                database,
                sql`UPDATE ${sql.raw(ARTIFACT_VERSIONS_TABLE)} SET minor = number - 1`,
            );
        },
    ],
] as const;
