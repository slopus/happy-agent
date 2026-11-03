import { watch, type FSWatcher } from "node:fs";

import { containsHomeDirectory } from "./containsHomeDirectory.js";

export interface FolderEntriesObserver {
    /** An entry of the folder itself changed; `undefined` when the runtime did not say which. */
    readonly onEntry: (name: string | undefined) => void;
    /** Whether events are currently arriving; polling must cover the gaps. */
    readonly onWatching: (watching: boolean) => void;
}

/**
 * Watches only the entries of one folder on this machine, never what is below them.
 *
 * A folder that is not a repository has no Git state to keep current until `.git` appears in it,
 * and a recursive watch of it can cost tens of thousands of inotify watches when an agent keeps
 * caches or a package store there. This costs one. The home directory and its ancestors are never
 * watched, as with the working-tree watch; their observers poll.
 */
export function watchFolderEntries(root: string, observer: FolderEntriesObserver): () => void {
    let closed = false;
    let watcher: FSWatcher | undefined;
    void containsHomeDirectory(root).then((home) => {
        if (closed || home) return;
        try {
            watcher = watch(root, { persistent: false }, (_event, name) => {
                if (!closed) observer.onEntry(name === null ? undefined : String(name));
            });
        } catch {
            // Missing or unreadable: the folder is polled.
            return;
        }
        watcher.on("error", () => {
            watcher?.close();
            watcher = undefined;
            if (!closed) observer.onWatching(false);
        });
        watcher.unref?.();
        observer.onWatching(true);
    });
    return () => {
        closed = true;
        watcher?.close();
        watcher = undefined;
    };
}
