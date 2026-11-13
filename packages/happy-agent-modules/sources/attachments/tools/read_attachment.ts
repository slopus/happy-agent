import { TextDecoder } from "node:util";

import { Type, type Static } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";
import type { SessionOutputBlock } from "@slopus/happy-providers";
import type { Context } from "@steve.kite/stdlib";

import { ImageProcessingError } from "../../impl/images/ImageProcessingError.js";
import { prepareImageForPrompt } from "../../impl/images/prepareImageForPrompt.js";
import { MAX_PROMPT_IMAGE_INPUT_BYTES } from "../../impl/images/referenceImageLimits.js";
import type { Compute, ComputeModule } from "../../compute/index.js";
import { readFileHead } from "../impl/attachmentFiles.js";
import { quoteVisibleExact } from "../../impl/quoteVisibleExact.js";
import { formatSize } from "../impl/attachmentNote.js";
import { attachmentIdSchema } from "../Attachment.js";
import type { AttachmentsModule } from "../AttachmentsModule.js";

/** How many lines one read returns when the model does not ask for fewer. */
const MAX_LINES_TO_READ = 2_000;
/** How much text one read may carry, however few lines that turns out to be. */
const MAX_CHARACTERS = 60_000;
/** The largest file read as text. */
const MAX_TEXT_BYTES = 1024 * 1024;
/** The longest side and the largest encoding of an image shown to the model. */
const MAX_IMAGE_DIMENSION = 2000;
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const RASTER_IMAGE_MIME_TYPES: ReadonlySet<string> = new Set([
    "image/avif",
    "image/bmp",
    "image/gif",
    "image/jpeg",
    "image/png",
    "image/webp",
]);
/** The largest file copied to the agent's machine, which receives a copy in one write. */
const MAX_COPY_BYTES = 512 * 1024 * 1024;
/** Media types whose bytes are text even though they are not `text/*`. */
const TEXT_MIME_TYPES: ReadonlySet<string> = new Set([
    "application/json",
    "application/javascript",
    "application/xml",
    "application/yaml",
    "application/x-yaml",
    "application/toml",
    "application/x-sh",
    "image/svg+xml",
]);

const readAttachmentInputSchema = Type.Object(
    {
        attachment_id: attachmentIdSchema,
        path: Type.Optional(
            Type.String({
                minLength: 1,
                maxLength: 4096,
                description:
                    "Where to save a copy of the file on your machine, relative to your working directory or absolute. Omit it to only look at the file.",
            }),
        ),
        overwrite: Type.Optional(
            Type.Boolean({
                description: "Replace a file that already exists at path. Defaults to false.",
            }),
        ),
        offset: Type.Optional(
            Type.Integer({
                minimum: 0,
                maximum: Number.MAX_SAFE_INTEGER,
                description:
                    "The line number to start reading from. Only provide if the file is too large to read at once",
            }),
        ),
        limit: Type.Optional(
            Type.Integer({
                exclusiveMinimum: 0,
                maximum: Number.MAX_SAFE_INTEGER,
                description:
                    "The number of lines to read. Only provide if the file is too large to read at once.",
            }),
        ),
    },
    { additionalProperties: false },
);
type ReadAttachmentInput = Static<typeof readAttachmentInputSchema>;

const attachmentReadSchema = Type.Object({
    attachmentId: Type.String(),
    name: Type.Optional(Type.String()),
    /** Where the copy on the agent's machine was saved, when one was asked for. */
    path: Type.Optional(Type.String()),
    mimeType: Type.Optional(Type.String()),
    size: Type.Optional(Type.Integer({ minimum: 0 })),
    /** The lines read, each as its number, a tab, and the line. */
    text: Type.Optional(Type.String()),
    startLine: Type.Optional(Type.Integer({ minimum: 1 })),
    returnedLines: Type.Optional(Type.Integer({ minimum: 0 })),
    totalLines: Type.Optional(Type.Integer({ minimum: 0 })),
    /** The line the next read starts at, when more follows. */
    nextOffset: Type.Optional(Type.Integer({ minimum: 1 })),
    image: Type.Optional(Type.Object({ data: Type.String(), mimeType: Type.String() })),
    /** Why the file's content is not shown. */
    note: Type.Optional(Type.String()),
});
type AttachmentRead = Static<typeof attachmentReadSchema>;

/**
 * Read a file a person attached to a message in this conversation: images are shown and text is
 * read a page at a time. With a path, the file is also copied there on the agent's own machine,
 * wherever that is, so its own tools can open it. The copy is the agent's; changing or deleting it
 * never touches the attachment, which the daemon keeps.
 */
