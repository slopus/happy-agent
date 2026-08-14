import { Type, type Static } from "@sinclair/typebox";
import type { Context } from "@steve.kite/stdlib";

import {
    secretAgentIdSchema,
    secretAttachmentSchema,
    secretIdSchema,
    secretReferenceSchema,
    secretScopeRefSchema,
    secretOperationIdSchema,
    secretOperationFingerprintSchema,
} from "./Secret.js";

export const secretEventIdSchema = Type.String({
    minLength: 1,
    maxLength: 256,
    pattern: "^[^\\u0000\\r\\n]+$",
});

export const secretEventTimestampSchema = Type.Integer({
    minimum: 0,
});

/**
 * Context is owned by Agent Base/host code. It is opaque to the feature, but injected-boundary
 * validation still rejects primitive or null values.
 */
export const secretContextSchema = Type.Unsafe<Context>(
    Type.Object({}, { additionalProperties: true }),
);

const eventEnvelope = {
    eventId: secretEventIdSchema,
    at: secretEventTimestampSchema,
    agentId: secretAgentIdSchema,
    operationId: secretOperationIdSchema,
    fingerprint: secretOperationFingerprintSchema,
};

/** Stable, safe events for protocol/projector listeners. */
export const secretEventSchema = Type.Union([
    Type.Object(
        {
            ...eventEnvelope,
            type: Type.Literal("secret_registered"),
            secret: secretReferenceSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...eventEnvelope,
            type: Type.Literal("secret_updated"),
            secret: secretReferenceSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...eventEnvelope,
            type: Type.Literal("secret_removed"),
            secretId: secretIdSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...eventEnvelope,
            type: Type.Literal("secret_attached"),
            attachment: secretAttachmentSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...eventEnvelope,
            type: Type.Literal("secret_detached"),
            scopeRef: secretScopeRefSchema,
            secretId: secretIdSchema,
        },
        { additionalProperties: false },
    ),
]);

export type SecretEvent = Static<typeof secretEventSchema>;

const listenerResultSchema = Type.Union([Type.Void(), Type.Promise(Type.Unknown())]);

/** Transactional and outermost post-commit observers. */
export const secretFeatureListenerSchema = Type.Object(
    {
        onEventTransactional: Type.Optional(
            Type.Function([secretContextSchema, secretEventSchema], listenerResultSchema),
        ),
        onEvent: Type.Optional(
            Type.Function([secretContextSchema, secretEventSchema], listenerResultSchema),
        ),
    },
    { additionalProperties: false },
);

/** Listener type is inferred directly from the runtime TypeBox contract. */
export type SecretFeatureListener = Static<typeof secretFeatureListenerSchema>;
