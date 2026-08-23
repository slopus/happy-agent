import { Type, type Static } from "@sinclair/typebox";

/** Opaque host-owned identities. The module never interprets their contents. */
export const secretAgentIdSchema = Type.String({
    minLength: 1,
    maxLength: 256,
    pattern: "^[^\\u0000\\r\\n]+$",
});

export const secretIdSchema = Type.String({
    minLength: 1,
    maxLength: 128,
    pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",
});

/** IDs owned by host-managed credentials rather than user registrations. */
export const GITHUB_SECRET_ID = "github" as const;
export const PROJECT_GIT_SECRET_ID = "project-git" as const;

export const secretReservedIdSchema = Type.Union([
    Type.Literal(GITHUB_SECRET_ID),
    Type.Literal(PROJECT_GIT_SECRET_ID),
]);

export const secretScopeRefSchema = Type.String({
    minLength: 1,
    /**
     * Opaque scopes stay short enough that the attach/detach tools can always
     * render the complete scope and secret identities at the minimum
     * maxOutputCharacters setting (256).
     */
    maxLength: 100,
    pattern: "^[^\\u0000\\r\\n]+$",
});

/**
 * Stable list position. Cursors are integer offsets into the host's filtered
 * result set, so a host must advance by exactly the number of returned rows.
 */
export const secretCursorSchema = Type.Integer({
    minimum: 0,
    maximum: Number.MAX_SAFE_INTEGER,
});

export const secretEnvironmentVariableNameSchema = Type.String({
    minLength: 1,
    maxLength: 256,
    pattern: "^[A-Za-z_][A-Za-z0-9_]*$",
});

export const secretEnvironmentVariableNamesSchema = Type.Array(
    secretEnvironmentVariableNameSchema,
    {
        maxItems: 256,
        uniqueItems: true,
    },
);

/**
 * Values cross the module boundary only between a trusted host and its resolver/store.
 * They are intentionally absent from references, events, and every model-facing shape.
 */
export const secretEnvironmentVariableValueSchema = Type.String({
    maxLength: 65_536,
    pattern: "^[^\\u0000]*$",
});

/**
 * A host-owned opaque revision for a secret's values. Revisions are safe to
 * expose in references, but their contents are never interpreted by the module.
 */
export const secretRevisionSchema = Type.String({
    minLength: 1,
    maxLength: 256,
    pattern: "^[^\\u0000\\r\\n]+$",
});

export const secretDescriptionSchema = Type.String({
    minLength: 1,
    maxLength: 2_000,
});

const secretEnvironmentSchema = Type.Record(
    secretEnvironmentVariableNameSchema,
    secretEnvironmentVariableValueSchema,
    {
        additionalProperties: false,
        maxProperties: 256,
    },
);

const secretEnvironmentPatchSchema = Type.Record(
    secretEnvironmentVariableNameSchema,
    Type.Union([secretEnvironmentVariableValueSchema, Type.Null()]),
    {
        additionalProperties: false,
        maxProperties: 256,
        minProperties: 1,
    },
);

/** Safe metadata. This schema deliberately has no value-bearing property. */
export const secretReferenceSchema = Type.Object(
    {
        id: secretIdSchema,
        description: secretDescriptionSchema,
        environmentVariables: secretEnvironmentVariableNamesSchema,
        revision: secretRevisionSchema,
        availableToModel: Type.Optional(Type.Boolean()),
        kind: Type.Optional(
            Type.String({
                minLength: 1,
                maxLength: 128,
                pattern: "^[A-Za-z0-9._:-]+$",
            }),
        ),
    },
    { additionalProperties: false },
);

