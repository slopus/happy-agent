import { cuid2Schema, defineAgentTool } from "@slopus/happy-agent-base";
import type { SessionOutputBlock } from "@slopus/happy-providers";
import { Type, type Static } from "@sinclair/typebox";
import type { Context } from "@steve.kite/stdlib";

import { ImageProcessingError } from "../../impl/images/ImageProcessingError.js";
import { prepareImageForPrompt } from "../../impl/images/prepareImageForPrompt.js";
import { MAX_PROMPT_IMAGE_INPUT_BYTES } from "../../impl/images/referenceImageLimits.js";
import { artifactCounterSchema, artifactFileSchema, artifactPathSchema } from "../Artifact.js";
import { MAX_ARTIFACT_TEXT_BYTES, type ArtifactsModule } from "../ArtifactsModule.js";
import { formatBytes } from "../ArtifactTypes.js";
import { decodeArtifactText } from "../impl/decodeArtifactText.js";
import { ARTIFACT_TOOL_CAPABILITY } from "./common.js";

/** How many lines one read returns when the model does not ask for fewer. */
const MAX_LINES_TO_READ = 2_000;
/** How much text one read may carry, however few lines that turns out to be. */
const MAX_CHARACTERS = 60_000;
/** The longest side and the largest encoding of an image shown to the model. */
const MAX_IMAGE_DIMENSION = 2048;
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const RASTER_IMAGE_MIME_TYPES: ReadonlySet<string> = new Set([
    "image/avif",
    "image/bmp",
    "image/gif",
    "image/jpeg",
    "image/png",
    "image/webp",
]);

const readArtifactFileToolInputSchema = Type.Object(
    {
        artifactId: cuid2Schema,
        path: artifactPathSchema,
        version: Type.Optional(artifactCounterSchema),
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
type ReadArtifactFileToolInput = Static<typeof readArtifactFileToolInputSchema>;

const artifactFileReadSchema = Type.Object({
    artifactId: cuid2Schema,
    version: artifactCounterSchema,
    file: artifactFileSchema,
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
type ArtifactFileRead = Static<typeof artifactFileReadSchema>;

/** Read one file of an artifact version: text a page at a time, or an image to look at. */
export function readArtifactFileTool(artifacts: ArtifactsModule) {
    return defineAgentTool({
        name: "read_artifact_file",
        defer: true,
        capabilities: [ARTIFACT_TOOL_CAPABILITY],
        searchKeywords: ["read artifact file", "view artifact image", "artifact asset"],
        description: `Reads one file of an artifact by its path, from the latest version unless you name one. Text files, such as Markdown, HTML, CSS, scripts, and SVG, come back as numbered lines: a line number, then a tab, then the line, numbered from 1. By default it reads up to ${String(MAX_LINES_TO_READ)} lines from the start; offset and limit read another stretch of a long file. Images are shown to you. Other files, such as videos and PDFs, are described without their bytes. List an artifact's files with read_artifact.`,
        parameters: readArtifactFileToolInputSchema,
        returnType: artifactFileReadSchema,
        durable: false,
        reloadable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (
            ctx: Context,
            input: ReadArtifactFileToolInput,
        ): Promise<ArtifactFileRead> => {
            const selector = input.version ?? "latest";
            const stored = await artifacts.storedFile(ctx, input.artifactId, selector, input.path);
            const base = {
                artifactId: input.artifactId,
                version: stored.version,
                file: stored.file,
            };
            if (RASTER_IMAGE_MIME_TYPES.has(stored.file.mimeType)) {
                return { ...base, ...(await readImage(ctx, artifacts, input, stored.version)) };
            }
            if (stored.file.size > MAX_ARTIFACT_TEXT_BYTES) {
                return {
                    ...base,
                    note: `This file is larger than the ${formatBytes(MAX_ARTIFACT_TEXT_BYTES)} a text file may be to read.`,
                };
            }
            const read = await artifacts.readFile(
                ctx,
                input.artifactId,
                stored.version,
                input.path,
                {
                    maxBytes: stored.file.size,
                },
            );
            const decoded = decodeArtifactText(stored.file.mimeType, read.bytes, {
                atStart: true,
                atEnd: true,
            });
            if (decoded === undefined) {
                return {
                    ...base,
                    note: "This file is not text or an image, so its bytes are not shown.",
                };
            }
            const lines = decoded.text.split(/\r?\n/);
            // A trailing newline ends the last line rather than starting another.
            if (lines.length > 1 && lines.at(-1) === "") lines.pop();
            const totalLines = decoded.text === "" ? 0 : lines.length;
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
                text =
                    returnedLines === 0
                        ? numbered.slice(0, MAX_CHARACTERS)
                        : `${text}\n${numbered}`;
                returnedLines += 1;
            }
            const next = startLine + returnedLines;
            return {
                ...base,
                text,
                startLine,
                returnedLines,
                totalLines,
                ...(next <= totalLines ? { nextOffset: next } : {}),
            };
        },
        toLLM: (read) => formatArtifactFileRead(read),
    });
}

async function readImage(
    ctx: Context,
    artifacts: ArtifactsModule,
    input: ReadArtifactFileToolInput,
    version: number,
): Promise<Pick<ArtifactFileRead, "image" | "note">> {
    const read = await artifacts.readFile(ctx, input.artifactId, version, input.path, {
        maxBytes: MAX_PROMPT_IMAGE_INPUT_BYTES + 1,
    });
    if (read.more || read.bytes.byteLength > MAX_PROMPT_IMAGE_INPUT_BYTES) {
        return { note: "This image is too large to show." };
    }
    try {
        const prepared = await prepareImageForPrompt(read.bytes, {
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

function formatArtifactFileRead(read: ArtifactFileRead): readonly SessionOutputBlock[] {
    const header = `${JSON.stringify(read.file.path)} in version ${String(read.version)} of artifact ${read.artifactId}: ${read.file.mimeType}, ${formatBytes(read.file.size)}.`;
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
