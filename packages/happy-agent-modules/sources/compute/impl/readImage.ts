import { Type, type Static } from "@sinclair/typebox";
import type { Context } from "@steve.kite/stdlib";

import type { Compute } from "../Compute.js";
import type { FileReadLog } from "../../impl/FileReadLog.js";
import { ImageProcessingError } from "../../impl/images/ImageProcessingError.js";
import { prepareImageForPrompt } from "../../impl/images/prepareImageForPrompt.js";
import { MAX_PROMPT_IMAGE_INPUT_BYTES } from "../../impl/images/referenceImageLimits.js";
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

/** One image read for the model, with the file's bytes exactly as stored. */
export interface ComputeImageRead {
    readonly image: ComputeImage;
    readonly original: Uint8Array;
}

/**
 * Read a bounded image and remember it as a file the agent has seen.
 *
 * Without `maxDimension` the bytes are shown exactly as stored, so the file itself must fit. With
 * it, a source file of up to 32 MiB is decoded and any side longer than the limit is scaled down,
 * so a tool whose provider refuses larger images never puts one into the history that every later
 * request replays. An image still too large after that is refused with what the model needs to
 * make a smaller copy itself; nothing smaller is substituted silently. The original bytes come
 * back too, for showing the file itself to the user.
 */
export async function readImageForModel(
    compute: Compute,
    reads: FileReadLog,
    ctx: Context,
    permissions: Parameters<Compute["fs"]["readFileBuffer"]>[0],
    path: string,
    options: { readonly maxDimension?: number } = {},
): Promise<ComputeImageRead> {
    const mediaType = imageMediaTypeForPath(path);
    if (mediaType === undefined) {
        throw new Error(`This is not a supported image file: ${path}`);
    }
    const maxSourceBytes =
        options.maxDimension === undefined ? MAX_COMPUTE_IMAGE_BYTES : MAX_PROMPT_IMAGE_INPUT_BYTES;
    const stat = await compute.fs.stat(permissions, path);
    if (!stat.isFile) throw new Error(`Image path is not a file: ${path}`);
    if (stat.size > maxSourceBytes) throw tooLarge(path, stat.size, maxSourceBytes);
    const bytes = await compute.fs.readFileBuffer(permissions, path, { maxBytes: maxSourceBytes });
    if (bytes.byteLength > maxSourceBytes) throw tooLarge(path, bytes.byteLength, maxSourceBytes);
    const image =
        options.maxDimension === undefined
            ? {
                  data: Buffer.from(bytes).toString("base64"),
                  mime_type: mediaType,
                  bytes: bytes.byteLength,
              }
            : await fitImage(path, bytes, options.maxDimension);
    await reads.record(ctx, path, stat.mtimeMs);
    return { image, original: bytes };
}

/** The refusal for an image too large to show: how large, the limit, and how to make a copy. */
function tooLarge(path: string, bytes: number, limit: number, shownAt?: string): Error {
    const size = shownAt === undefined ? formatBytes(bytes) : `${formatBytes(bytes)} at ${shownAt}`;
    return new Error(
        `Image ${path} is too large to show (${size}; the limit is ${formatBytes(limit)}). ` +
            "Make a smaller copy, for example with `sips -Z 1600 -s format jpeg <image> --out <copy>.jpg` " +
            "or `ffmpeg -i <image> -vf scale=1600:-1 <copy>.jpg`, then read the copy.",
    );
}

function formatBytes(bytes: number): string {
    if (bytes < 1024 * 1024) return `${String(bytes)} bytes`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
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
        throw tooLarge(
            path,
            prepared.bytes.byteLength,
            MAX_COMPUTE_IMAGE_BYTES,
            `${String(prepared.width)}×${String(prepared.height)}`,
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
