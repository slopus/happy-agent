import { agentDatabaseRun, type AgentModuleMigration } from "@slopus/happy-agent-base";
import { sql } from "drizzle-orm";

/** Preserve standalone rows while making the mobile owner part of every durable key. */
export const personalSessionMigration: AgentModuleMigration = [
    "004-personal-session-sync",
    async (_ctx, db) => {
        await agentDatabaseRun(
            db,
            sql`CREATE TABLE happy_agent_happy_sessions_personal (
            owner_id TEXT NOT NULL DEFAULT '', agent_id TEXT NOT NULL,
            session_id TEXT NOT NULL, credential_fingerprint TEXT NOT NULL, tag TEXT NOT NULL,
            remote_session_id TEXT, encryption_variant TEXT NOT NULL, encryption_key_base64 TEXT NOT NULL,
            last_remote_seq INTEGER NOT NULL DEFAULT 0, history_backfilled INTEGER NOT NULL DEFAULT 0,
            projected_event_id TEXT, projection_status TEXT NOT NULL DEFAULT 'active',
            projection_stall_cause TEXT, projection_error TEXT,
            created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
            PRIMARY KEY (owner_id, agent_id)
        )`,
        );
        await agentDatabaseRun(
            db,
            sql`INSERT INTO happy_agent_happy_sessions_personal SELECT '', * FROM happy_agent_happy_sessions`,
        );
        await agentDatabaseRun(db, sql`DROP TABLE happy_agent_happy_sessions`);
        await agentDatabaseRun(
            db,
            sql`ALTER TABLE happy_agent_happy_sessions_personal RENAME TO happy_agent_happy_sessions`,
        );
        await agentDatabaseRun(
            db,
            sql`CREATE TABLE happy_agent_happy_outbox_personal (
            owner_id TEXT NOT NULL DEFAULT '', agent_id TEXT NOT NULL, position INTEGER NOT NULL,
            local_id TEXT NOT NULL, payload_json TEXT NOT NULL, deferred INTEGER NOT NULL DEFAULT 0,
            created_at_ms INTEGER NOT NULL, PRIMARY KEY (owner_id, agent_id, position),
            UNIQUE (owner_id, agent_id, local_id)
        )`,
        );
        await agentDatabaseRun(
            db,
            sql`INSERT INTO happy_agent_happy_outbox_personal SELECT '', * FROM happy_agent_happy_outbox`,
        );
        await agentDatabaseRun(db, sql`DROP TABLE happy_agent_happy_outbox`);
        await agentDatabaseRun(
            db,
            sql`ALTER TABLE happy_agent_happy_outbox_personal RENAME TO happy_agent_happy_outbox`,
        );
        await agentDatabaseRun(
            db,
            sql`CREATE INDEX happy_agent_happy_outbox_ready ON happy_agent_happy_outbox(owner_id, agent_id, deferred, position)`,
        );
    },
];

export const personalIntegrationMigration: AgentModuleMigration = [
    "005-personal-integration-state",
    async (_ctx, db) => {
        await agentDatabaseRun(
            db,
            sql`CREATE TABLE happy_agent_happy_integration_personal (
            owner_id TEXT PRIMARY KEY, state_json TEXT NOT NULL
        )`,
        );
        await agentDatabaseRun(
            db,
            sql`INSERT INTO happy_agent_happy_integration_personal SELECT '', state_json FROM happy_agent_happy_integration_state WHERE singleton_id = 1`,
        );
        await agentDatabaseRun(db, sql`DROP TABLE happy_agent_happy_integration_state`);
        await agentDatabaseRun(
            db,
            sql`ALTER TABLE happy_agent_happy_integration_personal RENAME TO happy_agent_happy_integration_state`,
        );
    },
];

export const personalProjectMigration: AgentModuleMigration = [
    "006-personal-project-sync",
    async (_ctx, db) => {
        await agentDatabaseRun(
            db,
            sql`CREATE TABLE happy_agent_happy_projects_personal (
            owner_id TEXT NOT NULL DEFAULT '', local_project_id TEXT NOT NULL,
            credential_fingerprint TEXT NOT NULL, remote_project_id TEXT,
            encryption_variant TEXT NOT NULL, encryption_key_base64 TEXT NOT NULL,
            metadata_fingerprint TEXT, avatar_fingerprint TEXT, avatar_version INTEGER,
            created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
            PRIMARY KEY (owner_id, local_project_id)
        )`,
        );
        await agentDatabaseRun(
            db,
            sql`INSERT INTO happy_agent_happy_projects_personal SELECT '', * FROM happy_agent_happy_projects`,
        );
        await agentDatabaseRun(db, sql`DROP TABLE happy_agent_happy_projects`);
        await agentDatabaseRun(
            db,
            sql`ALTER TABLE happy_agent_happy_projects_personal RENAME TO happy_agent_happy_projects`,
        );
        await agentDatabaseRun(
            db,
            sql`CREATE INDEX happy_agent_happy_projects_account ON happy_agent_happy_projects(owner_id, credential_fingerprint, updated_at_ms)`,
        );
    },
];
