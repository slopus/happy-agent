import { readReferenceImages } from "../../impl/images/readReferenceImages.js";
import { MAX_REFERENCE_IMAGES_ENCODED_BYTES } from "../../impl/images/referenceImageLimits.js";

/**
 * The images a Codex edit is built from, as the data URLs that API expects.
 *
 * Reading and normalizing the files is the image pipeline's job and shared with every other vendor;
 * only the data-URL shape below is Codex's own.
 */
export async function prepareReferencedImages(paths: readonly string[]): Promise<string[]> {
    const images = await readReferenceImages(paths);
    return images.map(
        (image) => `data:${image.mediaType};base64,${image.bytes.toString("base64")}`,
    );
}

/** Encoded images are bounded together as well as apart: the whole request has to be sendable. */
export function assertAggregateImageSize(images: readonly string[]): void {
    const bytes = images.reduce((total, image) => total + Buffer.byteLength(image), 0);
    if (bytes > MAX_REFERENCE_IMAGES_ENCODED_BYTES) {
        throw new Error("Referenced images exceed the 48 MiB encoded request limit.");
    }
}
