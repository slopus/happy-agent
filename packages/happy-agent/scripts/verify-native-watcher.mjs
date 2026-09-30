import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";

const require = createRequire(new URL("../../happy-agent-modules/package.json", import.meta.url));
const packageRoot = dirname(require.resolve("@parcel/watcher/package.json"));
const bindingPath = process.argv[2]
    ? resolve(process.argv[2])
    : join(packageRoot, "build", `${process.platform}-${process.arch}`, "watcher.node");
const { createWrapper } = require(join(packageRoot, "wrapper.js"));
const watcher = createWrapper(require(bindingPath));

async function main() {
    const timeout = setTimeout(() => {
        process.stderr.write("Native watcher verification timed out.\n");
        process.exit(1);
    }, 20_000);
    const root = await mkdtemp(join(await realpath(tmpdir()), "happy-native-watcher-"));
    const ignored = join(root, "ignored");
    const references = [];
    let anchor;
    try {
        if (process.platform === "darwin") {
            // FSEvents rejects these on its subscription worker. Keep unrelated
            // filesystem callbacks and GC active to expose invalid JS handles.
            for (let index = 0; index < 128; index += 1) {
                await Promise.all([
                    assert.rejects(
                        watcher.subscribe(join(root, `missing-${index}`), callback(), {
                            backend: "fs-events",
                        }),
                    ),
                    ...Array.from({ length: 1024 }, () => lstat(root)),
                ]);
                collect();
            }
        }

        await mkdir(ignored);
        const events = [];
        anchor = await watcher.subscribe(
            root,
            (error, changes) => {
                assert.equal(error, null);
                events.push(...changes);
            },
            { ignore: [ignored] },
        );
        for (let index = 0; index < 64; index += 1) await subscribeAndRelease();
        await writeFile(join(ignored, "hidden.txt"), "ignored");
        const visible = join(root, "visible.txt");
        await writeFile(visible, "visible");
        while (!events.some((event) => event.path === visible)) await nextTurn();
        assert(!events.some((event) => event.path.startsWith(ignored)));

        // A callback's closure must become collectible after failed subscribe
        // or unsubscribe. deref() retains it until the next event-loop turn.
        while (references.some((reference) => reference.deref() !== undefined)) {
            await nextTurn();
            collect();
            await nextTurn();
        }
        console.log("Native watcher: subscriptions, events, ignores, and callback release passed.");
    } finally {
        await anchor?.unsubscribe();
        await rm(root, { recursive: true, force: true });
        clearTimeout(timeout);
    }

    function callback() {
        const value = () => undefined;
        references.push(new WeakRef(value));
        return value;
    }

    async function subscribeAndRelease() {
        const subscription = await watcher.subscribe(root, callback(), { ignore: [ignored] });
        await subscription.unsubscribe();
    }
}

function collect() {
    if (globalThis.Bun) globalThis.Bun.gc(true);
    else {
        assert.equal(typeof globalThis.gc, "function", "Run Node with --expose-gc");
        globalThis.gc();
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
