import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import type { Compute } from "../../Compute.js";
import {
    COMPUTE_BACKGROUND_GRACE_MS,
    startComputeCommand,
} from "../../impl/startComputeCommand.js";
import {
    boundClaudeShellOutput,
    MAX_CLAUDE_SHELL_OUTPUT_CHARACTERS,
} from "./impl/boundClaudeShellOutput.js";

/** How long a command is waited for when the model does not say. */
const DEFAULT_TIMEOUT_MS = 120_000;

/** The longest wait a model may ask for. Beyond this it should background the command instead. */
const MAX_TIMEOUT_MS = 600_000;

const exact = { additionalProperties: false } as const;

const CLAUDE_BASH_DESCRIPTION = `Executes a bash command and returns its output.

- Commands start in the session working directory. Shell state (such as \`cd\`, environment variables, and functions) does not persist between calls.
- Try to maintain the current working directory by using absolute paths and avoiding usage of \`cd\`. In particular, never prepend \`cd <current-directory>\` to a \`git\` command: Git already operates on the current working tree, and making it a compound command can trigger an unnecessary permission review.
- Prefer the dedicated file and search tools over shell equivalents when one fits.
- \`timeout\` is in milliseconds: default ${String(DEFAULT_TIMEOUT_MS)}, max ${String(MAX_TIMEOUT_MS)}. It is how long you wait, not how long the command may live: a command still running when the wait ends keeps running in the background and comes back with a shell ID.
- \`run_in_background\` starts the command in the background right away, waiting about ${String(COMPUTE_BACKGROUND_GRACE_MS / 1_000)} seconds to see that it did not fall over. Use it for dev servers and watchers. No \`&\` needed.
- Read a background shell with \`BashOutput\`, type into it with \`BashInput\`, and stop it with \`BashStop\`.

# Git
- Interactive flags such as \`git rebase -i\` and \`git add -i\` are not supported.
- Use the \`gh\` CLI for GitHub operations.
- Commit or push only when the user asks.

Happy Agent extension: \`dangerouslyDisableSandbox\` requests one reviewed Full-access execution in Auto mode; it never bypasses Read only or Workspace write mode.

Output is truncated to the last ${String(MAX_CLAUDE_SHELL_OUTPUT_CHARACTERS)} characters.`;

/** Claude's `Bash`: run a command, and hand back a task when it outlives the wait. */
export function claudeBashTool(compute: Compute) {
    return defineAgentTool({
        name: "Bash",
        description: CLAUDE_BASH_DESCRIPTION,
        parameters: Type.Object(
            {
                command: Type.String({ description: "The command to execute" }),
                timeout: Type.Optional(
                    Type.Number({
                        description: `Optional timeout in milliseconds (max ${String(MAX_TIMEOUT_MS)})`,
                        maximum: MAX_TIMEOUT_MS,
                        minimum: 0,
                    }),
                ),
                description: Type.Optional(
                    Type.String({
                        description:
                            'Clear, concise description of what this command does in active voice. Never use words like "complex" or "risk" in the description.',
                    }),
                ),
                run_in_background: Type.Optional(
                    Type.Boolean({
                        description: "Set to true to run this command in the background.",
                    }),
                ),
                tty: Type.Optional(
                    Type.Boolean({
                        description:
                            "Run the command under a terminal, for programs that behave differently without one. Defaults to false.",
                    }),
                ),
                dangerouslyDisableSandbox: Type.Optional(
                    Type.Boolean({
                        description:
                            "Request reviewed execution outside the workspace sandbox in Auto mode. Use only when the sandbox blocks a necessary command.",
                    }),
                ),
            },
            exact,
        ),
        returnType: Type.Object(
            {
                command: Type.String(),
                stdout: Type.String(),
                stderr: Type.String(),
                exitCode: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
                bash_id: Type.Optional(Type.String()),
                truncated: Type.Boolean(),
                wallTimeSeconds: Type.Number(),
            },
            exact,
        ),
        // Running a command again runs it again, which is rarely the same thing twice.
        durable: false,
        autoPermissionInstructions:
            "For Bash, request full-access execution with dangerouslyDisableSandbox: true only when the workspace sandbox blocks necessary work. Commands without it remain sandboxed.",
        describeAutoPermissionAction: ({ command, dangerouslyDisableSandbox, description }) =>
            `running ${JSON.stringify(command)} in ${JSON.stringify(compute.cwd)} ${
                dangerouslyDisableSandbox === true
                    ? "outside the workspace sandbox, with unrestricted filesystem and network access"
                    : "inside the current workspace sandbox"
            }${description === undefined ? "" : `. Stated purpose: ${description}`}`,
        // A sandboxed command is the ordinary case and needs no reviewer; leaving the sandbox is
        // the whole of what one is asked about here.
        shouldReviewInAutoMode: ({ dangerouslyDisableSandbox }) =>
            dangerouslyDisableSandbox === true,
        shouldRunInFullAccessInAutoMode: ({ dangerouslyDisableSandbox }) =>
            dangerouslyDisableSandbox === true,
        execute: async (ctx, { command, run_in_background, timeout, tty }) => {
            const { snapshot, wallTimeSeconds } = await startComputeCommand(compute, ctx, {
                command,
                ...(tty === undefined ? {} : { tty }),
                ...(run_in_background === true ? { background: true } : {}),
                waitMs: Math.min(MAX_TIMEOUT_MS, timeout ?? DEFAULT_TIMEOUT_MS),
            });
            const stdout = boundClaudeShellOutput(snapshot.stdoutDelta);
            const stderr = boundClaudeShellOutput(snapshot.stderrDelta);
            const dropped =
                (snapshot.stdoutDeltaOmittedBytes ?? 0) + (snapshot.stderrDeltaOmittedBytes ?? 0);
            const running = snapshot.status === "running";
            return {
                command: snapshot.command,
                stdout: stdout.text,
                stderr: stderr.text,
                ...(running
                    ? { bash_id: String(snapshot.sessionId) }
                    : { exitCode: snapshot.exitCode }),
                truncated: stdout.truncated || stderr.truncated || dropped > 0,
                wallTimeSeconds: Number(wallTimeSeconds.toFixed(3)),
            };
        },
        // A command still running has not failed yet, and one that ended anywhere but zero has.
        isError: (result) => result.exitCode !== undefined && result.exitCode !== 0,
        toLLM: (result) => {
            const parts: string[] = [];
            if (result.stdout.length > 0) parts.push(result.stdout);
            if (result.stderr.length > 0) parts.push(result.stderr);
            if (result.bash_id !== undefined) {
                parts.push(
                    `The command is still running as background shell ${result.bash_id}. Read its new output with BashOutput, type into it with BashInput, and stop it with BashStop.`,
                );
            } else if (result.exitCode === null) {
                parts.push("The command was stopped before it could exit.");
            } else if (result.exitCode !== undefined && result.exitCode !== 0) {
                parts.push(`The command exited with code ${String(result.exitCode)}.`);
            }
            return [{ type: "text", text: parts.length === 0 ? "(no output)" : parts.join("\n") }];
        },
    });
}
