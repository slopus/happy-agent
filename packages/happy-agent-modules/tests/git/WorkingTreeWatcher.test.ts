import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createRootContext } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it } from "vitest";

import {
    WorkingTreeWatcher,
    type WorkingTreeChange,
} from "../../sources/git/impl/WorkingTreeWatcher.js";
import { scanGitRunnerFromCommandRunner } from "../../sources/git/runScanGit.js";
import { cleanupRoots, commitFile, createRepository, createRoot, gitRunner } from "./helpers.js";

// Git runs directly so these run inside an already sandboxed test process too.
const scan = scanGitRunnerFromCommandRunner({
    run: async (cwd, args, options) =>
        await gitRunner.run(cwd, ["--no-optional-locks", ...args], options),
});
const disposers: (() => void)[] = [];

afterEach(async () => {
    for (const dispose of disposers.splice(0)) dispose();
    await cleanupRoots();
});

// Native watch setup and Git subprocesses can be slow on a loaded machine.
describe("WorkingTreeWatcher", { timeout: 60_000 }, () => {
    it.skipIf(process.platform === "win32")(
        "reports changes when the watched root is a directory symlink",
        async () => {
            const root = await realpath(await createRoot());
            const actual = join(root, "actual");
            const alias = join(root, "alias");
            await mkdir(actual);
            await symlink(actual, alias);
            const { changes, watching } = watchRepository(alias);
            await expect.poll(watching, { timeout: 5_000 }).toBe(true);
            await writeFile(join(alias, "changed.txt"), "visible through the alias\n");
            await expect
                .poll(() => changes.map((change) => change.path), { timeout: 5_000 })
                .toContain("changed.txt");
        },
    );

    it("reports working-tree changes and nothing from ignored directories", async () => {
        const repository = await createRepository();
        await commitFile(repository, ".gitignore", "build/\n");
        await mkdir(join(repository, "build", "deep"), { recursive: true });
        await mkdir(join(repository, "node_modules", "package"), { recursive: true });
        await mkdir(join(repository, "src"));
        const { changes, watcher, watching } = watchRepository(repository);
        await waitFor(() => watching());

        await writeFile(join(repository, "build", "deep", "output.js"), "built\n");
        await writeFile(join(repository, "node_modules", "package", "index.js"), "dep\n");
        await writeFile(join(repository, ".git", "scratch"), "internal\n");
        await writeFile(join(repository, "src", "main.ts"), "source\n");
        await waitFor(() => changes.some((change) => change.path === "src/main.ts"));
        await settle();

        expect(new Set(changes.map((change) => change.path))).toEqual(new Set(["src/main.ts"]));
        expect(changes[0]?.kind).toBe("create");
        expect(watcher.isWatching(repository)).toBe(true);
    });

    it("stops reporting a directory once Git starts ignoring it", async () => {
        const repository = await createRepository();
        await commitFile(repository, ".gitignore", "build/\n");
        const { changes, watching } = watchRepository(repository);
        await waitFor(() => watching());

        await mkdir(join(repository, "out"));
        await writeFile(join(repository, ".gitignore"), "build/\nout/\n");
        await waitFor(() => changes.some((change) => change.path === ".gitignore"));

        // The ignore list is re-derived shortly after `.gitignore` changes, at most every ten
        // seconds per folder. Until then `out/` is still watched.
        const deadline = Date.now() + 40_000;
        let observed: string[] = [];
        while (Date.now() < deadline) {
            changes.length = 0;
            await writeFile(
                join(repository, "out", "artifact.js"),
                `built ${String(Date.now())}\n`,
            );
            await writeFile(join(repository, "tracked.txt"), `source ${String(Date.now())}\n`);
            await waitFor(() => changes.some((change) => change.path === "tracked.txt"));
            await settle();
            observed = [...new Set(changes.map((change) => change.path))];
            if (!observed.includes("out/artifact.js")) break;
        }
        expect(observed).toEqual(["tracked.txt"]);
    }, 120_000);

    it("shares one watch per folder and closes it with its last observer", async () => {
        const repository = await createRepository();
        await commitFile(repository, "README.md", "fixture\n");
        const first = watchRepository(repository);
        const second = watchRepository(repository, first.watcher);
        await waitFor(() => first.watching() && second.watching());

        first.release();
        await writeFile(join(repository, "shared.txt"), "one\n");
        await waitFor(() => second.changes.some((change) => change.path === "shared.txt"));
        expect(first.changes).toEqual([]);

        second.release();
        expect(first.watcher.isWatching(repository)).toBe(false);
    });

    it("delivers events to a watch opened right after another one closed", async () => {
        // The native backend is torn down when its last watch closes; a watch opened during that
        // teardown used to attach to the dying backend and never hear anything.
        for (let attempt = 0; attempt < 10; attempt += 1) {
            const closing = await createRoot();
            const first = new WorkingTreeWatcher(createRootContext(), scan);
            let firstWatching = false;
            first.watch(closing, {
                onChanges: () => undefined,
                onWatching: (watching) => {
                    firstWatching = watching;
                },
            });
            await waitFor(() => firstWatching);
            first.dispose();

            const opened = await createRoot();
            const { changes, watching } = watchRepository(opened);
            await waitFor(() => watching());
            await writeFile(join(opened, "created.txt"), String(attempt));
            await waitFor(() => changes.some((change) => change.path === "created.txt"));
        }
    });

    it("reports an unwatchable folder so its observers keep polling", async () => {
        const missing = join(await createRoot(), "missing");
        const { watcher, watching } = watchRepository(missing);
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(watching()).toBe(false);
        expect(watcher.isWatching(missing)).toBe(false);
    });

    it.runIf(process.platform === "linux")(
        "spends inotify watches only on directories Git does not ignore",
        async () => {
            const repository = await createRepository();
            await commitFile(repository, ".gitignore", "dist/\n");
            await mkdir(join(repository, "src", "nested"), { recursive: true });
            for (let index = 0; index < 200; index += 1) {
                await mkdir(join(repository, "node_modules", `package-${String(index)}`, "lib"), {
                    recursive: true,
                });
                await mkdir(join(repository, "dist", `chunk-${String(index)}`), {
                    recursive: true,
                });
            }
            const before = inotifyWatches();
            const { watching } = watchRepository(repository);
            await waitFor(() => watching());

            // The root, src, and src/nested; never the 600 ignored directories or .git.
            expect(inotifyWatches() - before).toBeLessThanOrEqual(3);
        },
    );
});

