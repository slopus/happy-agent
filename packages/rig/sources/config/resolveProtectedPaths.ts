import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { parseConfigToml } from "./parseConfigToml.js";

export function resolveProtectedPaths(
    cwd: string,
    machineProtectedPaths: readonly string[],
): readonly string[] {
    const paths = new Set(machineProtectedPaths);
    const projectConfigPath = join(cwd, "happy.toml");
    try {
        for (const path of parseConfigToml(readFileSync(projectConfigPath, "utf8")).permissions
            ?.protectedPaths ?? []) {
            paths.add(path);
        }
    } catch (error) {
        if (
            !(
                error instanceof Error &&
                "code" in error &&
                ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")
            )
        ) {
            throw error;
        }
    }
    return [...paths].filter((path) => existsSync(resolve(cwd, path)));
}
