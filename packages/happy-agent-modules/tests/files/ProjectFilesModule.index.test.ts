import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FileFinder } from "@ff-labs/fff-node";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GitModule, type WorkingTreeObserver } from "../../sources/git/index.js";
import { ProjectFilesModule, type ProjectFileRoot } from "../../sources/files/index.js";
import type { ProjectsModule } from "../../sources/projects/index.js";
import { RunnersModule } from "../../sources/runners/index.js";
import type { WorkspacesModule } from "../../sources/workspaces/index.js";
import { git, gitRunner } from "../git/helpers.js";
import { inotifyWatchCount } from "../git/inotifyWatchCount.js";
import { temporaryTestConfig } from "../support/configModule.js";

const directories = new Set<string>();
const modules = new Set<ProjectFilesModule>();
const gits = new Set<GitModule>();
const runnerModules = new Set<RunnersModule>();

afterEach(async () => {
    await Promise.all([...modules].map(async (module) => await module.close()));
    modules.clear();
    await Promise.all([...runnerModules].map(async (runners) => await runners.close()));
    runnerModules.clear();
    for (const git of gits) git.dispose();
    gits.clear();
    await Promise.all(
        [...directories].map(
            async (directory) =>
                await rm(directory, {
                    force: true,
                    recursive: true,
                }),
        ),
    );
    directories.clear();
});

