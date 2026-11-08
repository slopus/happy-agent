import type { PlatformPath } from "node:path";

import { computePermissions, type Compute } from "@slopus/happy-agent-compute";

import type { GitModule, GitWorktreePreservation } from "../../git/index.js";
import type { Project } from "../../projects/index.js";
import type { Workspace } from "../Workspace.js";
import { archivedWorkspaceRef } from "./archivedWorkspaceRef.js";

const VALID_STORAGE_KEY = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
const PRODUCT = computePermissions("full_access");

/**
 * Deletes the folder an archived workspace was working in.
 *
 * Removal is the one place a durable record makes Happy Agent delete something a person cannot get back,
 * so nothing here is taken on trust. The path must be exactly the managed path this workspace's
 * own storage identity describes; a symbolic link or anything that is not a directory is refused
 * outright; and a worktree is only removed through Git, from the project that still proves it
 * owns the shared repository. When the project itself is gone, the folder is removed only once
 * the shared Git directory is gone too — otherwise something else still owns this checkout.
 *
 * Archival passes `preserveChanges`: before a worktree folder is deleted, whatever its branch does
 * not already hold is committed to `archivedWorkspaceRef` in the project's repository, and the
 * answer says what was saved. Purging and clearing a half-made checkout delete outright.
 */
export async function removeWorkspaceDirectory(options: {
    git: GitModule;
    /** The machine the workspace's folder is on. */
    machine: Compute;
    /** That machine's path rules. */
    paths: PlatformPath;
    keepCopiesOnArchive: boolean;
    keepWorktreesOnArchive: boolean;
    preserveChanges: boolean;
    project: Project;
    stopped: () => boolean;
    workspace: Workspace;
}): Promise<GitWorktreePreservation | undefined> {
    const { machine, project, workspace } = options;
    const { basename, dirname } = options.paths;
    if (
        !VALID_STORAGE_KEY.test(project.storageKey) ||
        !VALID_STORAGE_KEY.test(workspace.storageKey)
    ) {
        throw new Error("The workspace storage identity is invalid.");
    }
    if (
        basename(workspace.path) !== workspace.storageKey ||
        basename(dirname(workspace.path)) !== project.storageKey
    ) {
        throw new Error("The workspace path does not match its managed storage identity.");
    }

    if (
        workspace.kind === "git_worktree"
            ? options.keepWorktreesOnArchive
            : options.keepCopiesOnArchive
    ) {
        return undefined;
    }

    let workspaceExists = true;
    try {
        const metadata = await machine.fs.lstat(PRODUCT, workspace.path);
        if (metadata.isSymbolicLink) {
            throw new Error("Refusing to archive a workspace path that is a symbolic link.");
        }
        if (!metadata.isDirectory) {
            throw new Error("Refusing to archive a workspace path that is not a directory.");
        }
        if ((await machine.fs.realpath(PRODUCT, workspace.path)) !== workspace.path) {
            throw new Error("The workspace path does not match its managed storage identity.");
        }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        workspaceExists = false;
    }
    if (options.stopped()) return undefined;

    const commonDir = workspace.gitCommonDir;
    if (workspace.kind !== "git_worktree" || commonDir === undefined) {
        // A copied folder, or a checkout that never got far enough for Git to know about it.
        if (workspaceExists)
            await machine.fs.rm(PRODUCT, workspace.path, { force: true, recursive: true });
        return undefined;
    }

    if (await machine.fs.exists(PRODUCT, project.repositoryRef)) {
        return await options.git.removeWorktree({
            ...(workspace.runnerId === undefined ? {} : { runnerId: workspace.runnerId }),
            expectedCommonDir: commonDir,
            ...(options.preserveChanges
                ? {
                      preserveChanges: {
                          message: preservationMessage(workspace),
                          ref: archivedWorkspaceRef(workspace.id),
                      },
                  }
                : {}),
            projectPath: project.repositoryRef,
            removeDirectory: workspaceExists,
            workspacePath: workspace.path,
        });
    }

    if (await machine.fs.exists(PRODUCT, commonDir)) {
        throw new Error(
            "The source project is unavailable while its Git common directory still exists.",
        );
    }
    if (workspaceExists)
        await machine.fs.rm(PRODUCT, workspace.path, { force: true, recursive: true });
    return undefined;
}

function preservationMessage(workspace: Workspace): string {
    return [
        `Uncommitted work from archived workspace ${JSON.stringify(workspace.name)}`,
        "",
        `Happy saved what workspace ${workspace.id} still held on branch ${workspace.branch}`,
        `before removing its worktree at ${workspace.path}.`,
    ].join("\n");
}
