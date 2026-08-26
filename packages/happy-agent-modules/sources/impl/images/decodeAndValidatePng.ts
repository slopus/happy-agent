import { getImageProcessor } from "./getImageProcessor.js";

/** The eight bytes every PNG file begins with. */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const MAX_DECODED_PIXELS = 40_000_000;

/**
 * The provider's answer, proven to be a real PNG before it becomes a file.
 *
 * What comes back over the network is written into a folder people browse and handed to the model
 * as an image, so it is checked three times: that the text is base64 at all, that the bytes open
 * with the PNG signature, and that a decoder can actually read the picture inside them.
 */
export async function decodeAndValidatePng(base64: string): Promise<Buffer> {
    const normalized = base64.trim();
    if (
        normalized.length === 0 ||
        normalized.length % 4 !== 0 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(normalized)
    ) {
        throw new Error("The image provider returned invalid base64 image data.");
    }
    const bytes = Buffer.from(normalized, "base64");
    if (
        bytes.toString("base64") !== normalized ||
        bytes.length < PNG_SIGNATURE.length ||
        !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
    ) {
        throw new Error("The image provider returned data that is not a PNG image.");
    }
    try {
        const processor = await getImageProcessor();
        const metadata = await processor.metadata(bytes, {
            autoOrient: false,
            maxPixels: MAX_DECODED_PIXELS,
        });
        if (metadata.format !== "png") {
            throw new Error("The decoded image format is not PNG.");
        }
        await processor.validate(bytes, {
            autoOrient: false,
            maxPixels: MAX_DECODED_PIXELS,
        });
    } catch (error) {
        throw new Error("The image provider returned a malformed PNG image.", { cause: error });
    }
    return bytes;
}
