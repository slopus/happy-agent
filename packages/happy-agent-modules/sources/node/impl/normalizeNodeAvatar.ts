import { createHash } from "node:crypto";
import { getImageProcessor } from "../../impl/images/getImageProcessor.js";
import { rgbaToThumbHash } from "../../impl/images/rgbaToThumbHash.js";
import { MAX_NODE_AVATAR_BYTES, type NodeAvatarAsset } from "../NodeState.js";

/** Decode with a hard pixel bound, then retain only one small, oriented WebP and its placeholder. */
export async function normalizeNodeAvatar(bytes: Uint8Array): Promise<NodeAvatarAsset> {
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_NODE_AVATAR_BYTES) {
        throw new Error("The node avatar must be a nonempty image no larger than 8 MiB.");
    }
    try {
        const processor = await getImageProcessor();
        const options = { autoOrient: true, maxPixels: 40_000_000 };
        const metadata = await processor.metadata(bytes, options);
        if (!["jpeg", "png", "webp"].includes(metadata.format))
            throw new Error("Unsupported image format.");
        const image = await processor.encode(bytes, {
            ...options,
            format: "webp",
            quality: 82,
            resize: {
                filter: "lanczos3",
                fit: "inside",
                width: 256,
                height: 256,
                withoutEnlargement: true,
            },
        });
        const rgba = await processor.rgba(image.data, {
            autoOrient: false,
            maxPixels: 40_000_000,
            resize: {
                filter: "lanczos3",
                fit: "inside",
                width: 100,
                height: 100,
                withoutEnlargement: true,
            },
        });
        return {
            data: image.data.toString("base64"),
            thumbhash: Buffer.from(rgbaToThumbHash(rgba.width, rgba.height, rgba.data)).toString(
                "base64",
            ),
            etag: `"${createHash("sha256").update(image.data).digest("hex")}"`,
        };
    } catch {
        throw new Error(
            "The node avatar must be a readable PNG, JPEG, or WebP with at most 40 million pixels.",
        );
    }
}
