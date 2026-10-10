import {
    agentDatabaseRun,
    type AgentDatabase,
    type AgentDatabaseFacade,
} from "@slopus/happy-agent-base";
import { sql } from "drizzle-orm";
import type { Context } from "@steve.kite/stdlib";

export const TASKS_TABLE = "happy_agent_module_tasks";
export const TASK_MEMBERS_TABLE = "happy_agent_module_task_members";

/**
 * The `tasks` module's migrations.
 *
 * The module name once belonged to a per-agent checklist kept in `happy_agent_task_state`. Agent
 * Base requires the migrations a database has applied to stay a prefix of the declared list, so
 * the checklist's released migration stays here unchanged, the next one removes its table, and
 * the task catalog follows. Tasks have no catalog order of their own: each member orders the tasks
 * they joined, so the order lives on the membership.
 */
export const taskMigrations = [
    [
        "001-task-state",
        async (_ctx: Context, database: AgentDatabaseFacade<AgentDatabase>): Promise<void> => {
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE IF NOT EXISTS happy_agent_task_state (
                        agent_id TEXT PRIMARY KEY,
                        tasks_json TEXT NOT NULL
                    )`,
            );
        },
    ],
    [
        "002-task-list-removed",
        async (_ctx: Context, database: AgentDatabaseFacade<AgentDatabase>): Promise<void> => {
            await agentDatabaseRun(database, sql`DROP TABLE IF EXISTS happy_agent_task_state`);
        },
    ],
    [
        "003-task-catalog",
        async (_ctx: Context, database: AgentDatabaseFacade<AgentDatabase>): Promise<void> => {
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE ${sql.raw(TASKS_TABLE)} (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    folder_name TEXT NOT NULL UNIQUE,
                    owner_user_id TEXT,
                    creator_agent_id TEXT,
                    workspace_id TEXT NOT NULL UNIQUE,
                    workspace_version INTEGER NOT NULL,
                    workspace_updated_at BIGINT NOT NULL,
                    agent_id TEXT NOT NULL UNIQUE,
                    path TEXT NOT NULL UNIQUE,
                    runner_id TEXT,
                    status TEXT NOT NULL,
                    version INTEGER NOT NULL,
                    created_at BIGINT NOT NULL,
                    updated_at BIGINT NOT NULL,
                    archived_at BIGINT
                )`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE INDEX ${sql.raw(`${TASKS_TABLE}_created`)}
                    ON ${sql.raw(TASKS_TABLE)} (created_at, id)`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE INDEX ${sql.raw(`${TASKS_TABLE}_creator`)}
                    ON ${sql.raw(TASKS_TABLE)} (creator_agent_id)`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE ${sql.raw(TASK_MEMBERS_TABLE)} (
                    task_id TEXT NOT NULL,
                    member_id TEXT NOT NULL,
                    order_key TEXT NOT NULL,
                    joined_at BIGINT NOT NULL,
                    PRIMARY KEY (task_id, member_id)
                )`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE INDEX ${sql.raw(`${TASK_MEMBERS_TABLE}_order`)}
                    ON ${sql.raw(TASK_MEMBERS_TABLE)} (member_id, order_key, task_id)`,
            );
        },
    ],
] as const;
