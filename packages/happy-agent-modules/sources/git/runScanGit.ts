import { randomUUID } from "node:crypto";
import { join } from "node:path";

import {
    computePermissions,
    createHostCompute,
    quoteShellArgument,
} from "@slopus/happy-agent-compute";
import { createRootContext } from "@steve.kite/stdlib";

import type { GitCommandRunner } from "./GitCommandRunner.js";
import { resolveGitExecutable } from "./resolveGitExecutable.js";

const SCAN_TIMEOUT_MS = 10_000;
const SCAN_OUTPUT_LIMIT = 16 * 1024 * 1024;
const STRIPPED_ENVIRONMENT = [
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_ASKPASS",
    "GIT_CONFIG",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_SYSTEM",
    "GIT_COMMON_DIR",
    "GIT_DIR",
    "GIT_EDITOR",
    "GIT_EXTERNAL_DIFF",
    "GIT_EXEC_PATH",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_PROXY_COMMAND",
    "GIT_SSH",
    "GIT_SSH_COMMAND",
    "GIT_TEMPLATE_DIR",
    "GIT_WORK_TREE",
];
const SAFE_CONFIGURATION = [
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "diff.external=",
    "-c",
    "credential.helper=",
];

export interface ScanGitResult {
    stdout: string;
    stdoutBytes: Buffer;
    truncated: boolean;
}

export type ScanGitRunner = (options: {
    args: readonly string[];
    cwd: string;
    maximumBytes?: number;
    signal?: AbortSignal;
}) => Promise<ScanGitResult>;

/**
 * Executes a hardened read-only Git invocation.
 *
 * Optional locks, lazy fetches, credentials, hooks, fsmonitor, external diffs, and text conversion
 * are all disabled. Output and time are bounded, and the command receives no interactive terminal.
 */
export async function runScanGit(options: {
    args: readonly string[];
    cwd: string;
    gitCeilingDirectories?: string;
    maximumBytes?: number;
    signal?: AbortSignal;
}): Promise<ScanGitResult> {
    const git = await resolveGitExecutable();
    const argv = [
        git,
        "-C",
        options.cwd,
        "--no-optional-locks",
        ...SAFE_CONFIGURATION,
        ...options.args,
    ];
    const rootContext = createRootContext();
    const scanContext = rootContext.named("git-read-only-scan");
    const compute = createHostCompute({
        ctx: scanContext,
        cwd: options.cwd,
        environment: scanEnvironment(options.cwd, options.gitCeilingDirectories),
    });
    try {
        // Happy Agent Compute is the shared host execution boundary in v2. It deliberately accepts
        // a command string, so every argv element is quoted independently before the read-only
        // policy is applied. Unlike v1's private command builder, this keeps Git on the same
        // filesystem and network sandbox as every other provider.
        const maximumBytes = options.maximumBytes ?? SCAN_OUTPUT_LIMIT;
        // The shared shell result is UTF-8 text. Base64 keeps `cat-file` and every future binary
        // reader byte-exact while Git and any helper it starts remain inside the same sandbox.
        const command = [
            "set -o pipefail",
            `${argv.map((argument) => quoteShellArgument(argument)).join(" ")} | /usr/bin/base64`,
        ].join("\n");
        const result = await compute.shell.run({
            command,
            maxOutputBytes: Math.ceil(maximumBytes / 3) * 4 + 1024,
            permissions: computePermissions("read_only"),
            ...(options.signal === undefined ? {} : { signal: options.signal }),
            timeoutMs: SCAN_TIMEOUT_MS,
        });
        const decoded = Buffer.from(retainedBase64Prefix(result.stdout), "base64");
        if (result.exitCode !== 0 || result.timedOut) {
            throw scanGitError(
                result.timedOut ? "The Git scan timed out." : result.stderr,
                result.exitCode ?? 1,
                result.stderr,
                decoded.toString("utf8"),
            );
        }
        const stdoutBytes = decoded.subarray(0, maximumBytes);
        return {
            stdout: stdoutBytes.toString("utf8"),
            stdoutBytes,
            truncated:
                decoded.byteLength > maximumBytes ||
                (result.stdoutOmittedBytes ?? 0) > 0 ||
                (result.stderrOmittedBytes ?? 0) > 0,
        };
    } finally {
        await compute.dispose(scanContext);
    }
}

