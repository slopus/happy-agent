import type { GeminiGeneratedMedia } from "../Gemini.js";
import { resolveGeminiImageRequest, type GeminiImageMimeType } from "../GeminiImageModels.js";
import { extractGeminiGeneratedMedia } from "./extractGeminiGeneratedMedia.js";
import { requestGeminiInteraction } from "./requestGeminiInteraction.js";

const IMAGE_RESPONSE_LIMIT_BYTES = 64 * 1024 * 1024;
const IMAGE_TIMEOUT_MS = 2 * 60 * 1000;

/** One image a generation is built from, already decoded and proven by the image pipeline. */
export interface GeminiReferenceImage {
    readonly base64: string;
    readonly mimeType: string;
}

export interface GenerateGeminiImageOptions {
    apiKey: string;
    aspectRatio?: string;
    fetch?: typeof fetch;
    imageSize?: string;
    /** The encoding to ask Gemini for; it decides the default when this is absent. */
    mimeType?: GeminiImageMimeType;
    /** Which image model answers. Defaults to the catalog's default model. */
    model?: string;
    prompt: string;
    /** Images the new image is built from, for editing, composition, or style. */
    referenceImages?: readonly GeminiReferenceImage[];
    signal?: AbortSignal;
}

/**
 * One image from a Gemini image model, as bytes and whatever Gemini wrote about them.
 *
 * The arguments are checked against the chosen model's own published limits first, so a ratio or
 * resolution that model cannot produce is refused before a generation is billed. Reference images
 * travel in the same `input` array as the prompt, which is how the Interactions API expresses
 * editing: text first, then the images the result is built from.
 */
export async function generateGeminiImage(
    options: GenerateGeminiImageOptions,
): Promise<GeminiGeneratedMedia> {
    const model = resolveGeminiImageRequest({
        ...(options.model === undefined ? {} : { model: options.model }),
        ...(options.aspectRatio === undefined ? {} : { aspectRatio: options.aspectRatio }),
        ...(options.imageSize === undefined ? {} : { imageSize: options.imageSize }),
    });
    const references = options.referenceImages ?? [];
    if (references.length > model.maxReferenceImages) {
        throw new Error(
            `${model.name} accepts up to ${String(model.maxReferenceImages)} reference images, but ${String(references.length)} were given.`,
        );
    }
    const response = await requestGeminiInteraction({
        apiKey: options.apiKey,
        body: {
            input: [
                { type: "text", text: options.prompt },
                ...references.map((image) => ({
                    type: "image",
                    mime_type: image.mimeType,
                    data: image.base64,
                })),
            ],
            model: model.id,
            response_format: {
                type: "image",
                ...(options.mimeType === undefined ? {} : { mime_type: options.mimeType }),
                ...(options.aspectRatio === undefined ? {} : { aspect_ratio: options.aspectRatio }),
                ...(options.imageSize === undefined ? {} : { image_size: options.imageSize }),
            },
        },
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        maximumResponseBytes: IMAGE_RESPONSE_LIMIT_BYTES,
        operation: "image generation",
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        timeoutMs: IMAGE_TIMEOUT_MS,
    });
    return extractGeminiGeneratedMedia(response, "image");
}
