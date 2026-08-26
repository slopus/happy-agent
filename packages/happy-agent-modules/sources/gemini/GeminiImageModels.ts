/**
 * The Gemini models that generate images, and what each of them accepts.
 *
 * The catalog is written here rather than discovered from the API, because Rig never asks a
 * provider what it offers. Every value comes from Google's Interactions API image-generation
 * reference: the aspect ratios and resolutions below are the exact tables published for each
 * model, so a request Rig sends is one the model documents it can answer.
 */

/** The aspect ratios every image model accepts. */
const COMMON_ASPECT_RATIOS = [
    "1:1",
    "2:3",
    "3:2",
    "3:4",
    "4:3",
    "4:5",
    "5:4",
    "9:16",
    "16:9",
    "21:9",
] as const;

/** The extreme panoramic ratios only Gemini 3.1 Flash Image adds. */
const FLASH_ONLY_ASPECT_RATIOS = ["1:4", "4:1", "1:8", "8:1"] as const;

/** Every aspect ratio any model accepts, which is what the tool schema offers. */
export const GEMINI_ASPECT_RATIOS = [...COMMON_ASPECT_RATIOS, ...FLASH_ONLY_ASPECT_RATIOS] as const;

/** Every resolution any model accepts. Google rejects a lowercase `k`. */
export const GEMINI_IMAGE_SIZES = ["0.5K", "1K", "2K", "4K"] as const;

/** The encodings Gemini will return an image in. */
export const GEMINI_IMAGE_MIME_TYPES = ["image/jpeg", "image/png"] as const;

export type GeminiAspectRatio = (typeof GEMINI_ASPECT_RATIOS)[number];
export type GeminiImageSize = (typeof GEMINI_IMAGE_SIZES)[number];
export type GeminiImageMimeType = (typeof GEMINI_IMAGE_MIME_TYPES)[number];

/** One image model, and the requests it documents that it can answer. */
export interface GeminiImageModel {
    /** The model ID sent to the API. */
    readonly id: string;
    /** How a person would refer to this model. */
    readonly name: string;
    /** What it is for, in one line, shown to the model choosing between them. */
    readonly summary: string;
    readonly aspectRatios: readonly GeminiAspectRatio[];
    /** The resolutions it accepts, or nothing when it generates one fixed size. */
    readonly imageSizes: readonly GeminiImageSize[];
    /** How many reference images it can usefully be given. */
    readonly maxReferenceImages: number;
}

/** The model used when the caller names none. */
export const DEFAULT_GEMINI_IMAGE_MODEL = "gemini-3.1-flash-image";

export const GEMINI_IMAGE_MODELS: readonly GeminiImageModel[] = [
    {
        id: "gemini-3.1-flash-image",
        name: "Nano Banana 2",
        summary:
            "Best all-round quality, speed, and cost. Adds 512px output and the panoramic 1:4, 4:1, 1:8, and 8:1 ratios.",
        aspectRatios: GEMINI_ASPECT_RATIOS,
        imageSizes: GEMINI_IMAGE_SIZES,
        maxReferenceImages: 14,
    },
    {
        id: "gemini-3-pro-image",
        name: "Nano Banana Pro",
        summary:
            "Professional asset production: complex instructions, high-fidelity text, and a reasoning pass before it draws. Slower and more expensive.",
        aspectRatios: COMMON_ASPECT_RATIOS,
        imageSizes: ["1K", "2K", "4K"],
        maxReferenceImages: 14,
    },
    {
        id: "gemini-2.5-flash-image",
        name: "Nano Banana",
        summary:
            "The original, for high-volume low-latency work. Generates one fixed 1024px size, so image_size does not apply.",
        aspectRatios: COMMON_ASPECT_RATIOS,
        imageSizes: [],
        maxReferenceImages: 3,
    },
];

/** The model with this ID, or nothing when Rig does not offer it. */
export function geminiImageModel(id: string): GeminiImageModel | undefined {
    return GEMINI_IMAGE_MODELS.find((model) => model.id === id);
}

/**
 * The chosen model with its arguments checked against what it documents.
 *
 * A ratio or resolution the model does not accept is refused here rather than spent on a request
 * Google would reject, and the message names what that model does accept so the next attempt can
 * succeed.
 */
export function resolveGeminiImageRequest(options: {
    readonly model?: string;
    readonly aspectRatio?: string;
    readonly imageSize?: string;
}): GeminiImageModel {
    const id = options.model ?? DEFAULT_GEMINI_IMAGE_MODEL;
    const model = geminiImageModel(id);
    if (model === undefined) {
        throw new Error(
            `Unknown Gemini image model '${id}'. Available models: ${GEMINI_IMAGE_MODELS.map((candidate) => candidate.id).join(", ")}.`,
        );
    }
    if (
        options.aspectRatio !== undefined &&
        !model.aspectRatios.includes(options.aspectRatio as GeminiAspectRatio)
    ) {
        throw new Error(
            `${model.name} does not support the ${options.aspectRatio} aspect ratio. It supports: ${model.aspectRatios.join(", ")}.`,
        );
    }
    if (options.imageSize !== undefined) {
        if (model.imageSizes.length === 0) {
            throw new Error(
                `${model.name} generates one fixed image size, so image_size cannot be set for it.`,
            );
        }
        if (!model.imageSizes.includes(options.imageSize as GeminiImageSize)) {
            throw new Error(
                `${model.name} does not support the ${options.imageSize} image size. It supports: ${model.imageSizes.join(", ")}.`,
            );
        }
    }
    return model;
}
