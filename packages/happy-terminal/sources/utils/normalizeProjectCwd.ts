import { realpathSync } from "node:fs";
import { resolve } from "node:path";

export function normalizeProjectCwd(cwd: string): string {
    const absolute = resolve(cwd);
    try {
        return realpathSync.native(absolute);
    } catch {
        return absolute;
    }
}
