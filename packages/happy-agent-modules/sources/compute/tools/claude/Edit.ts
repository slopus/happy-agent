import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import type { Compute } from "../../Compute.js";
import { computeFileDiffPresentationSchema } from "../../ComputeToolPresentation.js";
import { describeComputePathAction } from "../../impl/describeComputePathAction.js";
import { editComputeText } from "../../impl/editComputeText.js";
import type { FileReadLog } from "../../../impl/FileReadLog.js";
import { shouldReviewComputePath } from "../../impl/shouldReviewComputePath.js";

const exact = { additionalProperties: false } as const;

// Read numbers a line as the number, a tab, then the line, so that is what the model is told to
// strip. Describing a prefix it will not actually see is how an exact-match edit fails for a
// reason nobody can find.
const CLAUDE_EDIT_DESCRIPTION = `Performs exact string replacements in files.

Usage:
- When editing text from Read tool output, ensure you preserve the exact indentation (tabs/spaces) as it appears AFTER the line number prefix. The line number prefix format is: line number + tab. Everything after that is the actual file content to match. Never include any part of the line number prefix in the old_string or new_string.
- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.
- Only use emojis if the user explicitly requests it. Avoid adding emojis to files unless asked.
- The edit will FAIL if \`old_string\` is not unique in the file. Either provide a larger string with more surrounding context to make it unique or use \`replace_all\` to change every instance of \`old_string\`.
- Use \`replace_all\` for replacing and renaming strings across the file. This parameter is useful if you want to rename a variable for instance.`;

/** Claude's `Edit`: replace exact text inside a file. */
export function claudeEditTool(compute: Compute, reads: FileReadLog) {
    return defineAgentTool({
        name: "Edit",
        defer: false,
        capabilities: [
            "Read and modify files, run shell commands, inspect images, and manage background processes.",
        ],
        description: CLAUDE_EDIT_DESCRIPTION,
        parameters: Type.Object(
            {
                file_path: Type.String({ description: "The absolute path to the file to modify" }),
                old_string: Type.String({ description: "The text to replace" }),
                new_string: Type.String({
                    description: "The text to replace it with (must be different from old_string)",
                }),
                replace_all: Type.Optional(
                    Type.Boolean({
                        default: false,
                        description: "Replace all occurrences of old_string (default false)",
                    }),
                ),
            },
            exact,
        ),
        returnType: Type.Object(
            {
                path: Type.String(),
                replacements: Type.Integer(),
                presentation: computeFileDiffPresentationSchema,
            },
            exact,
        ),
        // The same edit run twice matches different text the second time, so a replay after a
        // restart would not be the change the model asked for.
        durable: false,
        describeAutoPermissionAction: ({ file_path }) =>
            describeComputePathAction(compute, file_path, "editing", { write: true }),
        shouldReviewInAutoMode: ({ file_path }, ctx) =>
            shouldReviewComputePath(compute, file_path, { write: true }, ctx),
        shouldRunInFullAccessInAutoMode: ({ file_path }, ctx) =>
            shouldReviewComputePath(compute, file_path, { write: true }, ctx),
        execute: async (ctx, { file_path, old_string, new_string, replace_all }) =>
            await editComputeText(compute, reads, ctx, {
                path: file_path,
                oldText: old_string,
                newText: new_string,
                ...(replace_all === undefined ? {} : { replaceAll: replace_all }),
            }),
        toLLM: (result) => [{ type: "text", text: `The file ${result.path} has been updated.` }],
    });
}
