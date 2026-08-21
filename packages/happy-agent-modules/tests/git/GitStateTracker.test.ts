import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createRootContext } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
    GIT_RECONCILE_STALE_AFTER_MS,
    GitStateTracker,
    gitReferenceChangeAffectsSnapshot,
    type GitStateTrackerOwner,
} from "../../sources/git/impl/GitStateTracker.js";
import {
    scanGitRunnerFromCommandRunner,
    type ScanGitRunner,
    type ScanGitResult,
} from "../../sources/git/runScanGit.js";
import type {
    GitChangeSnapshot,
    GitChangeState,
    GitTrackedEntity,
} from "../../sources/git/types.js";
import { cleanupRoots, commitFile, createRepository, gitRunner, setOriginMain } from "./helpers.js";

const HEAD = "a".repeat(40);
const entity: GitTrackedEntity = { path: "/missing/repository", projectId: "project-1" };

afterEach(async () => {
    vi.useRealTimers();
    await cleanupRoots();
});

describe("GitStateTracker scheduling", () => {
    it("uses one stale deadline without treating subscription renewal as dirtiness", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const scan = testScan();
        const tracker = new GitStateTracker(createRootContext(), scan.run, owner());

        await startTracking(tracker);
        expect(scan.fullStatusReads).toBe(1);

        tracker.replace([entity]);
        await vi.advanceTimersByTimeAsync(GIT_RECONCILE_STALE_AFTER_MS - 1);
        await settlePromises();
        expect(scan.fullStatusReads).toBe(1);

        await vi.advanceTimersByTimeAsync(1);
        await settlePromises();
        expect(scan.fullStatusReads).toBe(2);
        tracker.dispose();
    });

    it("drops worktree paths when scoped status reports no visible change", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const scan = testScan();
        const tracker = new GitStateTracker(createRootContext(), scan.run, owner());

        await startTracking(tracker);
        tracker.markWorktreeChanged(entity, "dist/generated.js");
        await vi.advanceTimersByTimeAsync(150);
        await settlePromises();
        expect(scan.pathStatusReads).toBe(1);
        expect(scan.fullStatusReads).toBe(1);

        scan.pathStatusDirty = true;
        tracker.markWorktreeChanged(entity, "src/tracked.ts");
        await vi.advanceTimersByTimeAsync(150);
        await settlePromises();
        expect(scan.pathStatusReads).toBe(2);
        expect(scan.fullStatusReads).toBe(2);
        tracker.dispose();
    });

    it("uses real Git ignore rules to suppress generated-file churn", async () => {
        const repository = await createRepository();
        const head = await commitFile(repository, ".gitignore", "dist/\n");
        await setOriginMain(repository, head);
        await mkdir(join(repository, "dist"));
        await writeFile(join(repository, "dist", "generated.js"), "generated\n");
        let fullStatusReads = 0;
        let pathStatusReads = 0;
        const scan = scanGitRunnerFromCommandRunner({
            async run(cwd, args, options) {
                if (args[0] === "status") {
                    if (args.includes("--branch")) fullStatusReads += 1;
                    else pathStatusReads += 1;
                }
                return await gitRunner.run(cwd, ["--no-optional-locks", ...args], options);
            },
        });
        const tracker = new GitStateTracker(createRootContext(), scan, owner());
        const watched = { path: repository, projectId: "project-ignored" };

        tracker.watch(watched);
        await waitFor(() => tracker.snapshot(watched) !== undefined);
        const scansBeforeChurn = fullStatusReads;
        tracker.markWorktreeChanged(watched, "dist/generated.js");
        await waitFor(() => pathStatusReads > 0);
        await waitForNoChange(() => fullStatusReads, 300);

        expect(fullStatusReads).toBe(scansBeforeChurn);
        tracker.dispose();
    });

    it("runs at most two full repository scans concurrently", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const scan = testScan();
        const run = scan.run;
        const releases: (() => void)[] = [];
        let active = 0;
        let maximumActive = 0;
        scan.run = async (options) => {
            if (options.args[0] === "status" && options.args.includes("--branch")) {
                active += 1;
                maximumActive = Math.max(maximumActive, active);
                await new Promise<void>((resolve) => {
                    releases.push(() => {
                        active -= 1;
                        resolve();
                    });
                });
            }
            return await run(options);
        };
        const tracker = new GitStateTracker(createRootContext(), scan.run, owner());
        for (let index = 0; index < 4; index += 1) {
            tracker.watch({
                path: `/missing/repository-${String(index)}`,
                projectId: `project-${String(index)}`,
            });
        }
        await settlePromises();
        await vi.advanceTimersByTimeAsync(150);
        await settlePromises();

        expect(active).toBe(2);
        expect(maximumActive).toBe(2);
        for (const release of releases.splice(0)) release();
        await settleUntil(() => active === 2);
        expect(active).toBe(2);
        for (const release of releases.splice(0)) release();
        await settleUntil(() => scan.fullStatusReads === 4);
        expect(scan.fullStatusReads).toBe(4);
        expect(maximumActive).toBe(2);
        tracker.dispose();
    });
});

