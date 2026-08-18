import { Type } from "@sinclair/typebox";
import { agentPermissionMode, defineAgentTool } from "@slopus/happy-agent-base";

import type { Compute } from "../../Compute.js";
import { describeComputePathAction } from "../../impl/describeComputePathAction.js";
import type { FileReadLog } from "../../impl/FileReadLog.js";
import { shouldReviewComputePath } from "../../impl/shouldReviewComputePath.js";
import { writeComputeTextFile } from "../../impl/writeComputeTextFile.js";

const exact = { additionalProperties: false } as const;

const CLAUDE_WRITE_DESCRIPTION = `Writes a file to the local filesystem.

Usage:
- This tool will overwrite the existing file if there is one at the provided path.
- If this is an existing file, you MUST use the Read tool first to read the file's contents. This tool will fail if you did not read the file first.
- Prefer the Edit tool for modifying existing files -- it only sends the diff. Only use this tool to create new files or for complete rewrites.
- NEVER create documentation files (*.md) or README files unless explicitly requested by the User.
- Only use emojis if the user explicitly requests it. Avoid writing emojis to files unless asked.`;

/** Claude's `Write`: create a file, or replace one the agent has already read. */
export function claudeWriteTool(compute: Compute, reads: FileReadLog) {
    return defineAgentTool({
        name: "Write",
        description: CLAUDE_WRITE_DESCRIPTION,
        parameters: Type.Object(
            {
                file_path: Type.String({
                    description:
                        "The absolute path to the file to write (must be absolute, not relative)",
                }),
                content: Type.String({ description: "The content to write to the file" }),
            },
            exact,
        ),
        returnType: Type.Object(
            {
                path: Type.String(),
                created: Type.Boolean(),
                characters: Type.Integer(),
            },
            exact,
        ),
        // A file on disk cannot be rolled back with the tool result, so replaying this call after a
        // restart would overwrite whatever happened in between.
        durable: false,
        describeAutoPermissionAction: ({ file_path }) =>
            describeComputePathAction(compute, file_path, "writing", { write: true }),
        shouldReviewInAutoMode: ({ file_path }, ctx) =>
            shouldReviewComputePath(compute, file_path, { write: true }, ctx),
        shouldRunInFullAccessInAutoMode: ({ file_path }, ctx) =>
            shouldReviewComputePath(compute, file_path, { write: true }, ctx),
        execute: async (ctx, { file_path, content }) =>
            await writeComputeTextFile(compute, reads, ctx, {
                path: file_path,
                content,
                allowUnread: agentPermissionMode(ctx) === "full_access",
            }),
        toLLM: (result) => [
            {
                type: "text",
                text: `File ${result.created ? "created" : "updated"} successfully at: ${result.path}`,
            },
        ],
    });
}
