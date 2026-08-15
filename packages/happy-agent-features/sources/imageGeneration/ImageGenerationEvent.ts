import { Type, type Static } from "@sinclair/typebox";

import {
    imageAgentIdSchema,
    imageAssetIdSchema,
    imageContextSchema,
    imageGenerationStatusSchema,
    imageOperationIdSchema,
    imageFingerprintSchema,
} from "./ImageGeneration.js";

export const imageEventIdSchema = Type.String({
    minLength: 1,
    maxLength: 256,
    pattern: "^[^\\u0000\\r\\n]+$",
});

export const imageGenerationEventSchema = Type.Union([
    Type.Object(
        {
            type: Type.Literal("image_generation_changed"),
            eventId: imageEventIdSchema,
            at: Type.Integer({ minimum: 0 }),
            agentId: imageAgentIdSchema,
            operationId: imageOperationIdSchema,
            fingerprint: imageFingerprintSchema,
            operation: imageGenerationStatusSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            type: Type.Literal("image_removed"),
            eventId: imageEventIdSchema,
            at: Type.Integer({ minimum: 0 }),
            agentId: imageAgentIdSchema,
            assetId: imageAssetIdSchema,
        },
        { additionalProperties: false },
    ),
]);

export type ImageGenerationEvent = Static<typeof imageGenerationEventSchema>;

const listenerPromiseSchema = Type.Promise(Type.Void());

/** Transactional and outermost-postcommit feature observers. */
export const imageGenerationListenerSchema = Type.Object(
    {
        onEventTransactional: Type.Optional(
            Type.Function([imageContextSchema, imageGenerationEventSchema], listenerPromiseSchema),
        ),
        onEvent: Type.Optional(
            Type.Function([imageContextSchema, imageGenerationEventSchema], listenerPromiseSchema),
        ),
    },
    { additionalProperties: false },
);

export type ImageGenerationListener = Static<typeof imageGenerationListenerSchema>;

export const imageEventIdFactorySchema = Type.Function(
    [imageContextSchema, imageAgentIdSchema, imageOperationIdSchema],
    Type.Promise(imageEventIdSchema),
);
