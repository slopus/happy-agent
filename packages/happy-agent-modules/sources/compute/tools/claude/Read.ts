import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import type { Compute } from "../../Compute.js";
import { boundOutputText } from "../../impl/boundOutputText.js";
import { computePermissionsForContext } from "../../impl/computePermissionsForContext.js";
import { describeComputePathAction } from "../../impl/describeComputePathAction.js";
import type { FileReadLog } from "../../../impl/FileReadLog.js";
import { readComputeTextFile } from "../../impl/readComputeTextFile.js";
import {
    computeImageSchema,
    imageMediaTypeForPath,
    readImageForModel,
} from "../../impl/readImage.js";
import { resolveComputePath } from "../../impl/resolveComputePath.js";
import { shouldReviewComputePath } from "../../impl/shouldReviewComputePath.js";

/** How many lines one read returns when the model does not ask for fewer. */
const MAX_LINES_TO_READ = 2_000;

/** How much text one read may carry, however few lines that turns out to be. */
const MAX_CHARACTERS = 60_000;

const exact = { additionalProperties: false } as const;

// Notebook and PDF parsing are deliberately outside this surface. Both are refused in a sentence
// rather than thrown, because the model's next move is to convert the file, not to retry the read.
const CLAUDE_READ_DESCRIPTION = `Reads a file from the local filesystem. Paths outside the active workspace may require permission or be blocked by the selected permission mode.
If the user provides a path to a file, assume the path is valid. It is okay to read a file that does not exist; an error will be returned.

Usage:
- The file_path parameter must be an absolute path, not a relative path
- By default, it reads up to ${String(MAX_LINES_TO_READ)} lines starting from the beginning of the file
- You can optionally specify a line offset and limit (especially handy for long files), but it's recommended to read the whole file by not providing these parameters
- Results are returned using cat -n format, with line numbers starting at 1
- This tool reads common image formats (for example PNG and JPG) and presents them visually.
- Jupyter notebooks (.ipynb files) are not supported. Ask the user to export the notebook to a plain-text format before reading it.
- This tool can only read files, not directories. To read a directory, use an ls command via the Bash tool.
- You will regularly be asked to read screenshots. If the user provides a path to a screenshot, ALWAYS use this tool to view the file at the path. This tool will work with all temporary file paths.
- Empty files are returned as \`(empty file)\`.`;

/** What one read found: a page of text, an image, or a format this surface will not parse. */
const claudeReadResultSchema = Type.Union([
    Type.Object(
        {
            outcome: Type.Literal("text"),
            path: Type.String(),
            content: Type.String(),
            start_line: Type.Integer(),
            returned_lines: Type.Integer(),
            total_lines: Type.Integer(),
            truncated: Type.Boolean(),
        },
        exact,
    ),
    Type.Object(
        {
            outcome: Type.Literal("image"),
            path: Type.String(),
            image: computeImageSchema,
        },
        exact,
    ),
    Type.Object(
        {
            outcome: Type.Literal("unsupported"),
            path: Type.String(),
            text: Type.String(),
        },
        exact,
    ),
]);

/** Claude's `Read`: a numbered page of a file, an image, or a plain refusal to parse a format. */
export function claudeReadTool(compute: Compute, reads: FileReadLog) {
    return defineAgentTool({
        name: "Read",
        defer: false,
        capabilities: [
            "Read and modify files, run shell commands, inspect images, and manage background processes.",
        ],
        description: CLAUDE_READ_DESCRIPTION,
        parameters: Type.Object(
            {
                file_path: Type.String({ description: "The absolute path to the file to read" }),
                offset: Type.Optional(
                    Type.Integer({
                        description:
                            "The line number to start reading from. Only provide if the file is too large to read at once",
                        minimum: 0,
                    }),
                ),
                limit: Type.Optional(
                    Type.Integer({
                        description:
                            "The number of lines to read. Only provide if the file is too large to read at once.",
                        exclusiveMinimum: 0,
                    }),
                ),
            },
            exact,
        ),
        returnType: claudeReadResultSchema,
        // Reading the same file again reads the same file, and the read it records commits with it.
        durable: true,
        reloadable: true,
        transactional: true,
        describeAutoPermissionAction: ({ file_path }) =>
            describeComputePathAction(compute, file_path, "reading"),
        shouldReviewInAutoMode: ({ file_path }, ctx) =>
            shouldReviewComputePath(compute, file_path, { write: false }, ctx),
        shouldRunInFullAccessInAutoMode: ({ file_path }, ctx) =>
            shouldReviewComputePath(compute, file_path, { write: false }, ctx),
        execute: async (ctx, { file_path, offset, limit }) => {
            const filePath = resolveComputePath(file_path, compute.cwd, compute.fs.home);
            const lower = filePath.toLowerCase();
            if (lower.endsWith(".ipynb")) {
                return {
                    outcome: "unsupported" as const,
                    path: filePath,
                    text: "Jupyter notebooks are not supported. Export the notebook to a plain-text format first.",
                };
            }
            if (lower.endsWith(".pdf")) {
                return {
                    outcome: "unsupported" as const,
                    path: filePath,
                    text: "PDF rendering is not supported. Convert the PDF to text or images first.",
                };
            }
            if (imageMediaTypeForPath(filePath) !== undefined) {
                const permissions = computePermissionsForContext(ctx);
                const image = await readImageForModel(compute, reads, ctx, permissions, filePath);
                return { outcome: "image" as const, path: filePath, image };
            }

            const page = await readComputeTextFile(compute, reads, ctx, {
                path: filePath,
                ...(offset === undefined ? {} : { offset }),
                ...(limit === undefined ? {} : { limit }),
                maxLines: MAX_LINES_TO_READ,
            });
            // A file with nothing in it still splits into one empty line; saying it has a line
            // would be a lie the model then quotes back in an edit.
            const empty = page.totalLines === 1 && (page.lines[0] ?? "") === "";
            const shown = empty ? [] : page.lines;
            const numbered = shown
                .map((line, index) => `${String(page.startLine + index)}\t${line}`)
                .join("\n");
            const bounded = boundOutputText(numbered, { maxCharacters: MAX_CHARACTERS });
            return {
                outcome: "text" as const,
                path: page.path,
                content: bounded.text,
                start_line: page.startLine,
                returned_lines: shown.length,
                total_lines: empty ? 0 : page.totalLines,
                truncated: bounded.truncated || page.moreLines,
            };
        },
        toLLM: (result) => {
            if (result.outcome === "image") {
                return [
                    { type: "text", text: `Image: ${result.path}` },
                    { type: "image", data: result.image.data, mimeType: result.image.mime_type },
                ];
            }
            if (result.outcome === "unsupported") {
                return [{ type: "text", text: result.text }];
            }
            if (result.returned_lines === 0) {
                return [
                    {
                        type: "text",
                        text:
                            result.total_lines === 0
                                ? "(empty file)"
                                : `(no lines there; the file has ${String(result.total_lines)} lines)`,
                    },
                ];
            }
            return [
                {
                    type: "text",
                    text: result.truncated
                        ? `${result.content}\n[Showing lines ${String(result.start_line)} to ${String(result.start_line + result.returned_lines - 1)} of ${String(result.total_lines)}. Read on with offset.]`
                        : result.content,
                },
            ];
        },
    });
}
