import { TextDecoder } from "node:util";

import type { SessionImageBlock, SessionTextBlock } from "@slopus/happy-providers";

import type { HistoryFileBlock } from "../../history/index.js";
import { getImageProcessor } from "../../impl/images/getImageProcessor.js";
import { ImageProcessingError } from "../../impl/images/ImageProcessingError.js";
import {
    prepareImageForPrompt,
    type PreparedPromptImage,
} from "../../impl/images/prepareImageForPrompt.js";
import { MAX_PROMPT_IMAGE_INPUT_BYTES } from "../../impl/images/referenceImageLimits.js";
import { readFileHead } from "./attachmentFiles.js";
import { formatSize } from "./formatSize.js";

/** Attached pictures up to this size are shown in the message, as on Happy Cloud. */
export const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;
/** Attached UTF-8 text up to this size is shown in the message, as on Happy Cloud. */
export const MAX_INLINE_TEXT_BYTES = 256 * 1024;
/** The longest side and the largest encoding of an image shown to the model. */
const MAX_IMAGE_DIMENSION = 2000;
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
/** JPEG qualities tried at each size, and how far each smaller size shrinks the sides. */
const SMALLER_QUALITIES = [85, 70] as const;
const SMALLER_SCALE = 0.75;
const SMALLEST_SIDE = 256;

/** What of an attached file the model sees in the message itself. */
export type AttachmentModelBody =
    | { readonly type: "image"; readonly image: SessionImageBlock }
    | { readonly type: "text"; readonly text: string }
    | { readonly type: "none" };

/**
 * Read what the model is shown of a stored file in the message: a picture up to 5 MB, sized for
 * a model, or UTF-8 text up to 256 KB. Anything else, or a picture that does not decode, is only
 * named.
 */
export async function readAttachmentModelBody(
    contentPath: string,
    mimeType: string,
    size: number,
): Promise<AttachmentModelBody> {
    if (mimeType.startsWith("image/")) {
        if (size > MAX_INLINE_IMAGE_BYTES) return { type: "none" };
        const image = await prepareAttachmentImage(contentPath, size);
        return "image" in image ? { type: "image", image: image.image } : { type: "none" };
    }
    if (size > MAX_INLINE_TEXT_BYTES) return { type: "none" };
    const text = decodeAttachmentText(await readFileHead(contentPath, size));
    return text === undefined ? { type: "none" } : { type: "text", text };
}

/**
 * What the model reads for one attached file: a line naming it with its ID, then the picture or
 * the text when the message shows them, so it can open the file again with `read_attachment`.
 */
export function attachmentModelInput(
    block: HistoryFileBlock,
    body: AttachmentModelBody,
): readonly (SessionTextBlock | SessionImageBlock)[] {
    const named = `Attachment ${block.attachment}: ${JSON.stringify(block.name)}, ${block.mimeType}, ${formatSize(block.size)}.`;
    switch (body.type) {
        case "image":
            return [
                {
                    type: "text",
                    text: `[${named} It is shown below; read_attachment opens it again or saves a copy.]`,
                },
                body.image,
            ];
        case "text":
            return [
                {
                    type: "text",
                    text: `[${named} Its text follows; read_attachment reads it by line or saves a copy.]\n<file name="${escapeAttribute(block.name)}">\n${body.text}${body.text.endsWith("\n") ? "" : "\n"}</file>`,
                },
            ];
        case "none":
            return [{ type: "text", text: `[${named} Open it with read_attachment.]` }];
    }
}

/** An attached picture sized for a model, or why it cannot be shown. */
export async function prepareAttachmentImage(
    contentPath: string,
    size: number,
): Promise<{ readonly image: SessionImageBlock } | { readonly note: string }> {
    if (size > MAX_PROMPT_IMAGE_INPUT_BYTES) return { note: "This image is too large to show." };
    try {
        const prepared = await prepareImageForPrompt(await readFileHead(contentPath, size), {
            maxDimension: MAX_IMAGE_DIMENSION,
            maxPatches: Number.POSITIVE_INFINITY,
        });
        const fitted = await fitImageBytes(prepared);
        if (fitted === undefined) {
            return { note: "This image is too large to show, even scaled down." };
        }
        return {
            image: {
                type: "image",
                data: fitted.bytes.toString("base64"),
                mimeType: fitted.mediaType,
            },
        };
    } catch (error: unknown) {
        if (!(error instanceof ImageProcessingError)) throw error;
        return { note: `This image cannot be shown. ${error.message}` };
    }
}

/**
 * A prepared picture within the byte budget. One already within it is kept as it is; a larger one,
 * such as a detailed PNG that fits the longest side, is encoded as JPEG, at lower quality and then
 * at smaller sizes, until it fits. JPEG because every provider that takes images accepts it, where
 * Grok takes only JPEG and PNG. The encoding keeps no EXIF orientation, so the pixels are turned
 * upright first and every size is measured upright. Undefined only when even the smallest size
 * does not fit.
 */
async function fitImageBytes(
    prepared: PreparedPromptImage,
): Promise<{ readonly bytes: Buffer; readonly mediaType: string } | undefined> {
    if (prepared.bytes.byteLength <= MAX_IMAGE_BYTES) return prepared;
    const processor = await getImageProcessor();
    const maxPixels = prepared.width * prepared.height;
    const upright = await processor.metadata(prepared.bytes, { autoOrient: true, maxPixels });
    let width = upright.width;
    let height = upright.height;
    for (;;) {
        for (const quality of SMALLER_QUALITIES) {
            const encoded = await processor.encode(prepared.bytes, {
                autoOrient: true,
                format: "jpeg",
                quality,
                maxPixels,
                ...(width === upright.width
                    ? {}
                    : {
                          resize: {
                              filter: "lanczos3" as const,
                              fit: "fill" as const,
                              width,
                              height,
                          },
                      }),
            });
            if (encoded.data.byteLength <= MAX_IMAGE_BYTES) {
                return { bytes: encoded.data, mediaType: "image/jpeg" };
            }
        }
        if (Math.max(width, height) <= SMALLEST_SIDE) return undefined;
        width = Math.max(1, Math.round(width * SMALLER_SCALE));
        height = Math.max(1, Math.round(height * SMALLER_SCALE));
    }
}

/** The bytes as UTF-8 text, or `undefined` when they are not valid UTF-8 or hold a NUL. */
export function decodeAttachmentText(bytes: Uint8Array): string | undefined {
    if (bytes.includes(0)) return undefined;
    try {
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
        return undefined;
    }
}

function escapeAttribute(value: string): string {
    return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}
