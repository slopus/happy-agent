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

export const cloudUsernameSchema = Type.String({
    minLength: 3,
    maxLength: 24,
    pattern: "^[a-z0-9_]+$",
});

/** Cloud enrollment is unavailable without a connected account. */
export const cloudEnrollmentInactiveSchema = Type.Object(
    { status: Type.Literal("inactive") },
    { additionalProperties: false },
);

/** Durable reconciliation is determining the connected account's profile state. */
export const cloudEnrollmentCheckingSchema = Type.Object(
    { status: Type.Literal("checking") },
    { additionalProperties: false },
);

/** The connected account has no Cloud username. */
export const cloudEnrollmentRequiredSchema = Type.Object(
    { status: Type.Literal("required") },
    { additionalProperties: false },
);

/** One durable username intent awaiting Happy Cloud acceptance. */
export const cloudEnrollmentEnrollingSchema = Type.Object(
    { status: Type.Literal("enrolling"), username: cloudUsernameSchema },
    { additionalProperties: false },
);

/** Happy Cloud has accepted the connected account's username. */
export const cloudEnrollmentEnrolledSchema = Type.Object(
    { status: Type.Literal("enrolled"), username: cloudUsernameSchema },
    { additionalProperties: false },
);

export const cloudEnrollmentSchema = Type.Union([
    cloudEnrollmentInactiveSchema,
    cloudEnrollmentCheckingSchema,
    cloudEnrollmentRequiredSchema,
    cloudEnrollmentEnrollingSchema,
    cloudEnrollmentEnrolledSchema,
]);
export type CloudEnrollment = Static<typeof cloudEnrollmentSchema>;

/** One 32-byte Cloud key serialized as unpadded base64url. */
export const cloudKeyValueSchema = Type.String({
    minLength: 43,
    maxLength: 43,
    pattern: "^[A-Za-z0-9_-]+$",
});

/** A canonical, versioned H1 generated secret used as the non-password Cloud key factor. */
export const cloudGeneratedSecretSchema = Type.String({
    minLength: 33,
    maxLength: 33,
    pattern:
        "^H1-[2-9A-HJ-NP-TV-Z]{5}-[2-9A-HJ-NP-TV-Z]{5}-[2-9A-HJ-NP-TV-Z]{5}-[2-9A-HJ-NP-TV-Z]{5}-[2-9A-HJ-NP-TV-Z]{6}$",
});
export type CloudGeneratedSecret = Static<typeof cloudGeneratedSecretSchema>;

/** The daemon-owned material returned only through the on-demand Cloud key backup read. */
export const cloudKeyBackupSchema = Type.Object(
    {
        generatedSecret: cloudGeneratedSecretSchema,
        rootSecret: cloudKeyValueSchema,
    },
    { additionalProperties: false },
);
export type CloudKeyBackup = Static<typeof cloudKeyBackupSchema>;

/** `GET /v0/cloud/keys/backup` */
export const cloudKeyBackupResponseSchema = Type.Object(
    { backup: cloudKeyBackupSchema },
    { additionalProperties: false },
);
export type CloudKeyBackupResponse = Static<typeof cloudKeyBackupResponseSchema>;

/** Human-readable platform recorded by one Happy Agent installation. */
export const cloudDevicePlatformSchema = Type.Union([
    Type.Literal("macOS"),
    Type.Literal("Linux"),
    Type.Literal("Windows"),
    Type.Literal("Other"),
]);
export type CloudDevicePlatform = Static<typeof cloudDevicePlatformSchema>;

const cloudDeviceTextSchema = Type.String({
    minLength: 1,
    maxLength: 256,
    pattern: "^(?=.*\\S)[^\\x00-\\x1f\\x7f]+$",
});

/** Owner-decrypted identity details supplied by one Happy Agent installation. */
export const cloudDeviceMetadataSchema = Type.Object(
    {
        agentVersion: cloudDeviceTextSchema,
        architecture: cloudDeviceTextSchema,
        installationId: Type.String({
            minLength: 2,
            maxLength: 64,
            pattern: "^[A-Za-z0-9][A-Za-z0-9-]*$",
        }),
        name: cloudDeviceTextSchema,
        osVersion: cloudDeviceTextSchema,
        platform: cloudDevicePlatformSchema,
    },
    { additionalProperties: false },
);
export type CloudDeviceMetadata = Static<typeof cloudDeviceMetadataSchema>;

/** One current Murmur roster entry and its optional owner-decrypted metadata. */
export const cloudDeviceSchema = Type.Object(
    {
        current: Type.Boolean(),
        id: cloudKeyValueSchema,
        lastAccessedAt: timestampSchema,
        metadata: Type.Union([cloudDeviceMetadataSchema, Type.Null()]),
    },
    { additionalProperties: false },
);
export type CloudDevice = Static<typeof cloudDeviceSchema>;

