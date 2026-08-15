import { Type, type Static } from "@sinclair/typebox";
import type { Context } from "@steve.kite/stdlib";

/**
 * Image generation is deliberately provider-neutral. The host chooses the provider, account,
 * serving URL, and persistent media location; this package only transports bounded metadata and
 * opaque identities.
 */
export const MAX_IMAGE_PROMPT_CHARACTERS = 8_000;
export const MAX_IMAGE_OPTIONS_CHARACTERS = 8_000;
export const MAX_IMAGE_METADATA_CHARACTERS = 8_000;
export const MAX_IMAGE_OUTPUT_BYTES = 50 * 1024 * 1024;
export const MAX_IMAGE_OUTPUT_CHARACTERS = 12_000;
/** Canonical operation input is bounded before it is hashed or compared. */
export const MAX_IMAGE_OPERATION_CANONICAL_DEPTH = 8;
export const MAX_IMAGE_OPERATION_CANONICAL_BYTES = 64 * 1024;
/**
 * Operation, agent, asset, and staging identities stay short enough for a
 * compact completed-generation result to retain every actionable identity at
 * the minimum model output budget. 48 characters still admits UUID-shaped
 * host identities.
 */
export const MAX_IMAGE_ID_CHARACTERS = 48;
/**
 * Locators are opaque but must remain renderable alongside the operation,
 * asset, and media identities in a 256-character model result.
 */
export const MAX_IMAGE_LOCATOR_CHARACTERS = 80;
export const MAX_IMAGE_ERROR_CHARACTERS = 2_000;
export const MAX_IMAGE_METADATA_PROPERTIES = 32;
export const MAX_IMAGE_METADATA_VALUE_CHARACTERS = 1_024;

/** Context is host-owned and opaque, but injected callbacks still require an object boundary. */
export const imageContextSchema = Type.Unsafe<Context>(
    Type.Object({}, { additionalProperties: true }),
);

export const imageAgentIdSchema = Type.String({
    minLength: 1,
    maxLength: MAX_IMAGE_ID_CHARACTERS,
    pattern: "^[^\\u0000\\r\\n]+$",
});

export const imageOperationIdSchema = Type.String({
    minLength: 1,
    maxLength: MAX_IMAGE_ID_CHARACTERS,
    pattern: "^[^\\u0000\\r\\n]+$",
});

export const imageAssetIdSchema = Type.String({
    minLength: 1,
    maxLength: MAX_IMAGE_ID_CHARACTERS,
    pattern: "^[^\\u0000\\r\\n]+$",
});

export const imageStageIdSchema = Type.String({
    minLength: 1,
    maxLength: MAX_IMAGE_ID_CHARACTERS,
    pattern: "^[^\\u0000\\r\\n]+$",
});

export const imageFingerprintSchema = Type.String({
    minLength: 64,
    maxLength: 64,
    pattern: "^[a-f0-9]{64}$",
});

export const imagePromptSchema = Type.String({
    minLength: 1,
    maxLength: MAX_IMAGE_PROMPT_CHARACTERS,
});

export const imageMediaTypeSchema = Type.String({
    minLength: 7,
    maxLength: 32,
    pattern: "^image/[A-Za-z0-9.+-]+$",
});

/**
 * An opaque, host-owned locator. It may be an authenticated URL, protocol reference, or another
 * serving handle. It is never interpreted as a path by the feature.
 */
export const imageAssetLocatorSchema = Type.String({
    minLength: 1,
    maxLength: MAX_IMAGE_LOCATOR_CHARACTERS,
    pattern: "^[^\\u0000\\r\\n]+$",
});

export const imageDimensionSchema = Type.Integer({
    minimum: 1,
    maximum: 100_000,
});

const imageMetadataKeySchema = Type.String({
    minLength: 1,
    maxLength: 128,
    pattern: "^[^\\u0000\\r\\n]+$",
});

const imageMetadataValueSchema = Type.Union([
    Type.String({ maxLength: MAX_IMAGE_METADATA_VALUE_CHARACTERS }),
    Type.Number(),
    Type.Boolean(),
    Type.Null(),
]);

/**
 * Metadata is intentionally flat and primitive. This gives hosts useful protocol-safe details
 * while making the total size and validation cost explicit.
 */
export const imageMetadataSchema = Type.Record(imageMetadataKeySchema, imageMetadataValueSchema, {
    maxProperties: MAX_IMAGE_METADATA_PROPERTIES,
});

/**
 * Generation options are provider-neutral hints. A host may ignore a hint, but an adapter may not
 * smuggle an unbounded provider request through this feature.
 */
