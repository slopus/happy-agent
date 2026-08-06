import { basename, isAbsolute, resolve } from "node:path";

import { isPathInsideWorkspace } from "./isPathInsideWorkspace.js";
import { isProtectedGitControlPath } from "./isProtectedGitControlPath.js";
import { isProtectedProjectConfigPath } from "./isProtectedProjectConfigPath.js";
import { resolvePotentialPath } from "./resolvePotentialPath.js";
import { isProtectedPath, type PermissionMode } from "../../permissions/index.js";

export async function assertCanWritePath(
    cwd: string,
    targetPath: string,
    mode: PermissionMode,
    protectedPaths: readonly string[] = [],
): Promise<void> {
    if (mode === "full_access") return;
    if (mode === "read_only") {
        throw new Error("File changes are disabled in read-only mode.");
    }

    if (!(await isPathInsideWorkspace(cwd, targetPath))) {
        throw new Error(
            `Workspace write mode cannot modify files outside the working directory: ${cwd}.`,
        );
    }

    const absoluteTarget = isAbsolute(targetPath) ? targetPath : resolve(cwd, targetPath);
    if (isProtectedPath(absoluteTarget, protectedPaths)) {
        throw new Error(
            `${mode === "auto" ? "Auto mode" : "Workspace write mode"} cannot modify a protected workspace path without Full access.`,
        );
    }
    const canonicalTarget = await resolvePotentialPath(absoluteTarget);
    const canonicalCwd = await resolvePotentialPath(cwd);
    if (
        isProtectedProjectConfigPath(cwd, absoluteTarget) ||
        isProtectedProjectConfigPath(canonicalCwd, canonicalTarget)
    ) {
        throw new Error(
            `Workspace write mode cannot modify the project ${basename(absoluteTarget)} file.`,
        );
    }
    if (isProtectedGitControlPath(absoluteTarget) || isProtectedGitControlPath(canonicalTarget)) {
        throw new Error(
            "Workspace write mode cannot modify Git control files without Full access.",
        );
    }
}
