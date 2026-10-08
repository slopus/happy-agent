import type { GitCommandRunner } from "../GitCommandRunner.js";
import { redactGitAuthenticationText } from "../GitCredentialBroker.js";
import { scanGitError, STRIPPED_ENVIRONMENT, type ScanGitRunner } from "../runScanGit.js";
import type { RunnerRunOptions, RunnerRunResult } from "../../runners/index.js";

const GIT_TIMEOUT_MS = 5_000;
const NETWORK_GIT_TIMEOUT_MS = 5 * 60 * 1_000;
const GIT_OUTPUT_LIMIT = 1024 * 1024;
const SCAN_TIMEOUT_MS = 10_000;
const SCAN_OUTPUT_LIMIT = 16 * 1024 * 1024;
/** The scanner's hardening, for the POSIX machines runners are. */
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

/** How a runner's Git runs: one program at a time on the runner's product machine. */
export interface RunnerGitTarget {
    readonly run: (options: RunnerRunOptions) => Promise<RunnerRunResult>;
}

/**
 * Foreground Git on a runner: writes, fetches, and clones, carrying the environment a credential
 * needs. The same exit-status contract as Git on this machine, so every caller is unchanged.
 */
export function runnerGitCommandRunner(
    target: RunnerGitTarget,
    environment: () => Promise<Readonly<Record<string, string>>> = async () => ({}),
): GitCommandRunner {
    return {
        async run(cwd, args, options = {}) {
            let extra: Readonly<Record<string, string>> = {};
            try {
                extra = await environment();
                const result = await target.run({
                    command: "git",
                    args: ["-C", cwd, ...args],
                    environment: { ...extra, GIT_TERMINAL_PROMPT: "0" },
                    maximumBytes: options.maxOutputBytes ?? GIT_OUTPUT_LIMIT,
                    timeoutMs:
                        options.timeoutMs ??
                        (args[0] === "fetch" ? NETWORK_GIT_TIMEOUT_MS : GIT_TIMEOUT_MS),
                    ...(options.signal === undefined ? {} : { signal: options.signal }),
                });
                const failed = result.timedOut || result.truncated;
                return {
                    code: failed && result.code === 0 ? 1 : result.code,
                    stderr: redactGitAuthenticationText(
                        result.timedOut
                            ? `${result.stderr}\nGit did not finish in time on the runner.`.trim()
                            : result.truncated
                              ? `${result.stderr}\nGit wrote more output than allowed.`.trim()
                              : result.stderr,
                        extra,
                    ),
                    stdout: result.stdout.toString("utf8"),
                };
            } catch (error) {
                return {
                    code: 1,
                    stderr: redactGitAuthenticationText(
                        error instanceof Error ? error.message : String(error),
                        extra,
                    ),
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
        const environment: Record<string, string | null> = {
            GIT_ATTR_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: "/dev/null",
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
                ...SAFE_CONFIGURATION,
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
