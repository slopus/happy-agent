import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { GitModule } from "../../sources/git/GitModule.js";
import {
    cleanupRoots,
    commitFile,
    createRepository,
    createRoot,
    git,
    gitRunner,
} from "./helpers.js";

const REF = "refs/happy/archived/workspace-1";
const SAVE = { message: "Uncommitted work from archived workspace", ref: REF };

const modules: GitModule[] = [];
afterEach(() => {
    for (const module of modules.splice(0)) module.dispose();
    return cleanupRoots();
});

/** A project with one commit and a worktree cut from it on its own branch. */
async function projectWithWorktree() {
    const project = await createRepository();
    await writeFile(join(project, ".gitignore"), "build/\n");
    await commitFile(project, "tracked.txt", "one\n");
    const head = await commitFile(project, "doomed.txt", "doomed\n");
    const module = GitModule.withRunner(gitRunner);
    modules.push(module);
    const commonDir = await module.commonDir(project);
    const workspacePath = join(await createRoot(), "workspace");
    await module.createWorktree({
        branch: "001-workspace",
        commit: head,
        expectedCommonDir: commonDir,
        projectPath: project,
        workspacePath,
    });
    const remove = async () =>
        await module.removeWorktree({
            expectedCommonDir: commonDir,
            preserveChanges: SAVE,
            projectPath: project,
            removeDirectory: true,
            workspacePath,
        });
    return { commonDir, head, module, project, remove, workspacePath };
}

async function refExists(project: string, ref: string): Promise<boolean> {
    return await git(project, ["show-ref", "--verify", "--quiet", ref]).then(
        () => true,
        () => false,
    );
}

describe("removing a worktree on archive", () => {
    it("removes a clean worktree as before and saves nothing", async () => {
        const { commonDir, module, project, remove, workspacePath } = await projectWithWorktree();
        // Ignored files are build output, not work, and do not make a worktree dirty.
        await mkdir(join(workspacePath, "build"));
        await writeFile(join(workspacePath, "build", "output.bin"), "ignored\n");

        await expect(remove()).resolves.toBeUndefined();

        expect(existsSync(workspacePath)).toBe(false);
        await expect(module.isWorktreeAt({ commonDir, path: workspacePath })).resolves.toBe(false);
        expect(await refExists(project, REF)).toBe(false);
        expect(await git(project, ["rev-parse", "--verify", "001-workspace"])).toBeTruthy();
    });

    it("saves uncommitted and untracked work to a ref that outlives the folder", async () => {
        const { head, project, remove, workspacePath } = await projectWithWorktree();
        await writeFile(join(workspacePath, "tracked.txt"), "two\n");
        await writeFile(join(workspacePath, "staged.txt"), "staged\n");
        await git(workspacePath, ["add", "staged.txt"]);
        await rm(join(workspacePath, "doomed.txt"));
        await writeFile(join(workspacePath, "untracked.txt"), "untracked\n");
        await mkdir(join(workspacePath, "build"));
        await writeFile(join(workspacePath, "build", "output.bin"), "ignored\n");
        const stashesBefore = await git(project, ["stash", "list"]);

        const preserved = await remove();

        expect(preserved).toMatchObject({ changedPaths: 4, ref: REF });
        expect(existsSync(workspacePath)).toBe(false);
        await git(project, ["worktree", "prune"]);
        await git(project, ["gc", "--quiet", "--prune=now"]);
        expect(await git(project, ["rev-parse", REF])).toBe(preserved?.commit);
        expect(await git(project, ["rev-parse", `${REF}^`])).toBe(head);
        expect(await git(project, ["show", `${REF}:tracked.txt`])).toBe("two");
        expect(await git(project, ["show", `${REF}:staged.txt`])).toBe("staged");
        expect(await git(project, ["show", `${REF}:untracked.txt`])).toBe("untracked");
        expect(await git(project, ["ls-tree", "--name-only", "-r", REF])).not.toMatch(
            /doomed\.txt|build\//u,
        );
        // The branch, the project's index, and its stashes are left exactly as they were.
        expect(await git(project, ["rev-parse", "001-workspace"])).toBe(head);
        expect(await git(project, ["status", "--porcelain"])).toBe("");
        expect(await git(project, ["stash", "list"])).toBe(stashesBefore);

        // The documented recovery brings the work back.
        const recovered = join(await createRoot(), "recovered");
        await git(project, ["worktree", "add", "--quiet", "-b", "recovered", recovered, REF]);
        await expect(readFile(join(recovered, "untracked.txt"), "utf8")).resolves.toBe(
            "untracked\n",
        );
        await expect(readFile(join(recovered, "tracked.txt"), "utf8")).resolves.toBe("two\n");
    });

    it("keeps the first save when removal is retried", async () => {
        const { project, remove, workspacePath } = await projectWithWorktree();
        await writeFile(join(workspacePath, "untracked.txt"), "first\n");
        const first = await git(workspacePath, ["rev-parse", "HEAD"]);
        await git(project, ["update-ref", REF, first]);
        await writeFile(join(workspacePath, "untracked.txt"), "half deleted\n");

        await expect(remove()).resolves.toEqual({ commit: first, ref: REF });

        expect(await git(project, ["rev-parse", REF])).toBe(first);
        expect(existsSync(workspacePath)).toBe(false);
    });

    it("saves a detached HEAD no branch contains, even with a clean tree", async () => {
        const { project, remove, workspacePath } = await projectWithWorktree();
        await git(workspacePath, ["checkout", "--quiet", "--detach"]);
        const detached = await commitFile(workspacePath, "detached.txt", "detached\n");

        await expect(remove()).resolves.toEqual({ changedPaths: 0, commit: detached, ref: REF });

        expect(await git(project, ["rev-parse", REF])).toBe(detached);
    });

    it("deletes outright when no save is asked for", async () => {
        const { commonDir, module, project, workspacePath } = await projectWithWorktree();
        await writeFile(join(workspacePath, "untracked.txt"), "untracked\n");

        await expect(
            module.removeWorktree({
                expectedCommonDir: commonDir,
                projectPath: project,
                removeDirectory: true,
                workspacePath,
            }),
        ).resolves.toBeUndefined();

        expect(existsSync(workspacePath)).toBe(false);
        expect(await refExists(project, REF)).toBe(false);
    });
});