/** A host registration contains values, but the module returns only its reference. */
export const secretRegistrationSchema = Type.Object(
    {
        id: secretIdSchema,
        description: secretDescriptionSchema,
        environment: secretEnvironmentSchema,
        availableToModel: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
);

/** Public registration input may omit an ID when the configured factory supplies one. */
export const secretRegistrationInputSchema = Type.Object(
    {
        id: Type.Optional(secretIdSchema),
        description: secretDescriptionSchema,
        environment: secretEnvironmentSchema,
        availableToModel: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
);

/** Public updates contain no raw-value result; null removes one environment variable. */
export const secretUpdateInputSchema = Type.Object(
    {
        description: Type.Optional(secretDescriptionSchema),
        environment: Type.Optional(secretEnvironmentPatchSchema),
        availableToModel: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false, minProperties: 1 },
);

/** One opaque scope-to-secret attachment. */
export const secretAttachmentSchema = Type.Object(
    {
        scopeRef: secretScopeRefSchema,
        secretId: secretIdSchema,
    },
    { additionalProperties: false },
);

export const secretAttachInputSchema = Type.Object(
    {
        scopeRef: secretScopeRefSchema,
        secretId: secretIdSchema,
    },
    { additionalProperties: false },
);

export const secretDetachInputSchema = secretAttachInputSchema;

/** Safe result returned by the durable attach tool, including its historical reference snapshot. */
export const secretAttachReferenceResultSchema = Type.Object(
    {
        attachment: secretAttachmentSchema,
        secret: secretReferenceSchema,
    },
    { additionalProperties: false },
);

const secretListLimitSchema = Type.Integer({
    minimum: 1,
    maximum: 50,
});

/** Public metadata input; the module supplies the bounded default when limit is omitted. */
export const secretListInputSchema = Type.Object(
    {
        limit: Type.Optional(secretListLimitSchema),
        cursor: Type.Optional(secretCursorSchema),
        scopeRef: Type.Optional(secretScopeRefSchema),
    },
    { additionalProperties: false },
);

/** A bounded metadata query. The host must enforce the limit at its read boundary. */
export const secretListQuerySchema = Type.Object(
    {
        limit: secretListLimitSchema,
        cursor: Type.Optional(secretCursorSchema),
        scopeRef: Type.Optional(secretScopeRefSchema),
    },
    { additionalProperties: false },
);

/** A bounded page returned by the module database with an explicit integer-offset continuation. */
export const secretPageSchema = Type.Object(
    {
        secrets: Type.Array(secretReferenceSchema, { maxItems: 50 }),
        limit: Type.Integer({ minimum: 1, maximum: 50 }),
        nextCursor: Type.Optional(secretCursorSchema),
    },
    { additionalProperties: false },
);

/**
 * Raw values returned only to a trusted host through `resolveForHost`. This schema is exported
 * so host adapters can validate their resolver result without importing the module class.
 */
export const secretHostEnvironmentSchema = Type.Record(
    secretEnvironmentVariableNameSchema,
    secretEnvironmentVariableValueSchema,
    {
        additionalProperties: false,
        maxProperties: 256,
    },
);

/**
 * The command-facing result of resolving selected attachments. `hiddenEnvironmentVariables` tells
 * the command host which ambient names to remove before adding `environment`; values never enter a
 * model-facing shape.
 */
export const secretCommandEnvironmentSchema = Type.Object(
    {
        environment: secretHostEnvironmentSchema,
        hiddenEnvironmentVariables: secretEnvironmentVariableNamesSchema,
    },
    { additionalProperties: false },
);

/** The kind of mutation a store applied; a tag on store mutation results. */
export const secretMutationOperationSchema = Type.Union([
    Type.Literal("register"),
    Type.Literal("update"),
    Type.Literal("remove"),
    Type.Literal("attach"),
    Type.Literal("detach"),
]);

export type SecretAgentId = Static<typeof secretAgentIdSchema>;
export type SecretId = Static<typeof secretIdSchema>;
export type SecretReservedId = Static<typeof secretReservedIdSchema>;
export type SecretScopeRef = Static<typeof secretScopeRefSchema>;
export type SecretCursor = Static<typeof secretCursorSchema>;
export type SecretEnvironmentVariableName = Static<typeof secretEnvironmentVariableNameSchema>;
export type SecretEnvironmentVariableNames = Static<typeof secretEnvironmentVariableNamesSchema>;
export type SecretEnvironmentVariableValue = Static<typeof secretEnvironmentVariableValueSchema>;
export type SecretRevision = Static<typeof secretRevisionSchema>;
export type SecretReference = Static<typeof secretReferenceSchema>;
export type SecretRegistration = Static<typeof secretRegistrationSchema>;
export type SecretRegistrationInput = Static<typeof secretRegistrationInputSchema>;
export type SecretUpdateInput = Static<typeof secretUpdateInputSchema>;
export type SecretAttachment = Static<typeof secretAttachmentSchema>;
export type SecretAttachInput = Static<typeof secretAttachInputSchema>;
export type SecretDetachInput = Static<typeof secretDetachInputSchema>;
export type SecretAttachReferenceResult = Static<typeof secretAttachReferenceResultSchema>;
export type SecretListInput = Static<typeof secretListInputSchema>;
export type SecretListQuery = Static<typeof secretListQuerySchema>;
export type SecretPage = Static<typeof secretPageSchema>;
export type SecretHostEnvironment = Static<typeof secretHostEnvironmentSchema>;
export type SecretCommandEnvironment = Static<typeof secretCommandEnvironmentSchema>;
export type SecretMutationOperation = Static<typeof secretMutationOperationSchema>;
