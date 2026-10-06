import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";
import type { Compute } from "../../Compute.js";
import { writeComputeCommandInput } from "../../impl/writeComputeCommandInput.js";
import { kimiTaskResult, kimiTaskResultSchema, parseKimiTaskId } from "./impl/kimiTaskResult.js";

export function kimiTaskInputTool(compute: Compute) {
    return defineAgentTool({
        name: "TaskInput",
        defer: false,
        capabilities: [
            "Read and modify files, run shell commands, inspect images, and manage background processes.",
        ],
        description:
            "Happy extension: send characters to a running shell task and collect new output. End a line with a newline; use \\u0003 for Ctrl-C. timeout is a wait in milliseconds, default 250, maximum 30000. Input is reviewed and stays inside the process's existing boundary, including its selected secret environment.",
        parameters: Type.Object(
            {
                task_id: Type.String(),
                input: Type.String(),
                timeout: Type.Optional(Type.Integer({ minimum: 0, maximum: 30000 })),
            },
            { additionalProperties: false },
        ),
        returnType: kimiTaskResultSchema,
        durable: false,
        describeAutoPermissionAction: (args) =>
            `Sending ${JSON.stringify(args.input)} to shell task ${args.task_id} inside its existing execution boundary${compute.shell.sessionUsesSecrets?.(parseKimiTaskId(args.task_id)) === true ? "; selected secret environment variables are present" : ""}.`,
        shouldReviewInAutoMode: (args) => args.input.length > 0,
        execute: async (ctx, args) =>
            kimiTaskResult(
                (
                    await writeComputeCommandInput(compute, ctx, {
                        commandId: parseKimiTaskId(args.task_id),
                        input: args.input,
                        waitMs: args.timeout ?? 250,
                    })
                ).snapshot,
            ),
        toLLM: (result) => [
            {
                type: "text",
                text: `Shell task ${result.task_id}: ${result.status}.\n${result.output || "(no new output)"}`,
            },
        ],
    });
}
