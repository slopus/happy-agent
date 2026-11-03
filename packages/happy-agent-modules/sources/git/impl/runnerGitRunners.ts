import type { PlatformPath } from "node:path";

import type { GitCommandRunner } from "../GitCommandRunner.js";
import { scanGitError, STRIPPED_ENVIRONMENT, type ScanGitRunner } from "../runScanGit.js";
import type { RunnerRunOptions, RunnerRunResult } from "../../runners/index.js";

const GIT_TIMEOUT_MS = 5_000;
const NETWORK_GIT_TIMEOUT_MS = 5 * 60 * 1_000;
const GIT_OUTPUT_LIMIT = 1024 * 1024;
const SCAN_TIMEOUT_MS = 10_000;
const SCAN_OUTPUT_LIMIT = 16 * 1024 * 1024;
/** The scanner's hardening, with the runner's own name for the null device. */
function safeConfiguration(nullDevice: string): string[] {
    return [
        "-c",
        "core.fsmonitor=false",
        "-c",
        `core.hooksPath=${nullDevice}`,
        "-c",
        "diff.external=",
        "-c",
        "credential.helper=",
    ];
}

/** Where a runner's Git reads nothing: `NUL` on Windows, `/dev/null` everywhere else. */
function nullDevice(paths: PlatformPath): string {
    return paths.sep === "\\" ? "NUL" : "/dev/null";
}

/** How a runner's Git runs: one program at a time on the runner's product machine. */
export interface RunnerGitTarget {
    readonly run: (options: RunnerRunOptions) => Promise<RunnerRunResult>;
    /** The runner's path rules, by which every path its Git reports is compared. */
    readonly paths: PlatformPath;
}

/**
 * Foreground Git on a runner uses that machine's Git configuration and authentication, with
 * the same exit-status contract as Git on this machine.
 */
export function runnerGitCommandRunner(target: RunnerGitTarget): GitCommandRunner {
    return {
        get paths() {
            return target.paths;
        },
        async run(cwd, args, options = {}) {
            try {
                const result = await target.run({
                    command: "git",
                    args: ["-C", cwd, ...args],
                    environment: { GIT_TERMINAL_PROMPT: "0" },
                    maximumBytes: options.maxOutputBytes ?? GIT_OUTPUT_LIMIT,
                    timeoutMs:
                        options.timeoutMs ??
                        (args[0] === "fetch" ? NETWORK_GIT_TIMEOUT_MS : GIT_TIMEOUT_MS),
                    ...(options.signal === undefined ? {} : { signal: options.signal }),
                });
                const failed = result.timedOut || result.truncated;
                return {
                    code: failed && result.code === 0 ? 1 : result.code,
                    stderr: result.timedOut
                        ? `${result.stderr}\nGit did not finish in time on the runner.`.trim()
                        : result.truncated
                          ? `${result.stderr}\nGit wrote more output than allowed.`.trim()
                          : result.stderr,
                    stdout: result.stdout.toString("utf8"),
                };
            } catch (error) {
                return {
                    code: 1,
                    stderr: error instanceof Error ? error.message : String(error),
                    stdout: "",
                };
            }
        },
    };
}

/**
 * Unattended read-only Git on a runner, hardened exactly as on this machine: no optional locks,
 * hooks, credential helpers, fsmonitor, external diffs, lazy fetches, prompts, or system and global
 * configuration, with bounded time and output.
 */
export function runnerScanGit(
    target: RunnerGitTarget,
    gitCeilingDirectories?: () => string | undefined,
): ScanGitRunner {
    return async (options) => {
        const maximumBytes = options.maximumBytes ?? SCAN_OUTPUT_LIMIT;
        const ceiling = gitCeilingDirectories?.();
        const devNull = nullDevice(target.paths);
        const environment: Record<string, string | null> = {
            GIT_ATTR_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: devNull,
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_NO_LAZY_FETCH: "1",
            GIT_OPTIONAL_LOCKS: "0",
            GIT_PAGER: "cat",
            GIT_TERMINAL_PROMPT: "0",
            LC_ALL: "C",
            ...(ceiling === undefined ? {} : { GIT_CEILING_DIRECTORIES: ceiling }),
        };
        for (const name of STRIPPED_ENVIRONMENT) environment[name] = null;
        const result = await target.run({
            command: "git",
            args: [
                "-C",
                options.cwd,
                "--no-optional-locks",
                ...safeConfiguration(devNull),
                ...options.args,
            ],
            environment,
            // One byte past the bound tells a full read from a truncated one.
            maximumBytes: maximumBytes + 1,
            timeoutMs: SCAN_TIMEOUT_MS,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
        if (result.timedOut || (result.code !== 0 && !result.truncated)) {
            throw scanGitError(
                result.timedOut ? "The Git scan timed out." : result.stderr,
                result.code,
                result.stderr,
                result.stdout.toString("utf8"),
            );
        }
        const stdoutBytes = result.stdout.subarray(0, maximumBytes);
        return {
            stdout: stdoutBytes.toString("utf8"),
            stdoutBytes,
            truncated: result.truncated || result.stdout.byteLength > maximumBytes,
        };
    };
}
