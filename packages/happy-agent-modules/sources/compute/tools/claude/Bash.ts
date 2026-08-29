import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import { secretIdSchema } from "../../../secrets/index.js";
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

const CLAUDE_BASH_DESCRIPTION = `Executes a bash command in the current working directory and returns its output.

- Environment variables and shell functions do not carry over between commands.
- Prefer the dedicated file and search tools over shell equivalents when one fits.
- \`timeout\` is in milliseconds: default ${String(DEFAULT_TIMEOUT_MS)}, max ${String(MAX_TIMEOUT_MS)}. It is how long you wait, not how long the command may live: a command still running when the wait ends keeps running in the background and comes back with a shell ID.
- \`run_in_background\` starts the command in the background right away, waiting about ${String(COMPUTE_BACKGROUND_GRACE_MS / 1_000)} seconds to see that it did not fall over. Use it for dev servers and watchers. No \`&\` needed.
- Read a background shell with \`BashOutput\`, type into it with \`BashInput\`, and stop it with \`BashStop\`.

# Git
- Interactive flags such as \`git rebase -i\` and \`git add -i\` are not supported.
- Use the \`gh\` CLI for GitHub operations.
- Commit or push only when the user asks.

Happy Agent extensions: \`dangerouslyDisableSandbox\` requests one reviewed Full-access execution in Auto mode; it never bypasses Read only or Workspace write mode. \`secrets\` selects attached secret bundles to expose to this command as environment variables. Secret selection is reviewed separately and stays sandboxed unless \`dangerouslyDisableSandbox\` is also true.

Output is truncated to the last ${String(MAX_CLAUDE_SHELL_OUTPUT_CHARACTERS)} characters.`;

/** Claude's `Bash`: run a command, and hand back a task when it outlives the wait. */
export function claudeBashTool(compute: Compute) {
    return defineAgentTool({
        name: "Bash",
        defer: false,
        capabilities: [
            "Read and modify files, run shell commands, inspect images, and manage background processes.",
        ],
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
                secrets: Type.Optional(
                    Type.Array(secretIdSchema, {
                        description:
                            "IDs of attached secret bundles to expose to this command as environment variables. Choose only what this command needs; use an empty array for none.",
                        maxItems: 256,
                        uniqueItems: true,
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
            "For Bash, request full-access execution with dangerouslyDisableSandbox: true only when the workspace sandbox blocks necessary work. Commands without it remain sandboxed. Put only the attached secret IDs this exact command needs in secrets. Secret provisioning is reviewed separately and does not change the sandbox; secrets and escalation may be used independently or together.",
        describeAutoPermissionAction: ({
            command,
            dangerouslyDisableSandbox,
            description,
            secrets,
        }) =>
            `running ${JSON.stringify(command)} in ${JSON.stringify(compute.cwd)} ${
                dangerouslyDisableSandbox === true
                    ? "outside the workspace sandbox, with unrestricted filesystem and network access"
                    : "inside the current workspace sandbox"
            }${describeSecretSelection(secrets)}${
                description === undefined ? "" : `. Stated purpose: ${description}`
            }`,
        // Secret provisioning and leaving the sandbox are both reviewed. Only the explicit
        // escalation argument widens the command's execution boundary.
        shouldReviewInAutoMode: ({ dangerouslyDisableSandbox, secrets }) =>
            dangerouslyDisableSandbox === true || hasSecrets(secrets),
        shouldRunInFullAccessInAutoMode: ({ dangerouslyDisableSandbox }) =>
            dangerouslyDisableSandbox === true,
        execute: async (ctx, { command, run_in_background, secrets, timeout, tty }) => {
            const { snapshot, wallTimeSeconds } = await startComputeCommand(compute, ctx, {
                command,
                ...(secrets === undefined ? {} : { secrets }),
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

function hasSecrets(secrets: readonly string[] | undefined): boolean {
    return (secrets?.length ?? 0) > 0;
}

function describeSecretSelection(secrets: readonly string[] | undefined): string {
    return hasSecrets(secrets)
        ? `. Secret environment bundles: ${(secrets ?? []).map((id) => JSON.stringify(id)).join(", ")}`
        : ". Secret environment bundles: none";
}
