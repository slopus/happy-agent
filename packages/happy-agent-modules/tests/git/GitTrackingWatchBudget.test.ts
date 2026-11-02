import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createRootContext } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it } from "vitest";

import {
    GitStateTracker,
    type GitStateTrackerOwner,
} from "../../sources/git/impl/GitStateTracker.js";
import { scanGitRunnerFromCommandRunner } from "../../sources/git/runScanGit.js";
import { cleanupRoots, createRoot, git, gitRunner } from "./helpers.js";
import { inotifyWatchCount } from "./inotifyWatchCount.js";

/** Kernel watches are a per-user budget only Linux spends one directory at a time. */
const linux = process.platform === "linux";

afterEach(async () => {
    await cleanupRoots();
});

describe.runIf(linux)("the kernel watches live Git tracking spends", () => {
    it("is one for a folder that is not a repository, however many directories it holds", async () => {
        const folder = join(await createRoot("happy-git-budget-"), "task");
        await scratchTree(folder, 400);
        const scan = scanGitRunnerFromCommandRunner({
            run: async (cwd, args, options) =>
                await gitRunner.run(cwd, ["--no-optional-locks", ...args], options),
        });
        const tracker = new GitStateTracker(createRootContext(), scan, owner());
        const watched = { path: folder, projectId: "project-scratch" };
        const before = inotifyWatchCount() ?? 0;
        try {
            tracker.watch(watched);
            await waitFor(() => tracker.snapshot(watched) !== undefined);
            // Parcel would have armed a watch per directory by now; give it the same chance.
            await new Promise((resolve) => setTimeout(resolve, 500));
            expect((inotifyWatchCount() ?? 0) - before).toBeLessThanOrEqual(1);

            // `git init` turns it into a repository, which gets the working-tree watch.
            await git(folder, ["init", "--quiet", "--initial-branch=main"]);
            await waitFor(() => (inotifyWatchCount() ?? 0) - before > 1);
        } finally {
            tracker.dispose();
        }
    });
});

/** A scratch tree shaped like a package store: `directories` folders a few levels deep. */
async function scratchTree(root: string, directories: number): Promise<void> {
    for (let index = 0; index < directories; index += 1) {
        const path = join(
            root,
            ".context",
            "store",
            `p${String(index % 20)}`,
            `d${String(Math.floor(index / 20))}`,
        );
        await mkdir(path, { recursive: true });
        await writeFile(join(path, "file.txt"), "x");
    }
}

function owner(): GitStateTrackerOwner {
    let version = 0;
    return {
        deliver: async () => undefined,
        report: () => undefined,
        stamp: (state) => ({ ...state, generation: "test", version: ++version }),
    };
}

async function waitFor(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Timed out waiting for Git tracking.");
}
