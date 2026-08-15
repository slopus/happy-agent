import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import {
    imageAgentIdSchema,
    imageContextSchema,
    imageDimensionSchema,
    imageFingerprintSchema,
    imageGenerationOptionsSchema,
    imageMediaTypeSchema,
    imageOperationIdSchema,
    imagePromptSchema,
    imageMetadataSchema,
    MAX_IMAGE_OUTPUT_BYTES,
} from "./ImageGeneration.js";

/** The provider request after the feature adds its durable identity and normalized input. */
export const imageGeneratorRequestSchema = Type.Object(
    {
        agentId: imageAgentIdSchema,
        operationId: imageOperationIdSchema,
        fingerprint: imageFingerprintSchema,
        prompt: imagePromptSchema,
        options: Type.Optional(imageGenerationOptionsSchema),
    },
    { additionalProperties: false },
);

/** Bounded bytes and protocol-safe metadata returned by a host provider. */
export const generatedImageSchema = Type.Object(
    {
        bytes: Type.Uint8Array({
            minByteLength: 1,
            maxByteLength: MAX_IMAGE_OUTPUT_BYTES,
        }),
        mediaType: imageMediaTypeSchema,
        width: Type.Optional(imageDimensionSchema),
        height: Type.Optional(imageDimensionSchema),
        metadata: Type.Optional(imageMetadataSchema),
    },
    { additionalProperties: false },
);

const generatedImagePromiseSchema = Type.Promise(generatedImageSchema);

/**
 * A narrow host provider boundary. Account routing, SDKs, and network clients remain host-owned;
 * the feature supplies only context plus a bounded request.
 */
export const imageGeneratorSchema = Type.Object(
    {
        generate: Type.Function(
            [imageContextSchema, imageGeneratorRequestSchema],
            generatedImagePromiseSchema,
        ),
    },
    { additionalProperties: false },
);

export type ImageGeneratorRequest = Static<typeof imageGeneratorRequestSchema>;
export type GeneratedImage = Static<typeof generatedImageSchema>;
export type ImageGenerator = Static<typeof imageGeneratorSchema>;

export function assertGeneratedImage(value: unknown): asserts value is GeneratedImage {
    if (!Value.Check(generatedImageSchema, value)) {
        throw new Error("Image generator returned invalid image data.");
    }
}
