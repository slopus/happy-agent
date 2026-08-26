import { getImageProcessor } from "./getImageProcessor.js";
import type { SupportedImageFormat } from "./ImageProcessor.js";

const MAX_DECODED_PIXELS = 40_000_000;

/** The formats a provider may hand back as a generated image. */
export type GeneratedImageFormat = Extract<SupportedImageFormat, "jpeg" | "png">;

/** One validated image: its bytes, and the format the decoder actually found in them. */
export interface ValidatedImage {
    readonly bytes: Buffer;
    readonly format: GeneratedImageFormat;
    readonly mediaType: `image/${GeneratedImageFormat}`;
}

/** How a format reads in a sentence written for a person. */
const FORMAT_NAMES: Readonly<Record<string, string>> = {
    gif: "GIF",
    jpeg: "JPEG",
    png: "PNG",
    tiff: "TIFF",
    webp: "WebP",
};

/** The name a person would use for a format the decoder reported. */
function formatName(format: string): string {
    return FORMAT_NAMES[format] ?? format.toUpperCase();
}

/**
 * The provider's answer, proven to be a real image before it becomes a file.
 *
 * What comes back over the network is written into a folder people browse and handed to the model
 * as an image, so the bytes are decoded rather than inspected: the runtime image processor reads
 * the picture and reports what it actually is. Nothing here reads magic bytes or believes the MIME
 * type the provider declared — a file that cannot be decoded is not an image, and a file that
 * decodes to something the caller does not accept is the wrong one. The format comes from the
 * decoder, so the file this becomes always carries the extension of its real contents.
 */
export async function decodeAndValidateImage(
    base64: string,
    accepted: readonly GeneratedImageFormat[],
): Promise<ValidatedImage> {
    const names = accepted.map(formatName).join(" or ");
    const normalized = base64.trim();
    if (
        normalized.length === 0 ||
        normalized.length % 4 !== 0 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(normalized)
    ) {
        throw new Error("The image provider returned invalid base64 image data.");
    }
    const bytes = Buffer.from(normalized, "base64");
    if (bytes.toString("base64") !== normalized) {
        throw new Error("The image provider returned invalid base64 image data.");
    }

    const processor = await getImageProcessor();
    const options = { autoOrient: false, maxPixels: MAX_DECODED_PIXELS };
    let format: string;
    try {
        format = (await processor.metadata(bytes, options)).format;
        // Metadata alone can be read from a header that the rest of the file does not honour, so
        // the picture is decoded in full before these bytes are published anywhere.
        await processor.validate(bytes, options);
    } catch (error) {
        throw new Error(`The image provider returned data that is not a ${names} image.`, {
            cause: error,
        });
    }
    const decoded = accepted.find((candidate) => candidate === format);
    if (decoded === undefined) {
        throw new Error(
            `The image provider returned a ${formatName(format)} image, but only ${names} is accepted.`,
        );
    }
    return { bytes, format: decoded, mediaType: `image/${decoded}` };
}
