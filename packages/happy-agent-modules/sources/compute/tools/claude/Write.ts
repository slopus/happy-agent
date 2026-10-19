import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import type { Compute } from "../../Compute.js";
import { computeFileDiffPresentationSchema } from "../../ComputeToolPresentation.js";
import { describeComputePathAction } from "../../impl/describeComputePathAction.js";
import type { FileReadLog } from "../../../impl/FileReadLog.js";
import { shouldReviewComputePath } from "../../impl/shouldReviewComputePath.js";
import { writeComputeTextFile } from "../../impl/writeComputeTextFile.js";

const exact = { additionalProperties: false } as const;

// Claude Code's wording, without its prior-Read requirement for overwriting.
const CLAUDE_WRITE_DESCRIPTION = `Writes a file to the local filesystem, overwriting if one exists.

When to use: creating a new file, or fully replacing one. For partial changes, use Edit instead.`;

/** Claude's `Write`: create a file or replace one whole. */
export function claudeWriteTool(compute: Compute, reads: FileReadLog) {
    return defineAgentTool({
        name: "Write",
        defer: false,
        capabilities: [
            "Read and modify files, run shell commands, inspect images, and manage background processes.",
        ],
        description: CLAUDE_WRITE_DESCRIPTION,
        parameters: Type.Object(
            {
                file_path: Type.String({
                    description:
                        "The absolute path to the file to write (must be absolute, not relative)",
                }),
                content: Type.String({ description: "The content to write to the file" }),
                dangerouslyDisableSandbox: Type.Optional(
                    Type.Boolean({
                        description:
                            "Request reviewed Full access for this write in Auto mode. Protected and outside-workspace paths are also reviewed automatically when omitted.",
                    }),
                ),
            },
            exact,
        ),
        returnType: Type.Object(
            {
                path: Type.String(),
                created: Type.Boolean(),
                characters: Type.Integer(),
                presentation: computeFileDiffPresentationSchema,
            },
            exact,
        ),
        // A file on disk cannot be rolled back with the tool result, so replaying this call after a
        // restart would overwrite whatever happened in between.
        durable: false,
        autoPermissionInstructions:
            "For Write, request reviewed Full access for this file change with dangerouslyDisableSandbox: true. Protected and outside-workspace paths are also reviewed automatically without the flag. Approval elevates only this call; Read only and Workspace write never elevate.",
        describeAutoPermissionAction: ({ file_path, dangerouslyDisableSandbox }) =>
            describeComputePathAction(compute, file_path, "writing", {
                write: true,
                fullAccess: dangerouslyDisableSandbox === true,
            }),
        shouldReviewInAutoMode: ({ file_path, dangerouslyDisableSandbox }, ctx) =>
            dangerouslyDisableSandbox === true ||
            shouldReviewComputePath(compute, file_path, { write: true }, ctx),
        shouldRunInFullAccessInAutoMode: ({ file_path, dangerouslyDisableSandbox }, ctx) =>
            dangerouslyDisableSandbox === true ||
            shouldReviewComputePath(compute, file_path, { write: true }, ctx),
        execute: async (ctx, { file_path, content }) =>
            await writeComputeTextFile(compute, reads, ctx, { path: file_path, content }),
        toLLM: (result) => [
            {
                type: "text",
                text: `File ${result.created ? "created" : "updated"} successfully at: ${result.path}`,
            },
        ],
    });
}