/** `GET /v0/cloud/devices` */
export const cloudDevicesResponseSchema = Type.Object(
    { devices: Type.Array(cloudDeviceSchema, { maxItems: 256 }) },
    { additionalProperties: false },
);
export type CloudDevicesResponse = Static<typeof cloudDevicesResponseSchema>;

/** Cloud keys are unavailable without a connected account. */
export const cloudKeysInactiveSchema = Type.Object(
    { status: Type.Literal("inactive") },
    { additionalProperties: false },
);

/** The connected account has no encrypted Cloud key bundle yet. */
export const cloudKeysCreateRequiredSchema = Type.Object(
    { status: Type.Literal("create_required") },
    { additionalProperties: false },
);

/** Happy Cloud has an encrypted bundle whose root is unavailable locally. */
export const cloudKeysRestoreRequiredSchema = Type.Object(
    { status: Type.Literal("restore_required") },
    { additionalProperties: false },
);

/** Happy Cloud is durably deleting an unrestorable encrypted vault. */
export const cloudKeysResettingSchema = Type.Object(
    { status: Type.Literal("resetting") },
    { additionalProperties: false },
);

/** The account root is available locally and its public identity has been derived. */
export const cloudKeysReadySchema = Type.Object(
    { identityKey: cloudKeyValueSchema, status: Type.Literal("ready") },
    { additionalProperties: false },
);

export const cloudKeysSchema = Type.Union([
    cloudKeysInactiveSchema,
    cloudKeysCreateRequiredSchema,
    cloudKeysRestoreRequiredSchema,
    cloudKeysResettingSchema,
    cloudKeysReadySchema,
]);
export type CloudKeys = Static<typeof cloudKeysSchema>;

const versionedFields = {
    updatedAt: timestampSchema,
    version: resourceVersionSchema,
};

const cloudSnapshotFields = {
    ...versionedFields,
    /** Durable username-enrollment state. Absent on older compatible daemons. */
    enrollment: Type.Optional(cloudEnrollmentSchema),
    /** Account encryption state. Absent on older compatible daemons. */
    keys: Type.Optional(cloudKeysSchema),
};

export const cloudDisconnectedSchema = Type.Object({
    ...cloudSnapshotFields,
    authorization: Type.Null(),
    environment: Type.Null(),
    error: Nullable(cloudErrorSchema),
    status: Type.Literal("disconnected"),
    user: Type.Null(),
});
export type CloudDisconnected = Static<typeof cloudDisconnectedSchema>;

/** The clean signed-out state returned by an explicit local disconnect. */
export const cloudCleanDisconnectedSchema = Type.Object({
    ...cloudSnapshotFields,
    authorization: Type.Null(),
    environment: Type.Null(),
    error: Type.Null(),
    status: Type.Literal("disconnected"),
    user: Type.Null(),
});
export type CloudCleanDisconnected = Static<typeof cloudCleanDisconnectedSchema>;

export const cloudAuthorizingSchema = Type.Object({
    ...cloudSnapshotFields,
    authorization: cloudAuthorizationSchema,
    environment: cloudEnvironmentSchema,
    error: Type.Null(),
    status: Type.Literal("authorizing"),
    user: Type.Null(),
});
export type CloudAuthorizing = Static<typeof cloudAuthorizingSchema>;

