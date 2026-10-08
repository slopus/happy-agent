import type { Context } from "@steve.kite/stdlib";

/** What to watch. */
export interface ComputeWatchOptions {
    /** The directory to watch recursively, relative to the compute's working directory. */
    path: string;
    /**
     * Directory names never descended into, at any depth — `node_modules`, for example. A watch on
     * Linux costs one kernel watch per directory, so skipping a dependency tree can be the
     * difference between watching a project and exhausting the machine's watch budget.
     */
    ignore?: readonly string[];
}

/** Paths that changed since the previous batch. */
export interface ComputeWatchBatch {
    /** Changed paths relative to the watched directory, with `/` separators, without duplicates. */
    paths: readonly string[];
    /**
     * Something may have changed that `paths` does not name: there were too many changes to list,
     * or part of the tree could not be watched. The caller should look at everything again.
     */
    overflow: boolean;
}

/** One running watch. */
export interface ComputeWatch {
    /** Receive batches. Returns the function that stops listening. */
    onChange(listener: (batch: ComputeWatchBatch) => void): () => void;
    /** Resolves when the watch ends: closed by the caller, or failed with a reason. */
    readonly closed: Promise<{ reason?: string }>;
    close(): void;
}

/**
 * Notifications about files changing, coalesced into batches.
 *
 * Batches say what may have changed, never what the change was: callers read the files again. A
 * watch is a hint that makes a scan cheaper, not a replacement for one.
 */
export interface ComputeWatcher {
    watch(ctx: Context, options: ComputeWatchOptions): Promise<ComputeWatch>;
}
