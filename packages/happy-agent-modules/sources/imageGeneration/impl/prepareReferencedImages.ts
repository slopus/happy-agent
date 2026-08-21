import { open, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

import { MAX_EDIT_IMAGES_ENCODED_BYTES, MAX_PROMPT_IMAGE_INPUT_BYTES } from "../ImageGeneration.js";
import { prepareImageForPrompt } from "./prepareImageForPrompt.js";

/**
 * The images an edit is built from, as data URLs.
 *
 * Every path is measured before anything is read, so a directory, a missing file, or a file far too
 * large to send is refused without spending memory on it. The images are then prepared one at a
 * time against a shrinking budget, because five files that each fit on their own can still be far
 * more than one request may carry.
 */
export async function prepareReferencedImages(paths: readonly string[]): Promise<string[]> {
    const references: string[] = [];
    let sourceBytes = 0;
    for (const path of paths) {
        const resolved = resolveImagePath(path);
        const info = await stat(resolved).catch(() => undefined);
        if (info === undefined || !info.isFile()) {
            throw new Error(`Referenced image '${path}' is not a file.`);
        }
        if (info.size > MAX_PROMPT_IMAGE_INPUT_BYTES) {
            throw new Error(`Referenced image '${path}' exceeds the supported image size.`);
        }
        sourceBytes += info.size;
        if (sourceBytes > MAX_PROMPT_IMAGE_INPUT_BYTES) {
            throw new Error("Referenced images exceed the 32 MiB aggregate input limit.");
        }
        references.push(resolved);
    }

    const images: string[] = [];
    let remainingBytes = MAX_PROMPT_IMAGE_INPUT_BYTES;
    for (const reference of references) {
        const bytes = await readBounded(reference, remainingBytes);
        remainingBytes -= bytes.byteLength;
        const image = await prepareImageForPrompt(bytes);
        images.push(`data:${image.mediaType};base64,${image.bytes.toString("base64")}`);
    }
    return images;
}

/** A path as a person would write it: `~` for home, otherwise relative to where Happy Agent runs. */
function resolveImagePath(path: string): string {
    if (path === "~") return homedir();
    if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
    if (isAbsolute(path)) return path;
    return resolve(process.cwd(), path);
}

/**
 * A file read that stops at the budget instead of exceeding it.
 *
 * The size was checked a moment ago, but a file can grow between the check and the read, and the
 * budget shrinks with every image already prepared.
 */
async function readBounded(path: string, maxBytes: number): Promise<Buffer> {
    const handle = await open(path, "r");
    try {
        const size = (await handle.stat()).size;
        const buffer = Buffer.alloc(Math.min(size, maxBytes) + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
        if (bytesRead > maxBytes) {
            throw new Error("Referenced images exceed the 32 MiB aggregate input limit.");
        }
        return buffer.subarray(0, bytesRead);
    } finally {
        await handle.close();
    }
}

/** Encoded images are bounded together as well as apart: the whole request has to be sendable. */
export function assertAggregateImageSize(images: readonly string[]): void {
    const bytes = images.reduce((total, image) => total + Buffer.byteLength(image), 0);
    if (bytes > MAX_EDIT_IMAGES_ENCODED_BYTES) {
        throw new Error("Referenced images exceed the 48 MiB encoded request limit.");
    }
}
