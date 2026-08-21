import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import type { Compute } from "../../Compute.js";
import { stopComputeCommand } from "../../impl/stopComputeCommand.js";
import { parseGrokTaskId } from "./impl/parseGrokTaskId.js";

/** Grok's `kill_command_or_subagent`, scoped here to the background commands this machine runs. */
export function grokKillCommandOrSubagentTool(compute: Compute) {
    return defineAgentTool({
        name: "kill_command_or_subagent",
        description: `Terminate a running background command by task ID.

Usage notes:
- The command is asked to stop first and forced a moment later, along with everything it started.
- Stopping a command that had already ended is not an error; you are simply told it had ended.
- This machine runs commands, so a subagent's task ID is not something it can stop.`,
        parameters: Type.Object(
            { task_id: Type.String({ description: "The task ID to terminate." }) },
            { additionalProperties: false },
        ),
        returnType: Type.Object({
            task_id: Type.String(),
            command: Type.Optional(Type.String()),
            outcome: Type.Union([
                Type.Literal("stopped"),
                Type.Literal("already_ended"),
                Type.Literal("not_found"),
            ]),
            message: Type.String(),
        }),
        // Process state cannot commit atomically with the tool result.
        durable: false,
        // Ending work Happy Agent itself started stays inside the machine the agent already has.
        shouldReviewInAutoMode: () => false,
        execute: async (_ctx, { task_id }) => {
            const commandId = parseGrokTaskId(task_id);
            let stop;
            try {
                stop = await stopComputeCommand(compute, { commandId });
            } catch {
                return {
                    task_id,
                    outcome: "not_found" as const,
                    message: `Task ${task_id} is not a background command on this machine.`,
                };
            }
            return stop.stopped
                ? {
                      task_id,
                      command: stop.command,
                      outcome: "stopped" as const,
                      message: `Stopped task ${task_id}: ${stop.command}`,
                  }
                : {
                      task_id,
                      command: stop.command,
                      outcome: "already_ended" as const,
                      message: `Task ${task_id} had already ended: ${stop.command}`,
                  };
        },
        toLLM: (result) => [{ type: "text", text: result.message }],
    });
}
