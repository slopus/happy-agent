import { Type, type Static } from "@sinclair/typebox";

import {
    secretAgentIdSchema,
    secretAttachInputSchema,
    secretIdSchema,
    secretOperationFingerprintSchema,
    secretRegistrationInputSchema,
    secretUpdateInputSchema,
} from "./Secret.js";
import { secretContextSchema } from "./SecretEvent.js";

/**
 * Normalized operation input delivered only to the trusted host fingerprint provider.
 *
 * Register and update variants contain raw values because the keyed digest must distinguish
 * value-only changes. The feature never persists, emits, exports to tools, or formats this input.
 */
export const secretFingerprintInputSchema = Type.Union([
    Type.Object(
        {
            operation: Type.Literal("register"),
            actingAgentId: secretAgentIdSchema,
            input: secretRegistrationInputSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            operation: Type.Literal("update"),
            actingAgentId: secretAgentIdSchema,
            secretId: secretIdSchema,
            input: secretUpdateInputSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            operation: Type.Literal("remove"),
            actingAgentId: secretAgentIdSchema,
            secretId: secretIdSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            operation: Type.Literal("attach"),
            actingAgentId: secretAgentIdSchema,
            input: secretAttachInputSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            operation: Type.Literal("detach"),
            actingAgentId: secretAgentIdSchema,
            input: secretAttachInputSchema,
        },
        { additionalProperties: false },
    ),
]);

/**
 * Host-owned keyed fingerprint boundary.
 *
 * The provider must canonicalize the validated input and return a collision-resistant keyed
 * digest that remains stable across feature restarts using the same host key. A lowercase
 * HMAC-SHA256 hex digest is the intended implementation. The provider key never crosses this
 * contract.
 */
export const secretFingerprintProviderSchema = Type.Object(
    {
        fingerprint: Type.Function(
            [secretContextSchema, secretFingerprintInputSchema],
            Type.Promise(secretOperationFingerprintSchema),
        ),
    },
    { additionalProperties: false },
);

export type SecretFingerprintInput = Static<typeof secretFingerprintInputSchema>;
export type SecretFingerprintProvider = Static<typeof secretFingerprintProviderSchema>;