describe("gitReferenceChangeAffectsSnapshot", () => {
    it("fans shared ref events only to worktrees whose visible state can change", () => {
        const snapshot = stampedSnapshot();

        expect(gitReferenceChangeAffectsSnapshot(snapshot, "heads/main.lock")).toBe(true);
        expect(gitReferenceChangeAffectsSnapshot(snapshot, "heads/other")).toBe(false);
        expect(gitReferenceChangeAffectsSnapshot(snapshot, "remotes/origin/main")).toBe(true);
        expect(gitReferenceChangeAffectsSnapshot(snapshot, "remotes/origin/other")).toBe(false);
        expect(gitReferenceChangeAffectsSnapshot(snapshot, "tags/v1.0.0")).toBe(false);
        expect(gitReferenceChangeAffectsSnapshot(snapshot, undefined)).toBe(true);
    });
});

interface TestScan {
    fullStatusReads: number;
    pathStatusDirty: boolean;
    pathStatusReads: number;
    run: ScanGitRunner;
}

function testScan(): TestScan {
    const scan: TestScan = {
        fullStatusReads: 0,
        pathStatusDirty: false,
        pathStatusReads: 0,
        run: async (options) => {
            const command = options.args[0];
            if (command === "status") {
                if (options.args.includes("--branch")) {
                    scan.fullStatusReads += 1;
                    return result(
                        [
                            `# branch.oid ${HEAD}`,
                            "# branch.head main",
                            "# branch.upstream origin/main",
                            "# branch.ab +0 -0",
                            "",
                        ].join("\0"),
                    );
                }
                scan.pathStatusReads += 1;
                return result(scan.pathStatusDirty ? "? src/tracked.ts\0" : "");
            }
            if (command === "rev-parse") {
                if (options.args.includes("--verify")) return result(`${HEAD}\n`);
                if (options.args.includes("--git-common-dir")) {
                    return result(`${options.cwd}/.git\n${options.cwd}/.git\n`);
                }
                return result(`${options.cwd}/.git\n`);
            }
            if (command === "merge-base") return result(`${HEAD}\n`);
            if (command === "diff") return result("");
            throw new Error(`Unexpected Git command: ${options.args.join(" ")}`);
        },
    };
    return scan;
}

function result(stdout: string): ScanGitResult {
    return { stdout, stdoutBytes: Buffer.from(stdout), truncated: false };
}

function owner(): GitStateTrackerOwner {
    let version = 0;
    return {
        deliver: async () => undefined,
        report: () => undefined,
        stamp: (state) => ({ ...state, generation: "test", version: ++version }),
    };
}

async function startTracking(tracker: GitStateTracker): Promise<void> {
    tracker.watch(entity);
    await settlePromises();
    await vi.advanceTimersByTimeAsync(150);
    await settlePromises();
    expect(tracker.snapshot(entity)).toBeDefined();
}

async function settlePromises(): Promise<void> {
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

async function settleUntil(predicate: () => boolean): Promise<void> {
    for (let index = 0; index < 1_000; index += 1) {
        if (predicate()) return;
        await Promise.resolve();
    }
    throw new Error("Timed out waiting for the tracker queue to settle.");
}

async function waitFor(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("Timed out waiting for Git tracking.");
}

async function waitForNoChange(read: () => number, durationMs: number): Promise<void> {
    const initial = read();
    const deadline = Date.now() + durationMs;
    while (Date.now() < deadline) {
        expect(read()).toBe(initial);
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

function stampedSnapshot(): GitChangeSnapshot {
    const state: GitChangeState = {
        base: HEAD,
        changedFiles: 0,
        comparison: "ready",
        conflicted: false,
        countsExact: true,
        deletions: 0,
        facts: {
            ahead: 0,
            behind: 0,
            branch: "main",
            detached: false,
            head: HEAD,
            upstream: "origin/main",
        },
        files: [],
        filesTruncated: false,
        insertions: 0,
        scannedAt: 1,
    };
    return { ...state, generation: "test", version: 1 };
}
