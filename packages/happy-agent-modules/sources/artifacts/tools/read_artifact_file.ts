import { cuid2Schema, defineAgentTool } from "@slopus/happy-agent-base";
import type { SessionOutputBlock } from "@slopus/happy-providers";
import { Type, type Static } from "@sinclair/typebox";
import type { Context } from "@steve.kite/stdlib";

import { ImageProcessingError } from "../../impl/images/ImageProcessingError.js";
import { prepareImageForPrompt } from "../../impl/images/prepareImageForPrompt.js";
import { MAX_PROMPT_IMAGE_INPUT_BYTES } from "../../impl/images/referenceImageLimits.js";
import { artifactCounterSchema, artifactFileSchema, artifactPathSchema } from "../Artifact.js";
import type { ArtifactsModule } from "../ArtifactsModule.js";
import { formatBytes } from "../ArtifactTypes.js";
import { decodeArtifactText } from "../impl/decodeArtifactText.js";
import { ARTIFACT_TOOL_CAPABILITY } from "./common.js";

/** How much of a text file one read hands the model. */
const MAX_FILE_TEXT_BYTES = 64 * 1024;
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
        offset: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
    },
    { additionalProperties: false },
);
type ReadArtifactFileToolInput = Static<typeof readArtifactFileToolInputSchema>;

const artifactFileReadSchema = Type.Object({
    artifactId: cuid2Schema,
    version: artifactCounterSchema,
    file: artifactFileSchema,
    text: Type.Optional(Type.String()),
    /** Where the shown text starts, and where the next read starts when more follows. */
    offset: Type.Optional(Type.Integer({ minimum: 0 })),
    nextOffset: Type.Optional(Type.Integer({ minimum: 0 })),
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
        description: `Read one file of an artifact by its path, from the latest version unless you name one. Text files, such as Markdown, HTML, CSS, scripts, and SVG, come back ${formatBytes(MAX_FILE_TEXT_BYTES)} at a time; pass nextOffset back as offset to read on. Images are shown to you. Other files, such as videos and PDFs, are described without their bytes. List an artifact's files with read_artifact.`,
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
            const read = await artifacts.readFile(
                ctx,
                input.artifactId,
                stored.version,
                input.path,
                {
                    ...(input.offset === undefined ? {} : { offset: input.offset }),
                    maxBytes: MAX_FILE_TEXT_BYTES,
                },
            );
            const decoded = decodeArtifactText(stored.file.mimeType, read.bytes, {
                atStart: read.offset === 0,
                atEnd: !read.more,
            });
            if (decoded === undefined) {
                return {
                    ...base,
                    note: "This file is not text or an image, so its bytes are not shown.",
                };
            }
            const nextOffset = read.offset + decoded.consumed;
            return {
                ...base,
                text: decoded.text,
                offset: read.offset,
                ...(nextOffset < stored.file.size ? { nextOffset } : {}),
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
        read.offset === undefined || read.offset === 0
            ? header
            : `${header} From byte ${String(read.offset)}:`,
        read.text,
    ];
    if (read.nextOffset !== undefined) {
        lines.push(`[More follows; read on with offset ${String(read.nextOffset)}.]`);
    }
    return [{ type: "text", text: lines.join("\n") }];
}
