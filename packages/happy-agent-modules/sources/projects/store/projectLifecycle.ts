import { sql } from "drizzle-orm";

import type { Project } from "../Project.js";
import { PROJECTS_TABLE } from "../ProjectMigrations.js";
import type { ProjectStateChanges, ProjectStore } from "../ProjectStore.js";
import {
    assertExpectedProjectVersion,
    databaseFor,
    requireProject,
    writeGuardedProject,
} from "./projectRecords.js";

/** Archival, restoration, and the host-reported state a project accumulates. */
export function createProjectLifecycle(): Pick<ProjectStore, "archive" | "restore" | "applyState"> {
    return {
        archive: async (ctx, input) => {
            const database = databaseFor(ctx);
            const before = await requireProject(database, input.projectId);
            if (before.status === "archived") {
                return {
                    operation: "archive",
                    changed: false,
                    project: before,
                };
            }
            assertExpectedProjectVersion(
                before,
                input.expectedVersion,
                "The project changed before it could be archived.",
            );
            const updatedAt = Date.now();
            return {
                operation: "archive",
                changed: true,
                project: await writeGuardedProject(
                    database,
                    input.projectId,
                    before.version,
                    sql`UPDATE ${sql.raw(PROJECTS_TABLE)}
                        SET status = 'archived', archived_at = ${updatedAt},
                            updated_at = ${updatedAt}, version = version + 1
                        WHERE id = ${input.projectId} AND version = ${before.version}
                        RETURNING id`,
                    "The project changed before it could be archived.",
                ),
            };
        },
        restore: async (ctx, input) => {
            const database = databaseFor(ctx);
            const before = await requireProject(database, input.projectId);
            if (before.status === "active") {
                return {
                    operation: "restore",
                    changed: false,
                    project: before,
                };
            }
            const updatedAt = Date.now();
            return {
                operation: "restore",
                changed: true,
                project: await writeGuardedProject(
                    database,
                    input.projectId,
                    before.version,
                    sql`UPDATE ${sql.raw(PROJECTS_TABLE)}
                        SET status = 'active', archived_at = ${null},
                            updated_at = ${updatedAt}, version = version + 1
                        WHERE id = ${input.projectId} AND version = ${before.version}
                        RETURNING id`,
                    "The project changed before it could be restored.",
                ),
            };
        },
        applyState: async (ctx, input) => {
            const database = databaseFor(ctx);
            const before = await requireProject(database, input.projectId);
            const after = withStateChanges(before, input.changes);
            if (JSON.stringify(after) === JSON.stringify(before)) {
                return {
                    operation: "state_change",
                    changed: false,
                    project: before,
                };
            }
            const updatedAt = Date.now();
            const stored = await writeGuardedProject(
                database,
                input.projectId,
                before.version,
                sql`UPDATE ${sql.raw(PROJECTS_TABLE)}
                    SET name = ${after.name},
                        name_source = ${after.nameSource},
                        presence = ${after.presence},
                        initialization_status = ${after.initializationStatus},
                        initialization_attempt = ${after.initializationAttempt},
                        initialization_error = ${after.initializationError ?? null},
                        default_branch = ${after.defaultBranch ?? null},
                        worktree_support = ${after.worktreeSupport},
                        worktree_unsupported_reason = ${after.worktreeUnsupportedReason ?? null},
                        git_ahead = ${after.gitAhead},
                        git_behind = ${after.gitBehind},
                        git_detached = ${after.gitDetached ? 1 : 0},
                        git_branch = ${after.gitBranch ?? null},
                        git_head = ${after.gitHead ?? null},
                        git_upstream = ${after.gitUpstream ?? null},
                        workspace_setup_commands_json = ${
                            after.workspaceSetupCommands === undefined
                                ? null
                                : JSON.stringify(after.workspaceSetupCommands)
                        },
                        updated_at = ${updatedAt},
                        version = version + 1
                    WHERE id = ${input.projectId} AND version = ${before.version}
                    RETURNING id`,
                "The project changed before its state could be recorded.",
            );
            return {
                operation: "state_change",
                changed: true,
                project: stored,
            };
        },
    };
}

/** Applies one host report to a project row. A null clears the field. */
function withStateChanges(project: Project, changes: ProjectStateChanges): Project {
    const next = structuredClone(project);
    if (changes.name !== undefined) next.name = changes.name;
    if (changes.nameSource !== undefined) next.nameSource = changes.nameSource;
    if (changes.presence !== undefined) next.presence = changes.presence;
    if (changes.worktreeSupport !== undefined) next.worktreeSupport = changes.worktreeSupport;
    if (changes.worktreeUnsupportedReason !== undefined) {
        setOptional(next, "worktreeUnsupportedReason", changes.worktreeUnsupportedReason);
    }
    if (changes.defaultBranch !== undefined) next.defaultBranch = changes.defaultBranch;
    if (changes.initializationStatus !== undefined) {
        next.initializationStatus = changes.initializationStatus;
    }
    if (changes.initializationAttempt !== undefined) {
        next.initializationAttempt = changes.initializationAttempt;
    }
    if (changes.initializationError !== undefined) {
        setOptional(next, "initializationError", changes.initializationError);
    }
    if (changes.gitAhead !== undefined) next.gitAhead = changes.gitAhead;
    if (changes.gitBehind !== undefined) next.gitBehind = changes.gitBehind;
    if (changes.gitDetached !== undefined) next.gitDetached = changes.gitDetached;
    if (changes.gitBranch !== undefined) setOptional(next, "gitBranch", changes.gitBranch);
    if (changes.gitHead !== undefined) setOptional(next, "gitHead", changes.gitHead);
    if (changes.gitUpstream !== undefined) setOptional(next, "gitUpstream", changes.gitUpstream);
    if (changes.workspaceSetupCommands !== undefined) {
        next.workspaceSetupCommands = structuredClone(changes.workspaceSetupCommands);
    }
    return next;
}

function setOptional(
    project: Project,
    field:
        | "worktreeUnsupportedReason"
        | "initializationError"
        | "gitBranch"
        | "gitHead"
        | "gitUpstream",
    value: string | null,
): void {
    if (value === null) {
        delete project[field];
        return;
    }
    project[field] = value;
}
