import { resolve } from "node:path";

import { computePermissions, type Compute } from "@slopus/happy-agent-compute";

import { PROJECT_CONFIG_FILE_NAMES } from "./loadWorkspaceFolderSettings.js";

const PRODUCT = computePermissions("full_access");
const SYNC_POLL_MS = 2_000;

/**
 * Notices changes to the project root's configuration and sync sources, best-effort.
 *
 * The handful of paths involved are looked at together every couple of seconds on the machine the
 * project is on, which costs one small request whether the folder is here or on a runner, and
 * never arms a watch over the project's whole tree. Every observed change funnels into one
 * callback: the caller re-reads the configuration, re-arms this, and replicates everything, so a
 * coarse observation still converges. A synced directory is seen to change when its own entries
 * do; a change deeper inside it is caught by the next change anywhere else.
 */
export function watchWorkspaceSyncPaths(options: {
    machine: Compute;
    onChange: () => void;
    projectPath: string;
    syncPaths: readonly string[];
}): () => void {
    const paths = [
        ...new Set([
            ...PROJECT_CONFIG_FILE_NAMES.map((name) => resolve(options.projectPath, name)),
            ...options.syncPaths.map((path) => resolve(options.projectPath, path)),
        ]),
    ];
    let stopped = false;
    let previous: string | undefined;
    let timer: NodeJS.Timeout | undefined;
    const look = async (): Promise<void> => {
        let signature: string | undefined;
        try {
            const stats = await options.machine.fs.lstatMany(PRODUCT, paths);
            signature = JSON.stringify(
                stats.map((stat) =>
                    stat === undefined ? null : [stat.isDirectory, stat.size, stat.mtimeMs],
                ),
            );
        } catch {
            // A machine that cannot answer right now is asked again on the next look.
        }
        if (stopped) return;
        if (signature !== undefined) {
            if (previous !== undefined && signature !== previous) options.onChange();
            previous = signature;
        }
        timer = setTimeout(() => void look(), SYNC_POLL_MS);
        timer.unref?.();
    };
    void look();
    return () => {
        stopped = true;
        if (timer !== undefined) clearTimeout(timer);
    };
}
