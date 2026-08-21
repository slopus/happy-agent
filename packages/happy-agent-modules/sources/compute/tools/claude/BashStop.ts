import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import type { Compute } from "../../Compute.js";
import { stopComputeCommand } from "../../impl/stopComputeCommand.js";
import { parseClaudeBashId } from "./impl/parseClaudeBashId.js";

const exact = { additionalProperties: false } as const;

const CLAUDE_BASH_STOP_DESCRIPTION = `Stop a background shell command started by Bash, along with everything it started.

The command is asked to stop first and forced a moment later. Stopping one that had already ended is not an error; you are simply told it had ended.`;

/** Claude's `BashStop`: end a background shell command and everything it started. */
export function claudeBashStopTool(compute: Compute) {
    return defineAgentTool({
        name: "BashStop",
        description: CLAUDE_BASH_STOP_DESCRIPTION,
        parameters: Type.Object(
            { bash_id: Type.String({ description: "The background shell identifier." }) },
            exact,
        ),
        returnType: Type.Object(
            {
                bash_id: Type.String(),
                command: Type.String(),
                stopped: Type.Boolean({
                    description: "False when the command had already ended by itself.",
                }),
            },
            exact,
        ),
        // Process state cannot commit atomically with the tool result.
        durable: false,
        // Ending work Happy Agent itself started stays inside the machine the agent already has.
        shouldReviewInAutoMode: () => false,
        execute: async (_ctx, { bash_id }) => {
            const commandId = parseClaudeBashId(bash_id);
            const stopped = await stopComputeCommand(compute, { commandId });
            return { bash_id, command: stopped.command, stopped: stopped.stopped };
        },
        toLLM: (result) => [
            {
                type: "text",
                text: result.stopped
                    ? `Stopped background shell ${result.bash_id}: ${result.command}`
                    : `Background shell ${result.bash_id} had already ended: ${result.command}`,
            },
        ],
    });
}
