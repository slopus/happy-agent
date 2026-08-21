import { Type, type Static } from "@sinclair/typebox";

const exact = { additionalProperties: false } as const;
const timestampSchema = Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 });
const versionSchema = Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 });
const mutationIdSchema = Type.String({ maxLength: 256, minLength: 1 });
export const HAPPY_CLOUD_CIPHERTEXT_MAX_LENGTH = 2 * 1024 * 1024;
const ciphertextSchema = Type.String({
    maxLength: HAPPY_CLOUD_CIPHERTEXT_MAX_LENGTH,
    minLength: 1,
    pattern: "^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-][AQgw]|[A-Za-z0-9_-]{2}[AEIMQUYcgkosw048])?$",
});
export const happyCloudSessionIdSchema = Type.String({ maxLength: 256, minLength: 1 });

export const HAPPY_CLOUD_CONTRACT_VERSION = 1 as const;

export const happyCloudCapabilitySchema = Type.Union([
    Type.Literal("group_chats"),
    Type.Literal("remote_control"),
    Type.Literal("session_blob_persistence"),
    Type.Literal("happy_profile"),
]);
export type HappyCloudCapability = Static<typeof happyCloudCapabilitySchema>;

export const happyCloudConsentSchema = Type.Union([
    Type.Literal("denied"),
    Type.Literal("granted"),
]);
export type HappyCloudConsent = Static<typeof happyCloudConsentSchema>;

export const happyCloudCapabilityStatusSchema = Type.Object(
    {
        changedAt: timestampSchema,
        consent: happyCloudConsentSchema,
    },
    exact,
);
export type HappyCloudCapabilityStatus = Static<typeof happyCloudCapabilityStatusSchema>;

export const happyCloudStatusSchema = Type.Object(
    {
        authority: Type.Literal("local_record_only"),
        capabilities: Type.Object(
            {
                group_chats: happyCloudCapabilityStatusSchema,
                happy_profile: happyCloudCapabilityStatusSchema,
                remote_control: happyCloudCapabilityStatusSchema,
                session_blob_persistence: happyCloudCapabilityStatusSchema,
            },
            exact,
        ),
        contractVersion: Type.Literal(HAPPY_CLOUD_CONTRACT_VERSION),
        enrollment: Type.Object(
            {
                changedAt: timestampSchema,
                state: Type.Union([Type.Literal("not_enrolled"), Type.Literal("enrolled")]),
            },
            exact,
        ),
        profile: Type.Object(
            {
                changedAt: timestampSchema,
                state: Type.Union([Type.Literal("not_created"), Type.Literal("created")]),
            },
            exact,
        ),
        updatedAt: timestampSchema,
        version: versionSchema,
    },
    exact,
);
export type HappyCloudStatus = Static<typeof happyCloudStatusSchema>;

export const happyCloudChangedEventSchema = Type.Object(
    {
        createdAt: timestampSchema,
        data: Type.Object(
            {
                mutationId: mutationIdSchema,
                version: versionSchema,
            },
            exact,
        ),
        id: Type.String({ maxLength: 256, minLength: 1 }),
        type: Type.Literal("happy_cloud_changed"),
    },
    exact,
);
export type HappyCloudChangedEvent = Static<typeof happyCloudChangedEventSchema>;

const commandBase = {
    contractVersion: Type.Literal(HAPPY_CLOUD_CONTRACT_VERSION),
    expectedVersion: versionSchema,
    mutationId: mutationIdSchema,
};

export const happyCloudCommandSchema = Type.Union([
    Type.Object(
        {
            ...commandBase,
            action: Type.Literal("set_enrollment"),
            state: Type.Union([Type.Literal("not_enrolled"), Type.Literal("enrolled")]),
        },
        exact,
    ),
    Type.Object(
        {
            ...commandBase,
            action: Type.Literal("set_capability"),
            capability: happyCloudCapabilitySchema,
            consent: happyCloudConsentSchema,
        },
        exact,
    ),
    Type.Object(
        {
            ...commandBase,
            action: Type.Literal("put_profile"),
            ciphertext: ciphertextSchema,
        },
        exact,
    ),
    Type.Object({ ...commandBase, action: Type.Literal("delete_profile") }, exact),
    Type.Object(
        {
            ...commandBase,
            action: Type.Literal("put_session_blob"),
            ciphertext: ciphertextSchema,
            sessionId: happyCloudSessionIdSchema,
        },
        exact,
    ),
    Type.Object(
        {
            ...commandBase,
            action: Type.Literal("delete_session_blob"),
            sessionId: happyCloudSessionIdSchema,
        },
        exact,
    ),
]);
export type HappyCloudCommand = Static<typeof happyCloudCommandSchema>;

export const happyCloudCommandResponseSchema = Type.Object(
    { status: happyCloudStatusSchema },
    exact,
);
export type HappyCloudCommandResponse = Static<typeof happyCloudCommandResponseSchema>;

export const happyCloudCommandErrorResponseSchema = Type.Object(
    {
        code: Type.Union([
            Type.Literal("capability_not_granted"),
            Type.Literal("mutation_reused"),
            Type.Literal("not_enrolled"),
            Type.Literal("version_conflict"),
        ]),
        error: Type.String({ minLength: 1 }),
        status: happyCloudStatusSchema,
    },
    exact,
);
export type HappyCloudCommandErrorResponse = Static<typeof happyCloudCommandErrorResponseSchema>;

export const happyCloudProfileCiphertextResponseSchema = Type.Object(
    {
        ciphertext: ciphertextSchema,
        version: versionSchema,
    },
    exact,
);
export type HappyCloudProfileCiphertextResponse = Static<
    typeof happyCloudProfileCiphertextResponseSchema
>;

export const happyCloudSessionBlobResponseSchema = Type.Object(
    {
        ciphertext: ciphertextSchema,
        sessionId: happyCloudSessionIdSchema,
        version: versionSchema,
    },
    exact,
);
export type HappyCloudSessionBlobResponse = Static<typeof happyCloudSessionBlobResponseSchema>;
