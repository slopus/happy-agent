import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import type { Compute } from "../../Compute.js";
import { writeComputeCommandInput } from "../../impl/writeComputeCommandInput.js";
import { boundClaudeShellOutput } from "./impl/boundClaudeShellOutput.js";
import { parseClaudeBashId } from "./impl/parseClaudeBashId.js";

/** How long typing waits for an answer when the model does not say. */
const DEFAULT_TIMEOUT_MS = 250;

/** The longest one answer is waited for; a longer wait belongs to BashOutput. */
const MAX_TIMEOUT_MS = 30_000;

const exact = { additionalProperties: false } as const;

const CLAUDE_BASH_INPUT_DESCRIPTION = `Type into a background shell command started by Bash and read what it prints back.

Use it to answer a prompt, drive a REPL, or interrupt with Ctrl-C ("\\u0003"). End a line with a newline, the way you would when typing. Only the output that arrived since your last read comes back.`;

/** Claude's `BashInput`: type into a background shell command. */
export function claudeBashInputTool(compute: Compute) {
    return defineAgentTool({
        name: "BashInput",
        defer: false,
        capabilities: [
            "Read and modify files, run shell commands, inspect images, and manage background processes.",
        ],
        description: CLAUDE_BASH_INPUT_DESCRIPTION,
        parameters: Type.Object(
            {
                bash_id: Type.String({ description: "The background shell identifier." }),
                input: Type.String({
                    description:
                        'Characters to send. Use "\\u0003" for Ctrl-C, which interrupts without ending the command.',
                }),
                timeout: Type.Optional(
                    Type.Number({
                        default: DEFAULT_TIMEOUT_MS,
                        description: "How long to wait for output afterwards, in milliseconds.",
                        maximum: MAX_TIMEOUT_MS,
                        minimum: 0,
                    }),
                ),
            },
            exact,
        ),
        returnType: Type.Object(
            {
                bash_id: Type.String(),
                command: Type.String(),
                status: Type.Union([
                    Type.Literal("completed"),
                    Type.Literal("killed"),
                    Type.Literal("running"),
                ]),
                exitCode: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
                output: Type.String(),
                truncated: Type.Boolean(),
            },
            exact,
        ),
        // Typing the same characters again is a second instruction to a live program, not a repeat
        // of the first one.
        durable: false,
        describeAutoPermissionAction: ({ input, bash_id }) =>
            `sending ${JSON.stringify(input)} to background shell ${bash_id}. Access: the shell's existing execution boundary${
                sessionHasSecrets(compute, bash_id)
                    ? ". Selected secret environment variables are present in the process"
                    : ""
            }`,
        // Typing into a live program is new instruction reaching something already running, so it
        // is decided on without changing the boundary the process started under.
        shouldReviewInAutoMode: ({ input }) => input.length > 0,
        execute: async (ctx, { bash_id, input, timeout }) => {
            const commandId = parseClaudeBashId(bash_id);
            const { snapshot } = await writeComputeCommandInput(compute, ctx, {
                commandId,
                input,
                waitMs: Math.max(0, Math.min(MAX_TIMEOUT_MS, timeout ?? DEFAULT_TIMEOUT_MS)),
            });
            const produced = [snapshot.stdoutDelta, snapshot.stderrDelta]
                .filter((part) => part.length > 0)
                .join("\n");
            const bounded = boundClaudeShellOutput(produced);
            const dropped =
                (snapshot.stdoutDeltaOmittedBytes ?? 0) + (snapshot.stderrDeltaOmittedBytes ?? 0);
            return {
                bash_id,
                command: snapshot.command,
                status: snapshot.status,
                ...(snapshot.status === "running" ? {} : { exitCode: snapshot.exitCode }),
                output: bounded.text,
                truncated: bounded.truncated || dropped > 0,
            };
        },
        toLLM: (result) => [
            {
                type: "text",
                text: `${
                    result.status === "running"
                        ? `Background shell ${result.bash_id} is still running.`
                        : `Background shell ${result.bash_id} has finished.`
                }\n${result.output.length > 0 ? result.output : "(no new output)"}`,
            },
        ],
    });
}

function sessionHasSecrets(compute: Compute, bashId: string): boolean {
    try {
        return compute.shell.sessionUsesSecrets?.(parseClaudeBashId(bashId)) === true;
    } catch {
        return false;
    }
}
