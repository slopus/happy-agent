import { sql } from "drizzle-orm";
import { agentDatabaseRun, type AgentDatabase } from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";

export const WORKSPACES_TABLE = "happy_agent_module_workspaces";
export const WORKSPACE_AGENTS_TABLE = "happy_agent_module_workspace_agents";
const WORKSPACE_RECEIPTS_TABLE = "happy_agent_module_workspace_operation_receipts";
const WORKSPACE_PROOFS_TABLE = "happy_agent_module_workspace_mutation_proofs";

/** Durable workspace catalog owned by the workspaces module. */
export const workspaceMigrations = [
    [
        "001-workspaces-catalog",
        async (_ctx: Context, database: AgentDatabase): Promise<void> => {
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE IF NOT EXISTS ${sql.raw(WORKSPACES_TABLE)} (
                    id TEXT PRIMARY KEY,
                    owner_agent_id TEXT NOT NULL,
                    project_ref TEXT NOT NULL,
                    base_ref TEXT,
                    name TEXT NOT NULL,
                    status TEXT NOT NULL,
                    created_at BIGINT NOT NULL,
                    updated_at BIGINT NOT NULL,
                    archived_at BIGINT
                )`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE INDEX IF NOT EXISTS ${sql.raw(`${WORKSPACES_TABLE}_project_id`)}
                    ON ${sql.raw(WORKSPACES_TABLE)} (project_ref, id)`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE IF NOT EXISTS ${sql.raw(WORKSPACE_RECEIPTS_TABLE)} (
                    agent_id TEXT NOT NULL,
                    operation_id TEXT NOT NULL,
                    result_json TEXT NOT NULL,
                    PRIMARY KEY (agent_id, operation_id)
                )`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE IF NOT EXISTS ${sql.raw(WORKSPACE_PROOFS_TABLE)} (
                    agent_id TEXT NOT NULL,
                    operation_id TEXT NOT NULL,
                    proof_json TEXT NOT NULL,
                    PRIMARY KEY (agent_id, operation_id)
                )`,
            );
        },
    ],
    [
        "002-drop-workspace-replay-state",
        async (_ctx: Context, database: AgentDatabase): Promise<void> => {
            await agentDatabaseRun(
                database,
                sql`DROP TABLE IF EXISTS ${sql.raw(WORKSPACE_RECEIPTS_TABLE)}`,
            );
            await agentDatabaseRun(
                database,
                sql`DROP TABLE IF EXISTS ${sql.raw(WORKSPACE_PROOFS_TABLE)}`,
            );
        },
    ],
    [
        "003-workspace-path",
        async (_ctx: Context, database: AgentDatabase): Promise<void> => {
            await agentDatabaseRun(
                database,
                sql`ALTER TABLE ${sql.raw(WORKSPACES_TABLE)} ADD COLUMN path TEXT`,
            );
        },
    ],
    [
        // A workspace is now a branch, a folder, a base, and a lifecycle rather than an opaque
        // catalog row, and branch, storage key, path, and kind are all NOT NULL. Happy Agent is early
        // stage, so this discards the old table instead of carrying a column-by-column data
        // migration for rows that could not describe a real worktree anyway.
        "004-workspace-git-record",
        async (_ctx: Context, database: AgentDatabase): Promise<void> => {
            await agentDatabaseRun(
                database,
                sql`DROP TABLE IF EXISTS ${sql.raw(WORKSPACES_TABLE)}`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE ${sql.raw(WORKSPACES_TABLE)} (
                    id TEXT PRIMARY KEY,
                    owner_agent_id TEXT NOT NULL,
                    project_ref TEXT NOT NULL,
                    name TEXT NOT NULL,
                    name_key TEXT NOT NULL,
                    name_configured INTEGER NOT NULL,
                    branch TEXT NOT NULL,
                    storage_key TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    path TEXT NOT NULL,
                    base_ref TEXT,
                    base_commit TEXT,
                    git_common_dir TEXT,
                    presence TEXT NOT NULL,
                    status TEXT NOT NULL,
                    order_key TEXT NOT NULL,
                    version INTEGER NOT NULL,
                    creator_session_id TEXT,
                    git_ahead INTEGER NOT NULL,
                    git_behind INTEGER NOT NULL,
                    git_detached INTEGER NOT NULL,
                    git_head TEXT,
                    git_upstream TEXT,
                    initialization_attempt INTEGER NOT NULL,
                    initialization_error TEXT,
                    created_at BIGINT NOT NULL,
                    updated_at BIGINT NOT NULL,
                    archived_at BIGINT
                )`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE INDEX IF NOT EXISTS ${sql.raw(`${WORKSPACES_TABLE}_order`)}
                    ON ${sql.raw(WORKSPACES_TABLE)} (project_ref, order_key, id)`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE UNIQUE INDEX IF NOT EXISTS ${sql.raw(`${WORKSPACES_TABLE}_path`)}
                    ON ${sql.raw(WORKSPACES_TABLE)} (path)`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE UNIQUE INDEX IF NOT EXISTS ${sql.raw(`${WORKSPACES_TABLE}_branch`)}
                    ON ${sql.raw(WORKSPACES_TABLE)} (project_ref, branch)`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE UNIQUE INDEX IF NOT EXISTS ${sql.raw(`${WORKSPACES_TABLE}_storage_key`)}
                    ON ${sql.raw(WORKSPACES_TABLE)} (project_ref, storage_key)`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE UNIQUE INDEX IF NOT EXISTS ${sql.raw(`${WORKSPACES_TABLE}_name_key`)}
                    ON ${sql.raw(WORKSPACES_TABLE)} (project_ref, name_key)`,
            );
        },
    ],
    [
        // A workspace belongs to the project it was cut from, not to an agent. The owning agent was
        // always the one identity the daemon had, so the column decided nothing and every read
        // ignored it. Happy Agent is early stage, so the generation is advanced and the catalog reset
        // rather than rebuilding the table to drop a column SQLite cannot drop in place.
        "005-workspace-without-owner",
        async (_ctx: Context, database: AgentDatabase): Promise<void> => {
            await agentDatabaseRun(
                database,
                sql`DROP TABLE IF EXISTS ${sql.raw(WORKSPACES_TABLE)}`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE ${sql.raw(WORKSPACES_TABLE)} (
                    id TEXT PRIMARY KEY,
                    project_ref TEXT NOT NULL,
                    name TEXT NOT NULL,
                    name_key TEXT NOT NULL,
                    name_configured INTEGER NOT NULL,
                    branch TEXT NOT NULL,
                    storage_key TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    path TEXT NOT NULL,
                    base_ref TEXT,
                    base_commit TEXT,
                    git_common_dir TEXT,
                    presence TEXT NOT NULL,
                    status TEXT NOT NULL,
                    order_key TEXT NOT NULL,
                    version INTEGER NOT NULL,
                    creator_session_id TEXT,
                    git_ahead INTEGER NOT NULL,
                    git_behind INTEGER NOT NULL,
                    git_detached INTEGER NOT NULL,
                    git_head TEXT,
                    git_upstream TEXT,
                    initialization_attempt INTEGER NOT NULL,
                    initialization_error TEXT,
                    created_at BIGINT NOT NULL,
                    updated_at BIGINT NOT NULL,
                    archived_at BIGINT
                )`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE INDEX IF NOT EXISTS ${sql.raw(`${WORKSPACES_TABLE}_order`)}
                    ON ${sql.raw(WORKSPACES_TABLE)} (project_ref, order_key, id)`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE UNIQUE INDEX IF NOT EXISTS ${sql.raw(`${WORKSPACES_TABLE}_path`)}
                    ON ${sql.raw(WORKSPACES_TABLE)} (path)`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE UNIQUE INDEX IF NOT EXISTS ${sql.raw(`${WORKSPACES_TABLE}_branch`)}
                    ON ${sql.raw(WORKSPACES_TABLE)} (project_ref, branch)`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE UNIQUE INDEX IF NOT EXISTS ${sql.raw(`${WORKSPACES_TABLE}_storage_key`)}
                    ON ${sql.raw(WORKSPACES_TABLE)} (project_ref, storage_key)`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE UNIQUE INDEX IF NOT EXISTS ${sql.raw(`${WORKSPACES_TABLE}_name_key`)}
                    ON ${sql.raw(WORKSPACES_TABLE)} (project_ref, name_key)`,
            );
        },
    ],
    [
        // Conversations are agents, and their durable placement belongs to the workspace catalog.
        // Associations stay separate from workspace lifecycle rows: moving an agent changes neither
        // a branch nor the folder it works in.
        "006-workspace-agent-associations",
        async (_ctx: Context, database: AgentDatabase): Promise<void> => {
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE ${sql.raw(WORKSPACE_AGENTS_TABLE)} (
                    workspace_id TEXT NOT NULL,
                    agent_id TEXT PRIMARY KEY,
                    order_key TEXT NOT NULL
                )`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE INDEX ${sql.raw(`${WORKSPACE_AGENTS_TABLE}_workspace_order`)}
                    ON ${sql.raw(WORKSPACE_AGENTS_TABLE)} (workspace_id, order_key, agent_id)`,
            );
        },
    ],
    [
        // A project ID is the implicit root of its workspace tree. Existing workspaces become
        // direct children of that root; nested workspaces are introduced by new reservations.
        "007-workspace-hierarchy",
        async (_ctx: Context, database: AgentDatabase): Promise<void> => {
            await agentDatabaseRun(
                database,
                sql`ALTER TABLE ${sql.raw(WORKSPACES_TABLE)}
                    ADD COLUMN parent_id TEXT NOT NULL DEFAULT ''`,
            );
            await agentDatabaseRun(
                database,
                sql`UPDATE ${sql.raw(WORKSPACES_TABLE)}
                    SET parent_id = project_ref
                    WHERE parent_id = ''`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE INDEX ${sql.raw(`${WORKSPACES_TABLE}_project_parent_order`)}
                    ON ${sql.raw(WORKSPACES_TABLE)} (project_ref, parent_id, order_key, id)`,
            );
        },
    ],
] as const;
