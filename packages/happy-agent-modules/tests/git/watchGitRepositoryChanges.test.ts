import { join } from "node:path";

import { createRootContext } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it } from "vitest";

import { readGitCommonDir } from "../../sources/git/readGitCommonDir.js";
import {
    GitRepositoryWatchRegistry,
    gitWatchTargetKey,
    gitWatchTargets,
    watchGitRepositoryChanges,
} from "../../sources/git/watchGitRepositoryChanges.js";
import {
    cleanupRoots,
    commitFile,
    createRepository,
    createRoot,
    git,
    gitRunner,
} from "./helpers.js";

const disposers: (() => void)[] = [];
afterEach(async () => {
    for (const dispose of disposers.splice(0)) dispose();
    await cleanupRoots();
});

describe("watchGitRepositoryChanges", () => {
    it("watches replace-by-rename control files through their parent directories", async () => {
        const repository = await createRepository();
        await commitFile(repository, "README.md", "fixture\n");
        const commonDirectory = await readGitCommonDir(gitRunner, repository);
        const gitDirectory = await git(repository, [
            "rev-parse",
            "--path-format=absolute",
            "--git-dir",
        ]);
        const targets = gitWatchTargets({ commonDirectory, gitDirectory, path: repository });
        expect(targets.map((target) => target.directory)).toContain(gitDirectory);
        expect(targets.some((target) => target.directory.endsWith("/HEAD"))).toBe(false);
        expect(
            targets.find((target) => target.directory === `${commonDirectory}/refs`)?.recursive,
        ).toBe(true);
        const info = targets.find((target) => target.directory === `${commonDirectory}/info`);
        expect(info?.accept?.("exclude")).toBe(true);
        expect(info?.accept?.("attributes")).toBe(false);
    });

    it("reconciles once after arming and stops after disposal", async () => {
        const repository = await createRepository();
        await commitFile(repository, "README.md", "fixture\n");
        const commonDirectory = await readGitCommonDir(gitRunner, repository);
        const gitDirectory = await git(repository, [
            "rev-parse",
            "--path-format=absolute",
            "--git-dir",
        ]);
        let dirty = 0;
        const dispose = watchGitRepositoryChanges(createRootContext(), {
            commonDirectory,
            gitDirectory,
            onDirty: () => {
                dirty += 1;
            },
            path: repository,
        });
        disposers.push(dispose);
        expect(dirty).toBe(1);
        dispose();
        const observed = dirty;
        await commitFile(repository, "later.txt", "later\n");
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(dirty).toBe(observed);
    });

    it("shares common-directory and ref handles across worktrees", async () => {
        const repository = await createRepository();
        await commitFile(repository, "README.md", "fixture\n");
        const workspace = join(await createRoot(), "workspace");
        await git(repository, ["worktree", "add", "--quiet", "-b", "workspace", workspace]);
        const commonDirectory = await readGitCommonDir(gitRunner, repository);
        const repositoryGitDirectory = await git(repository, [
            "rev-parse",
            "--path-format=absolute",
            "--git-dir",
        ]);
        const workspaceGitDirectory = await git(workspace, [
            "rev-parse",
            "--path-format=absolute",
            "--git-dir",
        ]);
        const repositoryTargets = gitWatchTargets({
            commonDirectory,
            gitDirectory: repositoryGitDirectory,
            path: repository,
        });
        const workspaceTargets = gitWatchTargets({
            commonDirectory,
            gitDirectory: workspaceGitDirectory,
            path: workspace,
        });
        const uniqueTargets = new Set(
            [...repositoryTargets, ...workspaceTargets].map(gitWatchTargetKey),
        );
        expect(uniqueTargets.size).toBeLessThan(repositoryTargets.length + workspaceTargets.length);

        const registry = new GitRepositoryWatchRegistry(createRootContext());
        disposers.push(() => registry.dispose());
        const unwatchRepository = registry.watch({
            commonDirectory,
            gitDirectory: repositoryGitDirectory,
            onDirty: () => undefined,
            path: repository,
        });
        const unwatchWorkspace = registry.watch({
            commonDirectory,
            gitDirectory: workspaceGitDirectory,
            onDirty: () => undefined,
            path: workspace,
        });

        expect(registry.watchedTargetCount).toBe(uniqueTargets.size);
        unwatchWorkspace();
        expect(registry.watchedTargetCount).toBe(
            new Set(repositoryTargets.map(gitWatchTargetKey)).size,
        );
        unwatchRepository();
        expect(registry.watchedTargetCount).toBe(0);
    });
});
