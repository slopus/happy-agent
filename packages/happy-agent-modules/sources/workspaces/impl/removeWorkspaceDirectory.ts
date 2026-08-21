import { existsSync } from "node:fs";
import { lstat, rm } from "node:fs/promises";
import { basename, dirname } from "node:path";

import type { GitCredentialRef, GitModule } from "../../git/index.js";
import type { Project } from "../../projects/index.js";
import type { Workspace } from "../Workspace.js";

const VALID_STORAGE_KEY = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;

/**
 * Deletes the folder an archived workspace was working in.
 *
 * Removal is the one place a durable record makes Happy Agent delete something a person cannot get back,
 * so nothing here is taken on trust. The path must be exactly the managed path this workspace's
 * own storage identity describes; a symbolic link or anything that is not a directory is refused
 * outright; and a worktree is only removed through Git, from the project that still proves it
 * owns the shared repository. When the project itself is gone, the folder is removed only once
 * the shared Git directory is gone too — otherwise something else still owns this checkout.
 */
export async function removeWorkspaceDirectory(options: {
    credential?: GitCredentialRef;
    git: GitModule;
    keepCopiesOnArchive: boolean;
    keepWorktreesOnArchive: boolean;
    project: Project;
    stopped: () => boolean;
    workspace: Workspace;
}): Promise<void> {
    const { project, workspace } = options;
    if (
        !VALID_STORAGE_KEY.test(project.storageKey) ||
        !VALID_STORAGE_KEY.test(workspace.storageKey)
    ) {
        throw new Error("The workspace storage identity is invalid.");
    }
    const workspacePath = options.git.normalizeFuturePath(workspace.path);
    if (
        workspace.path !== workspacePath ||
        basename(workspacePath) !== workspace.storageKey ||
        basename(dirname(workspacePath)) !== project.storageKey
    ) {
        throw new Error("The workspace path does not match its managed storage identity.");
    }

    if (
        workspace.kind === "git_worktree"
            ? options.keepWorktreesOnArchive
            : options.keepCopiesOnArchive
    ) {
        return;
    }

    let workspaceExists = true;
    try {
        const metadata = await lstat(workspace.path);
        if (metadata.isSymbolicLink()) {
            throw new Error("Refusing to archive a workspace path that is a symbolic link.");
        }
        if (!metadata.isDirectory()) {
            throw new Error("Refusing to archive a workspace path that is not a directory.");
        }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        workspaceExists = false;
    }
    if (options.stopped()) return;

    const commonDir = workspace.gitCommonDir;
    if (workspace.kind !== "git_worktree" || commonDir === undefined) {
        // A copied folder, or a checkout that never got far enough for Git to know about it.
        if (workspaceExists) await rm(workspace.path, { force: true, recursive: true });
        return;
    }

    if (existsSync(project.repositoryRef)) {
        await options.git.removeWorktree({
            ...(options.credential === undefined ? {} : { credential: options.credential }),
            expectedCommonDir: commonDir,
            projectPath: project.repositoryRef,
            removeDirectory: workspaceExists,
            workspacePath: workspace.path,
        });
        return;
    }

    if (existsSync(commonDir)) {
        throw new Error(
            "The source project is unavailable while its Git common directory still exists.",
        );
    }
    if (workspaceExists) await rm(workspace.path, { force: true, recursive: true });
}
