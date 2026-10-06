import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";
import type { FileReadLog } from "../../../impl/FileReadLog.js";
import type { Compute } from "../../Compute.js";
import { computePermissionsForContext } from "../../impl/computePermissionsForContext.js";
import { computeImageSchema } from "../../impl/readImage.js";
import { resolveComputePath } from "../../impl/resolveComputePath.js";
import { kimiEscalationProperties, kimiPathPolicy } from "./impl/kimiPathPolicy.js";

const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const MAX_PIXELS = 40_000_000;

export function kimiReadMediaFileTool(compute: Compute, reads: FileReadLog) {
    return defineAgentTool({
        name: "ReadMediaFile",
        defer: false,
        capabilities: [
            "Read and modify files, run shell commands, inspect images, and manage background processes.",
        ],
        description:
            "Read a PNG, JPEG, WebP, or GIF image from the filesystem. This Bedrock model does not support video; session attachment URLs are unavailable. Source limit: 20 MiB and 40 million decoded pixels. Output limit: 3 MiB. By default images are resized to at most 2048 pixels per edge and delivered as PNG. region selects original-image pixels and preserves crop resolution. full_resolution skips resizing; oversized output returns an error asking for a smaller region. Animated images show their first frame. Original and delivered dimensions are reported; add region offsets when converting crop coordinates to original-image pixels. Re-read generated or edited images before continuing.",
        parameters: Type.Object(
            {
                path: Type.String(),
                region: Type.Optional(
                    Type.Object(
                        {
                            x: Type.Integer({ minimum: 0 }),
                            y: Type.Integer({ minimum: 0 }),
                            width: Type.Integer({ minimum: 1 }),
                            height: Type.Integer({ minimum: 1 }),
                        },
                        { additionalProperties: false },
                    ),
                ),
                full_resolution: Type.Optional(Type.Boolean()),
                ...kimiEscalationProperties,
            },
            { additionalProperties: false },
        ),
        returnType: Type.Object(
            {
                path: Type.String(),
                image: computeImageSchema,
                original_width: Type.Integer(),
                original_height: Type.Integer(),
                width: Type.Integer(),
                height: Type.Integer(),
                region_x: Type.Integer(),
                region_y: Type.Integer(),
            },
            { additionalProperties: false },
        ),
        durable: true,
        reloadable: true,
        transactional: true,
        ...kimiPathPolicy(compute, false, "viewing"),
        execute: async (ctx, args) => {
            const permissions = computePermissionsForContext(ctx);
            const path = resolveComputePath(args.path, compute.cwd, compute.fs.home);
            if (!/\.(png|jpe?g|webp|gif)$/i.test(path))
                throw new Error(
                    "Only PNG, JPEG, WebP, and GIF images are supported. Convert other media to one of these formats first.",
                );
            const stat = await compute.fs.stat(permissions, path);
            if (!stat.isFile) throw new Error("The image path is not a file.");
            if (stat.size > MAX_SOURCE_BYTES)
                throw new Error(
                    "Image source exceeds the 20 MiB limit. Create a smaller copy first.",
                );
            const bytes = await compute.fs.readFileBuffer(permissions, path, {
                maxBytes: MAX_SOURCE_BYTES + 1,
            });
            if (bytes.byteLength > MAX_SOURCE_BYTES)
                throw new Error("Image source exceeds the 20 MiB limit.");
            const sharp = (await import("sharp")).default;
            const source = sharp(Buffer.from(bytes), {
                limitInputPixels: MAX_PIXELS,
                animated: false,
            });
            const metadata = await source.metadata();
            if (!metadata.width || !metadata.height)
                throw new Error("Image dimensions could not be read.");
            if (!["png", "jpeg", "webp", "gif"].includes(metadata.format ?? ""))
                throw new Error("The file is not a supported image format.");
            if (args.region !== undefined) {
                if (
                    args.region.x + args.region.width > metadata.width ||
                    args.region.y + args.region.height > metadata.height
                )
                    throw new Error("The requested region is outside the original image.");
                source.extract({
                    left: args.region.x,
                    top: args.region.y,
                    width: args.region.width,
                    height: args.region.height,
                });
            } else if (args.full_resolution !== true) {
                source.resize({
                    width: 2048,
                    height: 2048,
                    fit: "inside",
                    withoutEnlargement: true,
                });
            }
            const { data, info } = await source.png().toBuffer({ resolveWithObject: true });
            if (data.byteLength > MAX_IMAGE_BYTES)
                throw new Error(
                    "Delivered image exceeds the 3 MiB limit. Select a smaller region or create a smaller copy before reading it.",
                );
            if ((await compute.fs.stat(permissions, path)).mtimeMs !== stat.mtimeMs)
                throw new Error("The image changed while it was being read. Read it again.");
            await reads.record(ctx, path, stat.mtimeMs);
            return {
                path,
                image: {
                    data: data.toString("base64"),
                    mime_type: "image/png",
                    bytes: data.byteLength,
                },
                original_width: metadata.width,
                original_height: metadata.height,
                width: info.width,
                height: info.height,
                region_x: args.region?.x ?? 0,
                region_y: args.region?.y ?? 0,
            };
        },
        toLLM: (result) => [
            {
                type: "text",
                text: `Image ${result.path}: original ${result.original_width}×${result.original_height}, delivered ${result.width}×${result.height}; region offset (${result.region_x}, ${result.region_y}).`,
            },
            { type: "image", data: result.image.data, mimeType: result.image.mime_type },
        ],
    });
}
