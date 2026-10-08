import { normalize } from "node:path";

import { computePermissions, type Compute } from "@slopus/happy-agent-compute";

import { ProjectRegistrationError } from "../ProjectRegistrationError.js";

const PRODUCT = computePermissions("full_access");

/**
 * Checks a folder someone asked to register explicitly, on the machine it is on, and returns the
 * path as that machine names it.
 *
 * Any readable directory is a project. Registration never inspects Git: setup separately decides
 * whether the folder has a usable repository and whether child workspaces use worktrees or copies.
 */
export async function validateRegistrationPath(
    machine: Compute,
    requestedPath: string,
): Promise<string> {
    let details;
    try {
        details = await machine.fs.stat(PRODUCT, requestedPath);
    } catch (error) {
        if (isMissingPathError(error)) {
            throw new ProjectRegistrationError(
                "path_missing",
                "The project folder does not exist.",
            );
        }
        throw new ProjectRegistrationError(
            "path_inaccessible",
            "The project folder is not accessible.",
        );
    }
    if (!details.isDirectory) {
        throw new ProjectRegistrationError("not_directory", "The project path is not a folder.");
    }
    try {
        await machine.fs.readdirPage(PRODUCT, requestedPath, { limit: 1 });
    } catch {
        throw new ProjectRegistrationError(
            "path_inaccessible",
            "The project folder is not accessible.",
        );
    }
    try {
        return await machine.fs.realpath(PRODUCT, requestedPath);
    } catch {
        return normalize(requestedPath);
    }
}

function isMissingPathError(error: unknown): boolean {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    return code === "ENOENT" || code === "ENOTDIR";
}
