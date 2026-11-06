import { createHash } from "node:crypto";
import { mkdir, stat, utimes } from "node:fs/promises";
import { join } from "node:path";

import type {
    SessionContext,
    SessionImageBlock,
    SessionMessage,
    SessionTextBlock,
} from "@slopus/happy-providers";

import { writeGeneratedImageFile } from "../../impl/images/writeGeneratedImageFile.js";

/**
 * How stale a saved image's modification time may get before a request naming it renews it.
 * Pruning only looks for files untouched for half a year, so renewing once a day is plenty and
 * spares a write on every turn.
 */
const TOUCH_AFTER_MS = 24 * 60 * 60 * 1000;

/** File extensions for the image types the reading tools recognize by name. */
const EXTENSIONS: Readonly<Record<string, string>> = {
    "image/bmp": "bmp",
    "image/gif": "gif",
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
};

/** Whether a message carries an image a person or another agent sent, rather than a tool's. */
export function contextHasSentImages(context: SessionContext): boolean {
    return context.messages.some(
        (message) => isSentMessage(message) && message.content.some(isImage),
    );
}

/**
 * The request's context with every image a person or another agent sent replaced by a reference
 * to the file it is saved in.
 *
 * Models see such images by reference: the model opens the file with its own reading tool, which
 * sizes the picture for the provider or says why it cannot. Each image is saved in `directory`
 * under its SHA-256, so every later request names the same file and replays the same text. The
 * file is only a copy of what history holds: one that is missing, because pruning or a person
 * removed it, is written again before the request, and one a request names has its modification
 * time renewed so pruning leaves it alone. History is not changed, and people still see the
 * picture they sent. Images inside tool results are what a reading tool already sized, so they
 * stay inline.
 */
export async function imagesByReference(
    context: SessionContext,
    directory: string,
    now: number = Date.now(),
): Promise<SessionContext> {
    if (!contextHasSentImages(context)) return context;
    const messages: SessionMessage[] = [];
    for (const message of context.messages) {
        if (!isSentMessage(message) || !message.content.some(isImage)) {
            messages.push(message);
            continue;
        }
        const content = [];
        for (const block of message.content) {
            content.push(isImage(block) ? await reference(block, directory, now) : block);
        }
        messages.push({ ...message, content } as SessionMessage);
    }
    return { ...context, messages };
}

async function reference(
    image: SessionImageBlock,
    directory: string,
    now: number,
): Promise<SessionTextBlock> {
    const bytes = Buffer.from(image.data, "base64");
    if (bytes.byteLength === 0)
        return { type: "text", text: "[An empty image was attached here.]" };
    const name = `${createHash("sha256").update(bytes).digest("hex")}.${extensionFor(image.mimeType)}`;
    const path = join(directory, name);
    const saved = await stat(path).catch(() => undefined);
    if (saved?.isFile() !== true || saved.size !== bytes.byteLength) {
        // People's pictures are private, so the cache is readable by its owner only.
        await mkdir(directory, { mode: 0o700, recursive: true });
        await writeGeneratedImageFile(directory, name, bytes);
    } else if (now - saved.mtimeMs > TOUCH_AFTER_MS) {
        const time = new Date(now);
        // A copy pruning removes anyway is written again the next time it is named.
        await utimes(path, time, time).catch(() => undefined);
    }
    return {
        type: "text",
        text: `[Image attached here, saved at ${path} (${image.mimeType}, ${formatSize(bytes.byteLength)}). It is not shown inline; open the file with your file-reading tool to see it.]`,
    };
}

function isSentMessage(
    message: SessionMessage,
): message is Extract<SessionMessage, { readonly role: "user" | "system" | "agent" }> {
    return message.role === "user" || message.role === "system" || message.role === "agent";
}

function isImage(block: { readonly type: string }): block is SessionImageBlock {
    return block.type === "image";
}

function extensionFor(mimeType: string): string {
    const known = EXTENSIONS[mimeType.toLowerCase()];
    if (known !== undefined) return known;
    const subtype = /^image\/([a-z0-9]{1,16})$/iu.exec(mimeType)?.[1];
    return subtype === undefined ? "bin" : subtype.toLowerCase();
}

function formatSize(bytes: number): string {
    if (bytes < 1024) return `${String(bytes)} bytes`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
