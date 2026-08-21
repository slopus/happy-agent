import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import type { Compute } from "../../Compute.js";
import { describeComputePathAction } from "../../impl/describeComputePathAction.js";
import type { FileReadLog } from "../../../impl/FileReadLog.js";
import { shouldReviewComputePath } from "../../impl/shouldReviewComputePath.js";
import { writeComputeTextFile } from "../../impl/writeComputeTextFile.js";

/** Grok's `write`: create a file, or replace one whole. */
export function grokWriteTool(compute: Compute, reads: FileReadLog) {
    return defineAgentTool({
        name: "write",
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
            },
            { additionalProperties: false },
        ),
        returnType: Type.Object({
            path: Type.String(),
            created: Type.Boolean(),
            characters: Type.Integer(),
        }),
        // The filesystem write cannot commit atomically with the tool result.
        durable: false,
        describeAutoPermissionAction: ({ file_path }) =>
            describeComputePathAction(compute, file_path, "writing", { write: true }),
        shouldReviewInAutoMode: ({ file_path }, ctx) =>
            shouldReviewComputePath(compute, file_path, { write: true }, ctx),
        shouldRunInFullAccessInAutoMode: ({ file_path }, ctx) =>
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
