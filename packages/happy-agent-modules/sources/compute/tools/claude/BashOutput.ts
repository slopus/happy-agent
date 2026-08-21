import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import type { Compute } from "../../Compute.js";
import { readComputeCommand } from "../../impl/readComputeCommand.js";
import { boundClaudeShellOutput } from "./impl/boundClaudeShellOutput.js";
import { parseClaudeBashId } from "./impl/parseClaudeBashId.js";

/** How long a read waits for a command to finish when the model does not say. */
const DEFAULT_TIMEOUT_MS = 30_000;

/** The longest one read may wait before answering with the command still running. */
const MAX_TIMEOUT_MS = 600_000;

const exact = { additionalProperties: false } as const;

const CLAUDE_BASH_OUTPUT_DESCRIPTION = `Read output from a background shell command started by Bash.

Only what the command has produced since your last read comes back; you already have everything before that. Set block to false to look without waiting.`;

/** Claude's `BashOutput`: what a background shell command has said since it was last read. */
export function claudeBashOutputTool(compute: Compute) {
    return defineAgentTool({
        name: "BashOutput",
        description: CLAUDE_BASH_OUTPUT_DESCRIPTION,
        parameters: Type.Object(
            {
                bash_id: Type.String({ description: "The background shell identifier." }),
                block: Type.Optional(
                    Type.Boolean({
                        default: true,
                        description: "Whether to wait for the command to finish.",
                    }),
                ),
                timeout: Type.Optional(
                    Type.Number({
                        description: `Maximum wait in milliseconds. Defaults to ${String(DEFAULT_TIMEOUT_MS)}.`,
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
                retrieval_status: Type.Union([
                    Type.Literal("not_ready"),
                    Type.Literal("success"),
                    Type.Literal("timeout"),
                ]),
            },
            exact,
        ),
        // Reading consumes the output: a second read after a restart would come back empty and
        // lose everything the first one was about to report.
        durable: false,
        // Reading back work Happy Agent itself started stays inside the machine the agent already has.
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, { bash_id, block, timeout }) => {
            const commandId = parseClaudeBashId(bash_id);
            const { snapshot } = await readComputeCommand(compute, ctx, {
                commandId,
                waitMs:
                    block === false ? 0 : Math.min(MAX_TIMEOUT_MS, timeout ?? DEFAULT_TIMEOUT_MS),
            });
            const produced = [snapshot.stdoutDelta, snapshot.stderrDelta]
                .filter((part) => part.length > 0)
                .join("\n");
            const bounded = boundClaudeShellOutput(produced);
            const dropped =
                (snapshot.stdoutDeltaOmittedBytes ?? 0) + (snapshot.stderrDeltaOmittedBytes ?? 0);
            const running = snapshot.status === "running";
            return {
                bash_id,
                command: snapshot.command,
                status: snapshot.status,
                ...(running ? {} : { exitCode: snapshot.exitCode }),
                output: bounded.text,
                truncated: bounded.truncated || dropped > 0,
                retrieval_status: running
                    ? block === false
                        ? ("not_ready" as const)
                        : ("timeout" as const)
                    : ("success" as const),
            };
        },
        toLLM: (result) => {
            const heading =
                result.status === "running"
                    ? `Background shell ${result.bash_id} is still running: ${result.command}`
                    : result.exitCode === null
                      ? `Background shell ${result.bash_id} was stopped: ${result.command}`
                      : `Background shell ${result.bash_id} exited with code ${String(result.exitCode ?? 0)}: ${result.command}`;
            return [
                {
                    type: "text",
                    text: `${heading}\n${result.output.length > 0 ? result.output : "(no new output)"}`,
                },
            ];
        },
    });
}
