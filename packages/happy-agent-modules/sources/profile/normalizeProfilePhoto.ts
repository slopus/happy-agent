import { createHash } from "node:crypto";

import { getImageProcessor } from "../impl/images/getImageProcessor.js";
import { rgbaToThumbHash } from "./rgbaToThumbHash.js";

export const MAX_PROFILE_PHOTO_BYTES = 8 * 1024 * 1024;
const MAX_DECODED_PIXELS = 25_000_000;
const ACCEPTED_MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export interface NormalizedProfilePhoto {
    readonly bytes: Buffer;
    readonly contentHash: string;
    readonly contentType: "image/webp";
    readonly height: number;
    readonly thumbhash: string;
    readonly width: number;
}

/** Decode, orient, bound, and strip metadata from an uploaded profile photo. */
export async function normalizeProfilePhoto(
    bytes: Uint8Array,
    declaredContentType: string,
): Promise<NormalizedProfilePhoto> {
    if (!ACCEPTED_MEDIA_TYPES.has(declaredContentType)) {
        throw new Error("The profile photo must be a PNG, JPEG, or WebP image.");
    }
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_PROFILE_PHOTO_BYTES) {
        throw new Error("The profile photo must be no larger than 8 MiB.");
    }

    const input = Buffer.from(bytes);
    const processor = await getImageProcessor();
    const metadata = await processor.metadata(input, {
        autoOrient: true,
        maxPixels: MAX_DECODED_PIXELS,
    });
    const actualContentType =
        metadata.format === "png"
            ? "image/png"
            : metadata.format === "jpeg"
              ? "image/jpeg"
              : metadata.format === "webp"
                ? "image/webp"
                : undefined;
    if (actualContentType === undefined || actualContentType !== declaredContentType) {
        throw new Error("The profile photo does not match its content type.");
    }

    const normalized = await processor.encode(input, {
        autoOrient: true,
        format: "webp",
        maxPixels: MAX_DECODED_PIXELS,
        quality: 82,
        resize: {
            filter: "lanczos3",
            fit: "inside",
            height: 512,
            width: 512,
            withoutEnlargement: true,
        },
    });
    if (
        normalized.width < 1 ||
        normalized.height < 1 ||
        normalized.data.byteLength > MAX_PROFILE_PHOTO_BYTES
    ) {
        throw new Error("The normalized profile photo is invalid.");
    }

    const placeholder = await processor.rgba(normalized.data, {
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
    const thumbhash = Buffer.from(
        rgbaToThumbHash(placeholder.width, placeholder.height, placeholder.data),
    ).toString("base64");

    return {
        bytes: normalized.data,
        contentHash: createHash("sha256").update(normalized.data).digest("hex"),
        contentType: "image/webp",
        height: normalized.height,
        thumbhash,
        width: normalized.width,
    };
}
