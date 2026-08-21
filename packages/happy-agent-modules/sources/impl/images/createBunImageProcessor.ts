import type { ImageProcessor, ImageResize, SupportedImageFormat } from "./ImageProcessor.js";
import { decodePngRgba } from "./decodePngRgba.js";

interface BunImage {
    buffer(): Promise<Buffer>;
    jpeg(options?: { progressive?: boolean; quality?: number }): BunImage;
    metadata(): Promise<{ format: string; height: number; width: number }>;
    png(options?: {
        colors?: number;
        compressionLevel?: number;
        dither?: boolean;
        palette?: boolean;
    }): BunImage;
    resize(
        width: number,
        height?: number,
        options?: { filter?: string; fit?: "fill" | "inside"; withoutEnlargement?: boolean },
    ): BunImage;
    webp(options?: { lossless?: boolean; quality?: number }): BunImage;
}

interface BunImageConstructor {
    backend: "bun" | "system";
    new (input: Uint8Array, options?: { autoOrient?: boolean; maxPixels?: number }): BunImage;
}

export function createBunImageProcessor(): ImageProcessor {
    const Image = bunImage();
    Image.backend = "bun";
    return {
        async metadata(input, options) {
            return await new Image(input, {
                autoOrient: options.autoOrient,
                maxPixels: options.maxPixels,
            }).metadata();
        },
        async validate(input, options) {
            await new Image(input, {
                autoOrient: options.autoOrient,
                maxPixels: options.maxPixels,
            })
                .png()
                .buffer();
        },
        async encode(input, options) {
            let image = new Image(input, {
                // Bun.Image does not retain EXIF orientation on re-encode. Baking it into resized
                // pixels preserves what the person sees when the shared contract asks to retain
                // metadata, while Node can keep the original orientation metadata with Sharp.
                autoOrient: options.autoOrient || options.preserveMetadata === true,
                maxPixels: options.maxPixels,
            });
            if (options.resize !== undefined) image = resize(image, options.resize);
            image = encode(image, options.format, options.quality, options.lossless);
            const data = await image.buffer();
            const metadata = await new Image(data, { maxPixels: options.maxPixels }).metadata();
            return { data, height: metadata.height, width: metadata.width };
        },
        async rgba(input, options) {
            const png = await resize(
                new Image(input, {
                    autoOrient: options.autoOrient,
                    maxPixels: options.maxPixels,
                }),
                options.resize,
            )
                .png({ palette: false })
                .buffer();
            return decodePngRgba(png);
        },
    };
}

function bunImage(): BunImageConstructor {
    const bun = (globalThis as { Bun?: { Image?: unknown } }).Bun;
    if (bun === undefined || typeof bun.Image !== "function") {
        throw new Error("The Bun image runtime is unavailable.");
    }
    return bun.Image as BunImageConstructor;
}

function resize(image: BunImage, options: ImageResize): BunImage {
    return image.resize(options.width, options.height, {
        filter: options.filter,
        fit: options.fit,
        ...(options.withoutEnlargement === undefined
            ? {}
            : { withoutEnlargement: options.withoutEnlargement }),
    });
}

function encode(
    image: BunImage,
    format: SupportedImageFormat,
    quality: number | undefined,
    lossless: boolean | undefined,
): BunImage {
    if (format === "jpeg") return image.jpeg(quality === undefined ? {} : { quality });
    if (format === "webp") {
        return image.webp({
            ...(lossless === undefined ? {} : { lossless }),
            ...(quality === undefined ? {} : { quality }),
        });
    }
    return image.png();
}