export const imageGenerationOptionsSchema = Type.Object(
    {
        size: Type.Optional(
            Type.String({
                minLength: 1,
                maxLength: 64,
                pattern: "^[^\\u0000\\r\\n]+$",
            }),
        ),
        width: Type.Optional(imageDimensionSchema),
        height: Type.Optional(imageDimensionSchema),
        aspectRatio: Type.Optional(
            Type.String({
                minLength: 1,
                maxLength: 32,
                pattern: "^[^\\u0000\\r\\n]+$",
            }),
        ),
        quality: Type.Optional(
            Type.Union([Type.Literal("draft"), Type.Literal("standard"), Type.Literal("high")]),
        ),
        style: Type.Optional(
            Type.String({
                maxLength: 512,
                pattern: "^[^\\u0000\\r\\n]*$",
            }),
        ),
        seed: Type.Optional(Type.Integer({ minimum: 0, maximum: 2_147_483_647 })),
    },
    { additionalProperties: false },
);

/** Public generation input. The model cannot provide an operation identity. */
export const imageGenerationToolInputSchema = Type.Object(
    {
        prompt: imagePromptSchema,
        options: Type.Optional(imageGenerationOptionsSchema),
    },
    { additionalProperties: false },
);

/**
 * Host callers may provide an operation identity they own. When omitted, the feature allocates
 * one from the configured factory, or from call-scoped Agent KV for the durable common tool.
 */
export const imageGenerationInputSchema = Type.Object(
    {
        prompt: imagePromptSchema,
        options: Type.Optional(imageGenerationOptionsSchema),
        operationId: Type.Optional(imageOperationIdSchema),
    },
    { additionalProperties: false },
);

/** The exact normalized request persisted in a host receipt and status record. */
export const imageGenerationRequestSchema = Type.Object(
    {
        agentId: imageAgentIdSchema,
        operationId: imageOperationIdSchema,
        prompt: imagePromptSchema,
        options: Type.Optional(imageGenerationOptionsSchema),
    },
    { additionalProperties: false },
);

export const imageGenerationStatusKindSchema = Type.Union([
    Type.Literal("pending"),
    Type.Literal("completed"),
    Type.Literal("failed"),
]);

const imageGenerationStatusIdentity = {
    operationId: imageOperationIdSchema,
    agentId: imageAgentIdSchema,
    fingerprint: imageFingerprintSchema,
    prompt: imagePromptSchema,
    options: Type.Optional(imageGenerationOptionsSchema),
};

export const imageAssetSchema = Type.Object(
    {
        id: imageAssetIdSchema,
        /** Asset ownership is part of the host result, not inferred from a query. */
        agentId: imageAgentIdSchema,
        operationId: imageOperationIdSchema,
        mediaType: imageMediaTypeSchema,
        byteLength: Type.Integer({ minimum: 1, maximum: MAX_IMAGE_OUTPUT_BYTES }),
        locator: imageAssetLocatorSchema,
        width: Type.Optional(imageDimensionSchema),
        height: Type.Optional(imageDimensionSchema),
        metadata: Type.Optional(imageMetadataSchema),
    },
    { additionalProperties: false },
);

const imageGenerationPendingSchema = Type.Object(
    {
        ...imageGenerationStatusIdentity,
        status: Type.Literal("pending"),
        createdAt: Type.Integer({ minimum: 0 }),
        updatedAt: Type.Integer({ minimum: 0 }),
    },
    { additionalProperties: false },
);

const imageGenerationCompletedSchema = Type.Object(
    {
        ...imageGenerationStatusIdentity,
        status: Type.Literal("completed"),
        createdAt: Type.Integer({ minimum: 0 }),
        updatedAt: Type.Integer({ minimum: 0 }),
        asset: imageAssetSchema,
    },
    { additionalProperties: false },
);

const imageGenerationFailedSchema = Type.Object(
    {
        ...imageGenerationStatusIdentity,
        status: Type.Literal("failed"),
        createdAt: Type.Integer({ minimum: 0 }),
        updatedAt: Type.Integer({ minimum: 0 }),
        error: Type.String({
            minLength: 1,
            maxLength: MAX_IMAGE_ERROR_CHARACTERS,
        }),
    },
    { additionalProperties: false },
);

export const imageGenerationStatusSchema = Type.Union([
    imageGenerationPendingSchema,
    imageGenerationCompletedSchema,
    imageGenerationFailedSchema,
]);

export const imageGenerationStatusResultSchema = Type.Union([
    imageGenerationStatusSchema,
    Type.Undefined(),
    Type.Null(),
]);

export const imageGenerationStatusQuerySchema = Type.Object(
    {
        agentId: imageAgentIdSchema,
        operationId: imageOperationIdSchema,
    },
    { additionalProperties: false },
);

