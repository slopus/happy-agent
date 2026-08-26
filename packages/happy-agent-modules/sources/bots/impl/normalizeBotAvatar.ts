import { createHash } from "node:crypto";

import { getImageProcessor } from "../../impl/images/getImageProcessor.js";
import { rgbaToThumbHash } from "../../impl/images/rgbaToThumbHash.js";
import { BotAvatarInputError } from "../BotAvatarInputError.js";
import type { BotAvatarAsset } from "../Bot.js";

export const MAX_BOT_AVATAR_BYTES = 8 * 1024 * 1024;
const MAX_DECODED_PIXELS = 25_000_000;
const ACCEPTED_FORMATS = new Set(["jpeg", "png", "webp"]);

/**
 * Turns whatever picture a bot was given into the one shape the catalog stores: a bounded,
 * oriented, square-fitting WebP addressed by the hash of its own bytes. PNG, JPEG, and WebP are
 * all accepted going in, and every stored bot picture is a WebP coming out.
 */
export async function normalizeBotAvatar(
    bytes: Uint8Array,
    declaredContentType?: "image/jpeg" | "image/png" | "image/webp",
): Promise<BotAvatarAsset> {
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_BOT_AVATAR_BYTES) {
        throw new BotAvatarInputError("The bot image must be no larger than 8 MiB.");
    }
    try {
        const processor = await getImageProcessor();
        const metadata = await processor.metadata(bytes, {
            autoOrient: true,
            maxPixels: MAX_DECODED_PIXELS,
        });
        if (!ACCEPTED_FORMATS.has(metadata.format)) {
            throw new BotAvatarInputError("The bot image must be a PNG, JPEG, or WebP picture.");
        }
        const actualContentType =
            metadata.format === "jpeg"
                ? "image/jpeg"
                : metadata.format === "png"
                  ? "image/png"
                  : "image/webp";
        if (declaredContentType !== undefined && actualContentType !== declaredContentType) {
            throw new BotAvatarInputError("The bot image does not match its content type.");
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
        const contentHash = createHash("sha256").update(result.data).digest("hex");
        return {
            bytes: new Uint8Array(result.data),
            contentHash,
            etag: `"${contentHash}"`,
            height: result.height,
            thumbhash: Buffer.from(
                rgbaToThumbHash(placeholder.width, placeholder.height, placeholder.data),
            ).toString("base64"),
            width: result.width,
        };
    } catch (error: unknown) {
        if (error instanceof BotAvatarInputError) throw error;
        throw new BotAvatarInputError("The bot image does not contain a readable picture.");
    }
}
