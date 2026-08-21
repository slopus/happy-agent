import { rename, rm, stat } from "node:fs/promises";
import { parse, join } from "node:path";

export const DAEMON_LOG_ROTATION_BYTES = 10 * 1024 * 1024;

export async function rotateDaemonLog(
    path: string,
    maximumBytes = DAEMON_LOG_ROTATION_BYTES,
): Promise<void> {
    let size: number;
    try {
        size = (await stat(path)).size;
    } catch (error) {
        if (
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "ENOENT"
        )
            return;
        throw error;
    }
    if (size < maximumBytes) return;

    const parsed = parse(path);
    const previousPath = join(parsed.dir, `${parsed.name}.previous${parsed.ext || ".log"}`);
    await rm(previousPath, { force: true });
    await rename(path, previousPath);
}
