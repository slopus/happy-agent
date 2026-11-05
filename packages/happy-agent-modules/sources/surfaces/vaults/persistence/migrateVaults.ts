import {
    agentDatabaseRun,
    type AgentDatabaseFacade,
    type AgentDatabase,
} from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";

/**
 * Vault tables. Entries, versions, and activity keep their whole public record as JSON beside
 * the columns queries filter and sort on; `writeVaultEntry` and `writeVaultVersion` keep the two
 * in step. Content text for search lives in an FTS5 trigram index keyed by `vault_texts` rows.
 */
export async function migrateVaults(
    _ctx: Context,
    database: AgentDatabaseFacade<AgentDatabase>,
): Promise<void> {
    const run = (query: ReturnType<typeof sql>) => agentDatabaseRun(database, query);
    await run(
        sql`CREATE TABLE happy_agent_vault_settings (surface_id TEXT PRIMARY KEY, settings_json TEXT NOT NULL)`,
    );
    await run(
        sql`CREATE TABLE happy_agent_vault_entries (id TEXT PRIMARY KEY, surface_id TEXT NOT NULL, parent_id TEXT, name_key TEXT NOT NULL, kind TEXT NOT NULL, size BIGINT, updated_at BIGINT NOT NULL, deleted_at BIGINT, entry_json TEXT NOT NULL)`,
    );
    await run(
        sql`CREATE INDEX happy_agent_vault_entry_children ON happy_agent_vault_entries (surface_id, parent_id, deleted_at)`,
    );
    // Names are unique among a folder's children that are not themselves deleted.
    await run(
        sql`CREATE UNIQUE INDEX happy_agent_vault_entry_names ON happy_agent_vault_entries (surface_id, coalesce(parent_id, ''), name_key) WHERE deleted_at IS NULL`,
    );
    await run(
        sql`CREATE INDEX happy_agent_vault_entry_trash ON happy_agent_vault_entries (surface_id, deleted_at) WHERE deleted_at IS NOT NULL`,
    );
    await run(
        sql`CREATE TABLE happy_agent_vault_versions (entry_id TEXT NOT NULL, number INTEGER NOT NULL, surface_id TEXT NOT NULL, sha256 TEXT, created_at BIGINT NOT NULL, pinned INTEGER NOT NULL, version_json TEXT NOT NULL, PRIMARY KEY (entry_id, number))`,
    );
    await run(
        sql`CREATE INDEX happy_agent_vault_version_content ON happy_agent_vault_versions (sha256) WHERE sha256 IS NOT NULL`,
    );
    await run(
        sql`CREATE TABLE happy_agent_vault_version_files (entry_id TEXT NOT NULL, number INTEGER NOT NULL, path TEXT NOT NULL, mime_type TEXT NOT NULL, size BIGINT NOT NULL, sha256 TEXT NOT NULL, PRIMARY KEY (entry_id, number, path))`,
    );
    await run(
        sql`CREATE INDEX happy_agent_vault_version_file_content ON happy_agent_vault_version_files (sha256)`,
    );
    await run(
        sql`CREATE TABLE happy_agent_vault_activity (id TEXT PRIMARY KEY, entry_id TEXT NOT NULL, kind TEXT NOT NULL, agent_id TEXT, at BIGINT NOT NULL, activity_json TEXT NOT NULL)`,
    );
    await run(
        sql`CREATE INDEX happy_agent_vault_activity_entries ON happy_agent_vault_activity (entry_id, id)`,
    );
    await run(
        sql`CREATE INDEX happy_agent_vault_activity_agents ON happy_agent_vault_activity (entry_id, agent_id, at) WHERE agent_id IS NOT NULL`,
    );
    await run(
        sql`CREATE TABLE happy_agent_vault_uploads (id TEXT PRIMARY KEY, size BIGINT NOT NULL, received BIGINT NOT NULL, expected_sha256 TEXT, sha256 TEXT, created_at BIGINT NOT NULL, expires_at BIGINT NOT NULL)`,
    );
    await run(
        sql`CREATE INDEX happy_agent_vault_upload_content ON happy_agent_vault_uploads (sha256) WHERE sha256 IS NOT NULL`,
    );
    await run(
        sql`CREATE INDEX happy_agent_vault_upload_expiry ON happy_agent_vault_uploads (expires_at)`,
    );
    await run(
        sql`CREATE TABLE happy_agent_vault_texts (id INTEGER PRIMARY KEY, entry_id TEXT NOT NULL, surface_id TEXT NOT NULL, inner_path TEXT)`,
    );
    await run(
        sql`CREATE INDEX happy_agent_vault_text_entries ON happy_agent_vault_texts (entry_id)`,
    );
    await run(
        sql`CREATE VIRTUAL TABLE happy_agent_vault_text_index USING fts5(text, tokenize = 'trigram')`,
    );
    // Digests whose stored content may have lost its last reference, checked from `not_before`.
    await run(
        sql`CREATE TABLE happy_agent_vault_garbage (sha256 TEXT PRIMARY KEY, not_before BIGINT NOT NULL)`,
    );
}