function watchRepository(
    root: string,
    shared?: WorkingTreeWatcher,
): {
    changes: WorkingTreeChange[];
    release: () => void;
    watcher: WorkingTreeWatcher;
    watching: () => boolean;
} {
    const watcher = shared ?? new WorkingTreeWatcher(createRootContext(), scan);
    if (shared === undefined) disposers.push(() => watcher.dispose());
    const changes: WorkingTreeChange[] = [];
    let watching = false;
    const release = watcher.watch(root, {
        onChanges: (observed) => {
            if (observed !== null) changes.push(...observed);
        },
        onWatching: (value) => {
            watching = value;
        },
    });
    disposers.push(release);
    return { changes, release, watcher, watching: () => watching };
}

function inotifyWatches(): number {
    let watches = 0;
    for (const descriptor of readdirSync("/proc/self/fd")) {
        try {
            if (readlinkSync(`/proc/self/fd/${descriptor}`) !== "anon_inode:inotify") continue;
            watches += readFileSync(`/proc/self/fdinfo/${descriptor}`, "utf8")
                .split("\n")
                .filter((line) => line.startsWith("inotify wd:")).length;
        } catch {
            // The descriptor closed while being read.
        }
    }
    return watches;
}

async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 300));
}

async function waitFor(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Timed out waiting for the working-tree watcher.");
}
