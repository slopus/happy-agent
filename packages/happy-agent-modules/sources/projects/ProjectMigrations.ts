import { sql } from "drizzle-orm";
import { agentDatabaseRun, type AgentDatabase } from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";

export const PROJECTS_TABLE = "happy_agent_module_projects";
export const PROJECT_SETTINGS_TABLE = "happy_agent_module_project_settings";
export const PROJECT_ROOT_AGENTS_TABLE = "happy_agent_module_project_root_agents";
export const PROJECT_AVATARS_TABLE = "happy_agent_module_project_avatars";
const PROJECT_RECEIPTS_TABLE = "happy_agent_module_project_operation_receipts";
const PROJECT_PROOFS_TABLE = "happy_agent_module_project_mutation_proofs";

/**
 * The projects module owns these tables. They deliberately use stable,
 * human-readable names so a module upgrade can append migrations without
 * borrowing Happy Agent's application schema. An existing migration is never edited:
 * a released Happy Agent may already have applied it.
 */
export const projectMigrations = [
    [
        "001-projects-catalog",
        async (_ctx: Context, database: AgentDatabase): Promise<void> => {
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE IF NOT EXISTS ${sql.raw(PROJECTS_TABLE)} (
                    id TEXT PRIMARY KEY,
                    owner_agent_id TEXT NOT NULL,
                    repository_ref TEXT NOT NULL UNIQUE,
                    name TEXT NOT NULL,
                    status TEXT NOT NULL,
                    description TEXT,
                    created_at BIGINT NOT NULL,
                    updated_at BIGINT NOT NULL,
                    archived_at BIGINT
                )`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE INDEX IF NOT EXISTS ${sql.raw(`${PROJECTS_TABLE}_status_id`)}
                    ON ${sql.raw(PROJECTS_TABLE)} (status, id)`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE IF NOT EXISTS ${sql.raw(PROJECT_SETTINGS_TABLE)} (
                    project_id TEXT PRIMARY KEY,
                    settings_json TEXT NOT NULL
                )`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE IF NOT EXISTS ${sql.raw(PROJECT_RECEIPTS_TABLE)} (
                    agent_id TEXT NOT NULL,
                    operation_id TEXT NOT NULL,
                    result_json TEXT NOT NULL,
                    PRIMARY KEY (agent_id, operation_id)
                )`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE IF NOT EXISTS ${sql.raw(PROJECT_PROOFS_TABLE)} (
                    agent_id TEXT NOT NULL,
                    operation_id TEXT NOT NULL,
                    proof_json TEXT NOT NULL,
                    PRIMARY KEY (agent_id, operation_id)
                )`,
            );
        },
    ],
    [
        "002-drop-project-idempotency-tables",
        async (_ctx: Context, database: AgentDatabase): Promise<void> => {
            await agentDatabaseRun(
                database,
                sql`DROP TABLE IF EXISTS ${sql.raw(PROJECT_RECEIPTS_TABLE)}`,
            );
            await agentDatabaseRun(
                database,
                sql`DROP TABLE IF EXISTS ${sql.raw(PROJECT_PROOFS_TABLE)}`,
            );
        },
    ],
    [
        "003-project-order-version-avatar",
        async (_ctx: Context, database: AgentDatabase): Promise<void> => {
            await agentDatabaseRun(
                database,
                sql`ALTER TABLE ${sql.raw(PROJECTS_TABLE)}
                    ADD COLUMN order_key TEXT NOT NULL DEFAULT ''`,
            );
            await agentDatabaseRun(
                database,
                sql`ALTER TABLE ${sql.raw(PROJECTS_TABLE)}
                    ADD COLUMN version BIGINT NOT NULL DEFAULT 1`,
            );
            await agentDatabaseRun(
                database,
                sql`ALTER TABLE ${sql.raw(PROJECTS_TABLE)}
                    ADD COLUMN avatar_json TEXT`,
            );
            await agentDatabaseRun(
                database,
                sql`UPDATE ${sql.raw(PROJECTS_TABLE)}
                    SET order_key = printf('%020d', rowid)
                    WHERE order_key = ''`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE INDEX IF NOT EXISTS ${sql.raw(`${PROJECTS_TABLE}_order_id`)}
                    ON ${sql.raw(PROJECTS_TABLE)} (order_key, id)`,
            );
        },
    ],
    [
        "004-project-folder-record",
        /**
         * A project is now a real folder with a kind, a storage key, presence,
         * initialization state and cached Git facts. Happy Agent is early-stage, so the
         * old rows are dropped rather than migrated column by column: an opaque
         * repository reference cannot be turned into a canonical folder path
         * here, and inventing one would put unusable rows in front of the user.
         */
        async (_ctx: Context, database: AgentDatabase): Promise<void> => {
            await agentDatabaseRun(database, sql`DROP TABLE IF EXISTS ${sql.raw(PROJECTS_TABLE)}`);
            await agentDatabaseRun(
                database,
                sql`DROP TABLE IF EXISTS ${sql.raw(PROJECT_SETTINGS_TABLE)}`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE ${sql.raw(PROJECTS_TABLE)} (
                    id TEXT PRIMARY KEY,
                    owner_agent_id TEXT NOT NULL,
                    repository_ref TEXT NOT NULL UNIQUE,
                    kind TEXT NOT NULL,
                    storage_key TEXT NOT NULL UNIQUE,
                    name TEXT NOT NULL,
                    name_source TEXT NOT NULL,
                    status TEXT NOT NULL,
                    presence TEXT NOT NULL,
                    initialization_status TEXT NOT NULL,
                    initialization_attempt BIGINT NOT NULL DEFAULT 0,
                    initialization_error TEXT,
                    default_branch TEXT,
                    worktree_support TEXT NOT NULL DEFAULT 'unknown',
                    worktree_unsupported_reason TEXT,
                    remote_source_json TEXT,
                    required_secret_kind TEXT,
                    git_ahead BIGINT NOT NULL DEFAULT 0,
                    git_behind BIGINT NOT NULL DEFAULT 0,
                    git_detached INTEGER NOT NULL DEFAULT 0,
                    git_branch TEXT,
                    git_head TEXT,
                    git_upstream TEXT,
                    order_key TEXT NOT NULL,
                    version BIGINT NOT NULL DEFAULT 1,
                    avatar_json TEXT,
                    description TEXT,
                    created_at BIGINT NOT NULL,
                    updated_at BIGINT NOT NULL,
                    archived_at BIGINT
                )`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE INDEX IF NOT EXISTS ${sql.raw(`${PROJECTS_TABLE}_status_id`)}
                    ON ${sql.raw(PROJECTS_TABLE)} (status, id)`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE INDEX IF NOT EXISTS ${sql.raw(`${PROJECTS_TABLE}_order_id`)}
                    ON ${sql.raw(PROJECTS_TABLE)} (order_key, id)`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE ${sql.raw(PROJECT_SETTINGS_TABLE)} (
                    project_id TEXT PRIMARY KEY,
                    settings_json TEXT NOT NULL
                )`,
            );
        },
    ],
    [
        "005-project-without-owner",
        /**
         * A project belongs to this installation, not to an agent. The owning agent was always
         * the one identity the daemon had, so the column decided nothing and every read ignored
         * it. Happy Agent is early-stage: the generation is advanced and the catalog reset rather than
         * rewriting rows to drop a column SQLite would have to rebuild the table for anyway.
         */
        async (_ctx: Context, database: AgentDatabase): Promise<void> => {
            await agentDatabaseRun(database, sql`DROP TABLE IF EXISTS ${sql.raw(PROJECTS_TABLE)}`);
            await agentDatabaseRun(
                database,
                sql`DROP TABLE IF EXISTS ${sql.raw(PROJECT_SETTINGS_TABLE)}`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE ${sql.raw(PROJECTS_TABLE)} (
                    id TEXT PRIMARY KEY,
                    repository_ref TEXT NOT NULL UNIQUE,
                    kind TEXT NOT NULL,
                    storage_key TEXT NOT NULL UNIQUE,
                    name TEXT NOT NULL,
                    name_source TEXT NOT NULL,
                    status TEXT NOT NULL,
                    presence TEXT NOT NULL,
                    initialization_status TEXT NOT NULL,
                    initialization_attempt BIGINT NOT NULL DEFAULT 0,
                    initialization_error TEXT,
                    default_branch TEXT,
                    worktree_support TEXT NOT NULL DEFAULT 'unknown',
                    worktree_unsupported_reason TEXT,
                    remote_source_json TEXT,
                    required_secret_kind TEXT,
                    git_ahead BIGINT NOT NULL DEFAULT 0,
                    git_behind BIGINT NOT NULL DEFAULT 0,
                    git_detached INTEGER NOT NULL DEFAULT 0,
                    git_branch TEXT,
                    git_head TEXT,
                    git_upstream TEXT,
                    order_key TEXT NOT NULL,
                    version BIGINT NOT NULL DEFAULT 1,
                    avatar_json TEXT,
                    description TEXT,
                    created_at BIGINT NOT NULL,
                    updated_at BIGINT NOT NULL,
                    archived_at BIGINT
                )`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE INDEX IF NOT EXISTS ${sql.raw(`${PROJECTS_TABLE}_status_id`)}
                    ON ${sql.raw(PROJECTS_TABLE)} (status, id)`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE INDEX IF NOT EXISTS ${sql.raw(`${PROJECTS_TABLE}_order_id`)}
                    ON ${sql.raw(PROJECTS_TABLE)} (order_key, id)`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE ${sql.raw(PROJECT_SETTINGS_TABLE)} (
                    project_id TEXT PRIMARY KEY,
                    settings_json TEXT NOT NULL
                )`,
            );
        },
    ],
    [
        "006-project-root-agents",
        /**
         * A root agent is a project's root conversation. The association contains only stable
         * identities and insertion order; Agent Base owns its configuration, metadata, and archive.
         */
        async (_ctx: Context, database: AgentDatabase): Promise<void> => {
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE ${sql.raw(PROJECT_ROOT_AGENTS_TABLE)} (
                    position INTEGER PRIMARY KEY AUTOINCREMENT,
                    project_id TEXT NOT NULL,
                    agent_id TEXT NOT NULL UNIQUE
                )`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE INDEX ${sql.raw(`${PROJECT_ROOT_AGENTS_TABLE}_project_position`)}
                    ON ${sql.raw(PROJECT_ROOT_AGENTS_TABLE)} (project_id, position)`,
            );
        },
    ],
    [
        "007-project-root-agent-order-keys",
        /**
         * Root-agent placement uses a fractional key. Reordering updates just the
         * moved association, leaving every neighbour's durable placement intact.
         */
        async (_ctx: Context, database: AgentDatabase): Promise<void> => {
            await agentDatabaseRun(
                database,
                sql`ALTER TABLE ${sql.raw(PROJECT_ROOT_AGENTS_TABLE)}
                    ADD COLUMN order_key TEXT NOT NULL DEFAULT ''`,
            );
            await agentDatabaseRun(
                database,
                sql`UPDATE ${sql.raw(PROJECT_ROOT_AGENTS_TABLE)}
                    SET order_key = printf('%020d', position)
                    WHERE order_key = ''`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE INDEX ${sql.raw(`${PROJECT_ROOT_AGENTS_TABLE}_project_order`)}
                    ON ${sql.raw(PROJECT_ROOT_AGENTS_TABLE)} (project_id, order_key, agent_id)`,
            );
        },
    ],
    [
        "008-project-avatar-assets",
        /**
         * A project avatar is one normalized image, not metadata pointing at an independently
         * managed file. The bytes and their integrity metadata commit with the project row.
         * Earlier avatar JSON used a different shape, so it is deliberately discarded rather
         * than interpreted as the new resource.
         */
        async (_ctx: Context, database: AgentDatabase): Promise<void> => {
            await agentDatabaseRun(
                database,
                sql`UPDATE ${sql.raw(PROJECTS_TABLE)} SET avatar_json = NULL`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE ${sql.raw(PROJECT_AVATARS_TABLE)} (
                    project_id TEXT PRIMARY KEY,
                    image_bytes BLOB NOT NULL,
                    content_type TEXT NOT NULL,
                    content_hash TEXT NOT NULL,
                    thumbhash TEXT NOT NULL,
                    width INTEGER NOT NULL,
                    height INTEGER NOT NULL
                )`,
            );
        },
    ],
] as const;
