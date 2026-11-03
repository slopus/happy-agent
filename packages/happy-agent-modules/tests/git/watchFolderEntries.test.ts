import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { watchFolderEntries } from "../../sources/git/impl/watchFolderEntries.js";
import { inotifyWatchCount } from "./inotifyWatchCount.js";

const roots: string[] = [];

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("watchFolderEntries", () => {
    it("reports .git appearing while spending one kernel watch however deep the folder is", async () => {
        const root = await mkdtemp(join(tmpdir(), "folder-entries-"));
        roots.push(root);
        // Shaped like an agent's scratch folder holding a package store.
        for (let store = 0; store < 20; store += 1) {
            for (let entry = 0; entry < 10; entry += 1) {
                await mkdir(
                    join(root, ".context", "store", `p${String(store)}`, `d${String(entry)}`),
                    {
                        recursive: true,
                    },
                );
            }
        }
        const before = inotifyWatchCount();
        const names: (string | undefined)[] = [];
        let watching = false;
        const unwatch = watchFolderEntries(root, {
            onEntry: (name) => names.push(name),
            onWatching: (live) => {
                watching = live;
            },
        });
        try {
            await waitFor(() => watching);
            if (before !== undefined) expect(inotifyWatchCount()).toBe(before + 1);

            await mkdir(join(root, ".context", "store", "p0", "d0", "deeper"));
            await mkdir(join(root, ".git"));
            await waitFor(() => names.includes(".git"));
            expect(names).not.toContain("deeper");
        } finally {
            unwatch();
        }
        if (before !== undefined) await waitFor(() => inotifyWatchCount() === before);
    });

    it("never watches the home directory", async () => {
        let watching = false;
        const unwatch = watchFolderEntries(process.env.HOME ?? "/", {
            onEntry: () => undefined,
            onWatching: (live) => {
                watching = live;
            },
        });
        await new Promise((resolve) => setTimeout(resolve, 100));
        unwatch();
        expect(watching).toBe(false);
    });
});

async function waitFor(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Timed out waiting for the folder watch.");
}
