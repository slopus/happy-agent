import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createRootContext, type Context } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it } from "vitest";

import { GitModule } from "../../sources/git/GitModule.js";
import type { GitCommandRunner } from "../../sources/git/GitCommandRunner.js";
import type { GitChangeSnapshot } from "../../sources/git/types.js";
import { cleanupRoots, commitFile, createRepository, gitRunner, setOriginMain } from "./helpers.js";

const modules: GitModule[] = [];
afterEach(() => {
    for (const module of modules.splice(0)) module.dispose();
    return cleanupRoots();
});

function open(runner: GitCommandRunner = gitRunner): GitModule {
    const module = GitModule.withRunner(runner);
    modules.push(module);
    return module;
}

function caller(): Context {
    return createRootContext().named("test-caller");
}

describe("GitModule live tracking", () => {
    it("coalesces a burst, publishes changes only, and keeps versions monotonic", async () => {
        const repository = await createRepository();
        const head = await commitFile(repository, "tracked.txt", "one\n");
        await setOriginMain(repository, head);
        const module = open();
        const published: GitChangeSnapshot[] = [];
        module.onSnapshot((_ctx, _entity, snapshot) => {
            published.push(snapshot);
        });
        const entity = { path: repository, projectId: "project-1" };

        module.track(entity);
        for (let index = 0; index < 20; index += 1) module.markChanged(entity);
        await waitFor(() => published.length === 1);

        // Nothing changed in the repository, so a rescan publishes nothing new.
        await module.refresh(caller(), entity);
        expect(published).toHaveLength(1);
        expect(module.trackedSnapshot(entity)?.version).toBe(published[0]?.version);
        expect(module.trackedKeys()).toEqual(["project:project-1"]);
        expect(module.liveSnapshots()).toMatchObject([
            { projectId: "project-1", type: "project_git_changed" },
        ]);

        await writeFile(join(repository, "tracked.txt"), "two\n");
        await module.refresh(caller(), entity);
        await waitFor(() => published.length >= 2);
        const versions = published.map((snapshot) => snapshot.version);
        expect(versions).toEqual([...versions].sort((left, right) => left - right));
        expect(new Set(versions).size).toBe(versions.length);
        expect(published.at(-1)?.changedFiles).toBeGreaterThan(0);
    });

    it("keeps a snapshot pending when a subscriber could not take it", async () => {
        const repository = await createRepository();
        const head = await commitFile(repository, "tracked.txt", "one\n");
        await setOriginMain(repository, head);
        const module = open();
        let attempts = 0;
        module.onSnapshot(() => {
            attempts += 1;
            if (attempts === 1) throw new Error("persistence failed");
        });
        const entity = { path: repository, projectId: "project-1" };

        module.track(entity);
        await waitFor(() => attempts === 1);
        await module.refresh(caller(), entity);

        expect(attempts).toBeGreaterThanOrEqual(2);
    });

    it("stops publishing once a repository is no longer tracked", async () => {
        const repository = await createRepository();
        const head = await commitFile(repository, "tracked.txt", "one\n");
        await setOriginMain(repository, head);
        const module = open();
        let published = 0;
        const unsubscribe = module.onSnapshot(() => {
            published += 1;
        });
        const entity = { path: repository, projectId: "project-1" };

        module.track(entity);
        await waitFor(() => published === 1);
        module.untrack(entity);
        expect(module.trackedKeys()).toEqual([]);
        expect(module.trackedSnapshot(entity)).toBeUndefined();

        unsubscribe();
        module.track(entity);
        await module.refresh(caller(), entity);
        expect(published).toBe(1);
    });

    it("atomically replaces the tracked subscription set while retaining known snapshots", async () => {
        const firstRepository = await createRepository();
        const firstHead = await commitFile(firstRepository, "tracked.txt", "one\n");
        await setOriginMain(firstRepository, firstHead);
        const secondRepository = await createRepository();
        const secondHead = await commitFile(secondRepository, "tracked.txt", "one\n");
        await setOriginMain(secondRepository, secondHead);
        const module = open();
        const published: string[] = [];
        module.onSnapshot((_ctx, entity) => {
            published.push(entity.workspaceId ?? entity.projectId);
        });
        const first = { path: firstRepository, projectId: "project-1" };
        const second = {
            path: secondRepository,
            projectId: "project-1",
            workspaceId: "workspace-2",
        };

        module.replaceTracked([first, second]);
        await waitFor(() => published.length === 2);
        const retained = module.trackedSnapshot(second);

        module.replaceTracked([second, first]);
        expect(module.trackedSnapshot(second)).toBe(retained);
        expect(published).toHaveLength(2);

        module.replaceTracked([second]);
        expect(module.trackedKeys()).toEqual(["workspace:workspace-2"]);
        expect(module.trackedSnapshot(first)).toBeUndefined();
        expect(module.liveSnapshots()).toHaveLength(1);
        expect(module.trackedSnapshot(second)).toBe(retained);
    });

    it("does not rescan a fresh retained repository when its subscription is renewed", async () => {
        const repository = await createRepository();
        const head = await commitFile(repository, "tracked.txt", "one\n");
        await setOriginMain(repository, head);
        let statusReads = 0;
        const module = open({
            run: gitRunner.run,
            async scan(options) {
                if (options.args.includes("--git-common-dir")) {
                    throw new Error("Filesystem watching is unavailable in this test.");
                }
                if (options.args[0] === "status") statusReads += 1;
                const result = await gitRunner.run(
                    options.cwd,
                    ["--no-optional-locks", ...options.args],
                    {
                        ...(options.maximumBytes === undefined
                            ? {}
                            : { maxOutputBytes: options.maximumBytes }),
                        ...(options.signal === undefined ? {} : { signal: options.signal }),
                    },
                );
                if (result.code !== 0) throw new Error(result.stderr);
                return {
                    stdout: result.stdout,
                    stdoutBytes: Buffer.from(result.stdout),
                    truncated: false,
                };
            },
        });
        const entity = { path: repository, projectId: "project-1" };

        module.replaceTracked([entity]);
        await waitFor(() => module.trackedSnapshot(entity) !== undefined);
        await waitForSettled(() => statusReads, 300);
        const readsBeforeRenewal = statusReads;

        module.replaceTracked([entity]);

        await waitForNoChange(() => statusReads, 300);
        expect(statusReads).toBe(readsBeforeRenewal);
    }, 10_000);

    it("retires omitted repositories before their first scan and settles concurrent replacements to the final set", async () => {
        const firstRepository = await createRepository();
        const firstHead = await commitFile(firstRepository, "tracked.txt", "one\n");
        await setOriginMain(firstRepository, firstHead);
        const secondRepository = await createRepository();
        const secondHead = await commitFile(secondRepository, "tracked.txt", "one\n");
        await setOriginMain(secondRepository, secondHead);
        const module = open();
        const published: string[] = [];
        module.onSnapshot((_ctx, entity) => {
            published.push(entity.workspaceId ?? entity.projectId);
        });
        const first = { path: firstRepository, projectId: "project-1" };
        const second = {
            path: secondRepository,
            projectId: "project-1",
            workspaceId: "workspace-2",
        };

        await Promise.all([
            Promise.resolve().then(() => module.replaceTracked([first])),
            Promise.resolve().then(() => module.replaceTracked([second])),
        ]);

        expect(module.trackedKeys()).toEqual(["workspace:workspace-2"]);
        await waitFor(() => published.length === 1);
        expect(published).toEqual(["workspace-2"]);
        expect(module.trackedSnapshot(first)).toBeUndefined();
        expect(module.trackedSnapshot(second)).toBeDefined();
    });

    it("releases a replaced watch set when disposed and rejects malformed public input", async () => {
        const repository = await createRepository();
        const head = await commitFile(repository, "tracked.txt", "one\n");
        await setOriginMain(repository, head);
        const module = open();
        let published = 0;
        module.onSnapshot(() => {
            published += 1;
        });

        expect(() => module.replaceTracked([{ projectId: "project-1" }] as never)).toThrow(
            "The Git watch entities are invalid.",
        );

        module.replaceTracked([{ path: repository, projectId: "project-1" }]);
        module.dispose();
        expect(module.trackedKeys()).toEqual([]);

        await waitForNoChange(() => published, 250);
        expect(
            module.trackedSnapshot({ path: repository, projectId: "project-1" }),
        ).toBeUndefined();
    });

    it("reports the configured Git boundary's failure rather than scanning around it", async () => {
        const repository = await createRepository();
        const head = await commitFile(repository, "tracked.txt", "one\n");
        await setOriginMain(repository, head);
        const module = open({
            async run() {
                return { code: 3, stderr: "tracker runner refused", stdout: "" };
            },
        });

        await expect(
            module.refresh(caller(), { path: repository, projectId: "project-1" }),
        ).resolves.toMatchObject({
            comparison: "unavailable",
            error: "tracker runner refused",
        });
    });
});

async function waitFor(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("Timed out waiting for the Git module.");
}

async function waitForNoChange(read: () => number, durationMs: number): Promise<void> {
    const initial = read();
    const deadline = Date.now() + durationMs;
    while (Date.now() < deadline) {
        expect(read()).toBe(initial);
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

async function waitForSettled(read: () => number, durationMs: number): Promise<void> {
    const deadline = Date.now() + 5_000;
    let observed = read();
    let stableSince = Date.now();
    while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        const current = read();
        if (current !== observed) {
            observed = current;
            stableSince = Date.now();
        } else if (Date.now() - stableSince >= durationMs) {
            return;
        }
    }
    throw new Error("Timed out waiting for the Git module to settle.");
}