describe("ProjectFilesModule index", () => {
    it("fuzzy-searches relative file paths", async () => {
        const root = await workspace();
        await mkdir(join(root, "sources", "components"), { recursive: true });
        await writeFile(join(root, "sources", "components", "ChatComposer.tsx"), "export {};");
        await writeFile(join(root, "README.md"), "Happy Agent");
        const files = await createFiles();

        const result = await files.search(await fileRoot(root), { query: "chtcomp" });

        expect(result.files).toContainEqual({
            fileName: "ChatComposer.tsx",
            path: "sources/components/ChatComposer.tsx",
        });
    });

    it("lists ranked workspace files for an empty query", async () => {
        const root = await workspace();
        await mkdir(join(root, "src"), { recursive: true });
        await writeFile(join(root, "src", "mention-target.ts"), "export {};");
        const files = await createFiles();

        const result = await files.search(await fileRoot(root), { query: "" });

        expect(result.files).toContainEqual({
            fileName: "mention-target.ts",
            path: "src/mention-target.ts",
        });
    });

    it("lists physical folders immediately while FFF keeps ignored files out of autocomplete", async () => {
        const root = await workspace();
        await mkdir(join(root, "src"), { recursive: true });
        await mkdir(join(root, "node_modules", "dependency"), { recursive: true });
        await mkdir(join(root, "empty"));
        await writeFile(join(root, ".gitignore"), "node_modules/\n");
        await writeFile(join(root, "src", "main.ts"), "export {};");
        await writeFile(
            join(root, "node_modules", "dependency", "index.js"),
            "module.exports = {};",
        );
        const files = await createFiles();
        const resolvedRoot = await fileRoot(root);

        const tree = await files.tree(resolvedRoot, { limit: 50 });
        const search = await files.search(resolvedRoot, { query: "" });

        expect(tree.entries.map((entry) => entry.name)).toContain("src");
        expect(tree.entries.map((entry) => entry.name)).toContain("empty");
        expect(tree.entries.map((entry) => entry.name)).toContain("node_modules");
        expect(search.files.map((file) => file.path)).toContain("src/main.ts");
        expect(search.files.map((file) => file.path)).not.toContain(
            "node_modules/dependency/index.js",
        );
    });

    it("finds binary filenames in a folder outside any repository", async () => {
        // Outside every checkout, so no ancestor repository can switch FFF into its Git mode.
        const root = await plainFolder();
        await mkdir(join(root, "assets"));
        await writeFile(join(root, "README.md"), "workspace");
        await writeFile(join(root, "assets", "data.bin"), new Uint8Array([0, 1, 127, 128, 255]));
        await writeFile(join(root, "assets", "logo.png"), new Uint8Array([137, 80, 78, 71]));
        const files = await createFiles();

        const result = await files.search(await fileRoot(root), { query: "" });

        expect(result.files.map((file) => file.path)).toEqual(
            expect.arrayContaining(["README.md", "assets/data.bin", "assets/logo.png"]),
        );
    });

    it.runIf(process.platform === "linux")(
        "watches a folder outside any repository only where it indexes",
        async () => {
            const root = await plainFolder();
            await mkdir(join(root, "src"));
            await writeFile(join(root, "src", "main.ts"), "export {};");
            // An agent's scratch: a package store under a hidden folder, which fff never reads.
            for (let index = 0; index < 400; index += 1) {
                await mkdir(
                    join(root, ".context", "store", `p${String(index % 20)}`, `d${String(index)}`),
                    { recursive: true },
                );
            }
            await mkdir(join(root, "node_modules", "dependency"), { recursive: true });
            const files = await createFiles();
            const resolvedRoot = await fileRoot(root);
            const before = inotifyWatchCount() ?? 0;

            await files.search(resolvedRoot, { query: "main" });
            // Let the watch arm, then compare: the root and `src` are all fff reads.
            await new Promise((resolve) => setTimeout(resolve, 1_000));
            expect((inotifyWatchCount() ?? 0) - before).toBeLessThanOrEqual(4);

            await writeFile(join(root, "src", "added.ts"), "export {};");
            await vi.waitFor(
                async () => {
                    const result = await files.search(resolvedRoot, { query: "added" });
                    expect(result.files.map((file) => file.path)).toContain("src/added.ts");
                },
                { timeout: 15_000 },
            );
        },
        30_000,
    );

    it("keeps its repository's ignore rules for a folder nested below the top level", async () => {
        const repository = await workspace();
        const root = join(repository, "package");
        await mkdir(join(root, "src"), { recursive: true });
        await mkdir(join(root, "assets"));
        await mkdir(join(root, "build"));
        await mkdir(join(root, "node_modules", "dependency"), { recursive: true });
        await writeFile(join(repository, ".gitignore"), "node_modules/\n/package/build/\n*.log\n");
        await writeFile(join(root, "src", "main.ts"), "export {};");
        await writeFile(join(root, "assets", "data.bin"), new Uint8Array([0, 1, 127, 128, 255]));
        await writeFile(join(root, "build", "out.js"), "built");
        await writeFile(join(root, "debug.log"), "log");
        await writeFile(join(root, "node_modules", "dependency", "index.js"), "dependency");
        const files = await createFiles();
        const resolvedRoot = await fileRoot(root);

        const listed = await files.search(resolvedRoot, { query: "" });
        expect(listed.files.map((file) => file.path).sort()).toEqual([
            "assets/data.bin",
            "src/main.ts",
        ]);

        await files.write(resolvedRoot, {
            content: Buffer.from("created").toString("base64"),
            expectedHash: null,
            path: "src/created.ts",
        });
        const refreshed = await files.search(resolvedRoot, { query: "created" });
        expect(refreshed.files).toContainEqual({ fileName: "created.ts", path: "src/created.ts" });
    });

    it("finds files past Git's listing cap in a folder nested below the top level", async () => {
        const repository = await workspace();
        const root = join(repository, "package");
        await mkdir(join(root, "node_modules", "dependency"), { recursive: true });
        await writeFile(join(repository, ".gitignore"), "node_modules/\n");
        await writeFile(join(root, "a.ts"), "export {};");
        await writeFile(join(root, "zz-past-the-cap.ts"), "export {};");
        await writeFile(join(root, "node_modules", "dependency", "index.js"), "dependency");
        // A listing cut off at its cap, as a folder of more than 20,000 files is.
        const listed = GitModule.prototype.listWorkingTreeFiles;
        const listing = vi
            .spyOn(GitModule.prototype, "listWorkingTreeFiles")
            .mockImplementation(async function (this: GitModule, options) {
                const result = await listed.call(this, options);
                return { paths: result.paths.slice(0, 1), truncated: true };
            });
        try {
            const files = await createFiles();

            const result = await files.search(await fileRoot(root), { query: "" });

            expect(result.files.map((file) => file.path).sort()).toEqual([
                "a.ts",
                "zz-past-the-cap.ts",
            ]);
        } finally {
            listing.mockRestore();
        }
    });

    it("leaves dependency trees out of a folder its repository ignores entirely", async () => {
        // The gym's default scratch folder is such a folder: ignored by the checkout around it.
        const repository = await workspace();
        const root = join(repository, "scratch", "project");
        await mkdir(join(root, "src"), { recursive: true });
        await mkdir(join(root, "assets"));
        await mkdir(join(root, "node_modules", "dependency"), { recursive: true });
        await writeFile(join(repository, ".gitignore"), "/scratch/\nnode_modules/\n");
        await writeFile(join(root, "README.md"), "workspace");
        await writeFile(join(root, "src", "main.ts"), "export {};");
        await writeFile(join(root, "assets", "data.bin"), new Uint8Array([0, 1, 127, 128, 255]));
        await writeFile(join(root, "node_modules", "dependency", "index.js"), "dependency");
        const files = await createFiles();
        const resolvedRoot = await fileRoot(root);

        const listed = await files.search(resolvedRoot, { query: "" });
        expect(listed.files.map((file) => file.path).sort()).toEqual([
            "README.md",
            "assets/data.bin",
            "src/main.ts",
        ]);

        await files.write(resolvedRoot, {
            content: Buffer.from("created").toString("base64"),
            expectedHash: null,
            path: "src/created.ts",
        });
        const refreshed = await files.search(resolvedRoot, { query: "created" });
        expect(refreshed.files).toContainEqual({ fileName: "created.ts", path: "src/created.ts" });
    });

    it("refreshes the warm tree and autocomplete index after an API write", async () => {
        const root = await workspace();
        await writeFile(join(root, "README.md"), "workspace");
        const files = await createFiles();
        const resolvedRoot = await fileRoot(root);
        await files.tree(resolvedRoot, { limit: 50 });

        await files.write(resolvedRoot, {
            content: Buffer.from("created").toString("base64"),
            expectedHash: null,
            path: "generated/deep/note.txt",
        });

        const tree = await files.tree(resolvedRoot, { limit: 50 });
        const search = await files.search(resolvedRoot, { query: "deepnote" });
        expect(tree.entries.map((entry) => entry.name)).toContain("generated");
        expect(search.files).toContainEqual({
            fileName: "note.txt",
            path: "generated/deep/note.txt",
        });
    });

    it("rescans a warm index when a direct read proves an external path exists", async () => {
        const root = await workspace();
        await writeFile(join(root, "README.md"), "workspace");
        const files = await createFiles();
        const resolvedRoot = await fileRoot(root);
        await files.search(resolvedRoot, { query: "readme" });

        await mkdir(join(root, "external"));
        await writeFile(join(root, "external", "created.txt"), "outside");
        await files.read(resolvedRoot, { path: "external/created.txt" });

        await vi.waitFor(async () => {
            const result = await files.search(resolvedRoot, { query: "external" });
            expect(result.files.map((file) => file.path)).toContain("external/created.txt");
        });
    });

    it("rescans after a direct read that lands while a scan is still in flight", async () => {
        const root = await workspace();
        await writeFile(join(root, "README.md"), "workspace");
        // A watch that has not gone live yet, as on a loaded machine just after the first search.
        const git = {
            invalidate: () => undefined,
            markChanged: () => undefined,
            watchWorkingTree: () => () => undefined,
        } as unknown as GitModule;
        const runners = new RunnersModule(await temporaryTestConfig());
        runnerModules.add(runners);
        const files = new ProjectFilesModule(
            {} as ProjectsModule,
            {} as WorkspacesModule,
            git,
            runners,
        );
        modules.add(files);
        const resolvedRoot = await fileRoot(root);
        await files.search(resolvedRoot, { query: "readme" });

        await mkdir(join(root, "external"));
        await writeFile(join(root, "external", "created.txt"), "outside");
        // The scan the read meets may have passed this folder before it existed.
        const scanning = vi.spyOn(FileFinder.prototype, "isScanning").mockReturnValue(true);
        try {
            await files.read(resolvedRoot, { path: "external/created.txt" });
        } finally {
            scanning.mockRestore();
        }

        await vi.waitFor(async () => {
            const result = await files.search(resolvedRoot, { query: "external" });
            expect(result.files.map((file) => file.path)).toContain("external/created.txt");
        });
    });

    it("rescans when the watched tree reports an unseen external file", async () => {
        const root = await workspace();
        await writeFile(join(root, "README.md"), "workspace");
        const files = await createFiles();
        const resolvedRoot = await fileRoot(root);
        await files.search(resolvedRoot, { query: "readme" });

        await writeFile(join(root, "outside.txt"), "external");

        await vi.waitFor(
            async () => {
                const result = await files.search(resolvedRoot, { query: "outside" });
                expect(result.files.map((file) => file.path)).toContain("outside.txt");
            },
            { timeout: 15_000 },
        );
    }, 30_000);

    it("rescans once when its watch goes live after the first scan", async () => {
        const root = await workspace();
        await writeFile(join(root, "README.md"), "workspace");
        // The watch arms asynchronously; a file created before it is live produces no event.
        let observer: WorkingTreeObserver | undefined;
        const git = {
            invalidate: () => undefined,
            markChanged: () => undefined,
            watchWorkingTree: (_root: string, watching: WorkingTreeObserver) => {
                observer = watching;
                return () => undefined;
            },
        } as unknown as GitModule;
        // Search on this machine's folders never asks for a machine, only whether it is native.
        const runners = new RunnersModule(await temporaryTestConfig());
        runnerModules.add(runners);
        const files = new ProjectFilesModule(
            {} as ProjectsModule,
            {} as WorkspacesModule,
            git,
            runners,
        );
        modules.add(files);
        const resolvedRoot = await fileRoot(root);
        await files.search(resolvedRoot, { query: "readme" });

        await writeFile(join(root, "before-watch.txt"), "unseen");
        observer?.onWatching?.(true);

        await vi.waitFor(async () => {
            const result = await files.search(resolvedRoot, { query: "before-watch" });
            expect(result.files.map((file) => file.path)).toContain("before-watch.txt");
        });
    });

    it("does not rescan an idle watched workspace however old its index is", async () => {
        const root = await workspace();
        await writeFile(join(root, "README.md"), "workspace");
        const files = await createFiles();
        const resolvedRoot = await fileRoot(root);
        await files.search(resolvedRoot, { query: "readme" });
        // Let the watch arm. Going live rescans once, since the first scan predates the watch;
        // after that an idle workspace needs no scan at all.
        await new Promise((resolve) => setTimeout(resolve, 500));
        await files.search(resolvedRoot, { query: "readme" });
        await new Promise((resolve) => setTimeout(resolve, 200));
        const scans = vi.spyOn(FileFinder.prototype, "scanFiles");
        const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60 * 60 * 1000);
        try {
            for (let search = 0; search < 5; search += 1) {
                await files.search(resolvedRoot, { query: "readme" });
            }
            expect(scans).not.toHaveBeenCalled();
        } finally {
            clock.mockRestore();
            scans.mockRestore();
        }
    });
});

