import type { PlatformPath } from "node:path";

import { Type, type Static } from "@sinclair/typebox";

export const gitCommandResultSchema = Type.Object(
    {
        code: Type.Integer(),
        stderr: Type.String(),
        stdout: Type.String(),
    },
    { additionalProperties: false },
);

export type GitCommandResult = Static<typeof gitCommandResultSchema>;

export interface GitCommandOptions {
    /** Variables added to Git's environment for this one command. */
    readonly environment?: Readonly<Record<string, string>>;
    readonly maxOutputBytes?: number;
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
}

/**
 * Canonical Git execution boundary for the v2 host.
 *
 * A runner returns exit status and both output streams. Operations that require success use
 * `runGitCommandOrThrow`; probes can inspect a failure without losing Git's diagnostic text.
 */
export interface GitCommandRunner {
    /**
     * The path rules of the machine Git runs on, when that is a runner rather than this process.
     * Its paths are then compared by those rules alone: this machine's disk says nothing about
     * them, and a Windows runner's Git writes `C:/x` for the folder named `C:\x`.
     */
    readonly paths?: PlatformPath;
    /**
     * Optional unattended read surface. Foreground hosts expose this separately so scanners never
     * inherit the write and network authority required by worktree mutations.
     */
    readonly scan?: (options: {
        args: readonly string[];
        cwd: string;
        maximumBytes?: number;
        signal?: AbortSignal;
    }) => Promise<{ stdout: string; stdoutBytes: Buffer; truncated: boolean }>;
    run(
        cwd: string,
        args: readonly string[],
        options?: GitCommandOptions,
    ): Promise<GitCommandResult>;
}

export async function runGitCommandOrThrow(
    runner: GitCommandRunner,
    cwd: string,
    args: readonly string[],
    options?: GitCommandOptions,
): Promise<string> {
    const result = await runner.run(cwd, args, options);
    if (result.code === 0) return result.stdout.trim();
    const message = result.stderr.trim() || `Git exited with status ${String(result.code)}.`;
    const error = new Error(message) as Error & {
        code: number;
        stderr: string;
        stdout: string;
    };
    error.code = result.code;
    error.stderr = result.stderr;
    error.stdout = result.stdout;
    throw error;
}