/** Adapts an injected host runner without leaving the execution surface the host configured. */
export function scanGitRunnerFromCommandRunner(runner: GitCommandRunner): ScanGitRunner {
    if (runner.scan !== undefined) return runner.scan;
    return async (options) => {
        const result = await runner.run(options.cwd, options.args, {
            ...(options.maximumBytes === undefined ? {} : { maxOutputBytes: options.maximumBytes }),
            ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
        if (result.code !== 0) {
            throw scanGitError(result.stderr, result.code, result.stderr, result.stdout);
        }
        return {
            stdout: result.stdout,
            stdoutBytes: Buffer.from(result.stdout, "utf8"),
            truncated: false,
        };
    };
}

export function gitCommandRunnerFromScanGitRunner(runGit: ScanGitRunner): GitCommandRunner {
    return {
        async run(cwd, args, options = {}) {
            try {
                const result = await runGit({
                    args,
                    cwd,
                    ...(options.maxOutputBytes === undefined
                        ? {}
                        : { maximumBytes: options.maxOutputBytes }),
                    ...(options.signal === undefined ? {} : { signal: options.signal }),
                });
                return { code: 0, stderr: "", stdout: result.stdout };
            } catch (error) {
                const candidate = error as {
                    code?: unknown;
                    stderr?: unknown;
                    stdout?: unknown;
                };
                return {
                    code: typeof candidate.code === "number" ? candidate.code : 1,
                    stderr:
                        typeof candidate.stderr === "string"
                            ? candidate.stderr
                            : error instanceof Error
                              ? error.message
                              : String(error),
                    stdout: typeof candidate.stdout === "string" ? candidate.stdout : "",
                };
            }
        },
        scan: runGit,
    };
}

function scanEnvironment(cwd: string, gitCeilingDirectories?: string): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = { ...process.env };
    for (const name of STRIPPED_ENVIRONMENT) delete environment[name];
    // The shared sandbox correctly withholds private home-directory files. Tell Git not to probe
    // those files at all, rather than letting an inaccessible ~/.gitconfig turn a repository read
    // into a failure. Repository config remains available for the hostile-helper hardening above.
    // Keep the deliberately absent file inside the readable sandbox. A made-up root path can be
    // reported as EACCES on Linux, which Git treats as a fatal global-config error rather than an
    // absent file. Randomizing the name prevents repository content from supplying that config.
    environment.GIT_CONFIG_GLOBAL = join(cwd, `.happy-agent-git-config-${randomUUID()}`);
    environment.GIT_CONFIG_NOSYSTEM = "1";
    environment.GIT_ATTR_NOSYSTEM = "1";
    environment.GIT_TERMINAL_PROMPT = "0";
    environment.GIT_OPTIONAL_LOCKS = "0";
    environment.GIT_NO_LAZY_FETCH = "1";
    environment.GIT_PAGER = "cat";
    if (gitCeilingDirectories !== undefined) {
        environment.GIT_CEILING_DIRECTORIES = gitCeilingDirectories;
    }
    environment.LC_ALL = "C";
    environment.SHELL = "/bin/bash";
    return environment;
}

function retainedBase64Prefix(stdout: string): string {
    const marker = stdout.indexOf("\n... ");
    if (marker >= 0) return stdout.slice(0, marker);
    return stdout.startsWith("... ") ? "" : stdout;
}

function scanGitError(message: string, code: number, stderr: string, stdout: string): Error {
    const error = new Error(
        message.trim() || `Git exited with status ${String(code)}.`,
    ) as Error & {
        code: number;
        stderr: string;
        stdout: string;
    };
    error.code = code;
    error.stderr = stderr;
    error.stdout = stdout;
    return error;
}
