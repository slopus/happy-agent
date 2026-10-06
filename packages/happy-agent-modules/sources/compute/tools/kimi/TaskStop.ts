import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";
import type { Compute } from "../../Compute.js";
import { stopComputeCommand } from "../../impl/stopComputeCommand.js";
import { parseKimiTaskId } from "./impl/kimiTaskResult.js";

export function kimiTaskStopTool(compute: Compute) {
    return defineAgentTool({
        name: "TaskStop",
        defer: false,
        description:
            "Stop a background shell task and its process tree. Shutdown is requested first, then forced after the normal grace period. Use only when the task must be cancelled. A task that already ended returns stopped: false. This manages shell tasks only.",
        parameters: Type.Object(
            { task_id: Type.String({ description: "The background shell task ID to stop." }) },
            { additionalProperties: false },
        ),
        returnType: Type.Object(
            { task_id: Type.String(), stopped: Type.Boolean() },
            { additionalProperties: false },
        ),
        durable: false,
        shouldReviewInAutoMode: () => false,
        execute: async (_ctx, args) => ({
            task_id: args.task_id,
            stopped: (
                await stopComputeCommand(compute, { commandId: parseKimiTaskId(args.task_id) })
            ).stopped,
        }),
        toLLM: (result) => [
            {
                type: "text",
                text: result.stopped
                    ? `Stopped shell task ${result.task_id}.`
                    : `Shell task ${result.task_id} had already ended.`,
            },
        ],
    });
}