export const cloudConnectedSchema = Type.Object({
    ...cloudSnapshotFields,
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

const cloudKeysMutationFields = {
    authHash: cloudKeyValueSchema,
    encryptionKey: cloudKeyValueSchema,
    /** Present on clients that support durable retrieval of complete Cloud key backups. */
    generatedSecret: Type.Optional(cloudGeneratedSecretSchema),
    mutationId: Type.Optional(mutationIdSchema),
};

/** Creates and persists a new encrypted root bundle for the connected account. */
export const createCloudKeysRequestSchema = Type.Object(cloudKeysMutationFields, {
    additionalProperties: false,
});
export type CreateCloudKeysRequest = Static<typeof createCloudKeysRequestSchema>;

/** Restores the connected account root from its existing encrypted Cloud bundle. */
export const restoreCloudKeysRequestSchema = Type.Object(cloudKeysMutationFields, {
    additionalProperties: false,
});
export type RestoreCloudKeysRequest = Static<typeof restoreCloudKeysRequestSchema>;

export const CLOUD_VAULT_DELETE_CONFIRMATION = "YES DELETE MY VAULT" as const;

/** Deletes an unrestorable remote vault so the connected account can create it again. */
export const deleteCloudKeysRequestSchema = Type.Object(
    {
        confirmation: Type.Literal(CLOUD_VAULT_DELETE_CONFIRMATION),
        mutationId: Type.Optional(mutationIdSchema),
    },
    { additionalProperties: false },
);
export type DeleteCloudKeysRequest = Static<typeof deleteCloudKeysRequestSchema>;

/** A freshly minted access token and the still-current connected snapshot. */
export const cloudAccessTokenResponseSchema = Type.Object({
    accessToken: Type.String(),
    cloud: cloudConnectedSchema,
});
export type CloudAccessTokenResponse = Static<typeof cloudAccessTokenResponseSchema>;

/** One WorkOS organization associated with the connected Cloud user. */
export const cloudOrganizationSchema = Type.Object({
    id: Type.String({ minLength: 1, maxLength: 512 }),
    name: Type.String({ minLength: 1, maxLength: 512 }),
});
export type CloudOrganization = Static<typeof cloudOrganizationSchema>;

/** `GET /v0/cloud/organizations` */
export const cloudOrganizationsResponseSchema = Type.Object({
    organizations: Type.Array(cloudOrganizationSchema, { maxItems: 10_000 }),
});
export type CloudOrganizationsResponse = Static<typeof cloudOrganizationsResponseSchema>;

const cloudOrganizationNameInputSchema = Type.String({
    minLength: 1,
    maxLength: 255,
    pattern: "^(?=.*\\S)[^\\x00-\\x1f\\x7f]+$",
});

/** Creates a WorkOS organization for the connected Cloud user. */
export const createCloudOrganizationRequestSchema = Type.Object(
    {
        mutationId: Type.Optional(mutationIdSchema),
        name: cloudOrganizationNameInputSchema,
    },
    { additionalProperties: false },
);
export type CreateCloudOrganizationRequest = Static<typeof createCloudOrganizationRequestSchema>;

/** `POST /v0/cloud/organizations` */
export const createCloudOrganizationResponseSchema = Type.Object({
    organization: cloudOrganizationSchema,
});
export type CreateCloudOrganizationResponse = Static<typeof createCloudOrganizationResponseSchema>;

/** `DELETE /v0/cloud/organizations/:id` */
export const deleteCloudOrganizationResponseSchema = Type.Object({
    deleted: Type.Literal(true),
});
export type DeleteCloudOrganizationResponse = Static<typeof deleteCloudOrganizationResponseSchema>;

const cloudVisibleNameSchema = Type.String({
    minLength: 1,
    maxLength: 64,
    pattern: "^(?=.*\\S)[^\\x00-\\x1f\\x7f]+$",
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

export const cloudProfileResponseSchema = Type.Object({
    enrollment: Type.Optional(cloudEnrollmentSchema),
    profile: cloudProfileSchema,
});
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

/** One complete public profile retained in the Cloud social lists. */
export const cloudSocialProfileSchema = Type.Object({
    firstName: cloudVisibleNameSchema,
    lastName: Type.Optional(cloudVisibleNameSchema),
    username: cloudUsernameSchema,
    version: resourceVersionSchema,
});
export type CloudSocialProfile = Static<typeof cloudSocialProfileSchema>;

const cloudSocialLists = {
    blocked: Type.Array(cloudSocialProfileSchema),
    friends: Type.Array(cloudSocialProfileSchema),
    incomingRequests: Type.Array(cloudSocialProfileSchema),
    outgoingRequests: Type.Array(cloudSocialProfileSchema),
};

/** Cloud friends are inactive until the connected account has enrolled a profile. */
export const cloudSocialUnenrolledSchema = Type.Object({
    ...versionedFields,
    blocked: Type.Tuple([]),
    connection: Type.Null(),
    friends: Type.Tuple([]),
    incomingRequests: Type.Tuple([]),
    outgoingRequests: Type.Tuple([]),
    status: Type.Literal("unenrolled"),
});
export type CloudSocialUnenrolled = Static<typeof cloudSocialUnenrolledSchema>;

/** The retained social state for an enrolled Cloud account. */
export const cloudSocialEnrolledSchema = Type.Object({
    ...versionedFields,
    ...cloudSocialLists,
    connection: Type.Union([Type.Literal("connecting"), Type.Literal("connected")]),
    status: Type.Literal("enrolled"),
});
export type CloudSocialEnrolled = Static<typeof cloudSocialEnrolledSchema>;

/** The complete durable Cloud social snapshot, narrowed by enrollment status. */
export const cloudSocialSchema = Type.Union([
    cloudSocialUnenrolledSchema,
    cloudSocialEnrolledSchema,
]);
export type CloudSocial = Static<typeof cloudSocialSchema>;

/** The response shared by Cloud social reads and mutations. */
export const cloudSocialResponseSchema = Type.Object({ cloudSocial: cloudSocialSchema });
export type CloudSocialResponse = Static<typeof cloudSocialResponseSchema>;

/** The optional event echo accepted by Cloud social mutations. */
export const cloudSocialMutationRequestSchema = Type.Object(
    { mutationId: Type.Optional(mutationIdSchema) },
    { additionalProperties: false },
);
export type CloudSocialMutationRequest = Static<typeof cloudSocialMutationRequestSchema>;
