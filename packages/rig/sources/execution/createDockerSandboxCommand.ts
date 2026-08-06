import { posix } from "node:path";

import { MANAGED_NETWORK_SOCAT_PREFLIGHT } from "../agent/context/managedNetworkSocatPreflight.js";
import { PROJECT_PROTECTED_FILE_NAMES } from "../config/projectProtectedFileNames.js";
import type { PermissionMode } from "../permissions/index.js";
import type { PreparedDockerSandbox } from "./prepareDockerSandbox.js";

export function createDockerSandboxCommand(options: {
    command: string;
    commandCwd: string;
    mode: Exclude<PermissionMode, "full_access">;
    networkBridgeRoot?: string;
    networkUnixProxySockets?: {
        authenticationToken: string;
        http: string;
        loopback?: readonly { path: string; port: number }[];
        socks: string;
    };
    protectedPaths?: readonly string[];
    readyProjectConfigNames?: readonly ("happy.toml" | "rig.toml")[];
    runtime: PreparedDockerSandbox;
    shell: string;
    workspaceCwd: string;
}): string[] {
    validateNetworkBridgePaths(options);
    const command = [
        options.runtime.bwrapPath,
        "--new-session",
        "--die-with-parent",
        "--unshare-net",
        "--ro-bind",
        "/",
        "/",
        "--dev",
        "/dev",
        "--tmpfs",
        "/tmp",
    ];
    if (options.mode === "read_only") {
        if (isAtOrBelow("/tmp", options.workspaceCwd)) {
            command.push("--ro-bind", options.workspaceCwd, options.workspaceCwd);
        }
    } else {
        command.push("--bind", options.workspaceCwd, options.workspaceCwd);
        if (options.networkBridgeRoot !== undefined) {
            command.push("--ro-bind", options.networkBridgeRoot, options.networkBridgeRoot);
        }
    }
    for (const name of [".agents", ".codex"])
        command.push(
            "--ro-bind-try",
            `${options.workspaceCwd}/${name}`,
            `${options.workspaceCwd}/${name}`,
        );
    for (const name of PROJECT_PROTECTED_FILE_NAMES) {
        const projectConfigPath = `${options.workspaceCwd}/${name}`;
        const hasPreparedProjectConfig =
            name !== "AGENTS_SECURITY.md" &&
            options.readyProjectConfigNames?.includes(name) === true;
        command.push(
            hasPreparedProjectConfig ? "--ro-bind" : "--ro-bind-try",
            projectConfigPath,
            projectConfigPath,
        );
    }
    for (const protectedPath of options.protectedPaths ?? []) {
        command.push("--ro-bind-try", protectedPath, protectedPath);
    }
    const userCommand =
        options.networkUnixProxySockets === undefined
            ? options.command
            : [
                  MANAGED_NETWORK_SOCAT_PREFLIGHT,
                  authenticatedSocatCommand(
                      3128,
                      options.networkUnixProxySockets.http,
                      options.networkUnixProxySockets.authenticationToken,
                  ),
                  authenticatedSocatCommand(
                      1080,
                      options.networkUnixProxySockets.socks,
                      options.networkUnixProxySockets.authenticationToken,
                  ),
                  ...(options.networkUnixProxySockets.loopback ?? []).map(({ path, port }) =>
                      authenticatedSocatCommand(
                          port,
                          path,
                          options.networkUnixProxySockets!.authenticationToken,
                      ),
                  ),
                  `trap 'kill $(jobs -p) 2>/dev/null || true' EXIT`,
                  readinessCheck([
                      3128,
                      1080,
                      ...(options.networkUnixProxySockets.loopback ?? []).map(({ port }) => port),
                  ]),
                  options.command,
              ].join("\n");
    command.push(
        "--unshare-pid",
        "--unshare-user",
        "--tmpfs",
        "/proc",
        "--chdir",
        options.commandCwd,
        "--",
        options.shell,
        "-lc",
        userCommand,
    );
    return command;
}

function authenticatedSocatCommand(port: number, socketPath: string, token: string): string {
    const relay = `{ printf %s "$RIG_NETWORK_TOKEN"; cat; } | ` + `socat - "$RIG_NETWORK_ADDRESS"`;
    return (
        `RIG_NETWORK_TOKEN=${shellQuote(token)} ` +
        `RIG_NETWORK_ADDRESS=${shellQuote(`UNIX-CONNECT:${socketPath}`)} ` +
        `socat TCP-LISTEN:${String(port)},bind=127.0.0.1,fork,reuseaddr ` +
        `SYSTEM:${shellQuote(relay)} >/dev/null 2>&1 &`
    );
}

function shellQuote(value: string): string {
    return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function readinessCheck(ports: readonly number[]): string {
    return ports
        .map(
            (port) =>
                `attempt=0; until socat -T 0.1 -u /dev/null TCP4:127.0.0.1:${String(port)} >/dev/null 2>&1; do attempt=$((attempt + 1)); [ "$attempt" -lt 100 ] || { echo "Managed network bridge did not become ready." >&2; exit 1; }; sleep 0.01; done`,
        )
        .join("\n");
}

function validateNetworkBridgePaths(options: {
    networkBridgeRoot?: string;
    networkUnixProxySockets?: {
        http: string;
        loopback?: readonly { path: string }[];
        socks: string;
    };
    workspaceCwd: string;
}): void {
    if (
        options.networkBridgeRoot !== undefined &&
        !isAtOrBelow(options.workspaceCwd, options.networkBridgeRoot)
    ) {
        throw new Error("Docker managed network bridge root must be inside the workspace.");
    }
    if (options.networkUnixProxySockets === undefined) return;
    if (options.networkBridgeRoot === undefined) {
        throw new Error("Docker managed network sockets require a protected bridge root.");
    }
    const paths = [
        options.networkUnixProxySockets.http,
        options.networkUnixProxySockets.socks,
        ...(options.networkUnixProxySockets.loopback ?? []).map(({ path }) => path),
    ];
    if (paths.some((path) => !isAtOrBelow(options.networkBridgeRoot!, path))) {
        throw new Error("Docker managed network sockets must be inside the protected bridge root.");
    }
}

function isAtOrBelow(root: string, target: string): boolean {
    const suffix = posix.relative(root, target);
    return (
        suffix === "" || (!suffix.startsWith("../") && suffix !== ".." && !posix.isAbsolute(suffix))
    );
}
