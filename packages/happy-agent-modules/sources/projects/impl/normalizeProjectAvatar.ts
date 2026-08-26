import { createHash } from "node:crypto";

import { getImageProcessor } from "../../impl/images/getImageProcessor.js";
import { rgbaToThumbHash } from "../../impl/images/rgbaToThumbHash.js";
import { ProjectAvatarInputError } from "../ProjectAvatarInputError.js";

export const MAX_AVATAR_BYTES = 8 * 1024 * 1024;
const MAX_DECODED_PIXELS = 25_000_000;
const ACCEPTED_FORMATS = new Set(["jpeg", "png", "webp"]);

export interface NormalizedProjectAvatar {
    readonly bytes: Buffer;
    readonly contentHash: string;
    readonly contentType: "image/webp";
    readonly height: number;
    readonly thumbhash: string;
    readonly width: number;
}

/**
 * Turns whatever image was offered into the one shape the catalog stores: a bounded, oriented,
 * square-fitting WebP addressed by the hash of its own bytes. Two projects that arrive at the
 * same picture therefore share one stored asset.
 */
export async function normalizeProjectAvatar(
    bytes: Uint8Array,
    declaredContentType?: "image/jpeg" | "image/png" | "image/webp",
): Promise<NormalizedProjectAvatar> {
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_AVATAR_BYTES) {
        throw new ProjectAvatarInputError("The project image must be no larger than 8 MiB.");
    }
    try {
        const processor = await getImageProcessor();
        const metadata = await processor.metadata(bytes, {
            autoOrient: true,
            maxPixels: MAX_DECODED_PIXELS,
        });
        if (!ACCEPTED_FORMATS.has(metadata.format)) {
            throw new ProjectAvatarInputError(
                "The project image does not contain a readable picture.",
            );
        }
        const actualContentType =
            metadata.format === "jpeg"
                ? "image/jpeg"
                : metadata.format === "png"
                  ? "image/png"
                  : "image/webp";
        if (declaredContentType !== undefined && actualContentType !== declaredContentType) {
            throw new ProjectAvatarInputError("The project image does not match its content type.");
        }
        const result = await processor.encode(bytes, {
            autoOrient: true,
            format: "webp",
            maxPixels: MAX_DECODED_PIXELS,
            quality: 82,
            resize: {
                filter: "lanczos3",
                fit: "inside",
                height: 256,
                width: 256,
                withoutEnlargement: true,
            },
        });
        const placeholder = await processor.rgba(result.data, {
            autoOrient: false,
            maxPixels: MAX_DECODED_PIXELS,
            resize: {
                filter: "lanczos3",
                fit: "inside",
                height: 100,
                width: 100,
                withoutEnlargement: true,
            },
        });
        return {
            bytes: result.data,
            contentHash: createHash("sha256").update(result.data).digest("hex"),
            contentType: "image/webp",
            height: result.height,
            thumbhash: Buffer.from(
                rgbaToThumbHash(placeholder.width, placeholder.height, placeholder.data),
            ).toString("base64"),
            width: result.width,
        };
    } catch (error: unknown) {
        if (error instanceof ProjectAvatarInputError) throw error;
        throw new ProjectAvatarInputError("The project image does not contain a readable picture.");
    }
}

/**
 * Reads a response body without letting the far end decide how much memory Happy Agent spends. The
 * declared length is checked first, and the stream is cut off the moment it exceeds the bound.
 */
export async function readBoundedResponseBytes(
    response: Response,
    maximumBytes: number,
    controller: AbortController,
): Promise<Buffer> {
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
        controller.abort();
        throw new Error("The remote project image is too large.");
    }
    if (response.body === null) return Buffer.alloc(0);

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let byteLength = 0;
    try {
        for (;;) {
            const next = await reader.read();
            if (next.done) break;
            byteLength += next.value.byteLength;
            if (byteLength > maximumBytes) {
                controller.abort();
                await reader.cancel();
                throw new Error("The remote project image is too large.");
            }
            chunks.push(next.value);
        }
    } finally {
        reader.releaseLock();
    }
    return Buffer.concat(
        chunks.map((chunk) => Buffer.from(chunk)),
        byteLength,
    );
}
