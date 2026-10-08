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
import { gitRunner } from "../git/helpers.js";
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
        const files = new ProjectFilesModule(
            {} as ProjectsModule,
            {} as WorkspacesModule,
            git,
            // Search on this machine's folders never asks for a machine.
            {} as RunnersModule,
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

async function workspace(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "happy-workspace-file-search-"));
    directories.add(directory);
    return directory;
}
