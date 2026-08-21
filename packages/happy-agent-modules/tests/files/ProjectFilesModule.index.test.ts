import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { GitModule } from "../../sources/git/index.js";
import { ProjectFilesModule, type ProjectFileRoot } from "../../sources/files/index.js";
import type { ProjectsModule } from "../../sources/projects/index.js";
import type { WorkspacesModule } from "../../sources/workspaces/index.js";

const directories = new Set<string>();
const modules = new Set<ProjectFilesModule>();

afterEach(async () => {
    await Promise.all([...modules].map(async (module) => await module.close()));
    modules.clear();
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
        const files = createFiles();

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
        const files = createFiles();

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
        const files = createFiles();
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
        const files = createFiles();
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
        const files = createFiles();
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

    it("refreshes an aged index when an unseen external file is created", async () => {
        const root = await workspace();
        await writeFile(join(root, "README.md"), "workspace");
        const files = createFiles();
        const resolvedRoot = await fileRoot(root);
        const now = Date.now();
        const clock = vi.spyOn(Date, "now").mockReturnValue(now);
        await files.search(resolvedRoot, { query: "readme" });

        await writeFile(join(root, "outside.txt"), "external");
        clock.mockReturnValue(now + 3_000);

        const result = await files.search(resolvedRoot, { query: "outside" });
        expect(result.files.map((file) => file.path)).toContain("outside.txt");
        clock.mockRestore();
    });
});

function createFiles(): ProjectFilesModule {
    const files = new ProjectFilesModule(
        {} as ProjectsModule,
        {} as WorkspacesModule,
        {
            invalidate: () => undefined,
            markChanged: () => undefined,
        } as unknown as GitModule,
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
