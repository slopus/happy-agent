import { access, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createLinuxBubblewrapCommand as createCommand } from "./createLinuxBubblewrapCommand.js";

const temporaryDirectories: string[] = [];
const projectConfigPlaceholders: NonNullable<
    Awaited<ReturnType<typeof createCommand>>["projectConfigPlaceholder"]
>[] = [];

afterEach(async () => {
    await Promise.all(
        projectConfigPlaceholders.splice(0).map((placeholder) => placeholder.close()),
    );
    await Promise.all(
        temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
    );
});

async function createLinuxBubblewrapCommand(
    options: Parameters<typeof createCommand>[0],
): ReturnType<typeof createCommand> {
    const result = await createCommand(options);
    if (result.projectConfigPlaceholder !== undefined) {
        projectConfigPlaceholders.push(result.projectConfigPlaceholder);
    }
    return result;
}

describe("createLinuxBubblewrapCommand", () => {
    it("bridges only managed proxy and loopback ports into the isolated network", async () => {
        const root = await mkdtemp(join(tmpdir(), "rig-bwrap-network-"));
        temporaryDirectories.push(root);

        const result = await createLinuxBubblewrapCommand({
            bwrapPath: "/usr/bin/bwrap",
            command: "curl https://example.com",
            commandCwd: root,
            cwd: root,
            mode: "workspace_write",
            networkUnixProxySockets: {
                authenticationToken: "command-secret",
                http: "/tmp/rig-network/http.sock",
                loopback: [{ path: "/tmp/rig-network/loopback-443.sock", port: 443 }],
                socks: "/tmp/rig-network/socks.sock",
            },
            shell: "/bin/sh",
            temporaryDirectory: join(root, "tmp"),
        });

        expect(result.args).toContain("--unshare-net");
        const bridgeMount = result.args.findIndex(
            (argument, index) =>
                argument === "/dev/rig-network" && result.args[index - 2] === "--ro-bind",
        );
        expect(result.args.slice(bridgeMount - 2, bridgeMount + 1)).toEqual([
            "--ro-bind",
            "/tmp/rig-network",
            "/dev/rig-network",
        ]);
        expect(result.args).toContain("--tmpfs");
        const script = result.args.at(-1);
        expect(script).toContain("Managed network access requires socat on PATH.");
        expect(script).toContain("TCP-LISTEN:3128,bind=127.0.0.1");
        expect(script).toContain("/dev/rig-network/http.sock");
        expect(script).not.toContain("/tmp/rig-network/http.sock");
        expect(script).toContain("command-secret");
        expect(script).toContain("TCP-LISTEN:1080,bind=127.0.0.1");
        expect(script).toContain("TCP-LISTEN:443,bind=127.0.0.1");
        expect(script).toContain("curl https://example.com");
    });

    it("does not re-expose the host /tmp after installing the private network tmpfs", async () => {
        const root = await mkdtemp(join(tmpdir(), "rig-bwrap-private-tmp-"));
        temporaryDirectories.push(root);

        const result = await createLinuxBubblewrapCommand({
            bwrapPath: "/usr/bin/bwrap",
            command: "true",
            commandCwd: root,
            cwd: root,
            mode: "workspace_write",
            networkUnixProxySockets: {
                authenticationToken: "command-secret",
                http: "/tmp/rig-network/http.sock",
                socks: "/tmp/rig-network/socks.sock",
            },
            shell: "/bin/sh",
            temporaryDirectory: "/tmp",
        });

        expect(result.args).toContain("--tmpfs");
        expect(bindMode(result.args, await realpath("/tmp"))).toBeUndefined();
    });

    it("keeps host /tmp private even when the command has no managed network policy", async () => {
        const root = await mkdtemp(join(tmpdir(), "rig-bwrap-private-default-tmp-"));
        temporaryDirectories.push(root);

        const result = await createLinuxBubblewrapCommand({
            bwrapPath: "/usr/bin/bwrap",
            command: "true",
            commandCwd: root,
            cwd: root,
            mode: "workspace_write",
            shell: "/bin/sh",
            temporaryDirectory: "/tmp",
        });

        expect(result.args).toContain("--tmpfs");
        expect(bindMode(result.args, await realpath("/tmp"))).toBeUndefined();
    });

    it("keeps protected project files read-only when the workspace is below /tmp", async () => {
        const privateTemporaryRoot = await realpath("/tmp");
        const root = await mkdtemp(join(privateTemporaryRoot, "rig-bwrap-protected-project-"));
        temporaryDirectories.push(root);
        await Promise.all([
            mkdir(join(root, ".agents")),
            mkdir(join(root, ".codex")),
            mkdir(join(root, "plans")),
            writeFile(join(root, "rig.toml"), "[network]\n"),
            writeFile(join(root, "happy.toml"), "[network]\n"),
            writeFile(join(root, "AGENTS_SECURITY.md"), "Require approval.\n"),
        ]);

        const result = await createLinuxBubblewrapCommand({
            bwrapPath: "/usr/bin/bwrap",
            command: "true",
            commandCwd: root,
            cwd: root,
            mode: "workspace_write",
            protectedPaths: [join(root, "plans"), join(root, "missing")],
            shell: "/bin/sh",
            temporaryDirectory: privateTemporaryRoot,
        });

        for (const name of [
            ".agents",
            ".codex",
            "rig.toml",
            "happy.toml",
            "AGENTS_SECURITY.md",
            "plans",
        ]) {
            expect(bindMode(result.args, join(root, name))).toBe("--ro-bind");
        }
        expect(bindMode(result.args, join(root, "missing"))).toBeUndefined();
        expect(result.protectedCreatePaths).not.toContain(join(root, "missing"));
    });

    it("rebinds a Read only workspace below /tmp after the private tmpfs mount", async () => {
        const privateTemporaryRoot = await realpath("/tmp");
        const root = await mkdtemp(join(privateTemporaryRoot, "rig-bwrap-read-only-project-"));
        temporaryDirectories.push(root);

        const result = await createLinuxBubblewrapCommand({
            bwrapPath: "/usr/bin/bwrap",
            command: "pwd",
            commandCwd: root,
            cwd: root,
            mode: "read_only",
            shell: "/bin/sh",
            temporaryDirectory: privateTemporaryRoot,
        });

        const temporaryMount = mountIndex(result.args, "--tmpfs", "/tmp");
        const restoredMount = mountIndex(result.args, "--ro-bind", root, root);
        expect(restoredMount).toBeGreaterThan(temporaryMount);
    });

    it("uses a read-only host view with isolated networking in Read only mode", async () => {
        const root = await mkdtemp(join(tmpdir(), "rig-bwrap-read-only-"));
        temporaryDirectories.push(root);

        const result = await createLinuxBubblewrapCommand({
            bwrapPath: "/usr/bin/bwrap",
            command: "git status --short",
            commandCwd: root,
            cwd: root,
            mode: "read_only",
            shell: "/bin/sh",
            temporaryDirectory: join(root, "tmp"),
        });

        expect(result.command).toBe("/usr/bin/bwrap");
        expect(bindMode(result.args, "/")).toBe("--ro-bind");
        expect(bindMode(result.args, root)).toBe(
            isAtOrBelow(await realpath("/tmp"), root) ? "--ro-bind" : undefined,
        );
        expect(result.args).toContain("--unshare-net");
        expect(result.args).toContain("--unshare-user");
        expect(result.args).toContain("--unshare-pid");
        expect(result.args).not.toContain("CAP_NET_BIND_SERVICE");
        expect(result.args.slice(-4)).toEqual(["--", "/bin/sh", "-lc", "git status --short"]);
    });

    it("keeps the temporary directory writable in Read only mode without exposing the workspace", async () => {
        const root = await mkdtemp(join(tmpdir(), "rig-bwrap-read-only-temp-"));
        temporaryDirectories.push(root);
        const cwd = join(root, "workspace");
        const temporaryDirectory = join(root, "tmp");
        await Promise.all([mkdir(cwd), mkdir(temporaryDirectory)]);

        const result = await createLinuxBubblewrapCommand({
            bwrapPath: "/usr/bin/bwrap",
            command: "git status --short",
            commandCwd: cwd,
            cwd,
            mode: "read_only",
            shell: "/bin/sh",
            temporaryDirectory,
        });

        expect(bindMode(result.args, await realpath(temporaryDirectory))).toBe("--bind");
        const canonicalCwd = await realpath(cwd);
        expect(bindMode(result.args, canonicalCwd)).toBe(
            isAtOrBelow(await realpath("/tmp"), canonicalCwd) ? "--ro-bind" : undefined,
        );
    });

    it("rebinds writable roots before protecting agent metadata and Rig control paths", async () => {
        const root = await mkdtemp(join(tmpdir(), "rig-bwrap-workspace-write-"));
        temporaryDirectories.push(root);
        const cwd = join(root, "workspace");
        const temporaryDirectory = join(root, "tmp");
        const gitDirectory = join(cwd, ".git");
        const agentsDirectory = join(cwd, ".agents");
        const codexDirectory = join(cwd, ".codex");
        const controlDirectory = join(temporaryDirectory, "rig-123");
        const tokenPath = join(controlDirectory, "token");
        await Promise.all([
            mkdir(join(gitDirectory, "info"), { recursive: true }),
            mkdir(agentsDirectory, { recursive: true }),
            mkdir(codexDirectory, { recursive: true }),
            mkdir(controlDirectory, { recursive: true }),
        ]);
        await writeFile(tokenPath, "secret\n");
        await writeFile(join(gitDirectory, "info", "exclude"), "*.local\n");
        const canonicalCwd = await realpath(cwd);
        const canonicalTemporaryDirectory = await realpath(temporaryDirectory);

        const result = await createLinuxBubblewrapCommand({
            bwrapPath: "/usr/bin/bwrap",
            command: "true",
            commandCwd: cwd,
            cwd,
            environment: { RIG_SERVER_TOKEN_PATH: tokenPath },
            mode: "workspace_write",
            shell: "/bin/sh",
            temporaryDirectory,
            uid: 123,
        });

        expect(bindMode(result.args, canonicalCwd)).toBe("--bind");
        expect(bindMode(result.args, canonicalTemporaryDirectory)).toBe("--bind");
        expect(bindMode(result.args, gitDirectory)).not.toBe("--ro-bind");
        for (const protectedPath of [
            agentsDirectory,
            codexDirectory,
            controlDirectory,
            tokenPath,
        ]) {
            expect(bindMode(result.args, protectedPath)).toBe("--ro-bind");
            expect(lastBindIndex(result.args, protectedPath)).toBeGreaterThan(
                lastBindIndex(result.args, canonicalCwd),
            );
        }
        expect(result.projectConfigPlaceholder?.gitExclude?.path).toBe(
            join(await realpath(gitDirectory), "info", "exclude"),
        );
        expect(
            mountIndex(
                result.args,
                "--ro-bind",
                result.projectConfigPlaceholder!.gitExclude!.sourcePath,
                join(await realpath(gitDirectory), "info", "exclude"),
            ),
        ).toBeGreaterThan(lastBindIndex(result.args, canonicalCwd));
        await result.projectConfigPlaceholder?.close();
        expect(result.args.slice(-6)).toEqual([
            "--chdir",
            canonicalCwd,
            "--",
            "/bin/sh",
            "-lc",
            "true",
        ]);
    });

    it("atomically masks an absent rig.toml and monitors other absent protected paths", async () => {
        const root = await mkdtemp(join(tmpdir(), "rig-bwrap-missing-protected-"));
        temporaryDirectories.push(root);
        const cwd = join(root, "workspace");
        await mkdir(cwd);

        const result = await createLinuxBubblewrapCommand({
            bwrapPath: "/usr/bin/bwrap",
            command: "true",
            commandCwd: cwd,
            cwd,
            mode: "workspace_write",
            shell: "/bin/sh",
            temporaryDirectory: join(root, "tmp"),
        });
        const canonicalCwd = await realpath(cwd);

        for (const name of [".agents", ".codex", ".git"]) {
            const path = join(cwd, name);
            expect(result.protectedCreatePaths).toContain(join(canonicalCwd, name));
            await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
        }
        const projectConfigPath = join(canonicalCwd, "rig.toml");
        expect(result.protectedCreatePaths).not.toContain(projectConfigPath);
        expect(result.protectedCreatePaths).toContain(join(canonicalCwd, "happy.toml"));
        expect(
            mountIndex(
                result.args,
                "--ro-bind",
                result.projectConfigPlaceholder!.sourcePath,
                projectConfigPath,
            ),
        ).toBeGreaterThan(lastBindIndex(result.args, canonicalCwd));
        expect(result.projectConfigPlaceholder?.path).toBe(projectConfigPath);
        await expect(access(projectConfigPath)).resolves.toBeUndefined();
        await expect(access(result.projectConfigPlaceholder!.sourcePath)).resolves.toBeUndefined();
        await result.projectConfigPlaceholder?.close();
        await expect(access(projectConfigPath)).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("keeps caller-level config masks alive across concurrent command startup", async () => {
        const root = await mkdtemp(join(tmpdir(), "rig-bwrap-concurrent-config-"));
        temporaryDirectories.push(root);
        const cwd = join(root, "workspace");
        const gitExcludePath = join(cwd, ".git", "info", "exclude");
        await mkdir(join(cwd, ".git", "info"), { recursive: true });

        const command = {
            bwrapPath: "/usr/bin/bwrap",
            command: "git status --short",
            commandCwd: cwd,
            cwd,
            mode: "workspace_write" as const,
            shell: "/bin/sh",
            temporaryDirectory: join(root, "tmp"),
        };
        const [first, second] = await Promise.all([
            createLinuxBubblewrapCommand(command),
            createLinuxBubblewrapCommand(command),
        ]);
        const projectConfigPath = join(await realpath(cwd), "rig.toml");

        expect(first.projectConfigPlaceholder).toBeDefined();
        expect(second.projectConfigPlaceholder).toBeDefined();
        expect(first.projectConfigPlaceholder!.sourcePath).not.toBe(
            second.projectConfigPlaceholder!.sourcePath,
        );
        expect(first.projectConfigPlaceholder!.gitExclude?.sourcePath).not.toBe(
            second.projectConfigPlaceholder!.gitExclude?.sourcePath,
        );
        await first.projectConfigPlaceholder!.close();
        await expect(access(projectConfigPath)).resolves.toBeUndefined();
        await expect(access(gitExcludePath)).resolves.toBeUndefined();
        await second.projectConfigPlaceholder!.close();
        await expect(access(projectConfigPath)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(access(gitExcludePath)).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("rejects a Git exclude symlink that escapes trusted repository metadata", async () => {
        const root = await mkdtemp(join(tmpdir(), "rig-bwrap-exclude-symlink-"));
        temporaryDirectories.push(root);
        const cwd = join(root, "workspace");
        const outside = join(root, "outside-exclude");
        await mkdir(join(cwd, ".git", "info"), { recursive: true });
        await writeFile(outside, "*.local\n");
        await symlink(outside, join(cwd, ".git", "info", "exclude"));

        await expect(
            createLinuxBubblewrapCommand({
                bwrapPath: "/usr/bin/bwrap",
                command: "git status --short",
                commandCwd: cwd,
                cwd,
                mode: "workspace_write",
                shell: "/bin/sh",
                temporaryDirectory: join(root, "tmp"),
            }),
        ).rejects.toThrow("resolves outside its trusted metadata directory");
    });
});

function bindMode(command: readonly string[], target: string): string | undefined {
    const targetIndex = lastBindIndex(command, target);
    return targetIndex < 2 ? undefined : command[targetIndex - 2];
}

function lastBindIndex(command: readonly string[], target: string): number {
    return command.findLastIndex(
        (argument, index) => argument === target && command[index - 1] === target,
    );
}

function mountIndex(
    command: readonly string[],
    mode: string,
    sourceOrTarget: string,
    target?: string,
): number {
    return command.findIndex(
        (argument, index) =>
            argument === mode &&
            command[index + 1] === sourceOrTarget &&
            (target === undefined || command[index + 2] === target),
    );
}

function isAtOrBelow(root: string, target: string): boolean {
    const suffix = relative(root, target);
    return suffix === "" || (!suffix.startsWith("..") && !isAbsolute(suffix));
}