async function createFiles(): Promise<ProjectFilesModule> {
    // A real Git module, so the index follows the same shared working-tree watch as production.
    const git = GitModule.withRunner(gitRunner);
    gits.add(git);
    const runners = new RunnersModule(await temporaryTestConfig());
    runnerModules.add(runners);
    const files = new ProjectFilesModule(
        {} as ProjectsModule,
        {} as WorkspacesModule,
        git,
        runners,
    );
    modules.add(files);
    return files;
}

async function fileRoot(root: string): Promise<ProjectFileRoot> {
    return { projectId: "project-1", root: await realpath(root) };
}

async function plainFolder(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "happy-plain-file-search-"));
    directories.add(directory);
    const enclosing = await git(directory, ["rev-parse", "--show-toplevel"]).catch(() => undefined);
    if (enclosing !== undefined) {
        throw new Error(
            `The plain-folder fixture ${directory} is inside the repository ${enclosing}; ` +
                "run this test with TMPDIR outside every checkout.",
        );
    }
    return directory;
}

async function workspace(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "happy-workspace-file-search-"));
    directories.add(directory);
    // Its own repository, as a workspace is. FFF finds a repository with libgit2, which ignores
    // GIT_CEILING_DIRECTORIES, so a bare folder inside a checkout would be indexed and statused as
    // part of that checkout, and every rescan would wait behind the checkout's whole git status.
    await git(directory, ["init", "--quiet", "--initial-branch=main"]);
    return directory;
}
