import { sql, type SQL } from "drizzle-orm";
import { agentDatabaseRows, agentDatabaseRun, type AgentDatabase } from "@slopus/happy-agent-base";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

import { projectOrderKeySchema, projectVersionSchema, type Project } from "../Project.js";
import { PROJECTS_TABLE, PROJECT_SETTINGS_TABLE } from "../ProjectMigrations.js";
import { projectFromRow, type ProjectRow } from "../ProjectRow.js";
import { ProjectLifecycleError } from "../ProjectLifecycleError.js";

export function databaseFor(ctx: Context): AgentDatabase {
    return ctx.db;
}

export async function readProject(
    database: AgentDatabase,
    projectId: string,
): Promise<Project | undefined> {
    const rows = await agentDatabaseRows<ProjectRow>(
        database,
        sql`SELECT * FROM ${sql.raw(PROJECTS_TABLE)} WHERE id = ${projectId} LIMIT 1`,
    );
    const row = rows[0];
    return row === undefined ? undefined : projectFromRow(row);
}

export async function requireProject(database: AgentDatabase, projectId: string): Promise<Project> {
    const project = await readProject(database, projectId);
    if (project === undefined) throw new Error(`Project "${projectId}" was not found.`);
    return project;
}

export async function readProjectByPath(
    database: AgentDatabase,
    repositoryRef: string,
    runnerId: string | undefined,
): Promise<Project | undefined> {
    const rows = await agentDatabaseRows<ProjectRow>(
        database,
        sql`SELECT * FROM ${sql.raw(PROJECTS_TABLE)}
            WHERE repository_ref = ${repositoryRef} AND runner_id = ${runnerId ?? ""} LIMIT 1`,
    );
    const row = rows[0];
    return row === undefined ? undefined : projectFromRow(row);
}

/** The one home project, when the catalog already has it. */
export async function readHomeProject(database: AgentDatabase): Promise<Project | undefined> {
    const rows = await agentDatabaseRows<ProjectRow>(
        database,
        sql`SELECT * FROM ${sql.raw(PROJECTS_TABLE)} WHERE kind = 'home' LIMIT 1`,
    );
    const row = rows[0];
    return row === undefined ? undefined : projectFromRow(row);
}

export async function takenStorageKeys(database: AgentDatabase): Promise<ReadonlySet<string>> {
    const rows = await agentDatabaseRows<{ readonly storage_key: string }>(
        database,
        sql`SELECT storage_key FROM ${sql.raw(PROJECTS_TABLE)}`,
    );
    return new Set(rows.map((row) => row.storage_key.toLocaleLowerCase("en-US")));
}

export async function nextProjectOrderKey(database: AgentDatabase): Promise<string> {
    const rows = await agentDatabaseRows<{ readonly order_key: string }>(
        database,
        sql`SELECT order_key
            FROM ${sql.raw(PROJECTS_TABLE)}
            ORDER BY order_key DESC, id DESC
            LIMIT 1`,
    );
    const current = rows[0]?.order_key;
    if (current === undefined) return orderKeyForPosition(1);
    if (!Value.Check(projectOrderKeySchema, current)) {
        throw new Error("Project order storage contains an invalid key.");
    }
    let next: bigint;
    try {
        next = BigInt(current) + 1n;
    } catch {
        throw new Error("Project order storage contains an invalid key.");
    }
    const value = next.toString().padStart(20, "0");
    if (!Value.Check(projectOrderKeySchema, value)) {
        throw new Error("Project order storage exceeded its key bound.");
    }
    return value;
}

export function orderKeyForPosition(position: number): string {
    const value = String(position).padStart(20, "0");
    if (!Value.Check(projectOrderKeySchema, value)) {
        throw new Error("Project order position is invalid.");
    }
    return value;
}

/**
 * One guarded write, and the row it actually produced.
 *
 * The query must carry its own `WHERE version = ...` predicate and end in `RETURNING id`, so the
 * update either lands on exactly the row the decision was read from or lands nowhere. A write that
 * touched no row is a row something else moved first, and the caller is told rather than handed a
 * result it did not cause.
 */
