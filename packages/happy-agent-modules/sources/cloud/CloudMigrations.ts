import { agentDatabaseRun, type AgentModuleMigration } from "@slopus/happy-agent-base";
import { sql } from "drizzle-orm";

export const CLOUD_MIGRATION_KEY = "001-cloud-state";

const CLOUD_STATE_TABLE = "happy_agent_cloud_state";

export const cloudStateMigrations: readonly AgentModuleMigration[] = [
    [
        CLOUD_MIGRATION_KEY,
        async (_ctx, database) => {
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE IF NOT EXISTS ${sql.raw(CLOUD_STATE_TABLE)} (
                    singleton_id INTEGER PRIMARY KEY,
                    state_json TEXT NOT NULL
                )`,
            );
        },
    ],
];

export const CLOUD_SOCIAL_MIGRATION_KEY = "002-cloud-social-state";

const CLOUD_SOCIAL_STATE_TABLE = "happy_agent_cloud_social_state";

export const cloudSocialMigrations: readonly AgentModuleMigration[] = [
    [
        CLOUD_SOCIAL_MIGRATION_KEY,
        async (_ctx, database) => {
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE IF NOT EXISTS ${sql.raw(CLOUD_SOCIAL_STATE_TABLE)} (
                    singleton_id INTEGER PRIMARY KEY,
                    state_json TEXT NOT NULL
                )`,
            );
        },
    ],
];

export const CLOUD_KEYS_MIGRATION_KEY = "003-cloud-keys";

const CLOUD_KEYS_TABLE = "happy_agent_cloud_keys";

export const cloudKeysMigrations: readonly AgentModuleMigration[] = [
    [
        CLOUD_KEYS_MIGRATION_KEY,
        async (_ctx, database) => {
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE IF NOT EXISTS ${sql.raw(CLOUD_KEYS_TABLE)} (
                    environment TEXT NOT NULL,
                    user_id TEXT NOT NULL,
                    state_json TEXT NOT NULL,
                    PRIMARY KEY (environment, user_id)
                )`,
            );
            await agentDatabaseRun(
                database,
                sql`UPDATE happy_agent_cloud_state
                    SET state_json = json_set(
                        state_json,
                        '$.session.keys',
                        json('{"status":"restore_required"}')
                    )
                    WHERE json_type(state_json, '$.session') = 'object'
                      AND json_type(state_json, '$.session.keys') IS NULL`,
            );
        },
    ],
];

export const CLOUD_MURMUR_STORE_MIGRATION_KEY = "004-cloud-murmur-store";

const CLOUD_MURMUR_STORE_TABLE = "happy_agent_cloud_murmur_store";

export const cloudMurmurStoreMigrations: readonly AgentModuleMigration[] = [
    [
        CLOUD_MURMUR_STORE_MIGRATION_KEY,
        async (_ctx, database) => {
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE IF NOT EXISTS ${sql.raw(CLOUD_MURMUR_STORE_TABLE)} (
                    environment TEXT NOT NULL,
                    user_id TEXT NOT NULL,
                    store_key TEXT NOT NULL COLLATE BINARY,
                    value_bytes BLOB NOT NULL,
                    PRIMARY KEY (environment, user_id, store_key)
                )`,
            );
        },
    ],
];

export const CLOUD_ENROLLMENT_MIGRATION_KEY = "005-cloud-enrollment";

export const cloudEnrollmentMigrations: readonly AgentModuleMigration[] = [
    [
        CLOUD_ENROLLMENT_MIGRATION_KEY,
        async (_ctx, database) => {
            await agentDatabaseRun(
                database,
                sql`UPDATE ${sql.raw(CLOUD_STATE_TABLE)}
                    SET state_json = CASE
                        WHEN json_type(state_json, '$.session.enrollment') = 'object'
                         AND json_type(state_json, '$.session.enrollment.status') IS NULL
                        THEN json_set(
                            state_json,
                            '$.session.enrollment.status',
                            'enrolled'
                        )
                        ELSE json_set(
                            state_json,
                            '$.session.enrollment',
                            json('{"status":"checking"}')
                        )
                    END
                    WHERE json_type(state_json, '$.session') = 'object'
                      AND (
                          json_type(state_json, '$.session.enrollment') IS NULL
                          OR json_type(state_json, '$.session.enrollment') = 'null'
                          OR (
                              json_type(state_json, '$.session.enrollment') = 'object'
                              AND json_type(state_json, '$.session.enrollment.status') IS NULL
                          )
                      )`,
            );
        },
    ],
];

export const CLOUD_DISCONNECT_MIGRATION_KEY = "006-cloud-disconnect";

export const CLOUD_DISCONNECT_REFRESH_TOKEN_MIGRATION_KEY = "007-cloud-disconnect-refresh-token";

const CLOUD_DISCONNECT_TABLE = "happy_agent_cloud_disconnect";

export const cloudDisconnectMigrations: readonly AgentModuleMigration[] = [
    [
        CLOUD_DISCONNECT_MIGRATION_KEY,
        async (_ctx, database) => {
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE IF NOT EXISTS ${sql.raw(CLOUD_DISCONNECT_TABLE)} (
                    singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
                    environment TEXT NOT NULL,
                    user_id TEXT NOT NULL,
                    generation TEXT NOT NULL
                )`,
            );
        },
    ],
    [
        CLOUD_DISCONNECT_REFRESH_TOKEN_MIGRATION_KEY,
        async (_ctx, database) => {
            await agentDatabaseRun(
                database,
                sql`ALTER TABLE ${sql.raw(CLOUD_DISCONNECT_TABLE)}
                    ADD COLUMN refresh_token TEXT`,
            );
        },
    ],
];

/** Historical entries are immutable; only the final migration changes the current schema. */
export const cloudMigrations: readonly AgentModuleMigration[] = [
    ...cloudStateMigrations,
    ...cloudSocialMigrations,
    ...cloudKeysMigrations,
    ...cloudMurmurStoreMigrations,
    ...cloudEnrollmentMigrations,
    ...cloudDisconnectMigrations,
    [
        "008-cloud-workos-only",
        async (_ctx, database) => {
            await agentDatabaseRun(
                database,
                sql`DROP TABLE IF EXISTS happy_agent_cloud_social_state`,
            );
            await agentDatabaseRun(database, sql`DROP TABLE IF EXISTS happy_agent_cloud_keys`);
            await agentDatabaseRun(
                database,
                sql`DROP TABLE IF EXISTS happy_agent_cloud_murmur_store`,
            );
            await agentDatabaseRun(
                database,
                sql`DROP TABLE IF EXISTS happy_agent_cloud_disconnect`,
            );
            await agentDatabaseRun(
                database,
                sql`UPDATE happy_agent_cloud_state
                    SET state_json = json_remove(
                        state_json,
                        '$.session.enrollment',
                        '$.session.keys',
                        '$.session.keysReconciliationCallId'
                    )
                    WHERE json_type(state_json, '$.session') = 'object'`,
            );
        },
    ],
];
