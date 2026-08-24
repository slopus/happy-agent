import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import type { Compute } from "../../Compute.js";
import { boundOutputText } from "../../impl/boundOutputText.js";
import {
    COMPUTE_BACKGROUND_GRACE_MS,
    startComputeCommand,
} from "../../impl/startComputeCommand.js";

/** How long a foreground command is waited for when the model does not say. */
const DEFAULT_TIMEOUT_MS = 120_000;

/** The longest wait a model may ask for. Beyond this it should background the command instead. */
const MAX_TIMEOUT_MS = 300_000;

/** How much of a command's output one answer may carry. */
const MAX_OUTPUT_CHARACTERS = 40_000;

/** Grok's `run_terminal_command`: run a bash command, and leave it running when it outlasts the wait. */
export function grokRunTerminalCommandTool(compute: Compute) {
    return defineAgentTool({
        name: "run_terminal_command",
        defer: false,
        capabilities: [
            "Read and modify files, run shell commands, inspect images, and manage background processes.",
        ],
        description: `Run a bash command in the current working directory and return its output.

Usage notes:
- You can specify an optional timeout in milliseconds, up to ${String(MAX_TIMEOUT_MS)}. If not specified, foreground commands wait ${String(DEFAULT_TIMEOUT_MS)}ms. The timeout is how long you wait, not how long the command may live: a command still running when the wait ends keeps running and comes back with a task_id.
- Use background for long-running commands such as development servers and long builds. It waits about ${String(COMPUTE_BACKGROUND_GRACE_MS / 1_000)} seconds to see that the command did not fall over; do not add '&' to the command.
- Read a background command with get_command_or_subagent_output, type into it with send_command_input, and stop it with kill_command_or_subagent.
- Environment variables and shell functions do not carry over between commands.
- Output may be truncated before it is returned.`,
        parameters: Type.Object(
            {
                command: Type.String({ description: "The bash command to run." }),
                description: Type.String({
                    description:
                        "One sentence explaining why this command needs to run and how it contributes to the goal.",
                }),
                background: Type.Optional(
                    Type.Boolean({
                        description:
                            "Set true for a long-running command. Returns a task_id while the command continues in the background. Defaults to false.",
                    }),
                ),
                timeout: Type.Optional(
                    Type.Integer({
                        description: `Optional timeout in milliseconds (max ${String(MAX_TIMEOUT_MS)}). Defaults to ${String(DEFAULT_TIMEOUT_MS)}. A timeout of 0 means the default.`,
                        maximum: MAX_TIMEOUT_MS,
                        minimum: 0,
                    }),
                ),
                tty: Type.Optional(
                    Type.Boolean({
                        description:
                            "Run the command under a terminal, for programs that behave differently without one. Defaults to false.",
                    }),
                ),
                sandbox_permissions: Type.Optional(
                    Type.Union([Type.Literal("use_default"), Type.Literal("require_escalated")], {
                        description:
                            "Request reviewed execution outside the workspace sandbox in Auto mode. Defaults to use_default.",
                    }),
                ),
            },
            { additionalProperties: false },
        ),
        returnType: Type.Object({
            text: Type.String(),
            task_id: Type.Optional(Type.String()),
        }),
        // Running a command changes the machine, so it cannot be replayed after a restart.
        durable: false,
        autoPermissionInstructions:
            'For run_terminal_command, request full-access execution with sandbox_permissions: "require_escalated" and say in the description why the sandbox has to be left. Keep sandbox_permissions at "use_default" or omit it for ordinary commands, which stay sandboxed.',
        describeAutoPermissionAction: ({ command, description, sandbox_permissions }) =>
            `running ${JSON.stringify(command)} in ${JSON.stringify(compute.cwd)} ${
                sandbox_permissions === "require_escalated"
                    ? "outside the workspace sandbox, with unrestricted filesystem and network access"
                    : "inside the current workspace sandbox"
            }. Reason given: ${description}`,
        // A sandboxed command is the ordinary case and needs no reviewer; leaving the sandbox is
        // the whole of what one is asked about here, and the reason travels in the description.
        shouldReviewInAutoMode: ({ sandbox_permissions }) =>
            sandbox_permissions === "require_escalated",
        shouldRunInFullAccessInAutoMode: ({ sandbox_permissions }) =>
            sandbox_permissions === "require_escalated",
        execute: async (ctx, { command, background, timeout, tty }) => {
            const outcome = await startComputeCommand(compute, ctx, {
                command,
                ...(background === undefined ? {} : { background }),
                ...(tty === undefined ? {} : { tty }),
                waitMs: timeout === undefined || timeout === 0 ? DEFAULT_TIMEOUT_MS : timeout,
            });
            const { snapshot } = outcome;
            const dropped =
                (snapshot.stdoutDeltaOmittedBytes ?? 0) + (snapshot.stderrDeltaOmittedBytes ?? 0);
            const bounded = boundOutputText(
                [snapshot.stdoutDelta, snapshot.stderrDelta]
                    .filter((part) => part.length > 0)
                    .join("\n"),
                { maxCharacters: MAX_OUTPUT_CHARACTERS, keep: "tail" },
            );
            const output =
                dropped === 0
                    ? bounded.text
                    : `[The machine dropped ${String(dropped)} bytes of this command's output as it ran.]\n${bounded.text}`;
            if (snapshot.status === "running") {
                const taskId = String(snapshot.sessionId);
                return {
                    task_id: taskId,
                    text: [
                        output,
                        `Command still running in the background with task_id ${taskId}. Read it with get_command_or_subagent_output, type into it with send_command_input, or stop it with kill_command_or_subagent.`,
                    ]
                        .filter((part) => part.length > 0)
                        .join("\n\n"),
                };
            }
            const text = output.length > 0 ? output : "(no output)";
            if (snapshot.exitCode !== null && snapshot.exitCode !== 0) {
                throw new Error(
                    `${text}\n\nCommand exited with code ${String(snapshot.exitCode)}.`,
                );
            }
            return { text };
        },
        toLLM: (result) => [{ type: "text", text: result.text }],
    });
}
