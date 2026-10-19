import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import { ChatMediaModule } from "../../../chatMedia/index.js";
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
import { READ_IMAGE_SHOWN_NOTICE, showReadImage } from "../../impl/showReadImage.js";

/** How many lines one read returns when the model does not ask for fewer. */
const MAX_LINES_TO_READ = 2_000;

/** How much text one read may carry, however few lines that turns out to be. */
const MAX_CHARACTERS = 60_000;

/**
 * The longest side of an image Read shows, as in Claude Code.
 *
 * Claude refuses any image larger than this once a request carries more than 20 images. Every read
 * image stays in the history each later request replays, so a single larger screenshot would make
 * the conversation fail permanently as soon as enough images accumulate.
 */
const MAX_IMAGE_DIMENSION = 2_000;

const exact = { additionalProperties: false } as const;

// Notebook and PDF parsing are deliberately outside this surface. Both are refused in a sentence
// rather than thrown, because the model's next move is to convert the file, not to retry the read.
const CLAUDE_READ_DESCRIPTION = `Reads a file from the local filesystem.

- \`file_path\` must be an absolute path.
- Reads up to ${String(MAX_LINES_TO_READ)} lines by default.
- When you already know which part of the file you need, only read that part. This can be important for larger files.
- Results are returned using cat -n format, with line numbers starting at 1
- Reads images (PNG, JPG, …) and presents them visually. PDFs and Jupyter notebooks (.ipynb) are not parsed; convert them to text first.
- Reading a directory or a missing file returns an error; an empty file returns \`(empty file)\`.
- Do NOT re-read a file you just edited to verify — Edit/Write would have errored if the change failed, and the harness tracks file state for you.
- Paths outside the active workspace may require permission or be blocked by the selected permission mode.`;

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
            /** The original file shown to the user; absent when it could not be shown. */
            presentation: Type.Optional(ChatMediaModule.presentationSchema),
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

/**
 * Claude's `Read`: a numbered page of a file, an image, or a plain refusal to parse a format.
 * With chat media, an image it reads is shown to the user as well.
 */
export function claudeReadTool(compute: Compute, reads: FileReadLog, chatMedia?: ChatMediaModule) {
    return createClaudeReadTool(compute, reads, true, chatMedia);
}

/** The same Claude-shaped reader for GLM's text-only fixed tool array. */
export function claudeTextReadTool(compute: Compute, reads: FileReadLog) {
    return createClaudeReadTool(compute, reads, false, undefined);
}

function createClaudeReadTool(
    compute: Compute,
    reads: FileReadLog,
    images: boolean,
    chatMedia: ChatMediaModule | undefined,
) {
    return defineAgentTool({
        name: "Read",
        defer: false,
        capabilities: [
            "Read and modify files, run shell commands, inspect images, and manage background processes.",
        ],
        description: images
            ? CLAUDE_READ_DESCRIPTION
            : CLAUDE_READ_DESCRIPTION.replace(
                  "- Reads images (PNG, JPG, …) and presents them visually.",
                  "- Reads text files. Image input is not supported by the current model.",
              ),
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
                if (!images) {
                    return {
                        outcome: "unsupported" as const,
                        path: filePath,
                        text: "This model does not support image input. Convert the image to text before reading it.",
                    };
                }
                const permissions = computePermissionsForContext(ctx);
                const { image, original } = await readImageForModel(
                    compute,
                    reads,
                    ctx,
                    permissions,
                    filePath,
                    { maxDimension: MAX_IMAGE_DIMENSION },
                );
                const presentation = await showReadImage(ctx, chatMedia, original, filePath);
                return {
                    outcome: "image" as const,
                    path: filePath,
                    image,
                    ...(presentation === undefined ? {} : { presentation }),
                };
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
                const resized = result.image.resized;
                const described =
                    resized === undefined
                        ? `Image: ${result.path}`
                        : `Image: ${result.path} (original ${String(resized.original_width)}×${String(resized.original_height)}, shown at ${String(resized.width)}×${String(resized.height)})`;
                return [
                    {
                        type: "text",
                        text:
                            result.presentation === undefined
                                ? described
                                : `${described}\n${READ_IMAGE_SHOWN_NOTICE}`,
                    },
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
