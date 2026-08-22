import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRootContext } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it } from "vitest";

import { MenuBarApp } from "../../sources/menuBar/index.js";

const roots: string[] = [];

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function temporaryRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "happy-menu-bar-"));
    roots.push(root);
    return root;
}

/** A stand-in for the real app, so supervision is exercised against actual child processes. */
async function fakeApp(root: string, body: string): Promise<string> {
    const app = join(root, "fake-menu-bar");
    await writeFile(app, `#!/bin/sh\n${body}\n`);
    await chmod(app, 0o755);
    return app;
}

function context(name: string) {
    return createRootContext().named(name);
}

describe("MenuBarApp", () => {
    it("stops trying when the app reports the machine has no menu bar", async () => {
        const root = await temporaryRoot();
        const counter = join(root, "runs");
        const app = await fakeApp(
            root,
            `printf x >> "${counter}"\necho "no login session" >&2\nexit 0`,
        );

        const outcome = await new MenuBarApp(app, [], { restartDelayMs: 1 }).supervise(
            context("menu-bar-unavailable"),
        );

        expect(outcome).toBe("unavailable");
        expect(await readFile(counter, "utf8")).toBe("x");
    });

    it("gives up after the app fails to start repeatedly", async () => {
        const root = await temporaryRoot();
        const counter = join(root, "runs");
        const app = await fakeApp(root, `printf x >> "${counter}"\nexit 3`);

        const outcome = await new MenuBarApp(app, [], {
            maxFailedStarts: 3,
            restartDelayMs: 1,
        }).supervise(context("menu-bar-abandoned"));

        expect(outcome).toBe("abandoned");
        expect(await readFile(counter, "utf8")).toBe("xxx");
    });

    it("restarts an app that had been running before it crashed", async () => {
        const root = await temporaryRoot();
        const counter = join(root, "runs");
        // The first run counts as started because it lasted beyond the startup window; the second
        // is a fresh first failure, so the app is restarted rather than abandoned.
        const app = await fakeApp(
            root,
            `printf x >> "${counter}"\nif [ "$(wc -c < "${counter}")" -le 1 ]; then sleep 0.2; fi\nexit 3`,
        );

        const outcome = await new MenuBarApp(app, [], {
            maxFailedStarts: 1,
            restartDelayMs: 1,
            startupWindowMs: 100,
        }).supervise(context("menu-bar-restart"));

        expect(outcome).toBe("abandoned");
        expect(await readFile(counter, "utf8")).toBe("xx");
    });

    it("passes its arguments to the app", async () => {
        const root = await temporaryRoot();
        const seen = join(root, "arguments");
        const app = await fakeApp(root, `echo "$@" > "${seen}"\nexit 0`);

        await new MenuBarApp(app, ["--socket", "/tmp/h.sock", "--token-file", "/tmp/t"], {
            restartDelayMs: 1,
        }).supervise(context("menu-bar-arguments"));

        expect((await readFile(seen, "utf8")).trim()).toBe(
            "--socket /tmp/h.sock --token-file /tmp/t",
        );
    });

    it("stops a running app and does not start it again", async () => {
        const root = await temporaryRoot();
        const counter = join(root, "runs");
        const app = await fakeApp(root, `printf x >> "${counter}"\nsleep 30`);
        const menuBar = new MenuBarApp(app, [], { restartDelayMs: 1, stopGraceMs: 50 });

        const supervising = menuBar.supervise(context("menu-bar-stop"));
        await waitFor(async () => (await readFile(counter, "utf8")) === "x");
        menuBar.stop();

        expect(await supervising).toBe("stopped");
        expect(await readFile(counter, "utf8")).toBe("x");
    });

    it("ends supervision when the app cannot be run at all", async () => {
        const root = await temporaryRoot();

        const outcome = await new MenuBarApp(join(root, "missing"), [], {
            maxFailedStarts: 1,
            restartDelayMs: 1,
        }).supervise(context("menu-bar-missing"));

        expect(outcome).toBe("abandoned");
    });
});

async function waitFor(condition: () => Promise<boolean>): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        try {
            if (await condition()) return;
        } catch {
            // The file the condition reads may not exist yet.
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("The menu bar app did not reach the expected state in time.");
}
