import { lstat, rm } from "node:fs/promises";
import { join } from "node:path";

import type { GitModule } from "../../git/index.js";
import type { Project } from "../Project.js";

/** Remove only a remote project cloned into Happy Agent's exact managed-projects directory. */
export async function removeManagedProjectDirectory(options: {
    git: GitModule;
    managedProjectsDirectory: string;
    project: Project;
}): Promise<void> {
    const { project } = options;
    if (
        project.remoteSource === undefined ||
        project.repositoryRef !==
            options.git.normalizeFuturePath(
                join(options.managedProjectsDirectory, project.storageKey),
            )
    ) {
        return;
    }
    try {
        const metadata = await lstat(project.repositoryRef);
        if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
            throw new Error("Refusing to archive a managed project path that is not a directory.");
        }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
    }
    await rm(project.repositoryRef, { force: true, recursive: true });
}
