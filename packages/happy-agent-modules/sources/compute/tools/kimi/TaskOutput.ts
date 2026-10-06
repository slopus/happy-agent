import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";
import type { Compute } from "../../Compute.js";
import { readComputeCommand } from "../../impl/readComputeCommand.js";
import { kimiTaskResult, kimiTaskResultSchema, parseKimiTaskId } from "./impl/kimiTaskResult.js";

export function kimiTaskOutputTool(compute: Compute) {
    return defineAgentTool({
        name: "TaskOutput",
        defer: false,
        description:
            "Read the current status and new output of a shell task started by Bash. Always non-blocking. Completion is reported automatically; use this for a progress check you will act on. Only output since the previous read is returned, bounded to 60000 characters. This tool manages shell tasks only; no full-log output_path is provided.",
        parameters: Type.Object(
            { task_id: Type.String({ description: "The background shell task ID to inspect." }) },
            { additionalProperties: false },
        ),
        returnType: kimiTaskResultSchema,
        durable: false,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, args) =>
            kimiTaskResult(
                (
                    await readComputeCommand(compute, ctx, {
                        commandId: parseKimiTaskId(args.task_id),
                        waitMs: 0,
                    })
                ).snapshot,
            ),
        toLLM: (result) => [
            {
                type: "text",
                text: `Shell task ${result.task_id}: ${result.status}${result.exit_code === undefined ? "" : `; exit code ${result.exit_code}`}.\n${result.output || "(no new output)"}`,
            },
        ],
    });
}
