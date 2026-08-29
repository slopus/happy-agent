import { Type, type Static } from "@sinclair/typebox";
import type { Context } from "@steve.kite/stdlib";

import {
    secretAgentIdSchema,
    secretAttachmentSchema,
    secretIdSchema,
    secretReferenceSchema,
    secretScopeRefSchema,
} from "./Secret.js";
import {
    secretApiAttachmentSchema,
    secretApiRecordSchema,
    secretApiVersionSchema,
} from "./SecretApi.js";

export const secretEventIdSchema = Type.String({
    minLength: 1,
    maxLength: 256,
    pattern: "^[^\\u0000\\r\\n]+$",
});

export const secretEventTimestampSchema = Type.Integer({
    minimum: 0,
});

/**
 * Context is owned by Agent Base/host code. It is opaque to the module, but injected-boundary
 * validation still rejects primitive or null values.
 */
export const secretContextSchema = Type.Unsafe<Context>(
    Type.Object({}, { additionalProperties: true }),
);

const eventEnvelope = {
    eventId: secretEventIdSchema,
    at: secretEventTimestampSchema,
    agentId: secretAgentIdSchema,
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
    Type.Object(
        {
            ...eventEnvelope,
            type: Type.Literal("secret_api_created"),
            secret: secretApiRecordSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...eventEnvelope,
            type: Type.Literal("secret_api_updated"),
            previousSecret: secretApiRecordSchema,
            secret: secretApiRecordSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...eventEnvelope,
            type: Type.Literal("secret_api_removed"),
            secretId: secretApiRecordSchema.properties.id,
            previousVersion: secretApiVersionSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...eventEnvelope,
            type: Type.Literal("secret_api_attached"),
            attachment: secretApiAttachmentSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...eventEnvelope,
            type: Type.Literal("secret_api_detached"),
            attachment: secretApiAttachmentSchema,
        },
        { additionalProperties: false },
    ),
]);

export type SecretEvent = Static<typeof secretEventSchema>;

/**
 * One subscriber to the stream above. Subscriptions are taken after construction through
 * `SecretsModule.onEventTransactional` and `SecretsModule.onEvent`, each of which returns the
 * function that ends the subscription.
 */
export const secretEventListenerSchema = Type.Function(
    [secretContextSchema, secretEventSchema],
    Type.Union([Type.Void(), Type.Promise(Type.Unknown())]),
);

export type SecretEventListener = Static<typeof secretEventListenerSchema>;

/** Ends a subscription. Calling it more than once does nothing further. */
export type SecretUnsubscribe = () => void;
