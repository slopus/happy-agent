/** Installation-wide Happy Cloud authentication state. */

import { type Static, Type } from "@sinclair/typebox";

import { mutationIdSchema, Nullable, resourceVersionSchema, timestampSchema } from "./common.js";

/** Which fixed Happy Cloud deployment and WorkOS client the daemon uses. */
export const cloudEnvironmentSchema = Type.Union([
    Type.Literal("production"),
    Type.Literal("staging"),
]);
export type CloudEnvironment = Static<typeof cloudEnvironmentSchema>;

/** The verified WorkOS identity associated with the stored refresh token. */
export const cloudUserSchema = Type.Object({
    email: Type.String(),
    firstName: Nullable(Type.String()),
    id: Type.String(),
    lastName: Nullable(Type.String()),
});
export type CloudUser = Static<typeof cloudUserSchema>;

/** The public portion of an in-process WorkOS PKCE attempt. */
export const cloudAuthorizationSchema = Type.Object({
    expiresAt: timestampSchema,
    url: Type.String(),
});
export type CloudAuthorization = Static<typeof cloudAuthorizationSchema>;

/** A stable machine code and its human-readable presentation. */
export const cloudErrorSchema = Type.Object({
    code: Type.String(),
    message: Type.String(),
});
export type CloudError = Static<typeof cloudErrorSchema>;

const snapshotFields = {
    updatedAt: timestampSchema,
    version: resourceVersionSchema,
};

export const cloudDisconnectedSchema = Type.Object({
    ...snapshotFields,
    authorization: Type.Null(),
    environment: Type.Null(),
    error: Nullable(cloudErrorSchema),
    status: Type.Literal("disconnected"),
    user: Type.Null(),
});
export type CloudDisconnected = Static<typeof cloudDisconnectedSchema>;

/** The clean signed-out state returned by an explicit local disconnect. */
export const cloudCleanDisconnectedSchema = Type.Object({
    ...snapshotFields,
    authorization: Type.Null(),
    environment: Type.Null(),
    error: Type.Null(),
    status: Type.Literal("disconnected"),
    user: Type.Null(),
});
export type CloudCleanDisconnected = Static<typeof cloudCleanDisconnectedSchema>;

export const cloudAuthorizingSchema = Type.Object({
    ...snapshotFields,
    authorization: cloudAuthorizationSchema,
    environment: cloudEnvironmentSchema,
    error: Type.Null(),
    status: Type.Literal("authorizing"),
    user: Type.Null(),
});
export type CloudAuthorizing = Static<typeof cloudAuthorizingSchema>;

export const cloudConnectedSchema = Type.Object({
    ...snapshotFields,
    authorization: Type.Null(),
    environment: cloudEnvironmentSchema,
    error: Type.Null(),
    status: Type.Literal("connected"),
    user: cloudUserSchema,
});
export type CloudConnected = Static<typeof cloudConnectedSchema>;

/** The complete current Cloud snapshot, narrowed by `status`. */
export const cloudSchema = Type.Union([
    cloudDisconnectedSchema,
    cloudAuthorizingSchema,
    cloudConnectedSchema,
]);
export type Cloud = Static<typeof cloudSchema>;

/** The current snapshot returned by Cloud status and authentication operations. */
export const cloudResponseSchema = Type.Object({ cloud: cloudSchema });
export type CloudResponse = Static<typeof cloudResponseSchema>;

/** A successfully started authorization attempt. */
export const cloudAuthorizingResponseSchema = Type.Object({ cloud: cloudAuthorizingSchema });
export type CloudAuthorizingResponse = Static<typeof cloudAuthorizingResponseSchema>;

/** A successfully authenticated Cloud account. */
export const cloudConnectedResponseSchema = Type.Object({ cloud: cloudConnectedSchema });
export type CloudConnectedResponse = Static<typeof cloudConnectedResponseSchema>;

/** The result of explicitly disconnecting Cloud locally. */
export const cloudDisconnectedResponseSchema = Type.Object({
    cloud: cloudCleanDisconnectedSchema,
});
export type CloudDisconnectedResponse = Static<typeof cloudDisconnectedResponseSchema>;

/** Starts a WorkOS PKCE authorization attempt. */
export const startCloudAuthorizationRequestSchema = Type.Object({
    environment: cloudEnvironmentSchema,
    mutationId: Type.Optional(mutationIdSchema),
    redirectUri: Type.String({ maxLength: 2048 }),
});
export type StartCloudAuthorizationRequest = Static<typeof startCloudAuthorizationRequestSchema>;

/** Completes the daemon's pending WorkOS PKCE authorization attempt. */
export const completeCloudAuthorizationRequestSchema = Type.Object({
    callbackUrl: Type.String({ maxLength: 4096 }),
    mutationId: Type.Optional(mutationIdSchema),
});
export type CompleteCloudAuthorizationRequest = Static<
    typeof completeCloudAuthorizationRequestSchema
>;

/** A Cloud mutation that carries only an optional event echo. */
export const cloudMutationRequestSchema = Type.Object({
    mutationId: Type.Optional(mutationIdSchema),
});
export type CloudMutationRequest = Static<typeof cloudMutationRequestSchema>;

/** A freshly minted access token and the still-current connected snapshot. */
export const cloudAccessTokenResponseSchema = Type.Object({
    accessToken: Type.String(),
    cloud: cloudConnectedSchema,
});
export type CloudAccessTokenResponse = Static<typeof cloudAccessTokenResponseSchema>;

const cloudVisibleNameSchema = Type.String({
    minLength: 1,
    maxLength: 64,
    pattern: "^(?=.*\\S)[^\\x00-\\x1f\\x7f]+$",
});

export const cloudUsernameSchema = Type.String({
    minLength: 3,
    maxLength: 24,
    pattern: "^[a-z0-9_]+$",
});

/** A public profile that has not yet been registered in Happy Cloud. */
export const cloudUnregisteredProfileSchema = Type.Object({
    firstName: Type.Null(),
    username: Type.Null(),
});
export type CloudUnregisteredProfile = Static<typeof cloudUnregisteredProfileSchema>;

/** The public identity stored durably by Happy Cloud for one WorkOS user. */
export const cloudRegisteredProfileSchema = Type.Object({
    firstName: cloudVisibleNameSchema,
    lastName: Type.Optional(cloudVisibleNameSchema),
    username: cloudUsernameSchema,
});
export type CloudRegisteredProfile = Static<typeof cloudRegisteredProfileSchema>;

export const cloudProfileSchema = Type.Union([
    cloudUnregisteredProfileSchema,
    cloudRegisteredProfileSchema,
]);
export type CloudProfile = Static<typeof cloudProfileSchema>;

export const cloudProfileResponseSchema = Type.Object({ profile: cloudProfileSchema });
export type CloudProfileResponse = Static<typeof cloudProfileResponseSchema>;

/** Enrolls the connected account using the local Happy Agent profile and a Cloud username. */
export const enrollCloudProfileRequestSchema = Type.Object(
    {
        mutationId: Type.Optional(mutationIdSchema),
        username: cloudUsernameSchema,
    },
    { additionalProperties: false },
);
export type EnrollCloudProfileRequest = Static<typeof enrollCloudProfileRequestSchema>;