export async function writeGuardedProject(
    database: AgentDatabase,
    projectId: string,
    expectedVersion: number,
    query: SQL,
    refusal: string,
): Promise<Project> {
    const affected = await agentDatabaseRows<{ readonly id: string }>(database, query);
    if (affected.length !== 1 || affected[0]?.id !== projectId) throw new Error(refusal);
    const stored = await requireProject(database, projectId);
    if (stored.version !== expectedVersion + 1) throw new Error(refusal);
    return stored;
}

/** Advances the resource version for a change owned by an adjacent project table. */
export async function touchProject(
    database: AgentDatabase,
    project: Project,
    refusal: string,
): Promise<Project> {
    return await writeGuardedProject(
        database,
        project.id,
        project.version,
        sql`UPDATE ${sql.raw(PROJECTS_TABLE)}
            SET updated_at = ${Date.now()}, version = version + 1
            WHERE id = ${project.id} AND version = ${project.version}
            RETURNING id`,
        refusal,
    );
}

/**
 * A write that rearranges a row without changing what the project is. Order is where a project sits
 * in a list, so it leaves the version alone — but it still refuses a row that moved underneath it,
 * because the list it was computed from would then be the wrong one.
 */
export async function writeGuardedProjectOrder(
    database: AgentDatabase,
    projectId: string,
    expectedVersion: number,
    orderKey: string,
    refusal: string,
): Promise<void> {
    const affected = await agentDatabaseRows<{ readonly id: string }>(
        database,
        sql`UPDATE ${sql.raw(PROJECTS_TABLE)}
            SET order_key = ${orderKey}
            WHERE id = ${projectId} AND version = ${expectedVersion}
            RETURNING id`,
    );
    if (affected.length !== 1) throw new Error(refusal);
}

export function assertExpectedProjectVersion(
    project: Project,
    expectedVersion: number | undefined,
    message: string,
): void {
    if (expectedVersion === undefined) return;
    if (!Value.Check(projectVersionSchema, expectedVersion)) throw new Error(message);
    if (project.version !== expectedVersion) throw new ProjectLifecycleError(message, project);
}

/** Writes a complete new project row and its empty settings row. */
export async function insertProjectRow(database: AgentDatabase, project: Project): Promise<void> {
    await agentDatabaseRun(
        database,
        sql`INSERT INTO ${sql.raw(PROJECTS_TABLE)} (
            id, repository_ref, runner_id, kind, storage_key, name, name_source,
            status, presence, initialization_status, initialization_attempt,
            initialization_error, default_branch, worktree_support,
            worktree_unsupported_reason, remote_source_json, required_secret_kind,
            git_ahead, git_behind, git_detached, git_branch, git_head, git_upstream,
            workspace_setup_commands_json,
            order_key, version, avatar_json, description, created_at, updated_at, archived_at
        ) VALUES (
            ${project.id}, ${project.repositoryRef}, ${project.runnerId ?? ""}, ${project.kind},
            ${project.storageKey}, ${project.name}, ${project.nameSource},
            ${project.status}, ${project.presence}, ${project.initializationStatus},
            ${project.initializationAttempt}, ${project.initializationError ?? null},
            ${project.defaultBranch ?? null}, ${project.worktreeSupport},
            ${project.worktreeUnsupportedReason ?? null},
            ${project.remoteSource === undefined ? null : JSON.stringify(project.remoteSource)},
            ${project.requiredSecretKind ?? null},
            ${project.gitAhead}, ${project.gitBehind}, ${project.gitDetached ? 1 : 0},
            ${project.gitBranch ?? null}, ${project.gitHead ?? null},
            ${project.gitUpstream ?? null},
            ${
                project.workspaceSetupCommands === undefined
                    ? null
                    : JSON.stringify(project.workspaceSetupCommands)
            },
            ${project.orderKey}, ${project.version},
            ${project.avatar === undefined ? null : JSON.stringify(project.avatar)},
            ${project.description ?? null}, ${project.createdAt}, ${project.updatedAt},
            ${project.archivedAt ?? null}
        )`,
    );
    await agentDatabaseRun(
        database,
        sql`INSERT INTO ${sql.raw(PROJECT_SETTINGS_TABLE)} (project_id, settings_json)
            VALUES (${project.id}, ${JSON.stringify({})})`,
    );
}
