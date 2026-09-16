import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

import { redactGitAuthenticationText } from "./GitCredentialBroker.js";
import type { GitCommandOptions, GitCommandResult, GitCommandRunner } from "./GitCommandRunner.js";
import { runScanGit } from "./runScanGit.js";

const execFile = promisify(execFileCallback);
const GIT_TIMEOUT_MS = 5_000;
const NETWORK_GIT_TIMEOUT_MS = 5 * 60 * 1_000;
const GIT_OUTPUT_LIMIT = 1024 * 1024;

export const directGitCommandRunner: GitCommandRunner = {
    run: runGitCommand,
    scan: runScanGit,
};

export async function runGitCommand(
    cwd: string,
    args: readonly string[],
    options: GitCommandOptions = {},
): Promise<GitCommandResult> {
    return await runGitCommandWithEnvironment(cwd, args, {}, options);
}

export async function runGitCommandWithEnvironment(
    cwd: string,
    args: readonly string[],
    environment: Readonly<Record<string, string>> = {},
    options: GitCommandOptions = {},
): Promise<GitCommandResult> {
    try {
        const result = await execFile("git", ["-C", cwd, ...args], {
            encoding: "utf8",
            windowsHide: true,
            env: { ...process.env, ...environment, GIT_TERMINAL_PROMPT: "0" },
            maxBuffer: options.maxOutputBytes ?? GIT_OUTPUT_LIMIT,
            signal: options.signal,
            // Fetch is allowed a deliberately generous foreground budget, but workspace creation
            // and shutdown must still be able to cancel it and can never wait forever.
            timeout:
                options.timeoutMs ?? (usesNetwork(args) ? NETWORK_GIT_TIMEOUT_MS : GIT_TIMEOUT_MS),
        });
        return { code: 0, stderr: result.stderr, stdout: result.stdout };
    } catch (error) {
        const candidate = error as {
            code?: number | string;
            stderr?: string;
            stdout?: string;
        };
        return {
            code: typeof candidate.code === "number" ? candidate.code : 1,
            stderr: redactGitAuthenticationText(
                candidate.stderr ?? (error instanceof Error ? error.message : String(error)),
                environment,
            ),
            stdout: candidate.stdout ?? "",
        };
    }
}

function usesNetwork(args: readonly string[]): boolean {
    return args[0] === "fetch";
}
