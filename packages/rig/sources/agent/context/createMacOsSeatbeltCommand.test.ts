import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { createMacOsSeatbeltCommand } from "./createMacOsSeatbeltCommand.js";

const temporaryDirectories: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
    );
});

describe("createMacOsSeatbeltCommand", () => {
    it("keeps the temporary directory writable in Read only mode without exposing the workspace", async () => {
        const cwd = await mkdtemp(join(tmpdir(), "rig-seatbelt-read-only-"));
        temporaryDirectories.push(cwd);

        const result = await createMacOsSeatbeltCommand({
            command: "git status --short",
            cwd,
            mode: "read_only",
            shell: "/bin/sh",
        });

        const writableRoots = definedPaths(result.args, "WRITABLE_ROOT");
        const canonicalTemporaryDirectory = await realpath(tmpdir());
        expect(writableRoots).toContain(canonicalTemporaryDirectory);
        expect(writableRoots).not.toContain(await realpath(cwd));
        expect(result.args[1]).toContain("(allow file-read*)");
    });

    it("makes the workspace writable in Workspace write mode", async () => {
        const cwd = await mkdtemp(join(tmpdir(), "rig-seatbelt-workspace-write-"));
        temporaryDirectories.push(cwd);
        await mkdir(join(cwd, ".git"));
        await mkdir(join(cwd, "plans"));

        const result = await createMacOsSeatbeltCommand({
            command: "git status --short",
            cwd,
            mode: "workspace_write",
            protectedPaths: [join(cwd, "plans")],
            shell: "/bin/sh",
        });

        expect(definedPaths(result.args, "WRITABLE_ROOT")).toContain(await realpath(cwd));
        expect(definedPaths(result.args, "WRITABLE_ROOT")).toContain(
            await realpath(join(cwd, ".git")),
        );
        expect(definedPaths(result.args, "PROTECTED_WRITE")).not.toContain(join(cwd, ".git"));
        expect(definedPaths(result.args, "PROTECTED_WRITE")).toEqual(
            expect.arrayContaining([
                join(cwd, "rig.toml"),
                join(cwd, "happy.toml"),
                join(cwd, "AGENTS_SECURITY.md"),
                join(cwd, "plans"),
            ]),
        );
    });

    it("allows outbound network only to the managed proxy port", async () => {
        const result = await createMacOsSeatbeltCommand({
            command: "true",
            cwd: process.cwd(),
            mode: "workspace_write",
            networkAllowedLoopbackPorts: [43_123],
            shell: "/bin/sh",
        });

        expect(result.args[1]).toContain('(allow network-outbound (remote ip "localhost:43123"))');
        expect(result.args[1]).not.toContain("\n(allow network-outbound)\n");
    });

    it("allows binding any local port without opening external egress", async () => {
        const result = await createMacOsSeatbeltCommand({
            command: "true",
            cwd: process.cwd(),
            mode: "workspace_write",
            networkAllowLocalBinding: true,
            shell: "/bin/sh",
        });

        expect(result.args[1]).toContain('(allow network-bind (local ip "*:*"))');
        expect(result.args[1]).toContain('(allow network-inbound (local ip "localhost:*"))');
        expect(result.args[1]).toContain('(allow network-outbound (remote ip "localhost:*"))');
        expect(result.args[1]).not.toContain("\n(allow network-outbound)\n");
    });

    it("confines unix sockets to the project, leaving host sockets unreachable", async () => {
        const cwd = await mkdtemp(join(tmpdir(), "rig-seatbelt-sockets-"));
        temporaryDirectories.push(cwd);

        const result = await createMacOsSeatbeltCommand({
            command: "true",
            cwd,
            mode: "workspace_write",
            shell: "/bin/sh",
        });

        const socketRoots = definedPaths(result.args, "PROJECT_SOCKET_ROOT");
        expect(socketRoots).toEqual([await realpath(cwd)]);
        expect(socketRoots).not.toContain(await realpath(tmpdir()));
        expect(result.args[1]).toContain("(allow system-socket (socket-domain AF_UNIX))");
        expect(result.args[1]).toContain(
            '(allow network-bind (local unix-socket (subpath (param "PROJECT_SOCKET_ROOT_0"))))',
        );
        expect(result.args[1]).toContain(
            '(allow network-outbound (remote unix-socket (subpath (param "PROJECT_SOCKET_ROOT_0"))))',
        );
    });

    it("refuses to grant sockets in the home folder, where host agents keep theirs", async () => {
        const result = await createMacOsSeatbeltCommand({
            command: "true",
            cwd: homedir(),
            mode: "workspace_write",
            shell: "/bin/sh",
        });

        expect(definedPaths(result.args, "PROJECT_SOCKET_ROOT")).toEqual([]);
        expect(result.args[1]).not.toContain("(allow network-bind (local unix-socket");
    });

    it("orders protected denies after the socket allows, as last-match-wins requires", async () => {
        const cwd = await mkdtemp(join(tmpdir(), "rig-seatbelt-socket-order-"));
        temporaryDirectories.push(cwd);

        const result = await createMacOsSeatbeltCommand({
            command: "true",
            cwd,
            mode: "workspace_write",
            shell: "/bin/sh",
        });

        const policy = result.args[1] ?? "";
        expect(policy.indexOf("(allow network-bind (local unix-socket")).toBeLessThan(
            policy.indexOf("(deny network-outbound"),
        );
    });

    it.runIf(process.platform === "darwin")(
        "binds a socket in the project and is refused one beside it",
        async () => {
            const root = await mkdtemp(join(tmpdir(), "rig-seatbelt-socket-runtime-"));
            temporaryDirectories.push(root);
            const cwd = join(root, "project");
            await mkdir(cwd);
            const bind = (path: string) =>
                `node -e "const net=require('net');const s=net.createServer();s.listen('${path}',()=>{console.log('BOUND');s.close();});s.on('error',(e)=>{console.log('DENIED '+e.code);});"`;

            const inside = await createMacOsSeatbeltCommand({
                command: bind(join(cwd, "inside.sock")),
                cwd,
                mode: "workspace_write",
                shell: "/bin/sh",
            });
            const outside = await createMacOsSeatbeltCommand({
                command: bind(join(root, "outside.sock")),
                cwd,
                mode: "workspace_write",
                shell: "/bin/sh",
            });

            const allowed = await execFileAsync(inside.command, inside.args as string[], { cwd });
            const refused = await execFileAsync(outside.command, outside.args as string[], { cwd });
            expect(allowed.stdout).toContain("BOUND");
            expect(refused.stdout).toContain("DENIED");
        },
    );

    it("keeps sockets out of Read only commands and out of protected paths", async () => {
        const cwd = await mkdtemp(join(tmpdir(), "rig-seatbelt-socket-limits-"));
        temporaryDirectories.push(cwd);

        const readOnly = await createMacOsSeatbeltCommand({
            command: "true",
            cwd,
            mode: "read_only",
            shell: "/bin/sh",
        });
        expect(definedPaths(readOnly.args, "PROJECT_SOCKET_ROOT")).toEqual([]);
        expect(readOnly.args[1]).not.toContain("(allow system-socket (socket-domain AF_UNIX))");
        expect(readOnly.args[1]).not.toContain("(allow network-bind (local unix-socket");

        const writable = await createMacOsSeatbeltCommand({
            command: "true",
            cwd,
            environment: { RIG_SERVER_SOCKET_PATH: join(cwd, "control", "server.sock") },
            mode: "workspace_write",
            shell: "/bin/sh",
        });
        const protectedPaths = definedPaths(writable.args, "PROTECTED_WRITE");
        expect(protectedPaths).toContain(join(cwd, "control", "server.sock"));
        const protectedKey = `PROTECTED_WRITE_${String(
            protectedPaths.indexOf(join(cwd, "control", "server.sock")),
        )}`;
        expect(writable.args[1]).toContain(
            `(deny network-outbound\n  (remote unix-socket (literal (param "${protectedKey}")))`,
        );
    });

    it.runIf(process.platform === "darwin")(
        "allows a normal commit from a linked worktree in Workspace write mode",
        async () => {
            const root = await mkdtemp(join(tmpdir(), "rig-seatbelt-git-worktree-"));
            temporaryDirectories.push(root);
            const repository = join(root, "repository");
            const worktree = join(root, "worktree");
            await execFileAsync("git", ["init", repository]);
            await execFileAsync("git", [
                "-C",
                repository,
                "config",
                "user.email",
                "rig@example.com",
            ]);
            await execFileAsync("git", ["-C", repository, "config", "user.name", "Rig"]);
            await writeFile(join(repository, "tracked.txt"), "initial\n");
            await execFileAsync("git", ["-C", repository, "add", "tracked.txt"]);
            await execFileAsync("git", ["-C", repository, "commit", "-m", "initial"]);
            await execFileAsync("git", [
                "-C",
                repository,
                "worktree",
                "add",
                "-b",
                "feature",
                worktree,
            ]);
            await writeFile(join(worktree, "tracked.txt"), "changed\n");

            const result = await createMacOsSeatbeltCommand({
                argv: ["git", "commit", "-am", "sandboxed commit"],
                command: "",
                cwd: worktree,
                mode: "workspace_write",
                shell: "/bin/sh",
            });

            await expect(
                execFileAsync(result.command, result.args as string[], { cwd: worktree }),
            ).resolves.toMatchObject({ stderr: expect.any(String), stdout: expect.any(String) });
        },
    );
});

function definedPaths(args: readonly string[], prefix: string): string[] {
    return args
        .filter((argument) => argument.startsWith(`-D${prefix}_`))
        .map((argument) => argument.slice(argument.indexOf("=") + 1));
}
