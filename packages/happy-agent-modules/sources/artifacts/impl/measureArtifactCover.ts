import { getImageProcessor } from "../../impl/images/getImageProcessor.js";
import type { ArtifactCover, ArtifactFile } from "../Artifact.js";
import { formatBytes } from "../ArtifactTypes.js";
import { readArtifactContent } from "./artifactContentFiles.js";

/**
 * The image formats a cover may be, by media type, with the name people know each by and the
 * format the decoder reports. Covers are raster images, because not every client can draw an SVG.
 */
const COVER_FORMATS: Readonly<
    Record<string, { readonly label: string; readonly decoded: string }>
> = {
    "image/png": { label: "PNG", decoded: "png" },
    "image/jpeg": { label: "JPEG", decoded: "jpeg" },
    "image/webp": { label: "WebP", decoded: "webp" },
    "image/gif": { label: "GIF", decoded: "gif" },
};

/**
 * The shapes a cover may have, so every client lays it out the same way: each with its ratio, the
 * size it is best drawn at, and the smallest it may be. The set may grow.
 */
const COVER_ASPECTS = [
    { aspect: "wide", ratio: 16 / 9, best: "1600×900", minWidth: 960, minHeight: 540 },
    { aspect: "square", ratio: 1, best: "1200×1200", minWidth: 720, minHeight: 720 },
] as const;
/** How far a cover's width divided by its height may be from its shape's ratio. */
const ASPECT_TOLERANCE = 0.02;
/** The longest side a cover may have, in pixels. */
export const MAX_ARTIFACT_COVER_SIDE = 4096;
/** The largest file a cover may be: an image artifact's own limit, so any image can be one. */
export const MAX_ARTIFACT_COVER_BYTES = 32 * 1024 * 1024;

const MAX_DECODED_PIXELS = 100_000_000;
const SIZE_ADVICE =
    'A cover is either 16:9 ("wide", best 1600×900, at least 960×540) or square ("square", best 1200×1200, at least 720×720), at most 4096 pixels a side.';

/**
 * Decode one file of a version as a cover and check it against the cover rules: its media type,
 * its size, and its pixel dimensions. Returns the cover, or why the file cannot be one in words
 * that name the file. The dimensions are the picture as shown, after any EXIF rotation.
 */
export async function measureArtifactCover(
    file: ArtifactFile,
    contentPath: string,
): Promise<{ readonly cover: ArtifactCover } | { readonly problem: string }> {
    const name = JSON.stringify(file.path);
    const format = COVER_FORMATS[file.mimeType];
    if (file.mimeType === "image/svg+xml") {
        return {
            problem: `${name} is an SVG, and not every client can draw one, so a cover must be a PNG, JPEG, WebP, or GIF image. Render the SVG to a PNG or WebP of at least 1600 pixels wide first, for example with rsvg-convert, a headless browser, or a script, and name that file as the cover.`,
        };
    }
    if (format === undefined) {
        return {
            problem: `${name} is a ${file.mimeType} file; a cover must be a PNG, JPEG, WebP, or GIF image, named by its extension.`,
        };
    }
    if (file.size > MAX_ARTIFACT_COVER_BYTES) {
        return {
            problem: `${name} is larger than the ${formatBytes(MAX_ARTIFACT_COVER_BYTES)} a cover may be.`,
        };
    }
    const bytes = await readArtifactContent(contentPath, 0, file.size);
    const size = await readRasterSize(bytes, format.decoded);
    if (size === undefined) {
        return { problem: `${name} could not be read as a ${format.label} image.` };
    }
    const { width, height } = size;
    const pixels = `${name} is ${String(width)}×${String(height)} pixels`;
    const shape = COVER_ASPECTS.find(
        (candidate) => Math.abs(width / height / candidate.ratio - 1) <= ASPECT_TOLERANCE,
    );
    if (shape === undefined) {
        return { problem: `${pixels}, which is neither 16:9 nor square. ${SIZE_ADVICE}` };
    }
    if (width < shape.minWidth || height < shape.minHeight) {
        return {
            problem: `${pixels}, too small for a ${shape.aspect} cover. ${SIZE_ADVICE}`,
        };
    }
    if (width > MAX_ARTIFACT_COVER_SIDE || height > MAX_ARTIFACT_COVER_SIDE) {
        return { problem: `${pixels}, too large. ${SIZE_ADVICE}` };
    }
    return {
        cover: { path: file.path, mimeType: file.mimeType, width, height, aspect: shape.aspect },
    };
}

/** A raster image's size as shown, when it decodes as the format its name says. */
async function readRasterSize(
    bytes: Uint8Array,
    format: string,
): Promise<{ readonly width: number; readonly height: number } | undefined> {
    try {
        const processor = await getImageProcessor();
        const metadata = await processor.metadata(bytes, {
            autoOrient: true,
            maxPixels: MAX_DECODED_PIXELS,
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