export function readAttachmentTool(
    attachments: AttachmentsModule,
    computeModule: ComputeModule,
    compute: Compute | undefined,
    agentId: string,
) {
    const reviewed = (path: string | undefined, ctx: Context): Promise<boolean> | boolean =>
        path !== undefined &&
        compute !== undefined &&
        computeModule.shouldReviewPath(ctx, compute, path, { write: true });
    return defineAgentTool({
        name: "read_attachment",
        defer: true,
        capabilities: ["Read files people attached to messages, and save copies to work on."],
        searchKeywords: ["attached file", "open attachment", "uploaded file", "read attachment"],
        description: `Reads a file a person attached to a message in this conversation. Each attachment appears in the message as a line naming its ID, file name, type, and size. Images are shown to you. Text files come back as numbered lines: a line number, then a tab, then the line, numbered from 1. By default it reads up to ${String(MAX_LINES_TO_READ)} lines from the start; offset and limit read another stretch of a long file. Other files, such as PDFs, archives, and videos, are only described. To work on the file with your own tools, pass path to save a copy on your machine; relative paths start from your working directory, and missing folders are created. Choose a place that will not get committed, such as an ignored scratch folder. An existing file is replaced only with overwrite: true. The copy is yours: changing or deleting it does not change the attachment, and you can save it again.`,
        parameters: readAttachmentInputSchema,
        returnType: attachmentReadSchema,
        durable: false,
        reloadable: true,
        shouldReviewInAutoMode: ({ path }, ctx) => reviewed(path, ctx),
        shouldRunInFullAccessInAutoMode: ({ path }, ctx) => reviewed(path, ctx),
        describeAutoPermissionAction: ({ attachment_id, path }) =>
            compute === undefined || path === undefined
                ? `reading attachment ${attachment_id}`
                : computeModule.describePathAction(
                      compute,
                      path,
                      `Saving a copy of attachment ${attachment_id} to`,
                      { write: true },
                  ),
        execute: async (ctx: Context, input: ReadAttachmentInput): Promise<AttachmentRead> => {
            const found = await attachments.readable(ctx, agentId, input.attachment_id);
            if (found === undefined) {
                return {
                    attachmentId: input.attachment_id,
                    note: "No attachment with this ID was sent in this conversation.",
                };
            }
            const attachment = found.attachment;
            const base = {
                attachmentId: attachment.id,
                name: attachment.name,
                mimeType: attachment.mimeType,
                size: attachment.size,
            };
            const { contentPath, mimeType, size } = found.content;
            const saved =
                input.path === undefined
                    ? {}
                    : {
                          path: await saveCopy(ctx, computeModule, compute, input.path, {
                              overwrite: input.overwrite === true,
                              contentPath,
                              size,
                          }),
                      };
            return {
                ...base,
                ...saved,
                ...(await readContent(input, contentPath, mimeType, size)),
            };
        },
        toLLM: (read) => formatAttachmentRead(read),
    });
}

/** What the model is shown of the content itself: an image, a page of text, or why not. */
async function readContent(
    input: ReadAttachmentInput,
    contentPath: string,
    mimeType: string,
    size: number,
): Promise<Partial<AttachmentRead>> {
    if (RASTER_IMAGE_MIME_TYPES.has(mimeType)) {
        return await readImage(contentPath, size);
    }
    const known = mimeType.startsWith("text/") || TEXT_MIME_TYPES.has(mimeType);
    if (!known && mimeType !== "application/octet-stream") {
        return { note: "This file is not text or an image, so its bytes are not shown here." };
    }
    if (size > MAX_TEXT_BYTES) {
        return {
            note: `This file is larger than the ${formatSize(MAX_TEXT_BYTES)} a text file may be to show here.`,
        };
    }
    const text = decodeText(await readFileHead(contentPath, size));
    if (text === undefined) {
        return { note: "This file is not text or an image, so its bytes are not shown here." };
    }
    return pageOfLines(text, input);
}

/**
 * Save the attachment where the agent asked, on its own machine and under the turn's own
 * permissions, so the sandbox and Auto review decide what is allowed exactly as for any write.
 * Missing folders are created. An existing file is refused unless `overwrite` is set. Answers the
 * resolved path.
 */
