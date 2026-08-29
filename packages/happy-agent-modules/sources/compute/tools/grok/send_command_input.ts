import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import type { Compute } from "../../Compute.js";
import { boundOutputText } from "../../impl/boundOutputText.js";
import { writeComputeCommandInput } from "../../impl/writeComputeCommandInput.js";
import { parseGrokTaskId } from "./impl/parseGrokTaskId.js";

/** How long to wait for an answer after typing, when the model does not say. */
const DEFAULT_TIMEOUT_MS = 250;

/** The longest one call may wait for what it typed to produce something. */
const MAX_TIMEOUT_MS = 30_000;

/** How much of what came back one answer may carry. */
const MAX_OUTPUT_CHARACTERS = 40_000;

/** Grok's `send_command_input`: type into a running background command and read what it says back. */
export function grokSendCommandInputTool(compute: Compute) {
    return defineAgentTool({
        name: "send_command_input",
        defer: false,
        capabilities: [
            "Read and modify files, run shell commands, inspect images, and manage background processes.",
        ],
        description: `Type into a running background command and read what it prints back.

Use it to answer a prompt, drive a REPL, or interrupt with Ctrl-C ("\\u0003"). End a line with a newline, the way you would when typing. Only the output that arrived since your last read comes back.`,
        parameters: Type.Object(
            {
                task_id: Type.String({
                    description: "Task ID of the running background command.",
                }),
                input: Type.String({
                    description:
                        'Characters to send. Use "\\u0003" for Ctrl-C, which interrupts without ending the command.',
                }),
                timeout_ms: Type.Optional(
                    Type.Integer({
                        description: `How long to wait for output afterwards. Defaults to ${String(DEFAULT_TIMEOUT_MS)}ms.`,
                        maximum: MAX_TIMEOUT_MS,
                        minimum: 0,
                    }),
                ),
            },
            { additionalProperties: false },
        ),
        returnType: Type.Object({
            task_id: Type.String(),
            status: Type.String(),
            exit_code: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
            output: Type.String(),
            truncated: Type.Boolean(),
        }),
        // Typing consumes the output it returns, so repeating the call after a restart would type
        // twice and answer with nothing.
        durable: false,
        describeAutoPermissionAction: ({ input, task_id }) =>
            `sending ${JSON.stringify(input)} to background command ${task_id}. Access: the command's existing execution boundary${
                sessionHasSecrets(compute, task_id)
                    ? ". Selected secret environment variables are present in the process"
                    : ""
            }`,
        // Typing into a live program is the program acting, not a lookup, so it is decided on; it
        // does not change the boundary the process started under, whether or not it carries secrets.
        shouldReviewInAutoMode: ({ input }) => input.length > 0,
        execute: async (ctx, { task_id, input, timeout_ms }) => {
            const commandId = parseGrokTaskId(task_id);
            const { snapshot } = await writeComputeCommandInput(compute, ctx, {
                commandId,
                input,
                waitMs: Math.min(MAX_TIMEOUT_MS, timeout_ms ?? DEFAULT_TIMEOUT_MS),
            });
            const bounded = boundOutputText(
                [snapshot.stdoutDelta, snapshot.stderrDelta]
                    .filter((part) => part.length > 0)
                    .join("\n"),
                { maxCharacters: MAX_OUTPUT_CHARACTERS, keep: "tail" },
            );
            return {
                task_id,
                status: snapshot.status,
                ...(snapshot.status === "running" ? {} : { exit_code: snapshot.exitCode }),
                output: bounded.text,
                truncated: bounded.truncated,
            };
        },
        toLLM: (result) => [
            {
                type: "text",
                text: [
                    result.status === "running"
                        ? `Task ${result.task_id} is still running.`
                        : result.exit_code === null || result.exit_code === undefined
                          ? `Task ${result.task_id} has ended without an exit code, which is what a stopped command looks like.`
                          : `Task ${result.task_id} has ended with exit code ${String(result.exit_code)}.`,
                    result.output.length > 0 ? result.output : "(no new output)",
                ].join("\n"),
            },
        ],
    });
}

function sessionHasSecrets(compute: Compute, taskId: string): boolean {
    try {
        return compute.shell.sessionUsesSecrets?.(parseGrokTaskId(taskId)) === true;
    } catch {
        return false;
    }
}
