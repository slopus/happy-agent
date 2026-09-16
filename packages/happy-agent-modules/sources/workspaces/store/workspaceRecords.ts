import { sql } from "drizzle-orm";
import { agentDatabaseRows, agentDatabaseRun, type AgentDatabase } from "@slopus/happy-agent-base";
import { Value } from "@sinclair/typebox/value";

import { workspaceSchema, type Workspace } from "../Workspace.js";
import { workspaceNameKey } from "../WorkspaceIdentity.js";
import { WORKSPACES_TABLE } from "../WorkspaceMigrations.js";

type WorkspaceRow = {
    readonly id: string;
    readonly project_ref: string;
    readonly parent_id: string;
    readonly name: string;
    readonly name_configured: number;
    readonly branch: string;
    readonly storage_key: string;
    readonly kind: string;
    readonly path: string;
    readonly base_ref: string | null;
    readonly base_commit: string | null;
    readonly git_common_dir: string | null;
    readonly presence: string;
    readonly status: string;
    readonly order_key: string;
    readonly version: number | string;
    readonly creator_session_id: string | null;
    readonly git_ahead: number | string;
    readonly git_behind: number | string;
    readonly git_detached: number;
    readonly git_head: string | null;
    readonly git_upstream: string | null;
    readonly initialization_attempt: number | string;
    readonly initialization_error: string | null;
    readonly created_at: number | string;
    readonly updated_at: number | string;
    readonly archived_at: number | string | null;
    readonly service_cleanup: string | null;
};

export function assertWorkspace(value: unknown): asserts value is Workspace {
    if (!Value.Check(workspaceSchema, value)) {
        throw new Error("Workspace store returned an invalid workspace.");
    }
}

export async function readWorkspace(
    database: AgentDatabase,
    workspaceId: string,
): Promise<Workspace | undefined> {
    const rows = await agentDatabaseRows<WorkspaceRow>(
        database,
        sql`SELECT * FROM ${sql.raw(WORKSPACES_TABLE)}
            WHERE id = ${workspaceId} LIMIT 1`,
    );
    const row = rows[0];
    return row === undefined ? undefined : workspaceFromRow(row);
}

export async function readWorkspaceByPath(
    database: AgentDatabase,
    path: string,
): Promise<Workspace | undefined> {
    const rows = await agentDatabaseRows<WorkspaceRow>(
        database,
        sql`SELECT * FROM ${sql.raw(WORKSPACES_TABLE)} WHERE path = ${path} LIMIT 1`,
    );
    const row = rows[0];
    return row === undefined ? undefined : workspaceFromRow(row);
}

export async function readProjectWorkspaces(
    database: AgentDatabase,
    projectRef: string,
): Promise<readonly Workspace[]> {
    const rows = await agentDatabaseRows<WorkspaceRow>(
        database,
        sql`SELECT * FROM ${sql.raw(WORKSPACES_TABLE)} WHERE project_ref = ${projectRef}`,
    );
    return rows.map(workspaceFromRow);
}

/** Direct children of one node, ordered within that one sibling list. */
export async function readWorkspaceChildren(
    database: AgentDatabase,
    projectRef: string,
    parentId: string,
    includeArchived = true,
): Promise<readonly Workspace[]> {
    const rows = await agentDatabaseRows<WorkspaceRow>(
        database,
        includeArchived
            ? sql`SELECT * FROM ${sql.raw(WORKSPACES_TABLE)}
                   WHERE project_ref = ${projectRef} AND parent_id = ${parentId}
                   ORDER BY order_key, id`
            : sql`SELECT * FROM ${sql.raw(WORKSPACES_TABLE)}
                   WHERE project_ref = ${projectRef}
                     AND parent_id = ${parentId}
                     AND status NOT IN ('archived', 'archiving')
                   ORDER BY order_key, id`,
    );
    return rows.map(workspaceFromRow);
}

/**
 * Validates and returns the chain from a workspace to its project's implicit root. A corrupt or
 * cross-project parent never becomes an ownership answer.
 */
export async function readWorkspaceAncestorIds(
    database: AgentDatabase,
    workspace: Workspace,
): Promise<readonly string[]> {
    const ancestors: string[] = [];
    const visited = new Set<string>();
    let current = workspace;
    for (;;) {
        if (visited.has(current.id)) {
            throw new Error(`Workspace "${workspace.id}" has a cyclic parent chain.`);
        }
        visited.add(current.id);
        ancestors.push(current.id);
        if (current.parentId === current.projectRef) return ancestors;

        const parent = await readWorkspace(database, current.parentId);
        if (parent === undefined) {
            throw new Error(`Workspace "${current.id}" has a parent that does not exist.`);
        }
        if (parent.projectRef !== workspace.projectRef) {
            throw new Error(`Workspace "${current.id}" has a parent in another project.`);
        }
        current = parent;
    }
}

