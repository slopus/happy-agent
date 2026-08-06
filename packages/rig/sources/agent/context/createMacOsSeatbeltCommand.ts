import { homedir, tmpdir } from "node:os";
import { join, sep } from "node:path";

import { PROJECT_PROTECTED_FILE_NAMES } from "../../config/projectProtectedFileNames.js";
import type { PermissionMode } from "../../permissions/index.js";
import { findGitWritablePaths } from "./findGitWritablePaths.js";
import { MACOS_SEATBELT_BASE_POLICY } from "./macOsSeatbeltBasePolicy.js";
import { quoteShellArgument } from "./quoteShellArgument.js";
import { resolvePotentialPath } from "./resolvePotentialPath.js";

const MACOS_SEATBELT_EXECUTABLE = "/usr/bin/sandbox-exec";
const PROTECTED_WORKSPACE_NAMES = [
    ".agents",
    ".codex",
    ...PROJECT_PROTECTED_FILE_NAMES,
] as const;

export async function createMacOsSeatbeltCommand(options: {
    /**
     * Run this exact argument vector instead of a shell command. Background readers use it so they
     * never build a shell string and never source the user's login profile.
     */
    argv?: readonly string[];
    command: string;
    cwd: string;
    environment?: NodeJS.ProcessEnv;
    mode: PermissionMode;
    networkAllowLocalBinding?: boolean;
    networkAllowedLoopbackPorts?: readonly number[];
    path?: string;
    protectedPaths?: readonly string[];
    shell: string;
}): Promise<{ args: readonly string[]; command: string }> {
    const environment = options.environment ?? process.env;
    const temporaryDirectory = tmpdir();
    // Read only withholds the workspace but still needs a writable temporary directory. Toolchain
    // shims such as macOS `xcrun` cache into TMPDIR on every invocation, and denying that write
    // makes them fall back to a path resolution that costs hundreds of milliseconds per command.
    const projectCandidates =
        options.mode === "read_only"
            ? []
            : [options.cwd, ...(await findGitWritablePaths(options.cwd))];
    const writableCandidates =
        options.mode === "read_only"
            ? [temporaryDirectory, "/tmp"]
            : [...projectCandidates, temporaryDirectory, "/tmp"];
    const writableRoots = [
        ...new Set(await Promise.all(writableCandidates.map(resolvePotentialPath))),
    ];
    // A unix socket is reachable by path, so where it may live decides what a command can talk to.
    // Inside a project a socket can only be one the command itself created; the host's own sockets —
    // the Docker daemon, the ssh agent, Rig's control socket in the temporary directory — sit
    // elsewhere and stay unreachable, which is why this is narrower than writable space.
    //
    // The home folder is the exception that makes the rule worth stating: a session can run there,
    // and `~/.docker`, `~/.gnupg`, and password-manager agents keep their sockets under it, so
    // granting the home folder would hand over exactly what this scope exists to withhold. Any
    // ancestor of the home folder is refused for the same reason.
    const home = await resolvePotentialPath(homedir());
    const projectSocketRoots = [
        ...new Set(await Promise.all(projectCandidates.map(resolvePotentialPath))),
    ].filter((root) => !isAtOrAbove(root, home));
    const protectedCandidates = [
        ...PROTECTED_WORKSPACE_NAMES.map((name) => join(options.cwd, name)),
        join(temporaryDirectory, `rig-${process.getuid?.() ?? 0}`),
        environment.RIG_SERVER_DIRECTORY,
        environment.RIG_SERVER_SOCKET_PATH,
        environment.RIG_SERVER_TOKEN_PATH,
    ].filter((path): path is string => typeof path === "string" && path.length > 0);
    const protectedPaths = [
        ...new Set([
            ...protectedCandidates,
            ...(await Promise.all(protectedCandidates.map(resolvePotentialPath))),
            ...(options.protectedPaths ?? []),
        ]),
    ];
    const definitions: string[] = [];
    const writableRules = writableRoots.map((root, index) => {
        const key = `WRITABLE_ROOT_${String(index)}`;
        definitions.push(`-D${key}=${root}`);
        return `  (subpath (param "${key}"))`;
    });
    const projectSocketRules = projectSocketRoots.flatMap((root, index) => {
        const key = `PROJECT_SOCKET_ROOT_${String(index)}`;
        definitions.push(`-D${key}=${root}`);
        return [
            `(allow network-bind (local unix-socket (subpath (param "${key}"))))`,
            `(allow network-outbound (remote unix-socket (subpath (param "${key}"))))`,
        ];
    });
    const protectedRules = protectedPaths.map((path, index) => {
        const key = `PROTECTED_WRITE_${String(index)}`;
        definitions.push(`-D${key}=${path}`);
        return `(deny file-write*
  (literal (param "${key}"))
  (subpath (param "${key}")))
(deny network-bind
  (local unix-socket (literal (param "${key}")))
  (local unix-socket (subpath (param "${key}"))))
(deny network-outbound
  (remote unix-socket (literal (param "${key}")))
  (remote unix-socket (subpath (param "${key}"))))`;
    });
    const fileWritePolicy =
        writableRules.length === 0 ? "" : `(allow file-write*\n${writableRules.join("\n")}\n)`;
    const policy = [
        MACOS_SEATBELT_BASE_POLICY,
        "; allow read-only file operations across the host, matching Codex workspace-write",
        "(allow file-read*)",
        ...(options.networkAllowLocalBinding === true
            ? [
                  '(allow network-bind (local ip "*:*"))',
                  '(allow network-inbound (local ip "localhost:*"))',
                  '(allow network-outbound (remote ip "localhost:*"))',
              ]
            : []),
        ...(options.networkAllowedLoopbackPorts ?? []).map(
            (port) => `(allow network-outbound (remote ip "localhost:${String(port)}"))`,
        ),
        ...(projectSocketRules.length === 0
            ? []
            : ["(allow system-socket (socket-domain AF_UNIX))"]),
        ...projectSocketRules,
        fileWritePolicy,
        ...protectedRules,
    ]
        .filter((section) => section.length > 0)
        .join("\n");
    const userCommand =
        options.path === undefined
            ? options.command
            : `export PATH=${quoteShellArgument(options.path)}\n${options.command}`;

    return {
        args: [
            "-p",
            policy,
            ...definitions,
            "--",
            ...(options.argv ?? [options.shell, "-lc", userCommand]),
        ],
        command: MACOS_SEATBELT_EXECUTABLE,
    };
}

/** True when `candidate` is the path itself or one of its ancestors. */
function isAtOrAbove(candidate: string, path: string): boolean {
    if (candidate === path) return true;
    const prefix = candidate.endsWith(sep) ? candidate : `${candidate}${sep}`;
    return path.startsWith(prefix);
}
