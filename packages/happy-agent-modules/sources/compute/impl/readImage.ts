import { Type, type Static } from "@sinclair/typebox";
import type { Context } from "@steve.kite/stdlib";

import type { Compute } from "../Compute.js";
import type { FileReadLog } from "../../impl/FileReadLog.js";
import { ImageProcessingError } from "../../impl/images/ImageProcessingError.js";
import { prepareImageForPrompt } from "../../impl/images/prepareImageForPrompt.js";
import { basenameComputePath } from "./resolveComputePath.js";

/** One bounded image read, ready to become a provider-neutral image block. */
export const computeImageSchema = Type.Object(
    {
        data: Type.String(),
        mime_type: Type.String(),
        bytes: Type.Integer(),
        /** Present only when the image was scaled down to fit the reading tool's size limit. */
        resized: Type.Optional(
            Type.Object(
                {
                    original_width: Type.Integer(),
                    original_height: Type.Integer(),
                    width: Type.Integer(),
                    height: Type.Integer(),
                },
                { additionalProperties: false },
            ),
        ),
    },
    { additionalProperties: false },
);

export type ComputeImage = Static<typeof computeImageSchema>;

/** Keep base64 image blocks within the providers' input limits. */
export const MAX_COMPUTE_IMAGE_BYTES = 3 * 1024 * 1024;

const IMAGE_MEDIA_TYPES: Readonly<Record<string, string>> = {
    ".bmp": "image/bmp",
    ".gif": "image/gif",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
};

/** Return the supported image media type for a path, or undefined for ordinary text. */
export function imageMediaTypeForPath(path: string): string | undefined {
    const name = basenameComputePath(path).toLowerCase();
    const dot = name.lastIndexOf(".");
    return dot < 0 ? undefined : IMAGE_MEDIA_TYPES[name.slice(dot)];
}

/**
 * Read a bounded image and remember it as a file the agent has seen.
 *
 * Without `maxDimension` the bytes are shown exactly as stored. With it, the image is decoded and
 * any side longer than the limit is scaled down, so a tool whose provider refuses larger images
 * never puts one into the history that every later request replays.
 */
export async function readImageForModel(
    compute: Compute,
    reads: FileReadLog,
    ctx: Context,
    permissions: Parameters<Compute["fs"]["readFileBuffer"]>[0],
    path: string,
    options: { readonly maxDimension?: number } = {},
): Promise<ComputeImage> {
    const mediaType = imageMediaTypeForPath(path);
    if (mediaType === undefined) {
        throw new Error(`This is not a supported image file: ${path}`);
    }
    const stat = await compute.fs.stat(permissions, path);
    if (!stat.isFile) throw new Error(`Image path is not a file: ${path}`);
    if (stat.size > MAX_COMPUTE_IMAGE_BYTES) {
        throw new Error(
            `Image ${path} is too large to show (${String(stat.size)} bytes; the limit is ${String(MAX_COMPUTE_IMAGE_BYTES)}).`,
        );
    }
    const bytes = await compute.fs.readFileBuffer(permissions, path, {
        maxBytes: MAX_COMPUTE_IMAGE_BYTES,
    });
    if (bytes.byteLength > MAX_COMPUTE_IMAGE_BYTES) {
        throw new Error(
            `Image ${path} is too large to show (${String(bytes.byteLength)} bytes; the limit is ${String(MAX_COMPUTE_IMAGE_BYTES)}).`,
        );
    }
    const image =
        options.maxDimension === undefined
            ? {
                  data: Buffer.from(bytes).toString("base64"),
                  mime_type: mediaType,
                  bytes: bytes.byteLength,
              }
            : await fitImage(path, bytes, options.maxDimension);
    await reads.record(ctx, path, stat.mtimeMs);
    return image;
}

async function fitImage(
    path: string,
    bytes: Uint8Array,
    maxDimension: number,
): Promise<ComputeImage> {
    let prepared;
    try {
        // Only the longest side is bounded; there is no separate budget on the total area.
        prepared = await prepareImageForPrompt(bytes, {
            maxDimension,
            maxPatches: Number.POSITIVE_INFINITY,
        });
    } catch (error) {
        if (!(error instanceof ImageProcessingError)) throw error;
        throw new Error(`Image ${path} cannot be shown. ${error.message}`, { cause: error });
    }
    if (prepared.bytes.byteLength > MAX_COMPUTE_IMAGE_BYTES) {
        throw new Error(
            `Image ${path} is too large to show after resizing (${String(prepared.bytes.byteLength)} bytes; the limit is ${String(MAX_COMPUTE_IMAGE_BYTES)}).`,
        );
    }
    const resized =
        prepared.width !== prepared.originalWidth || prepared.height !== prepared.originalHeight;
    return {
        data: prepared.bytes.toString("base64"),
        mime_type: prepared.mediaType,
        bytes: prepared.bytes.byteLength,
        ...(resized
            ? {
                  resized: {
                      original_width: prepared.originalWidth,
                      original_height: prepared.originalHeight,
                      width: prepared.width,
                      height: prepared.height,
                  },
              }
            : {}),
    };
}
