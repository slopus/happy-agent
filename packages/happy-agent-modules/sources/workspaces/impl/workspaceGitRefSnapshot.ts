import { computePermissions, type Compute } from "@slopus/happy-agent-compute";

import type { GitModule } from "../../git/index.js";

const PRODUCT = computePermissions("full_access");

/**
 * One bounded look at a project's branches and its managed workspace folders.
 *
 * Reservation decides a branch and a folder key inside a database transaction, so it cannot ask
 * Git or the machine about every candidate. Both are read once beforehand, on the machine the
 * project is on, which turns each candidate check into a set lookup. `complete` is false when
 * either could not be read in full, which tells the reservation to fall back to an
 * identity-bearing key instead of trusting an incomplete view.
 */
export interface WorkspaceGitRefSnapshot {
    readonly complete: boolean;
    readonly branches: ReadonlySet<string>;
    readonly folders: ReadonlySet<string>;
}

export async function workspaceGitRefSnapshot(options: {
    readonly git: GitModule;
    readonly machine: Compute;
    readonly projectPath: string;
    /** Whether the project is a Git repository whose branches workspaces are cut as. */
    readonly repository: boolean;
    readonly runnerId?: string;
    readonly workspaceRoot: string;
}): Promise<WorkspaceGitRefSnapshot> {
    let complete = true;
    let folders: ReadonlySet<string> = new Set();
    try {
        folders = new Set(await options.machine.fs.readdir(PRODUCT, options.workspaceRoot));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") complete = false;
    }
    let branches: ReadonlySet<string> = new Set();
    if (options.repository) {
        try {
            const listing = await options.git.readOnly(
                options.projectPath,
                ["for-each-ref", "--format=%(refname)", "refs/heads"],
                options.runnerId === undefined ? {} : { runnerId: options.runnerId },
            );
            branches = new Set(listing.split("\n").filter((line) => line.length > 0));
        } catch {
            complete = false;
        }
    }
    return { complete, branches, folders };
}

/** Whether Git already holds this branch. */
export function gitBranchExists(snapshot: WorkspaceGitRefSnapshot, branch: string): boolean {
    return snapshot.branches.has(`refs/heads/${branch}`);
}

/** Whether a managed folder key is already a directory or already names a workspace branch. */
export function workspaceStorageKeyExists(
    snapshot: WorkspaceGitRefSnapshot,
    storageKey: string,
): boolean {
    return snapshot.folders.has(storageKey) || gitBranchExists(snapshot, `worktree/${storageKey}`);
}