export async function readProjectWorkspacesFor(
    database: AgentDatabase,
    workspaceId: string,
): Promise<readonly Workspace[]> {
    const workspace = await readWorkspace(database, workspaceId);
    if (workspace === undefined) return [];
    return await readProjectWorkspaces(database, workspace.projectRef);
}

export async function readWorkspacePage(
    database: AgentDatabase,
    query: {
        readonly projectRef: string | undefined;
        readonly includeArchived: boolean;
        readonly cursor: number;
        readonly limit: number;
    },
): Promise<readonly Workspace[]> {
    // One row past the page proves whether another page exists, so an exact-sized page does not
    // hand out a cursor that leads to nothing.
    const window = query.limit + 1;
    const rows = await agentDatabaseRows<WorkspaceRow>(
        database,
        query.projectRef === undefined
            ? query.includeArchived
                ? sql`SELECT * FROM ${sql.raw(WORKSPACES_TABLE)}
                       ORDER BY order_key, id LIMIT ${window} OFFSET ${query.cursor}`
                : sql`SELECT * FROM ${sql.raw(WORKSPACES_TABLE)}
                       WHERE status NOT IN ('archived', 'archiving')
                       ORDER BY order_key, id LIMIT ${window} OFFSET ${query.cursor}`
            : query.includeArchived
              ? sql`SELECT * FROM ${sql.raw(WORKSPACES_TABLE)}
                     WHERE project_ref = ${query.projectRef}
                     ORDER BY order_key, id LIMIT ${window} OFFSET ${query.cursor}`
              : sql`SELECT * FROM ${sql.raw(WORKSPACES_TABLE)}
                     WHERE project_ref = ${query.projectRef}
                       AND status NOT IN ('archived', 'archiving')
                     ORDER BY order_key, id LIMIT ${window} OFFSET ${query.cursor}`,
    );
    return rows.map(workspaceFromRow);
}

export async function insertWorkspace(
    database: AgentDatabase,
    workspace: Workspace,
): Promise<void> {
    await agentDatabaseRun(
        database,
        sql`INSERT INTO ${sql.raw(WORKSPACES_TABLE)} (
            id, project_ref, parent_id, name, name_key, name_configured, branch, storage_key,
            kind, path, base_ref, base_commit, git_common_dir, presence, status, order_key,
            version, creator_session_id, git_ahead, git_behind, git_detached, git_head,
            git_upstream, initialization_attempt, initialization_error, created_at, updated_at,
            archived_at, service_cleanup
        ) VALUES (
            ${workspace.id}, ${workspace.projectRef}, ${workspace.parentId}, ${workspace.name},
            ${workspaceNameKey(workspace.name)}, ${workspace.nameConfigured ? 1 : 0},
            ${workspace.branch}, ${workspace.storageKey}, ${workspace.kind}, ${workspace.path},
            ${workspace.baseRef ?? null}, ${workspace.baseCommit ?? null},
            ${workspace.gitCommonDir ?? null}, ${workspace.presence}, ${workspace.status},
            ${workspace.orderKey}, ${workspace.version}, ${workspace.creatorSessionId ?? null},
            ${workspace.gitAhead}, ${workspace.gitBehind}, ${workspace.gitDetached ? 1 : 0},
            ${workspace.gitHead ?? null}, ${workspace.gitUpstream ?? null},
            ${workspace.initializationAttempt}, ${workspace.initializationError ?? null},
            ${workspace.createdAt}, ${workspace.updatedAt}, ${workspace.archivedAt ?? null},
            ${workspace.serviceCleanup === undefined ? null : JSON.stringify(workspace.serviceCleanup)}
        )`,
    );
}

/**
 * Writes one workspace over the exact row it was decided from.
 *
 * The version the caller read is part of the predicate, so a row another writer moved in the
 * meantime is left alone and the caller is told rather than silently overwritten. The stored row is
 * read back afterwards: a mutation reports the state that is actually durable.
 */
