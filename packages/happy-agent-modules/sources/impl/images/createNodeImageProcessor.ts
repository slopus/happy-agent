import type sharp from "sharp";
import type { Sharp } from "sharp";

import type { ImageProcessor, ImageResize, SupportedImageFormat } from "./ImageProcessor.js";

let sharpModule: typeof sharp | undefined;

export function createNodeImageProcessor(): ImageProcessor {
    return {
        async metadata(input, options) {
            const sharp = await loadSharp();
            let image = sharp(input, {
                animated: false,
                failOn: "error",
                limitInputPixels: options.maxPixels,
            });
            if (options.autoOrient) image = image.rotate();
            const metadata = await image.metadata();
            if (
                metadata.width === undefined ||
                metadata.height === undefined ||
                metadata.format === undefined
            ) {
                throw new Error("Image metadata is incomplete.");
            }
            return { format: metadata.format, height: metadata.height, width: metadata.width };
        },
        async validate(input, options) {
            const sharp = await loadSharp();
            let image = sharp(input, {
                animated: false,
                failOn: "error",
                limitInputPixels: options.maxPixels,
            });
            if (options.autoOrient) image = image.rotate();
            await image.stats();
        },
        async encode(input, options) {
            const sharp = await loadSharp();
            let image = sharp(input, {
                animated: false,
                failOn: "error",
                limitInputPixels: options.maxPixels,
            });
            if (options.autoOrient) image = image.rotate();
            if (options.resize !== undefined) image = resize(image, options.resize);
            if (options.preserveMetadata === true) image = image.keepMetadata();
            image = encode(image, options.format, options.quality, options.lossless);
            const result = await image.toBuffer({ resolveWithObject: true });
            return { data: result.data, height: result.info.height, width: result.info.width };
        },
        async rgba(input, options) {
            const sharp = await loadSharp();
            let image = sharp(input, {
                animated: false,
                failOn: "error",
                limitInputPixels: options.maxPixels,
            });
            if (options.autoOrient) image = image.rotate();
            const result = await resize(image, options.resize)
                .ensureAlpha()
                .raw()
                .toBuffer({ resolveWithObject: true });
            return { data: result.data, height: result.info.height, width: result.info.width };
        },
    };
}

async function loadSharp(): Promise<typeof sharp> {
    sharpModule ??= (await import("sharp")).default;
    return sharpModule;
}

function resize(image: Sharp, options: ImageResize): Sharp {
    return image.resize({
        fit: options.fit,
        height: options.height,
        kernel: options.filter === "linear" ? "linear" : "lanczos3",
        width: options.width,
        withoutEnlargement: options.withoutEnlargement,
    });
}

function encode(
    image: Sharp,
    format: SupportedImageFormat,
    quality: number | undefined,
    lossless: boolean | undefined,
): Sharp {
    if (format === "jpeg") return image.jpeg({ quality });
    if (format === "webp") return image.webp({ lossless, quality });
    return image.png();
}
