import { basename, dirname } from "node:path";

import { computePermissions, type Compute } from "@slopus/happy-agent-compute";

import type { GitCredentialRef, GitModule } from "../../git/index.js";
import type { Project } from "../../projects/index.js";
import type { Workspace } from "../Workspace.js";

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
 */
export async function removeWorkspaceDirectory(options: {
    credential?: GitCredentialRef;
    git: GitModule;
    /** The machine the workspace's folder is on. */
    machine: Compute;
    keepCopiesOnArchive: boolean;
    keepWorktreesOnArchive: boolean;
    project: Project;
    stopped: () => boolean;
    workspace: Workspace;
}): Promise<void> {
    const { machine, project, workspace } = options;
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
        return;
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
    if (options.stopped()) return;

    const commonDir = workspace.gitCommonDir;
    if (workspace.kind !== "git_worktree" || commonDir === undefined) {
        // A copied folder, or a checkout that never got far enough for Git to know about it.
        if (workspaceExists)
            await machine.fs.rm(PRODUCT, workspace.path, { force: true, recursive: true });
        return;
    }

    if (await machine.fs.exists(PRODUCT, project.repositoryRef)) {
        await options.git.removeWorktree({
            ...(options.credential === undefined ? {} : { credential: options.credential }),
            ...(workspace.runnerId === undefined ? {} : { runnerId: workspace.runnerId }),
            expectedCommonDir: commonDir,
            projectPath: project.repositoryRef,
            removeDirectory: workspaceExists,
            workspacePath: workspace.path,
        });
        return;
    }

    if (await machine.fs.exists(PRODUCT, commonDir)) {
        throw new Error(
            "The source project is unavailable while its Git common directory still exists.",
        );
    }
    if (workspaceExists)
        await machine.fs.rm(PRODUCT, workspace.path, { force: true, recursive: true });
}
