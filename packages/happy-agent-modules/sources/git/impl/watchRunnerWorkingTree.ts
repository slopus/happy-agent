import type { Compute, ComputeWatch } from "@slopus/happy-agent-compute";
import type { Context } from "@steve.kite/stdlib";

import type { WorkingTreeObserver } from "./WorkingTreeWatcher.js";

const RETRY_MS = 15_000;
const WATCH_IGNORE = ["node_modules", ".git"];

/**
 * Watch a working tree on a runner until the returned function is called.
 *
 * Batches become `update` changes, because a runner reports what may have changed rather than how;
 * an overflow becomes `null`, which tells the observer to look at everything again. When the watch
 * ends — usually because the runner dropped — the observer hears it is not watching and the watch
 * is opened again after a pause.
 */
export function watchRunnerWorkingTree(
    ctx: Context,
    machine: () => Promise<Compute>,
    root: string,
    observer: WorkingTreeObserver,
): () => void {
    let stopped = false;
    let current: ComputeWatch | undefined;
    let retry: NodeJS.Timeout | undefined;
    const open = async () => {
        try {
            const watcher = (await machine()).watcher;
            if (watcher === undefined) throw new Error("This runner cannot watch files.");
            const watch = await watcher.watch(ctx, { path: root, ignore: WATCH_IGNORE });
            if (stopped) {
                watch.close();
                return;
            }
            current = watch;
            observer.onWatching?.(true);
            watch.onChange((batch) => {
                if (batch.overflow) {
                    observer.onChanges(null);
                    return;
                }
                const changes = batch.paths
                    .filter((path) => path !== ".git" && !path.startsWith(".git/"))
                    .map((path) => ({ kind: "update" as const, path }));
                if (changes.length > 0) observer.onChanges(changes);
            });
            await watch.closed;
            if (current === watch) current = undefined;
        } catch {
            // Reported below as not watching; polling covers the gap.
        }
        if (stopped) return;
        observer.onWatching?.(false);
        retry = setTimeout(() => void open(), RETRY_MS);
        retry.unref?.();
    };
    void open();
    return () => {
        stopped = true;
        if (retry !== undefined) clearTimeout(retry);
        current?.close();
    };
}