async function saveCopy(
    ctx: Context,
    computeModule: ComputeModule,
    compute: Compute | undefined,
    requested: string,
    content: { readonly overwrite: boolean; readonly contentPath: string; readonly size: number },
): Promise<string> {
    if (compute === undefined) {
        throw new Error("This agent has no machine to save the file to.");
    }
    if (content.size > MAX_COPY_BYTES) {
        throw new Error(
            `The file is larger than the ${formatSize(MAX_COPY_BYTES)} that can be saved to your machine. Read it without path instead.`,
        );
    }
    const permissions = computeModule.permissionsForContext(ctx);
    const path = computeModule.resolvePath(compute, requested);
    const existing = await compute.fs.lstat(permissions, path).catch(() => undefined);
    if (existing !== undefined) {
        if (existing.isDirectory) {
            throw new Error(`${quoteVisibleExact(path)} is a folder. Pass the file's own path.`);
        }
        if (!content.overwrite) {
            throw new Error(
                `${quoteVisibleExact(path)} already exists. Pass overwrite: true to replace it, or choose another path.`,
            );
        }
    }
    const parent = computeModule.parentPath(path);
    if (parent !== path) await compute.fs.mkdir(permissions, parent, { recursive: true });
    await compute.fs.writeFile(
        permissions,
        path,
        await readFileHead(content.contentPath, content.size),
    );
    return path;
}

async function readImage(
    contentPath: string,
    size: number,
): Promise<Pick<AttachmentRead, "image" | "note">> {
    if (size > MAX_PROMPT_IMAGE_INPUT_BYTES) return { note: "This image is too large to show." };
    try {
        const prepared = await prepareImageForPrompt(await readFileHead(contentPath, size), {
            maxDimension: MAX_IMAGE_DIMENSION,
            maxPatches: Number.POSITIVE_INFINITY,
        });
        if (prepared.bytes.byteLength > MAX_IMAGE_BYTES) {
            return { note: "This image is too large to show, even scaled down." };
        }
        return {
            image: { data: prepared.bytes.toString("base64"), mimeType: prepared.mediaType },
        };
    } catch (error: unknown) {
        if (!(error instanceof ImageProcessingError)) throw error;
        return { note: `This image cannot be shown. ${error.message}` };
    }
}

/** The bytes as UTF-8 text, or `undefined` when they are not valid UTF-8 or hold a NUL. */
function decodeText(bytes: Uint8Array): string | undefined {
    if (bytes.includes(0)) return undefined;
    try {
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
        return undefined;
    }
}

function pageOfLines(
    decoded: string,
    input: ReadAttachmentInput,
): Pick<AttachmentRead, "text" | "startLine" | "returnedLines" | "totalLines" | "nextOffset"> {
    const lines = decoded.split(/\r?\n/u);
    // A trailing newline ends the last line rather than starting another.
    if (lines.length > 1 && lines.at(-1) === "") lines.pop();
    const totalLines = decoded === "" ? 0 : lines.length;
    const startLine = Math.max(1, input.offset ?? 1);
    const wanted = lines.slice(
        startLine - 1,
        startLine - 1 + Math.min(input.limit ?? MAX_LINES_TO_READ, MAX_LINES_TO_READ),
    );
    let text = "";
    let returnedLines = 0;
    for (const [index, line] of wanted.entries()) {
        const numbered = `${String(startLine + index)}\t${line}`;
        if (returnedLines > 0 && text.length + 1 + numbered.length > MAX_CHARACTERS) break;
        text = returnedLines === 0 ? numbered.slice(0, MAX_CHARACTERS) : `${text}\n${numbered}`;
        returnedLines += 1;
    }
    const next = startLine + returnedLines;
    return {
        text,
        startLine,
        returnedLines,
        totalLines,
        ...(next <= totalLines ? { nextOffset: next } : {}),
    };
}

function formatAttachmentRead(read: AttachmentRead): readonly SessionOutputBlock[] {
    const described =
        read.name === undefined
            ? `Attachment ${read.attachmentId}`
            : `Attachment ${read.attachmentId}, ${JSON.stringify(read.name)}${read.mimeType === undefined ? "" : `: ${read.mimeType}`}${read.size === undefined ? "" : `, ${formatSize(read.size)}`}`;
    const header = `${described}.${read.path === undefined ? "" : ` Saved a copy to ${read.path}.`}`;
    if (read.image !== undefined) {
        return [
            { type: "text", text: header },
            { type: "image", data: read.image.data, mimeType: read.image.mimeType },
        ];
    }
    if (read.text === undefined) {
        return [{ type: "text", text: `${header} ${read.note ?? ""}`.trim() }];
    }
    const lines = [
        read.totalLines === 0
            ? `${header} (empty file)`
            : read.returnedLines === 0
              ? `${header} It has ${String(read.totalLines)} lines, so nothing follows line ${String((read.startLine ?? 1) - 1)}.`
              : `${header} Lines ${String(read.startLine)}–${String((read.startLine ?? 1) + (read.returnedLines ?? 0) - 1)} of ${String(read.totalLines)}:`,
    ];
    if (read.text !== "") lines.push(read.text);
    if (read.nextOffset !== undefined) {
        lines.push(`[More follows; read on with offset ${String(read.nextOffset)}.]`);
    }
    return [{ type: "text", text: lines.join("\n") }];
}
