import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import type { Compute } from "../../Compute.js";
import { readComputeCommand } from "../../impl/readComputeCommand.js";
import { writeComputeCommandInput } from "../../impl/writeComputeCommandInput.js";
import { codexSessionId } from "./impl/codexSessionId.js";
import {
    createUnifiedExecOutput,
    formatUnifiedExecOutput,
    unifiedExecOutputSchema,
} from "./impl/unifiedExecOutput.js";

/** Typing produces an answer almost at once, so the wait after a write is short. */
const DEFAULT_WRITE_WAIT_MS = 250;
const MAXIMUM_WRITE_WAIT_MS = 30_000;

/** A poll is the model choosing to wait, so it may wait far longer than a write does. */
const DEFAULT_POLL_WAIT_MS = 5_000;
const MAXIMUM_POLL_WAIT_MS = 300_000;

/** Codex's own tool for typing into a running session, and for simply waiting on one. */
export function codexWriteStdinTool(compute: Compute) {
    return defineAgentTool({
        name: "write_stdin",
        defer: false,
        capabilities: [
            "Read and modify files, run shell commands, inspect images, and manage background processes.",
        ],
        description:
            "Writes to an existing shell session and returns recent output. Use it for REPLs started by exec_command; end each cell with a newline. Leave chars empty to poll a session without typing anything into it.",
        parameters: Type.Object(
            {
                session_id: Type.Number({
                    description: "Identifier of the running shell session.",
                }),
                chars: Type.Optional(
                    Type.String({
                        description:
                            "Bytes to write to stdin. Defaults to empty, which polls without writing.",
                    }),
                ),
                yield_time_ms: Type.Optional(
                    Type.Number({
                        description:
                            "Wait before yielding output. Non-empty writes default to 250 ms and cap at 30000 ms; empty polls default to 5000 ms and cap at 300000 ms.",
                    }),
                ),
                max_output_tokens: Type.Optional(
                    Type.Number({
                        description:
                            "Output token budget. Defaults to 10000 tokens; larger requests may be capped by policy.",
                    }),
                ),
            },
            { additionalProperties: false },
        ),
        returnType: unifiedExecOutputSchema,
        // Reading a session consumes the output it hands back, so the same call twice would tell
        // the model two different things.
        durable: false,
        describeAutoPermissionAction: ({ chars, session_id }) =>
            `sending ${JSON.stringify(chars ?? "")} to shell session ${String(session_id)}. Access: the session's own input, inside the sandbox it was started in`,
        // Typing into a live program is the program acting, not a lookup, so it is decided on. An
        // empty poll types nothing and only reads work Happy Agent itself started, so it is not. Neither
        // needs elevation: input reaches nothing the session could not already reach.
        shouldReviewInAutoMode: ({ chars }) => chars !== undefined && chars.length > 0,
        execute: async (ctx, { chars, max_output_tokens, session_id, yield_time_ms }) => {
            const commandId = codexSessionId(session_id);
            const typing = chars !== undefined && chars.length > 0;
            const waitMs = Math.max(
                0,
                Math.min(
                    typing ? MAXIMUM_WRITE_WAIT_MS : MAXIMUM_POLL_WAIT_MS,
                    yield_time_ms ?? (typing ? DEFAULT_WRITE_WAIT_MS : DEFAULT_POLL_WAIT_MS),
                ),
            );
            const { snapshot, wallTimeSeconds } = typing
                ? await writeComputeCommandInput(compute, ctx, {
                      commandId,
                      input: chars,
                      waitMs,
                  })
                : await readComputeCommand(compute, ctx, { commandId, waitMs });
            return createUnifiedExecOutput(snapshot, wallTimeSeconds, max_output_tokens);
        },
        isError: (result) => result.exit_code !== undefined && result.exit_code !== 0,
        toLLM: (result) => [{ type: "text", text: formatUnifiedExecOutput(result) }],
    });
}
