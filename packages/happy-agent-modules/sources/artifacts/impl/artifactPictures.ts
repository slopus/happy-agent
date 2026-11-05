import { getImageProcessor } from "../../impl/images/getImageProcessor.js";
import { rgbaToThumbHash } from "../../impl/images/rgbaToThumbHash.js";
import { firstWebpFrame } from "./firstWebpFrame.js";
import { readImageContainerSize } from "./readImageContainerSize.js";

/** The most pixels any artifact picture is decoded at. */
export const MAX_ARTIFACT_DECODED_PIXELS = 100_000_000;

/**
 * A picture's size as shown, when its bytes are the format named. A WebP or GIF may be animated,
 * so its size comes from its container instead of a decoder that would read every frame; any
 * other format is decoded, and its size is after EXIF orientation.
 */
export async function readArtifactPictureSize(
    bytes: Uint8Array,
    format: string,
): Promise<{ readonly width: number; readonly height: number } | undefined> {
    if (format === "webp" || format === "gif") return readImageContainerSize(bytes, format);
    try {
        const processor = await getImageProcessor();
        const metadata = await processor.metadata(bytes, {
            autoOrient: true,
            maxPixels: MAX_ARTIFACT_DECODED_PIXELS,
        });
        if (metadata.format !== format) return undefined;
        if (!Number.isSafeInteger(metadata.width) || !Number.isSafeInteger(metadata.height)) {
            return undefined;
        }
        if (metadata.width < 1 || metadata.height < 1) return undefined;
        return { width: metadata.width, height: metadata.height };
    } catch {
        return undefined;
    }
}

/**
 * The bytes a decoder reads for a picture's first frame. Bun.Image refuses an animated WebP, so
 * one is rewrapped as a still of its first frame; every other format's decoder reads the first
 * frame itself. Undefined when an animated WebP holds no readable frame.
 */
export function artifactStillFrame(bytes: Uint8Array, format: string): Uint8Array | undefined {
    return format === "webp" ? firstWebpFrame(bytes) : bytes;
}

/**
 * The ThumbHash a client draws while a picture loads, from a still fitted to 100×100, in the
 * base64 every other picture's uses. Null when the still does not decode, which only leaves the
 * client its neutral placeholder.
 */
export async function readArtifactThumbHash(still: Uint8Array): Promise<string | null> {
    try {
        const processor = await getImageProcessor();
        const placeholder = await processor.rgba(still, {
            autoOrient: true,
            maxPixels: MAX_ARTIFACT_DECODED_PIXELS,
            resize: {
                filter: "linear",
                fit: "inside",
                height: 100,
                width: 100,
                withoutEnlargement: true,
            },
        });
        return Buffer.from(
            rgbaToThumbHash(placeholder.width, placeholder.height, placeholder.data),
        ).toString("base64");
    } catch {
        return null;
    }
}
