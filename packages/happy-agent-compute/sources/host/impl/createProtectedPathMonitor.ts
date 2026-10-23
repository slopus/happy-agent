import { watch, type FSWatcher } from "node:fs";
import { lstat, rm } from "node:fs/promises";
import { dirname } from "node:path";

export interface ProtectedPathMonitor {
    stop(): Promise<boolean>;
}

/**
 * Watches paths a Linux- or Windows-sandboxed command must not create and removes any that appear.
 *
 * The sandbox forbids writing agent metadata such as a project's protected config, but a command
 * may still try. Watching those exact paths and deleting whatever shows up, then reporting that a
 * violation occurred, is the fail-closed backstop: the file never survives the command, and the
 * caller can surface that the sandbox blocked the attempt. macOS Seatbelt denies both the exact
 * path and its descendants natively, as Codex does, so it needs no host filesystem watcher.
 *
 * Windows ACLs can only deny writes to an object that exists, so a missing protected path is
 * guarded here rather than by materializing an empty placeholder in the user's project.
 */
export async function createProtectedPathMonitor(
    paths: readonly string[],
): Promise<ProtectedPathMonitor> {
    const protectedPaths = [...new Set(paths)];
    if (
        (process.platform !== "linux" && process.platform !== "win32") ||
        protectedPaths.length === 0
    ) {
        return { stop: async () => false };
    }
    const watchers: FSWatcher[] = [];
    let scanning: Promise<void> | undefined;
    let stopped = false;
    let violation = false;
    const scan = async () => {
        for (const path of protectedPaths) {
            try {
                const metadata = await lstat(path);
                violation = true;
                await rm(path, {
                    force: true,
                    recursive: metadata.isDirectory() && !metadata.isSymbolicLink(),
                });
            } catch (error) {
                if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
                    violation = true;
                }
            }
        }
    };
    const scheduleScan = () => {
        if (stopped || scanning !== undefined) return;
        scanning = scan().finally(() => {
            scanning = undefined;
        });
    };

    await scan();
    for (const parent of new Set(protectedPaths.map(dirname))) {
        try {
            const watcher = watch(parent, { persistent: false }, scheduleScan);
            watcher.on("error", scheduleScan);
            watchers.push(watcher);
        } catch {
            // Polling below remains the fail-closed fallback when inotify is unavailable.
        }
    }
    // Windows directory watches do not drop creations the way an overflowing inotify queue can,
    // and every poll is several file-system calls for as long as the command runs. Polling
    // there only backs the watches up.
    const interval = setInterval(scheduleScan, process.platform === "win32" ? 100 : 1);
    interval.unref();

    return {
        async stop() {
            if (!stopped) {
                stopped = true;
                clearInterval(interval);
                for (const watcher of watchers) watcher.close();
                await scanning;
                await scan();
            }
            return violation;
        },
    };
}