export const imageAssetQuerySchema = Type.Object(
    {
        agentId: imageAgentIdSchema,
        assetId: imageAssetIdSchema,
    },
    { additionalProperties: false },
);

/** Bytes enter the host-owned staging boundary and never enter the durable catalog result. */
export const imageGenerationStageInputSchema = Type.Object(
    {
        agentId: imageAgentIdSchema,
        operationId: imageOperationIdSchema,
        fingerprint: imageFingerprintSchema,
        prompt: imagePromptSchema,
        options: Type.Optional(imageGenerationOptionsSchema),
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

/** A stage handle is opaque to the feature and carries only bounded integrity metadata. */
export const imageGenerationStageSchema = Type.Object(
    {
        stageId: imageStageIdSchema,
        agentId: imageAgentIdSchema,
        operationId: imageOperationIdSchema,
        fingerprint: imageFingerprintSchema,
        mediaType: imageMediaTypeSchema,
        byteLength: Type.Integer({ minimum: 1, maximum: MAX_IMAGE_OUTPUT_BYTES }),
        width: Type.Optional(imageDimensionSchema),
        height: Type.Optional(imageDimensionSchema),
        metadata: Type.Optional(imageMetadataSchema),
    },
    { additionalProperties: false },
);

/** The host's catalog mutation request references staged data without exposing paths. */
export const imageAssetWriteInputSchema = Type.Object(
    {
        agentId: imageAgentIdSchema,
        operationId: imageOperationIdSchema,
        fingerprint: imageFingerprintSchema,
        prompt: imagePromptSchema,
        options: Type.Optional(imageGenerationOptionsSchema),
        stage: imageGenerationStageSchema,
    },
    { additionalProperties: false },
);

export const imageGenerationCreateResultSchema = imageGenerationStatusSchema;

/** Durable host receipt used to make retries exact and replay-safe. */
export const imageGenerationReceiptSchema = Type.Object(
    {
        agentId: imageAgentIdSchema,
        operationId: imageOperationIdSchema,
        fingerprint: imageFingerprintSchema,
        prompt: imagePromptSchema,
        options: Type.Optional(imageGenerationOptionsSchema),
        result: imageGenerationStatusSchema,
    },
    { additionalProperties: false },
);

/**
 * An independent immutable proof of a completed generation.
 *
 * The mutable receipt is the retry-facing record.  The proof is the host's
 * append-only tombstone for the exact result, including asset metadata that
 * must remain replayable after the mutable asset and operation rows are
 * removed.
 */
export const imageGenerationProofSchema = Type.Object(
    {
        agentId: imageAgentIdSchema,
        operationId: imageOperationIdSchema,
        fingerprint: imageFingerprintSchema,
        prompt: imagePromptSchema,
        options: Type.Optional(imageGenerationOptionsSchema),
        result: imageGenerationStatusSchema,
    },
    { additionalProperties: false },
);

export type ImageAgentId = Static<typeof imageAgentIdSchema>;
export type ImageOperationId = Static<typeof imageOperationIdSchema>;
export type ImageAssetId = Static<typeof imageAssetIdSchema>;
export type ImageStageId = Static<typeof imageStageIdSchema>;
export type ImageFingerprint = Static<typeof imageFingerprintSchema>;
export type ImagePrompt = Static<typeof imagePromptSchema>;
export type ImageMediaType = Static<typeof imageMediaTypeSchema>;
export type ImageMetadata = Static<typeof imageMetadataSchema>;
export type ImageAsset = Static<typeof imageAssetSchema>;
export type ImageGenerationOptions = Static<typeof imageGenerationOptionsSchema>;
export type ImageGenerationInput = Static<typeof imageGenerationInputSchema>;
export type ImageGenerationToolInput = Static<typeof imageGenerationToolInputSchema>;
export type ImageGenerationRequest = Static<typeof imageGenerationRequestSchema>;
export type ImageGenerationStatus = Static<typeof imageGenerationStatusSchema>;
export type ImageGenerationStatusQuery = Static<typeof imageGenerationStatusQuerySchema>;
export type ImageAssetQuery = Static<typeof imageAssetQuerySchema>;
export type ImageGenerationStageInput = Static<typeof imageGenerationStageInputSchema>;
export type ImageGenerationStage = Static<typeof imageGenerationStageSchema>;
export type ImageAssetWriteInput = Static<typeof imageAssetWriteInputSchema>;
export type ImageGenerationCreateResult = Static<typeof imageGenerationCreateResultSchema>;
export type ImageGenerationReceipt = Static<typeof imageGenerationReceiptSchema>;
export type ImageGenerationProof = Static<typeof imageGenerationProofSchema>;
