import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import type { Compute } from "../../Compute.js";
import { computeFileDiffPresentationSchema } from "../../ComputeToolPresentation.js";
import { describeComputePathAction } from "../../impl/describeComputePathAction.js";
import { editComputeText } from "../../impl/editComputeText.js";
import type { FileReadLog } from "../../../impl/FileReadLog.js";
import { shouldReviewComputePath } from "../../impl/shouldReviewComputePath.js";

const exact = { additionalProperties: false } as const;

// Claude Code's wording, without its prior-Read requirement: Happy Agent lets an edit through
// whenever its text matches the file as it is now.
const CLAUDE_EDIT_DESCRIPTION = `Performs exact string replacement in a file.

- \`old_string\` must match the file exactly, including indentation, and be unique — the edit fails otherwise. Strip the Read line prefix (line number + tab) before matching.
- \`replace_all: true\` replaces every occurrence instead.`;

// Claude Code's own wording for an edit applied to a file that changed after it was read.
const STALE_RECOVERED_NOTE =
    " (note: the file had been modified on disk since you last read it — the edit applied cleanly, but the file contains other changes not in your context. Read it before edits that depend on surrounding content.)";

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
                dangerouslyDisableSandbox: Type.Optional(
                    Type.Boolean({
                        description:
                            "Request reviewed Full access for this edit in Auto mode. Protected and outside-workspace paths are also reviewed automatically when omitted.",
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
                staleRecovered: Type.Optional(Type.Literal(true)),
            },
            exact,
        ),
        // The same edit run twice matches different text the second time, so a replay after a
        // restart would not be the change the model asked for.
        durable: false,
        autoPermissionInstructions:
            "For Edit, request reviewed Full access for this file change with dangerouslyDisableSandbox: true. Protected and outside-workspace paths are also reviewed automatically without the flag. Approval elevates only this call; Read only and Workspace write never elevate.",
        describeAutoPermissionAction: ({ file_path, dangerouslyDisableSandbox }) =>
            describeComputePathAction(compute, file_path, "editing", {
                write: true,
                fullAccess: dangerouslyDisableSandbox === true,
            }),
        shouldReviewInAutoMode: ({ file_path, dangerouslyDisableSandbox }, ctx) =>
            dangerouslyDisableSandbox === true ||
            shouldReviewComputePath(compute, file_path, { write: true }, ctx),
        shouldRunInFullAccessInAutoMode: ({ file_path, dangerouslyDisableSandbox }, ctx) =>
            dangerouslyDisableSandbox === true ||
            shouldReviewComputePath(compute, file_path, { write: true }, ctx),
        execute: async (ctx, { file_path, old_string, new_string, replace_all }) =>
            await editComputeText(compute, reads, ctx, {
                path: file_path,
                oldText: old_string,
                newText: new_string,
                ...(replace_all === undefined ? {} : { replaceAll: replace_all }),
                // Claude Code applies an edit whose text still matches a file changed since it was
                // read, such as by the model's own shell command, and says so in the result.
                applyWhenStale: true,
            }),
        toLLM: (result) => [
            {
                type: "text",
                text: `The file ${result.path} has been updated.${result.staleRecovered === true ? STALE_RECOVERED_NOTE : ""}`,
            },
        ],
    });
}
