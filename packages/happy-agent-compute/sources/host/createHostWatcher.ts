import { watch as watchPath, type FSWatcher } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import type { Context } from "@steve.kite/stdlib";

import type {
    ComputeWatch,
    ComputeWatchBatch,
    ComputeWatcher,
    ComputeWatchOptions,
} from "../ComputeWatcher.js";

export interface HostWatcherOptions {
    /** The directory relative watch paths resolve against. */
    readonly cwd: string;
    readonly platform?: NodeJS.Platform;
}

export interface HostWatcher extends ComputeWatcher {
    /** Close every watch still open. */
    dispose(): void;
}

/** How long changes are gathered before a batch is delivered. */
const HOST_WATCH_BATCH_DELAY_MS = 50;
/** More changed paths than this in one batch are reported as an overflow instead. */
const HOST_WATCH_MAX_BATCH_PATHS = 4096;
/** Linux directories one watch may hold before the rest of the tree is reported unwatched. */
const HOST_WATCH_MAX_DIRECTORIES = 20_000;

/** Notifications about this machine's files. */
export function createHostWatcher(options: HostWatcherOptions): HostWatcher {
    const open = new Set<HostWatch>();
    const platform = options.platform ?? process.platform;
    return {
        async watch(_ctx: Context, watch: ComputeWatchOptions): Promise<ComputeWatch> {
            const root = resolve(options.cwd, watch.path);
            if (!(await lstat(root)).isDirectory()) {
                throw Object.assign(new Error(`${watch.path} is not a directory.`), {
                    code: "ENOTDIR",
                });
            }
            const created = new HostWatch(root, new Set(watch.ignore ?? []), platform);
            open.add(created);
            void created.closed.finally(() => open.delete(created));
            await created.start();
            return created;
        },
        dispose() {
            for (const watch of open) watch.close();
        },
    };
}

class HostWatch implements ComputeWatch {
    readonly closed: Promise<{ reason?: string }>;
    readonly #root: string;
    readonly #ignore: ReadonlySet<string>;
    readonly #platform: NodeJS.Platform;
    readonly #watchers = new Map<string, FSWatcher>();
    readonly #pending = new Set<string>();
    #overflow = false;
    #timer: NodeJS.Timeout | undefined;
    #listener: ((batch: ComputeWatchBatch) => void) | undefined;
    #finish!: (result: { reason?: string }) => void;
    #ended = false;

    constructor(root: string, ignore: ReadonlySet<string>, platform: NodeJS.Platform) {
        this.#root = root;
        this.#ignore = ignore;
        this.#platform = platform;
        this.closed = new Promise((resolve) => {
            this.#finish = resolve;
        });
    }

    async start(): Promise<void> {
        if (this.#platform === "linux") {
            await this.#addTree("");
            return;
        }
        // FSEvents and ReadDirectoryChangesW watch a whole tree natively at no per-directory cost.
        const watcher = watchPath(this.#root, { persistent: false, recursive: true }, (_, name) => {
            if (name === null) {
                this.#markOverflow();
                return;
            }
            const relative = name.split(sep).join("/");
            if (relative.split("/").some((segment) => this.#ignore.has(segment))) return;
            this.#record(relative);
        });
        watcher.on("error", (error) => this.#end(errorMessage(error)));
        this.#watchers.set("", watcher);
    }

    onChange(listener: (batch: ComputeWatchBatch) => void): () => void {
        this.#listener = listener;
        this.#schedule();
        return () => {
            if (this.#listener === listener) this.#listener = undefined;
        };
    }

    close(): void {
        this.#end(undefined);
    }

    /** Watch a directory and everything below it that is not ignored, one watch per directory. */
    async #addTree(relative: string): Promise<void> {
        const queue = [relative];
        while (queue.length > 0 && !this.#ended) {
            const directory = queue.shift()!;
            if (this.#watchers.has(directory)) continue;
            if (this.#watchers.size >= HOST_WATCH_MAX_DIRECTORIES) {
                this.#markOverflow();
                return;
            }
            const absolute = join(this.#root, directory);
            let watcher: FSWatcher;
            try {
                watcher = watchPath(absolute, { persistent: false }, (event, name) =>
                    this.#onDirectoryEvent(directory, event, name),
                );
            } catch (error) {
                if (directory === "") {
                    this.#end(errorMessage(error));
                    return;
                }
                // Out of kernel watches, or the directory vanished: callers must rescan.
                this.#markOverflow();
                continue;
            }
            watcher.on("error", (error) => {
                this.#removeTree(directory);
                if (directory === "") this.#end(errorMessage(error));
                else this.#markOverflow();
            });
            this.#watchers.set(directory, watcher);
            let entries;
            try {
                entries = await readdir(absolute, { withFileTypes: true });
            } catch {
                continue;
            }
            for (const entry of entries) {
                if (!entry.isDirectory() || this.#ignore.has(entry.name)) continue;
                queue.push(directory === "" ? entry.name : `${directory}/${entry.name}`);
            }
        }
    }

    #onDirectoryEvent(directory: string, event: string, name: string | Buffer | null): void {
        if (name === null) {
            this.#markOverflow();
            return;
        }
        const entry = String(name);
        if (this.#ignore.has(entry)) return;
        const relative = directory === "" ? entry : `${directory}/${entry}`;
        this.#record(relative);
        if (event !== "rename") return;
        void lstat(join(this.#root, relative)).then(
            (stat) => {
                if (stat.isDirectory() && !this.#watchers.has(relative)) {
                    void this.#addTree(relative);
                }
            },
            () => this.#removeTree(relative),
        );
    }

    #removeTree(relative: string): void {
        for (const [directory, watcher] of this.#watchers) {
            if (relative === "" || directory === relative || directory.startsWith(`${relative}/`)) {
                watcher.close();
                this.#watchers.delete(directory);
            }
        }
    }

    #record(relative: string): void {
        if (this.#ended) return;
        if (!this.#overflow) {
            this.#pending.add(relative);
            if (this.#pending.size > HOST_WATCH_MAX_BATCH_PATHS) this.#markOverflow();
        }
        this.#schedule();
    }

    #markOverflow(): void {
        if (this.#ended) return;
        this.#overflow = true;
        this.#pending.clear();
        this.#schedule();
    }

    #schedule(): void {
        if (this.#timer !== undefined || this.#listener === undefined) return;
        if (this.#pending.size === 0 && !this.#overflow) return;
        this.#timer = setTimeout(() => {
            this.#timer = undefined;
            this.#flush();
        }, HOST_WATCH_BATCH_DELAY_MS);
        this.#timer.unref?.();
    }

    #flush(): void {
        const listener = this.#listener;
        if (listener === undefined || this.#ended) return;
        const batch: ComputeWatchBatch = { paths: [...this.#pending], overflow: this.#overflow };
        this.#pending.clear();
        this.#overflow = false;
        if (batch.paths.length > 0 || batch.overflow) listener(batch);
    }

    #end(reason: string | undefined): void {
        if (this.#ended) return;
        this.#flush();
        this.#ended = true;
        clearTimeout(this.#timer);
        for (const watcher of this.#watchers.values()) watcher.close();
        this.#watchers.clear();
        this.#finish(reason === undefined ? {} : { reason });
    }
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
