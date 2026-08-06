import { describe, expect, it } from "vitest";

import { createDockerSandboxCommand } from "./createDockerSandboxCommand.js";

const runtime = {
    bwrapPath: "/usr/bin/bwrap",
};

describe("createDockerSandboxCommand", () => {
    it("bridges managed proxy sockets without sharing the container network", () => {
        const command = createDockerSandboxCommand({
            command: "curl https://example.com",
            commandCwd: "/workspace",
            mode: "workspace_write",
            networkBridgeRoot: "/workspace/.rig-network",
            networkUnixProxySockets: {
                authenticationToken: "command-secret",
                http: "/workspace/.rig-network/command-1/http.sock",
                loopback: [
                    {
                        path: "/workspace/.rig-network/command-1/loopback-443.sock",
                        port: 443,
                    },
                ],
                socks: "/workspace/.rig-network/command-1/socks.sock",
            },
            runtime,
            shell: "/bin/sh",
            workspaceCwd: "/workspace",
        });

        expect(command).toContain("--unshare-net");
        expect(bindMode(command, "/workspace/.rig-network")).toBe("--ro-bind");
        expect(lastBindIndex(command, "/workspace/.rig-network")).toBeGreaterThan(
            lastBindIndex(command, "/workspace"),
        );
        const script = command.at(-1);
        expect(script).toContain("Managed network access requires socat on PATH.");
        expect(script).toContain("TCP-LISTEN:3128,bind=127.0.0.1");
        expect(script).toContain("TCP-LISTEN:1080,bind=127.0.0.1");
        expect(script).toContain("TCP-LISTEN:443,bind=127.0.0.1");
        expect(script).toContain("command-secret");
        expect(script).toContain("curl https://example.com");
    });

    it("makes the workspace read-only and isolates networking in Read only mode", () => {
        const command = createDockerSandboxCommand({
            command: "touch changed.txt",
            commandCwd: "/workspace",
            mode: "read_only",
            runtime,
            shell: "/bin/sh",
            workspaceCwd: "/workspace",
        });

        expect(command).toContain("--unshare-net");
        expect(command).toContain("--unshare-pid");
        expect(command).toContain("--unshare-user");
        const temporaryMount = command.findIndex(
            (argument, index) => argument === "/tmp" && command[index - 1] === "--tmpfs",
        );
        expect(command.slice(temporaryMount - 1, temporaryMount + 1)).toEqual(["--tmpfs", "/tmp"]);
        const procMount = command.findIndex(
            (argument, index) => argument === "/proc" && command[index - 1] === "--tmpfs",
        );
        expect(command.slice(procMount - 1, procMount + 1)).toEqual(["--tmpfs", "/proc"]);
        expect(command).not.toContain("CAP_NET_BIND_SERVICE");
        expect(bindMode(command, "/workspace")).toBeUndefined();
        expect(bindMode(command, "/tmp")).toBeUndefined();
        expect(command.slice(-3)).toEqual(["/bin/sh", "-lc", "touch changed.txt"]);
    });

    it("rebinds a Read only workspace below /tmp after the private tmpfs mount", () => {
        const command = createDockerSandboxCommand({
            command: "pwd",
            commandCwd: "/tmp/workspace",
            mode: "read_only",
            runtime,
            shell: "/bin/sh",
            workspaceCwd: "/tmp/workspace",
        });

        const temporaryMount = mountIndex(command, "--tmpfs", "/tmp");
        const restoredMount = mountIndex(command, "--ro-bind", "/tmp/workspace", "/tmp/workspace");
        expect(restoredMount).toBeGreaterThan(temporaryMount);
    });

    it("makes only the workspace and temporary directory writable in Workspace write mode", () => {
        const command = createDockerSandboxCommand({
            command: "touch changed.txt",
            commandCwd: "/workspace/packages/rig",
            mode: "workspace_write",
            protectedPaths: ["/workspace/plans"],
            runtime,
            shell: "/bin/sh",
            workspaceCwd: "/workspace",
        });

        expect(bindMode(command, "/")).toBe("--ro-bind");
        expect(bindMode(command, "/tmp")).toBeUndefined();
        expect(bindMode(command, "/workspace")).toBe("--bind");
        expect(command.filter((argument) => argument === "--tmpfs")).toHaveLength(2);
        expect(bindMode(command, "/workspace/.git")).toBeUndefined();
        expect(bindMode(command, "/workspace/.agents")).toBe("--ro-bind-try");
        expect(bindMode(command, "/workspace/plans")).toBe("--ro-bind-try");
        expect(command.slice(command.indexOf("--chdir"), command.indexOf("--chdir") + 2)).toEqual([
            "--chdir",
            "/workspace/packages/rig",
        ]);
    });

    it("atomically mounts the prepared project config over the writable workspace", () => {
        const command = createDockerSandboxCommand({
            command: "printf compromised > rig.toml",
            commandCwd: "/workspace",
            mode: "workspace_write",
            readyProjectConfigNames: ["rig.toml"],
            runtime,
            shell: "/bin/sh",
            workspaceCwd: "/workspace",
        });

        expect(
            mountIndex(command, "--ro-bind", "/workspace/rig.toml", "/workspace/rig.toml"),
        ).toBeGreaterThan(lastBindIndex(command, "/workspace"));
        expect(
            mountIndex(command, "--ro-bind-try", "/workspace/happy.toml", "/workspace/happy.toml"),
        ).toBeGreaterThan(lastBindIndex(command, "/workspace"));
        expect(
            mountIndex(
                command,
                "--ro-bind-try",
                "/workspace/AGENTS_SECURITY.md",
                "/workspace/AGENTS_SECURITY.md",
            ),
        ).toBeGreaterThan(lastBindIndex(command, "/workspace"));
        expect(
            mountIndex(command, "--ro-bind-try", "/workspace/rig.toml", "/workspace/rig.toml"),
        ).toBe(-1);
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
