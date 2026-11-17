import { execFileHidden } from "../../utils/hiddenChildProcess.js";
import { basename, dirname } from "node:path";

/** How long the process listing is given; the menu bar starts regardless once it passes. */
const LISTING_TIMEOUT_MS = 2_000;

/**
 * The menu bar apps in `listing` left behind by a daemon that is gone.
 *
 * `listing` is `ps -x -o pid=,ppid=,comm=` output: this user's processes with their full
 * executable paths. An app is an orphan when launchd has adopted it (its parent is 1) and it was
 * materialized next to `executable` — another `menu-bar-*` directory of the same binary assets,
 * which is where every released version, older ones included, puts its copy. An app with a live
 * parent belongs to a running daemon and is never chosen.
 */
export function orphanedMenuBarApps(listing: string, executable: string): number[] {
    const assets = dirname(dirname(executable));
    const name = basename(executable);
    const orphans: number[] = [];
    for (const line of listing.split("\n")) {
        const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
        if (match === null) continue;
        const [, pid, ppid, command] = match;
        if (ppid !== "1" || command === undefined) continue;
        if (basename(command) !== name) continue;
        const directory = dirname(command);
        if (dirname(directory) !== assets || !basename(directory).startsWith("menu-bar-")) {
            continue;
        }
        orphans.push(Number(pid));
    }
    return orphans;
}

/**
 * Stops the menu bar apps earlier daemons left running, so a new daemon's app is the only one.
 *
 * Older releases watched only their standard input, and anything else holding that pipe kept the
 * app alive after its daemon was gone: a second H, still flashing from a turn that had ended
 * long ago. Returns the process IDs that were asked to stop. Anything that goes wrong only means
 * nothing is stopped; the menu bar starts either way.
 */
export async function reapOrphanedMenuBarApps(executable: string): Promise<number[]> {
    if (process.platform !== "darwin") return [];
    const listing = await new Promise<string>((resolve) => {
        execFileHidden(
            "/bin/ps",
            ["-x", "-o", "pid=,ppid=,comm="],
            { timeout: LISTING_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
            (error, stdout) => resolve(error === null ? stdout : ""),
        );
    });
    const orphans = orphanedMenuBarApps(listing, executable);
    for (const pid of orphans) {
        try {
            process.kill(pid, "SIGTERM");
        } catch {
            // Already gone.
        }
    }
    return orphans;
}
