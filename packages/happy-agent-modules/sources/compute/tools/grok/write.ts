import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import type { Compute } from "../../Compute.js";
import { computeFileDiffPresentationSchema } from "../../ComputeToolPresentation.js";
import { describeComputePathAction } from "../../impl/describeComputePathAction.js";
import type { FileReadLog } from "../../../impl/FileReadLog.js";
import { shouldReviewComputePath } from "../../impl/shouldReviewComputePath.js";
import { writeComputeTextFile } from "../../impl/writeComputeTextFile.js";

/** Grok's `write`: create a file, or replace one whole. */
export function grokWriteTool(compute: Compute, reads: FileReadLog) {
    return defineAgentTool({
        name: "write",
        defer: false,
        capabilities: [
            "Read and modify files, run shell commands, inspect images, and manage background processes.",
        ],
        description: `Create or overwrite a file.

- Writing to an existing path replaces the file.
- Parent directories are created for you.
- Prefer search_replace for changing part of a file; this tool is for new files and complete rewrites.`,
        parameters: Type.Object(
            {
                file_path: Type.String({
                    description: "The absolute path to the file to write.",
                }),
                content: Type.String({ description: "The full file content to write." }),
                sandbox_permissions: Type.Optional(
                    Type.Union([Type.Literal("use_default"), Type.Literal("require_escalated")], {
                        description:
                            "Request reviewed Full access for this write in Auto mode. Protected and outside-workspace paths are also reviewed automatically when omitted.",
                    }),
                ),
                description: Type.Optional(
                    Type.String({
                        description:
                            "Concise user-facing reason why sandbox escalation is needed. Use only with require_escalated.",
                    }),
                ),
            },
            { additionalProperties: false },
        ),
        returnType: Type.Object(
            {
                path: Type.String(),
                created: Type.Boolean(),
                characters: Type.Integer(),
                presentation: computeFileDiffPresentationSchema,
            },
            { additionalProperties: false },
        ),
        // The filesystem write cannot commit atomically with the tool result.
        durable: false,
        autoPermissionInstructions:
            'For write, request reviewed Full access for this file change with sandbox_permissions: "require_escalated" and explain why in description. Protected and outside-workspace paths are also reviewed automatically without the flag. Approval elevates only this call; Read only and Workspace write never elevate.',
        describeAutoPermissionAction: ({ file_path, sandbox_permissions, description }) =>
            describeComputePathAction(compute, file_path, "writing", {
                write: true,
                fullAccess: sandbox_permissions === "require_escalated",
                ...(description === undefined ? {} : { reason: description }),
            }),
        shouldReviewInAutoMode: ({ file_path, sandbox_permissions }, ctx) =>
            sandbox_permissions === "require_escalated" ||
            shouldReviewComputePath(compute, file_path, { write: true }, ctx),
        shouldRunInFullAccessInAutoMode: ({ file_path, sandbox_permissions }, ctx) =>
            sandbox_permissions === "require_escalated" ||
            shouldReviewComputePath(compute, file_path, { write: true }, ctx),
        execute: async (ctx, { file_path, content }) =>
            await writeComputeTextFile(compute, reads, ctx, { path: file_path, content }),
        toLLM: (result) => [
            {
                type: "text",
                text: `${result.created ? "Created" : "Replaced"} ${result.path} (${String(result.characters)} characters).`,
            },
        ],
    });
}
