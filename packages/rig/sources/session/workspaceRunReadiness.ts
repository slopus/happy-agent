import { statSync } from "node:fs";

import type { ProjectRepository } from "../project/ProjectRepository.js";
import { normalizeProjectCwd } from "../utils/normalizeProjectCwd.js";
import type { WorkspaceRunReadiness } from "./InMemorySession.js";

export interface WorkspaceRunTarget {
    cwd: string;
    projectId: string;
    workspaceId: string;
}

/** The one durable gate every session store applies before a managed-workspace runtime exists. */
export function workspaceRunReadiness(
    projects: Pick<ProjectRepository, "getWorkspace">,
    target: WorkspaceRunTarget,
    stat: typeof statSync = statSync,
): WorkspaceRunReadiness {
    const workspace = projects.getWorkspace(target.projectId, target.workspaceId);
    if (workspace === undefined) {
        return {
            message:
                "The queued run could not start because its managed workspace no longer exists.",
            state: "failed",
        };
    }
    if (normalizeProjectCwd(workspace.path) !== normalizeProjectCwd(target.cwd)) {
        return {
            message:
                "The queued run could not start because its session directory no longer matches its managed workspace.",
            state: "failed",
        };
    }
    if (workspace.status === "initializing") return { state: "waiting" };
    if (workspace.status === "failed") {
        return {
            message: `The queued run could not start because workspace initialization failed${
                workspace.error === undefined ? "." : `: ${workspace.error}`
            }`,
            state: "failed",
        };
    }
    if (workspace.status === "archiving" || workspace.status === "archived") {
        return {
            message: "The queued run could not start because its managed workspace was archived.",
            state: "failed",
        };
    }
    if (workspace.presence !== "present") {
        return {
            message:
                "The queued run could not start because its managed workspace directory is unavailable.",
            state: "failed",
        };
    }
    try {
        if (stat(workspace.path).isDirectory()) return { state: "ready" };
        return {
            message:
                "The queued run could not start because its managed workspace path is not a directory.",
            state: "failed",
        };
    } catch (error) {
        const code = (error as NodeJS.ErrnoException | null)?.code;
        if (code !== "ENOENT" && code !== "ENOTDIR") {
            // An inconclusive filesystem probe must never destroy durable user work immediately.
            // The session applies a short bounded retry schedule before recording a clear failure.
            return { retryable: true, state: "waiting" };
        }
    }
    return {
        message:
            "The queued run could not start because its managed workspace directory is unavailable.",
        state: "failed",
    };
}
