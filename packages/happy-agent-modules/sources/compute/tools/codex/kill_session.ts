import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import type { Compute } from "../../Compute.js";
import { stopComputeCommand } from "../../impl/stopComputeCommand.js";
import { codexSessionId } from "./impl/codexSessionId.js";

/** Codex's own tool for ending a session and everything it started. */
export function codexKillSessionTool(compute: Compute) {
    return defineAgentTool({
        name: "kill_session",
        defer: false,
        capabilities: [
            "Read and modify files, run shell commands, inspect images, and manage background processes.",
        ],
        description:
            "Stops a running shell session and everything it started. The session is asked to stop first and forced a couple of seconds later. Stopping a session that has already ended is not an error; you are simply told it had ended.",
        parameters: Type.Object(
            {
                session_id: Type.Number({
                    description: "Identifier of the shell session to stop.",
                }),
            },
            { additionalProperties: false },
        ),
        returnType: Type.Object(
            {
                command: Type.String(),
                message: Type.String(),
                session_id: Type.Integer(),
            },
            { additionalProperties: false },
        ),
        // Process state cannot commit atomically with the tool result.
        durable: false,
        // Ending work Happy Agent itself started stays inside the machine the agent already has, so there
        // is nothing here for a reviewer to weigh.
        shouldReviewInAutoMode: () => false,
        execute: async (_ctx, { session_id }) => {
            const commandId = codexSessionId(session_id);
            const stop = await stopComputeCommand(compute, { commandId });
            return {
                command: stop.command,
                message: stop.stopped
                    ? "The shell session was stopped."
                    : "The shell session had already ended by itself.",
                session_id: commandId,
            };
        },
        toLLM: (result) => [
            {
                type: "text",
                text: `${result.message} Session ${String(result.session_id)}: ${result.command}`,
            },
        ],
    });
}
