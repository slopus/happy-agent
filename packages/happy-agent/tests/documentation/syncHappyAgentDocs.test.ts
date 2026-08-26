import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { syncHappyAgentDocs } from "../../sources/documentation/syncHappyAgentDocs.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map(async (path) => await rm(path, { force: true, recursive: true })),
    );
});

async function temporaryDirectory(name: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), name));
    temporaryDirectories.push(directory);
    return directory;
}

describe("syncHappyAgentDocs", () => {
    it("extracts the packaged documentation into the Happy home", async () => {
        const root = await temporaryDirectory("happy-agent-docs-");
        const source = join(root, "packaged-docs");
        const happyHome = join(root, ".happy");
        await mkdir(join(source, "guides"), { recursive: true });
        await writeFile(join(source, "README.md"), "# Happy Agent\n", "utf8");
        await writeFile(join(source, "guides", "workspaces.md"), "# Workspaces\n", "utf8");

        await syncHappyAgentDocs(happyHome, source);

        await expect(readFile(join(happyHome, "docs", "README.md"), "utf8")).resolves.toBe(
            "# Happy Agent\n",
        );
        await expect(
            readFile(join(happyHome, "docs", "guides", "workspaces.md"), "utf8"),
        ).resolves.toBe("# Workspaces\n");
        expect((await lstat(join(happyHome, "docs", "README.md"))).mode & 0o222).toBe(0);
    });

    it("restores shipped files to their current contents on every startup", async () => {
        const root = await temporaryDirectory("happy-agent-docs-update-");
        const source = join(root, "packaged-docs");
        const happyHome = join(root, ".happy");
        await mkdir(source, { recursive: true });
        await writeFile(join(source, "README.md"), "first release\n", "utf8");
        await syncHappyAgentDocs(happyHome, source);

        await chmod(join(happyHome, "docs", "README.md"), 0o600);
        await writeFile(join(happyHome, "docs", "README.md"), "locally changed\n", "utf8");
        await writeFile(join(source, "README.md"), "second release\n", "utf8");

        await syncHappyAgentDocs(happyHome, source);

        await expect(readFile(join(happyHome, "docs", "README.md"), "utf8")).resolves.toBe(
            "second release\n",
        );
        expect((await lstat(join(happyHome, "docs", "README.md"))).mode & 0o222).toBe(0);
    });

    it("does not follow a symlink placed at the managed documentation directory", async () => {
        const root = await temporaryDirectory("happy-agent-docs-symlink-");
        const source = join(root, "packaged-docs");
        const happyHome = join(root, ".happy");
        const outside = join(root, "outside");
        await mkdir(source, { recursive: true });
        await mkdir(happyHome, { recursive: true });
        await mkdir(outside, { recursive: true });
        await writeFile(join(source, "README.md"), "shipped\n", "utf8");
        await import("node:fs/promises").then(
            async ({ symlink }) => await symlink(outside, join(happyHome, "docs")),
        );

        await expect(syncHappyAgentDocs(happyHome, source)).rejects.toThrow(
            "documentation directory is unsafe",
        );
        await expect(readFile(join(outside, "README.md"), "utf8")).rejects.toMatchObject({
            code: "ENOENT",
        });
    });

    it("does not follow a symlink nested inside the managed documentation directory", async () => {
        const root = await temporaryDirectory("happy-agent-docs-nested-symlink-");
        const source = join(root, "packaged-docs");
        const happyHome = join(root, ".happy");
        const outside = join(root, "outside");
        await mkdir(join(source, "guides"), { recursive: true });
        await mkdir(join(happyHome, "docs"), { recursive: true });
        await mkdir(outside, { recursive: true });
        await writeFile(join(source, "guides", "workspaces.md"), "shipped\n", "utf8");
        await import("node:fs/promises").then(
            async ({ symlink }) => await symlink(outside, join(happyHome, "docs", "guides")),
        );

        await expect(syncHappyAgentDocs(happyHome, source)).rejects.toThrow(
            "documentation directory is unsafe",
        );
        await expect(readFile(join(outside, "workspaces.md"), "utf8")).rejects.toMatchObject({
            code: "ENOENT",
        });
    });
});
