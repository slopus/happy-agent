import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import type { Compute } from "../../Compute.js";
import { boundOutputText } from "../../impl/boundOutputText.js";
import { describeComputePathAction } from "../../impl/describeComputePathAction.js";
import type { FileReadLog } from "../../../impl/FileReadLog.js";
import { readComputeTextFile } from "../../impl/readComputeTextFile.js";
import { shouldReviewComputePath } from "../../impl/shouldReviewComputePath.js";

/** How many lines one read returns when the model does not ask for fewer, as Grok states it. */
const MAX_LINES = 1_000;

/** How much text one read may carry, however few lines that turns out to be. */
const MAX_CHARACTERS = 60_000;

/** Grok's `read_file`: one page of a text file, numbered the way Grok numbers it. */
export function grokReadFileTool(compute: Compute, reads: FileReadLog) {
    return defineAgentTool({
        name: "read_file",
        description: `Read a file.

Usage:
- target_file can be a relative path in the workspace or an absolute path.
- By default, it reads up to ${String(MAX_LINES)} lines starting from the beginning of the file.
- Results are returned with line numbers starting at 1 in the format LINE_NUMBER→LINE_CONTENT.
- Reading records the file's current state so a later write can detect if somebody else changed it first.`,
        parameters: Type.Object(
            {
                target_file: Type.String({
                    description:
                        "The path of the file to read. You can use a relative path in the workspace or an absolute path.",
                }),
                offset: Type.Optional(
                    Type.Integer({
                        description:
                            "The line number to start reading from. Only provide it if the file is too large to read at once.",
                        minimum: 1,
                    }),
                ),
                limit: Type.Optional(
                    Type.Integer({
                        description:
                            "The number of lines to read. Only provide it if the file is too large to read at once.",
                        minimum: 1,
                    }),
                ),
            },
            { additionalProperties: false },
        ),
        returnType: Type.Object({
            path: Type.String(),
            content: Type.String(),
            start_line: Type.Integer(),
            returned_lines: Type.Integer(),
            total_lines: Type.Integer(),
            truncated: Type.Boolean(),
        }),
        // Reading the same file again reads the same file, and the read it records is the same
        // read, so the record may commit with the result.
        durable: true,
        transactional: true,
        describeAutoPermissionAction: ({ target_file }) =>
            describeComputePathAction(compute, target_file, "reading"),
        shouldReviewInAutoMode: ({ target_file }, ctx) =>
            shouldReviewComputePath(compute, target_file, { write: false }, ctx),
        shouldRunInFullAccessInAutoMode: ({ target_file }, ctx) =>
            shouldReviewComputePath(compute, target_file, { write: false }, ctx),
        execute: async (ctx, { target_file, offset, limit }) => {
            const page = await readComputeTextFile(compute, reads, ctx, {
                path: target_file,
                ...(offset === undefined ? {} : { offset }),
                ...(limit === undefined ? {} : { limit }),
                maxLines: MAX_LINES,
            });
            // A file with nothing in it still splits into one empty line; saying it holds one
            // line would be a lie the model then reasons from.
            const empty = page.totalLines === 1 && (page.lines[0] ?? "") === "";
            const numbered = empty
                ? ""
                : page.lines
                      .map((line, index) => `${String(page.startLine + index)}→${line}`)
                      .join("\n");
            const bounded = boundOutputText(numbered, { maxCharacters: MAX_CHARACTERS });
            return {
                path: page.path,
                content: bounded.text,
                start_line: page.startLine,
                returned_lines: empty ? 0 : page.lines.length,
                total_lines: empty ? 0 : page.totalLines,
                truncated: bounded.truncated || page.moreLines,
            };
        },
        toLLM: (result) => [
            {
                type: "text",
                text:
                    result.returned_lines === 0
                        ? result.total_lines > 1
                            ? `(no lines there; the file has ${String(result.total_lines)} lines)`
                            : "(empty file)"
                        : result.truncated
                          ? `${result.content}\n[Showing lines ${String(result.start_line)} to ${String(result.start_line + result.returned_lines - 1)} of ${String(result.total_lines)}. Read on with offset.]`
                          : result.content,
            },
        ],
    });
}
