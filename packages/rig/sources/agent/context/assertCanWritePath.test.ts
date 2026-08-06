import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createNodeFileSystemContext } from "./createNodeFileSystemContext.js";
import type { PermissionMode } from "../../permissions/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
    );
});

describe("direct filesystem project configuration protection", () => {
    it("blocks configured files and directory descendants", async () => {
        const workspace = await mkdtemp(join(tmpdir(), "rig-protected-path-security-"));
        temporaryDirectories.push(workspace);
        await mkdir(join(workspace, "plans"));
        await writeFile(join(workspace, "plans", "one.md"), "original\n");
        const context = createNodeFileSystemContext(workspace, {
            permissionMode: () => "workspace_write",
            protectedPaths: [join(workspace, "plans")],
        });

        await expect(context.writeFile("plans/one.md", "changed\n")).rejects.toThrow(
            "protected workspace path",
        );
        await expect(context.writeFile("ordinary.md", "allowed\n")).resolves.toBeUndefined();
    });

    it("blocks changes to root project config files in restricted write modes", async () => {
        const workspace = await mkdtemp(join(tmpdir(), "rig-project-config-security-"));
        temporaryDirectories.push(workspace);
        await Promise.all(
            ["rig.toml", "happy.toml", "AGENTS_SECURITY.md"].map((name) =>
                writeFile(join(workspace, name), "[network]\nallowed_ports = [443]\n"),
            ),
        );
        let mode: PermissionMode = "workspace_write";
        const context = createNodeFileSystemContext(workspace, {
            permissionMode: () => mode,
        });

        for (const restrictedMode of ["workspace_write", "auto"] as const) {
            mode = restrictedMode;
            for (const name of ["rig.toml", "happy.toml", "AGENTS_SECURITY.md"]) {
                await expect(context.writeFile(name, "compromised\n")).rejects.toThrow(
                    `cannot modify the project ${name}`,
                );
                await expect(context.rm(name)).rejects.toThrow(`cannot modify the project ${name}`);
            }
        }

        for (const name of ["rig.toml", "happy.toml", "AGENTS_SECURITY.md"]) {
            await expect(readFile(join(workspace, name), "utf8")).resolves.toBe(
                "[network]\nallowed_ports = [443]\n",
            );
        }
    });

    it("allows explicit Full access to change the root rig.toml", async () => {
        const workspace = await mkdtemp(join(tmpdir(), "rig-project-config-full-access-"));
        temporaryDirectories.push(workspace);
        const context = createNodeFileSystemContext(workspace, {
            permissionMode: () => "full_access",
        });

        await context.writeFile("rig.toml", "[network]\nallowed_ports = [8443]\n");

        await expect(readFile(join(workspace, "rig.toml"), "utf8")).resolves.toContain("8443");
    });

    it("allows explicit Full access to change the root AGENTS_SECURITY.md", async () => {
        const workspace = await mkdtemp(join(tmpdir(), "rig-project-security-full-access-"));
        temporaryDirectories.push(workspace);
        const context = createNodeFileSystemContext(workspace, {
            permissionMode: () => "full_access",
        });

        await context.writeFile("AGENTS_SECURITY.md", "Require reviewed deployment commands.\n");

        await expect(readFile(join(workspace, "AGENTS_SECURITY.md"), "utf8")).resolves.toContain(
            "reviewed deployment",
        );
    });
});

describe("direct filesystem Git control protection", () => {
    it("blocks writes, directory creation, and removal throughout Git metadata", async () => {
        const workspace = await createRepositoryFixture();
        const context = createNodeFileSystemContext(workspace, {
            permissionMode: () => "workspace_write",
        });

        await expect(
            context.writeFile(".git/config", "[core]\n\thooksPath = hooks\n"),
        ).rejects.toThrow("cannot modify Git control files");
        await expect(context.mkdir(".git/hooks/new", { recursive: true })).rejects.toThrow(
            "cannot modify Git control files",
        );
        await expect(context.rm(".git/hooks", { recursive: true })).rejects.toThrow(
            "cannot modify Git control files",
        );
        await expect(context.writeFile("nested/.git/config", "[core]\n")).rejects.toThrow(
            "cannot modify Git control files",
        );
        await expect(context.writeFile("nested/.gitconfig", "[alias]\n")).rejects.toThrow(
            "cannot modify Git control files",
        );
        await expect(context.writeFile("nested/.gitmodules", "[submodule]\n")).rejects.toThrow(
            "cannot modify Git control files",
        );

        await expect(readFile(join(workspace, ".git", "config"), "utf8")).resolves.toBe("[core]\n");
        await expect(readFile(join(workspace, ".git", "hooks", "existing"), "utf8")).resolves.toBe(
            "existing hook\n",
        );
    });

    it("blocks symlink aliases while allowing normal source files in every restricted write mode", async () => {
        const workspace = await createRepositoryFixture();
        await symlink(join(workspace, ".git", "config"), join(workspace, "config-link"));
        await symlink(join(workspace, ".git"), join(workspace, "metadata-link"));
        let mode: PermissionMode = "workspace_write";
        const context = createNodeFileSystemContext(workspace, {
            permissionMode: () => mode,
        });

        for (const restrictedMode of ["workspace_write", "auto"] as const) {
            mode = restrictedMode;
            await expect(context.writeFile("config-link", "compromised\n")).rejects.toThrow(
                "cannot modify Git control files",
            );
            await expect(context.writeFile("metadata-link/hooks/new", "hook\n")).rejects.toThrow(
                "cannot modify Git control files",
            );
            await context.mkdir("src", { recursive: true });
            await context.writeFile("src/feature.ts", `export const mode = "${restrictedMode}";\n`);
            await context.writeFile(".gitignore", "dist/\n");
            await expect(context.rm("src/feature.ts")).resolves.toBeUndefined();
        }

        await expect(readFile(join(workspace, ".git", "config"), "utf8")).resolves.toBe("[core]\n");
        await expect(readFile(join(workspace, ".gitignore"), "utf8")).resolves.toBe("dist/\n");
    });

    it("allows explicit Full access to modify Git control files", async () => {
        const workspace = await createRepositoryFixture();
        const context = createNodeFileSystemContext(workspace, {
            permissionMode: () => "full_access",
        });

        await context.writeFile(".git/config", "[core]\n\thooksPath = hooks\n");
        await context.mkdir(".git/hooks/nested", { recursive: true });
        await context.writeFile(".git/hooks/nested/post-checkout", "#!/bin/sh\n");
        await context.rm(".git/hooks/existing");

        await expect(readFile(join(workspace, ".git", "config"), "utf8")).resolves.toContain(
            "hooksPath",
        );
        await expect(
            readFile(join(workspace, ".git", "hooks", "nested", "post-checkout"), "utf8"),
        ).resolves.toBe("#!/bin/sh\n");
    });
});

async function createRepositoryFixture(): Promise<string> {
    const workspace = await mkdtemp(join(tmpdir(), "rig-direct-git-security-"));
    temporaryDirectories.push(workspace);
    await mkdir(join(workspace, ".git", "hooks"), { recursive: true });
    await mkdir(join(workspace, "nested", ".git"), { recursive: true });
    await writeFile(join(workspace, ".git", "config"), "[core]\n");
    await writeFile(join(workspace, ".git", "hooks", "existing"), "existing hook\n");
    return workspace;
}
