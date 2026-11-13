/** Gen UI actions a client saves through the daemon: today, a `secret` action's form. */

import { type Static, Type } from "@sinclair/typebox";

import { cuid2Schema, mutationIdSchema, resourceVersionSchema } from "./common.js";
import {
    secretDescriptionSchema,
    secretEnvironmentPatchSchema,
    secretEnvironmentSchema,
    secretSchema,
} from "./secrets.js";

/** The secret name a person chose in the form, under the secret-name rules. */
export const artifactActionSecretIdSchema = Type.String({
    minLength: 2,
    maxLength: 32,
    pattern: "^[a-z][a-z0-9_-]*$",
});

/** The key of the render element the person tapped. */
export const artifactActionElementSchema = Type.String({ minLength: 1, maxLength: 512 });

/** A form that creates a secret: the whole environment bundle. */
export const artifactSecretActionCreateRequestSchema = Type.Object(
    {
        id: cuid2Schema,
        element: artifactActionElementSchema,
        secret: Type.Object(
            {
                id: artifactActionSecretIdSchema,
                description: secretDescriptionSchema,
                environment: secretEnvironmentSchema,
            },
            { additionalProperties: false },
        ),
        mutationId: Type.Optional(mutationIdSchema),
    },
    { additionalProperties: false },
);

/**
 * A form that changes the secret it showed: an environment patch, where a string sets a value,
 * `null` removes the variable, and a name left out keeps its stored value.
 */
export const artifactSecretActionChangeRequestSchema = Type.Object(
    {
        id: cuid2Schema,
        element: artifactActionElementSchema,
        secret: Type.Object(
            {
                id: artifactActionSecretIdSchema,
                description: secretDescriptionSchema,
                environment: secretEnvironmentPatchSchema,
            },
            { additionalProperties: false },
        ),
        ifMatch: resourceVersionSchema,
        mutationId: Type.Optional(mutationIdSchema),
    },
    { additionalProperties: false },
);

/** `POST /v0/artifacts/:artifactId/versions/:number/actions` for a `secret` action. */
export const artifactSecretActionRequestSchema = Type.Union([
    artifactSecretActionCreateRequestSchema,
    artifactSecretActionChangeRequestSchema,
]);
export type ArtifactSecretActionRequest = Static<typeof artifactSecretActionRequestSchema>;

/** The saved secret as safe metadata, and whether the save made it or changed it. */
export const artifactSecretActionResponseSchema = Type.Object({
    secret: secretSchema,
    outcome: Type.Union([Type.Literal("created"), Type.Literal("updated")]),
});
export type ArtifactSecretActionResponse = Static<typeof artifactSecretActionResponseSchema>;
