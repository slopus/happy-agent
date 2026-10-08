import { join } from "node:path";

import { computePermissions, type Compute } from "@slopus/happy-agent-compute";

import type { Project } from "../Project.js";

const PRODUCT = computePermissions("full_access");

/** Remove only a remote project cloned into Happy Agent's exact managed-projects directory. */
export async function removeManagedProjectDirectory(options: {
    /** The machine the project's folder is on. */
    machine: Compute;
    /** The managed-projects directory on that machine, as the machine names it. */
    managedProjectsDirectory: string;
    project: Project;
}): Promise<void> {
    const { machine, project } = options;
    const expected = join(options.managedProjectsDirectory, project.storageKey);
    if (project.remoteSource === undefined || project.repositoryRef !== expected) return;
    let metadata;
    try {
        metadata = await machine.fs.lstat(PRODUCT, expected);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
    }
    if (metadata.isSymbolicLink || !metadata.isDirectory) {
        throw new Error("Refusing to archive a managed project path that is not a directory.");
    }
    await machine.fs.rm(PRODUCT, expected, { force: true, recursive: true });
}