export async function writeWorkspace(
    database: AgentDatabase,
    workspace: Workspace,
    expectedVersion: number,
): Promise<Workspace> {
    const affected = await agentDatabaseRows<{ readonly id: string }>(
        database,
        sql`UPDATE ${sql.raw(WORKSPACES_TABLE)}
            SET project_ref = ${workspace.projectRef},
                parent_id = ${workspace.parentId},
                name = ${workspace.name},
                name_key = ${workspaceNameKey(workspace.name)},
                name_configured = ${workspace.nameConfigured ? 1 : 0},
                branch = ${workspace.branch},
                storage_key = ${workspace.storageKey},
                kind = ${workspace.kind},
                path = ${workspace.path},
                base_ref = ${workspace.baseRef ?? null},
                base_commit = ${workspace.baseCommit ?? null},
                git_common_dir = ${workspace.gitCommonDir ?? null},
                presence = ${workspace.presence},
                status = ${workspace.status},
                order_key = ${workspace.orderKey},
                version = ${workspace.version},
                creator_session_id = ${workspace.creatorSessionId ?? null},
                git_ahead = ${workspace.gitAhead},
                git_behind = ${workspace.gitBehind},
                git_detached = ${workspace.gitDetached ? 1 : 0},
                git_head = ${workspace.gitHead ?? null},
                git_upstream = ${workspace.gitUpstream ?? null},
                initialization_attempt = ${workspace.initializationAttempt},
                initialization_error = ${workspace.initializationError ?? null},
                created_at = ${workspace.createdAt},
                updated_at = ${workspace.updatedAt},
                archived_at = ${workspace.archivedAt ?? null},
                service_cleanup = ${workspace.serviceCleanup === undefined ? null : JSON.stringify(workspace.serviceCleanup)}
            WHERE id = ${workspace.id} AND version = ${expectedVersion}
            RETURNING id`,
    );
    if (affected.length !== 1) {
        throw new Error(
            `Workspace "${workspace.id}" changed before this write could be applied to it.`,
        );
    }
    const stored = await readWorkspace(database, workspace.id);
    if (stored === undefined || !sameJson(stored, workspace)) {
        throw new Error(`Workspace "${workspace.id}" did not store the state that was written.`);
    }
    return stored;
}

/** Advances the resource version for a change owned by an adjacent workspace table. */
export async function touchWorkspace(
    database: AgentDatabase,
    workspace: Workspace,
): Promise<Workspace> {
    return await writeWorkspace(
        database,
        {
            ...workspace,
            version: workspace.version + 1,
            updatedAt: Date.now(),
        },
        workspace.version,
    );
}

/** Whether a failed write lost a race for a name, rather than failing for some other reason. */
export function isUniquenessConflict(error: unknown): boolean {
    // A driver reports the failed statement and keeps the constraint that refused it as the cause.
    for (let current = error, depth = 0; current !== undefined && depth < 8; depth += 1) {
        const message = current instanceof Error ? current.message : String(current);
        if (/unique|duplicate/iu.test(message)) return true;
        if (!(current instanceof Error)) return false;
        current = current.cause;
    }
    return false;
}

function workspaceFromRow(row: WorkspaceRow): Workspace {
    const workspace: Workspace = {
        id: row.id,
        projectRef: row.project_ref,
        parentId: row.parent_id,
        name: row.name,
        nameConfigured: Number(row.name_configured) !== 0,
        branch: row.branch,
        storageKey: row.storage_key,
        kind: row.kind as Workspace["kind"],
        path: row.path,
        ...(row.base_ref === null ? {} : { baseRef: row.base_ref }),
        ...(row.base_commit === null ? {} : { baseCommit: row.base_commit }),
        ...(row.git_common_dir === null ? {} : { gitCommonDir: row.git_common_dir }),
        presence: row.presence as Workspace["presence"],
        status: row.status as Workspace["status"],
        orderKey: row.order_key,
        version: Number(row.version),
        ...(row.creator_session_id === null ? {} : { creatorSessionId: row.creator_session_id }),
        gitAhead: Number(row.git_ahead),
        gitBehind: Number(row.git_behind),
        gitDetached: Number(row.git_detached) !== 0,
        ...(row.git_head === null ? {} : { gitHead: row.git_head }),
        ...(row.git_upstream === null ? {} : { gitUpstream: row.git_upstream }),
        initializationAttempt: Number(row.initialization_attempt),
        ...(row.initialization_error === null
            ? {}
            : { initializationError: row.initialization_error }),
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
        ...(row.archived_at === null ? {} : { archivedAt: Number(row.archived_at) }),
        ...(row.service_cleanup === null
            ? {}
            : { serviceCleanup: JSON.parse(row.service_cleanup) }),
    };
    assertWorkspace(workspace);
    return workspace;
}

/**
 * Compares two records by value rather than by the order their keys happen to be written in.
 * Records are rebuilt by spreading and deleting optional fields, so insertion order says nothing
 * about whether anything actually changed.
 */
export function sameJson(left: unknown, right: unknown): boolean {
    return stableJson(left) === stableJson(right);
}

function stableJson(value: unknown): string {
    return JSON.stringify(value, (_key, item: unknown) =>
        item !== null && typeof item === "object" && !Array.isArray(item)
            ? Object.fromEntries(
                  Object.entries(item as Record<string, unknown>).sort(([left], [right]) =>
                      left < right ? -1 : left > right ? 1 : 0,
                  ),
              )
            : item,
    );
}
