import { createHash } from "node:crypto";

import type {
    SessionAssistantBlock,
    SessionImageBlock,
    SessionMessage,
} from "@/core/SessionContext.js";

/**
 * Claude Code refuses a whole request, before sending it, when any image in it carries more base64
 * data than this ("Image base64 size (5.5MB) exceeds API limit (5MB)"). It shrinks a new prompt
 * image itself, but not one it resumes from a transcript, and every rebuilt query replays the
 * complete history, so one such image would fail every later turn at once.
 */
export const CLAUDE_IMAGE_BASE64_LIMIT = 5 * 1024 * 1024;

/** An image is shrunk to this much base64, leaving a margin under the limit. */
const CLAUDE_IMAGE_BASE64_TARGET = 4.5 * 1024 * 1024;

/** Claude Code's own bound on the side of an image it sends; larger pictures cost detail anyway. */
const MAX_SIDE = 2000;
const MAX_DECODED_PIXELS = 100_000_000;
const SCALES = [1, 0.75, 0.5, 0.35, 0.25] as const;
const JPEG_QUALITIES = [85, 70, 50] as const;

/** Shrunk images are kept by content so a rebuilt query sends the same bytes without re-encoding. */
const CACHE_MAX_ENTRIES = 64;
const CACHE_MAX_BYTES = 64 * 1024 * 1024;
const cache = new Map<string, { bytes: number; fitted: Promise<SessionImageBlock | undefined> }>();

/**
 * Projects every image over the target onto a smaller copy for this request only: the picture is
 * scaled to fit Claude Code's 2000-pixel bound and re-encoded, smaller and at lower quality in
 * turn, until its base64 fits. Messages without such an image are returned as the same objects,
 * and the caller's history is never changed. An image that cannot be decoded, or a runtime without
 * an image codec, leaves the block as it was for the replay to replace with a note.
 */
export async function fitClaudeImages(
    messages: readonly SessionMessage[],
): Promise<SessionMessage[]> {
    return await Promise.all(messages.map(fitMessage));
}

async function fitMessage(message: SessionMessage): Promise<SessionMessage> {
    switch (message.role) {
        case "compaction":
            return message;
        case "assistant":
            if (!message.content.some(hasOversizedResult)) return message;
            return {
                ...message,
                content: await Promise.all(
                    message.content.map(
                        async (block): Promise<SessionAssistantBlock> =>
                            block.type === "tool_result" && hasOversizedResult(block)
                                ? { ...block, content: await fitBlocks(block.content) }
                                : block,
                    ),
                ),
            };
        case "agent":
            if (!message.content.some(isOversizedImage)) return message;
            return { ...message, content: await fitBlocks(message.content) };
        case "tool":
            if (!message.content.some(isOversizedImage)) return message;
            return { ...message, content: await fitBlocks(message.content) };
        case "user":
        case "system":
            if (!message.content.some(isOversizedImage)) return message;
            return { ...message, content: await fitBlocks(message.content) };
    }
}

function hasOversizedResult(block: SessionAssistantBlock): boolean {
    return block.type === "tool_result" && block.content.some(isOversizedImage);
}

function isOversizedImage(block: { readonly type: string }): block is SessionImageBlock {
    return (
        block.type === "image" &&
        (block as SessionImageBlock).data.length > CLAUDE_IMAGE_BASE64_TARGET
    );
}

async function fitBlocks<Block extends { readonly type: string }>(
    blocks: readonly (Block | SessionImageBlock)[],
): Promise<(Block | SessionImageBlock)[]> {
    return await Promise.all(
        blocks.map(async (block) =>
            isOversizedImage(block) ? ((await fitImage(block)) ?? block) : block,
        ),
    );
}

function fitImage(block: SessionImageBlock): Promise<SessionImageBlock | undefined> {
    const key = createHash("sha256").update(block.data).digest("base64");
    const cached = cache.get(key);
    if (cached !== undefined) {
        cache.delete(key);
        cache.set(key, cached);
        return cached.fitted;
    }
    const entry = { bytes: 0, fitted: shrinkImage(block).catch(() => undefined) };
    cache.set(key, entry);
    trimCache();
    void entry.fitted.then((result) => {
        entry.bytes = result?.data.length ?? 0;
        trimCache();
    });
    return entry.fitted;
}

function trimCache(): void {
    let bytes = 0;
    for (const entry of cache.values()) bytes += entry.bytes;
    for (const [key, entry] of cache) {
        if (cache.size <= CACHE_MAX_ENTRIES && bytes <= CACHE_MAX_BYTES) return;
        cache.delete(key);
        bytes -= entry.bytes;
    }
}

async function shrinkImage(block: SessionImageBlock): Promise<SessionImageBlock | undefined> {
    const Image = bunImage();
    if (Image === undefined) return undefined;
    const input = Buffer.from(block.data, "base64");
    const open = () => new Image(input, { autoOrient: true, maxPixels: MAX_DECODED_PIXELS });
    const { format, width, height } = await open().metadata();
    const bound = Math.min(1, MAX_SIDE / Math.max(width, height));
    const sizeAt = (scale: number) => ({
        width: Math.max(1, Math.round(width * bound * scale)),
        height: Math.max(1, Math.round(height * bound * scale)),
    });

    // A screenshot keeps its crisp lossless pixels when merely bounding it is enough.
    if (format === "png" || format === "webp") {
        const size = sizeAt(1);
        const png = await open().resize(size.width, size.height, { fit: "fill" }).png().buffer();
        if (fits(png))
            return { type: "image", mimeType: "image/png", data: png.toString("base64") };
    }
    for (const scale of SCALES) {
        const size = sizeAt(scale);
        for (const quality of JPEG_QUALITIES) {
            const jpeg = await open()
                .resize(size.width, size.height, { fit: "fill" })
                .jpeg({ quality })
                .buffer();
            if (fits(jpeg)) {
                return { type: "image", mimeType: "image/jpeg", data: jpeg.toString("base64") };
            }
        }
    }
    return undefined;
}

function fits(bytes: Buffer): boolean {
    return Math.ceil(bytes.length / 3) * 4 <= CLAUDE_IMAGE_BASE64_TARGET;
}

interface BunImage {
    buffer(): Promise<Buffer>;
    jpeg(options: { quality: number }): BunImage;
    metadata(): Promise<{ format: string; height: number; width: number }>;
    png(): BunImage;
    resize(width: number, height: number, options: { fit: "fill" }): BunImage;
}

type BunImageConstructor = new (
    input: Uint8Array,
    options: { autoOrient: boolean; maxPixels: number },
) => BunImage;

/** Bun, which Happy ships on, decodes images natively; other runtimes leave images unshrunk. */
function bunImage(): BunImageConstructor | undefined {
    const image = (globalThis as { Bun?: { Image?: unknown } }).Bun?.Image;
    return typeof image === "function" ? (image as BunImageConstructor) : undefined;
}
