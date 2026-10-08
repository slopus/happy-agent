import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRootContext, type Context } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it } from "vitest";

import type { ComputeWatchBatch } from "../../sources/ComputeWatcher.js";
import { createHostWatcher } from "../../sources/host/index.js";

const ctx: Context = createRootContext().named("host-watcher-test");
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

// The per-directory watch is Linux's; other platforms use the native recursive watch.
describe.runIf(process.platform === "linux")("host watcher", () => {
    it("reports changes anywhere below the root, including new directories", async () => {
        const { folder, batches, changed } = await watched();

        await mkdir(join(folder, "src", "deep"), { recursive: true });
        await waitFor(() => changed().has("src"));
        await new Promise((resolve) => setTimeout(resolve, 100));
        await writeFile(join(folder, "src", "deep", "file.ts"), "x");

        await waitFor(() => changed().has("src/deep/file.ts"));
        expect(batches.every((batch) => !batch.overflow)).toBe(true);
    });

    it("never descends into ignored directories", async () => {
        const { folder, changed } = await watched(async (root) => {
            await mkdir(join(root, "node_modules", "dep"), { recursive: true });
        });

        await writeFile(join(folder, "node_modules", "dep", "index.js"), "x");
        await writeFile(join(folder, "kept.txt"), "x");

        await waitFor(() => changed().has("kept.txt"));
        expect([...changed()].some((path) => path.startsWith("node_modules/dep"))).toBe(false);
    });

    it("ends when closed", async () => {
        const { watch } = await watched();

        watch.close();

        await expect(watch.closed).resolves.toEqual({});
    });
});

async function watched(prepare?: (root: string) => Promise<void>) {
    const folder = await mkdtemp(join(tmpdir(), "host-watcher-"));
    await prepare?.(folder);
    const watcher = createHostWatcher({ cwd: folder });
    const watch = await watcher.watch(ctx, { path: ".", ignore: ["node_modules"] });
    const batches: ComputeWatchBatch[] = [];
    watch.onChange((batch) => batches.push(batch));
    cleanups.push(async () => {
        watcher.dispose();
        await rm(folder, { force: true, recursive: true });
    });
    return {
        folder,
        watch,
        batches,
        changed: () => new Set(batches.flatMap((batch) => batch.paths)),
    };
}

async function waitFor(check: () => boolean, timeoutMs = 4_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
        if (Date.now() > deadline) throw new Error("The expected state never arrived.");
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}
