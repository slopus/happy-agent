import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import type { Compute } from "../../Compute.js";
import { computeFileDiffPresentationSchema } from "../../ComputeToolPresentation.js";
import { describeComputePathAction } from "../../impl/describeComputePathAction.js";
import { editComputeText } from "../../impl/editComputeText.js";
import type { FileReadLog } from "../../../impl/FileReadLog.js";
import { shouldReviewComputePath } from "../../impl/shouldReviewComputePath.js";

/** Grok's `search_replace`: replace exact text inside a file. */
export function grokSearchReplaceTool(compute: Compute, reads: FileReadLog) {
    return defineAgentTool({
        name: "search_replace",
        defer: false,
        capabilities: [
            "Read and modify files, run shell commands, inspect images, and manage background processes.",
        ],
        description: `Replace an exact string in a file.

- read_file prefixes each line with "LINE_NUMBER→". That prefix is not part of the file: match only what comes after the →, with its exact indentation.
- old_string must match exactly one place in the file. If it appears more than once, add surrounding lines to make it unique, or set replace_all to change every occurrence.`,
        parameters: Type.Object(
            {
                file_path: Type.String({
                    description:
                        "The path to the file to modify. You can use a relative path in the workspace or an absolute path.",
                }),
                old_string: Type.String({ description: "The text to replace." }),
                new_string: Type.String({
                    description: "The text to replace it with. It must differ from old_string.",
                }),
                replace_all: Type.Optional(
                    Type.Boolean({
                        description: "Replace all occurrences of old_string. Defaults to false.",
                    }),
                ),
            },
            { additionalProperties: false },
        ),
        returnType: Type.Object(
            {
                path: Type.String(),
                replacements: Type.Integer(),
                presentation: computeFileDiffPresentationSchema,
            },
            { additionalProperties: false },
        ),
        // The filesystem write cannot commit atomically with the tool result, and a repeated edit
        // would match different text the second time.
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
        toLLM: (result) => [
            {
                type: "text",
                text: `Successfully replaced ${String(result.replacements)} occurrence${result.replacements === 1 ? "" : "s"} in ${result.path}.`,
            },
        ],
    });
}
