import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRootContext, withLogger } from "@steve.kite/stdlib";

// Native type stripping keeps loader hooks out of the runtime under test.
const { WorkingTreeWatcher } = (await import(
    new URL("../../../sources/git/impl/WorkingTreeWatcher.ts", import.meta.url).href
)) as typeof import("../../../sources/git/impl/WorkingTreeWatcher.js");

const root = await mkdtemp(join(await realpath(tmpdir()), "happy-missing-watch-"));
let failed: (() => void) | undefined;
const context = withLogger(createRootContext(), {
    trace: () => undefined,
    debug: () => failed?.(),
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    fatal: () => undefined,
});
const watcher = new WorkingTreeWatcher(context, async () => ({
    stdout: "",
    stdoutBytes: Buffer.alloc(0),
    truncated: false,
}));
const live = join(root, "live");
await mkdir(live);
let watching = false;
let changed = false;

try {
    // Failed native subscriptions used to release JS references on the worker
    // thread. A later unrelated stat then crashed inside the runtime.
    for (let index = 0; index < 128; index += 1) {
        const rejected = new Promise<void>((resolve) => {
            failed = resolve;
        });
        const release = watcher.watch(join(root, `missing-${index}`), {
            onChanges: () => undefined,
        });
        await Promise.all([rejected, ...Array.from({ length: 1024 }, () => lstat(root))]);
        globalThis.gc?.();
        release();
    }
    failed = undefined;
    watcher.watch(live, {
        onChanges: (changes) => {
            if (changes?.some((change) => change.path === "created.txt")) changed = true;
        },
        onWatching: (value) => {
            watching = value;
        },
    });
    const deadline = Date.now() + 10_000;
    while (!watching && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert(watching, "An existing workspace must still become watched");
    await writeFile(join(live, "created.txt"), "still alive\n");
    while (!changed && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert(changed, "Existing workspaces must still report changes");
} finally {
    watcher.dispose();
    await rm(root, { recursive: true, force: true });
}
console.log("missing-workspaces-survived");
