import { isPathInside, joinComputePath } from "./resolveComputePath.js";

/** Root project files that change the boundary future commands run inside. */
export const PROJECT_PROTECTED_COMPUTE_FILE_NAMES = [
    "happy.toml",
    "mcp.toml",
    "AGENTS_SECURITY.md",
] as const;

/**
 * Whether the machine guards this path even inside the workspace. The compute names them — Git
 * control files, the project configuration that grants network access — and a change to one is
 * reviewed however ordinary the file looks.
 */
export function isProtectedComputePath(path: string, protectedPaths: readonly string[]): boolean {
    return protectedPaths.some((protectedPath) => isPathInside(protectedPath, path));
}

/** The protected project files at the root of one compute workspace. */
export function projectProtectedComputePaths(cwd: string): readonly string[] {
    return PROJECT_PROTECTED_COMPUTE_FILE_NAMES.map((name) => joinComputePath(cwd, name));
}
