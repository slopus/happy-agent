import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { TypeSystem } from "@sinclair/typebox/system";

/**
 * Projects are host-owned catalog rows. The feature deliberately treats the
 * repository reference as opaque: a host may use a path, URI, database key,
 * or any other representation without leaking that knowledge here.
 */
export const MAX_PROJECT_ID_LENGTH = 96;
export const MAX_PROJECT_AGENT_ID_LENGTH = 96;
export const MAX_PROJECT_REPOSITORY_REF_LENGTH = 2_048;
export const MAX_PROJECT_NAME_LENGTH = 500;
export const MAX_PROJECT_DESCRIPTION_LENGTH = 2_000;
export const MAX_PROJECT_OPERATION_ID_LENGTH = 96;
export const MAX_PROJECT_FINGERPRINT_LENGTH = 64;
export const MAX_PROJECT_EVENT_ID_LENGTH = 128;
export const MAX_PROJECT_TIMESTAMP = Number.MAX_SAFE_INTEGER;

export const MAX_PROJECT_SETTINGS_DEPTH = 8;
export const MAX_PROJECT_SETTINGS_STRING_LENGTH = 4_096;
export const MAX_PROJECT_SETTINGS_KEY_LENGTH = 128;
export const MAX_PROJECT_SETTINGS_ITEMS = 64;
export const MAX_PROJECT_SETTINGS_PROPERTIES = 64;
export const MAX_PROJECT_SETTINGS_ENCODED_BYTES = 16 * 1024;

const PROJECT_VISIBLE_IDENTIFIER_PATTERN =
    /^(?=[\s\S]*[^\p{Cc}\p{Cf}\p{Cn}\p{Cs}\p{Zs}\p{Zl}\p{Zp}\p{Mn}\p{Me}])(?:[^\uD800-\uDFFF])+$/u;

function projectVisibleIdentifierSchemaFor(maxLength: number) {
    return Type.RegExp(PROJECT_VISIBLE_IDENTIFIER_PATTERN, {
        minLength: 1,
        maxLength,
    });
}

export const projectIdSchema = projectVisibleIdentifierSchemaFor(MAX_PROJECT_ID_LENGTH);

export const projectAgentIdSchema = projectVisibleIdentifierSchemaFor(MAX_PROJECT_AGENT_ID_LENGTH);

export const projectRepositoryRefSchema = Type.String({
    minLength: 1,
    maxLength: MAX_PROJECT_REPOSITORY_REF_LENGTH,
    pattern: "^[^\\u0000\\r\\n]+$",
});

export const projectNameSchema = Type.String({
    minLength: 1,
    maxLength: MAX_PROJECT_NAME_LENGTH,
    pattern: "^[^\\u0000\\r\\n]+$",
});

export const projectDescriptionSchema = Type.String({
    minLength: 1,
    maxLength: MAX_PROJECT_DESCRIPTION_LENGTH,
    pattern: "^[^\\u0000\\r\\n]+$",
});

export const projectOperationIdSchema = Type.String({
    minLength: 1,
    maxLength: MAX_PROJECT_OPERATION_ID_LENGTH,
    pattern: "^[^\\u0000\\r\\n]+$",
});

export const projectOperationFingerprintSchema = Type.String({
    minLength: MAX_PROJECT_FINGERPRINT_LENGTH,
    maxLength: MAX_PROJECT_FINGERPRINT_LENGTH,
    pattern: "^[0-9a-f]{64}$",
});

export const projectEventIdSchema = Type.String({
    minLength: 1,
    maxLength: MAX_PROJECT_EVENT_ID_LENGTH,
    pattern: "^[^\\u0000\\r\\n]+$",
});

export const projectTimestampSchema = Type.Integer({
    minimum: 0,
    maximum: MAX_PROJECT_TIMESTAMP,
});

export const projectStatusSchema = Type.Union([Type.Literal("active"), Type.Literal("archived")]);

export const projectMutationOperationSchema = Type.Union([
    Type.Literal("create"),
    Type.Literal("ensure"),
    Type.Literal("rename"),
    Type.Literal("archive"),
    Type.Literal("update_settings"),
]);

export const projectOperationStateSchema = Type.Object(
    {
        id: Type.Union([projectIdSchema, projectOperationIdSchema]),
        fingerprint: projectOperationFingerprintSchema,
    },
    { additionalProperties: false },
);

const projectSettingsLeafSchema = Type.Union([
    Type.String({ maxLength: MAX_PROJECT_SETTINGS_STRING_LENGTH }),
    Type.Number({
        minimum: -Number.MAX_SAFE_INTEGER,
        maximum: Number.MAX_SAFE_INTEGER,
    }),
    Type.Boolean(),
    Type.Null(),
]);

const projectPlainObjectSchema = TypeSystem.Type<Record<string, unknown>>(
    "ProjectPlainObject",
    (_schema, value) => {
        if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
        try {
            const prototype = Object.getPrototypeOf(value);
            return prototype === Object.prototype || prototype === null;
        } catch {
            return false;
        }
    },
)({ type: "object" });

function projectSettingsRecordSchema<T extends TSchema>(child: T) {
    return Type.Intersect([
        projectPlainObjectSchema,
        Type.Record(Type.String({ maxLength: MAX_PROJECT_SETTINGS_KEY_LENGTH }), child, {
            maxProperties: MAX_PROJECT_SETTINGS_PROPERTIES,
        }),
    ]);
}

function projectSettingsValueAtDepth(depth: number): TSchema {
    if (depth <= 0) return projectSettingsLeafSchema;
    const child = projectSettingsValueAtDepth(depth - 1);
    return Type.Union([
        projectSettingsLeafSchema,
        Type.Array(child, { maxItems: MAX_PROJECT_SETTINGS_ITEMS }),
        projectSettingsRecordSchema(child),
    ]);
}

/**
 * A finite recursive JSON schema. A recursive Type.Record with no depth
 * boundary would still permit an arbitrarily deep persistence value.
 */
export const projectSettingsValueSchema = projectSettingsValueAtDepth(
    MAX_PROJECT_SETTINGS_DEPTH - 1,
);
export const projectSettingsSchema = projectSettingsRecordSchema(projectSettingsValueSchema);

export const projectSchema = Type.Object(
    {
        id: projectIdSchema,
        ownerAgentId: projectAgentIdSchema,
        repositoryRef: projectRepositoryRefSchema,
        name: projectNameSchema,
        status: projectStatusSchema,
        description: Type.Optional(projectDescriptionSchema),
        createdAt: projectTimestampSchema,
        updatedAt: projectTimestampSchema,
        archivedAt: Type.Optional(projectTimestampSchema),
    },
    { additionalProperties: false },
);

/** Host-facing create input. Durable identities are omitted from tool input. */
export const projectCreateInputSchema = Type.Object(
    {
        id: Type.Optional(projectIdSchema),
        operationId: Type.Optional(projectOperationIdSchema),
        repositoryRef: projectRepositoryRefSchema,
        name: projectNameSchema,
        description: Type.Optional(projectDescriptionSchema),
    },
    { additionalProperties: false },
);

export const projectCreateToolInputSchema = Type.Object(
    {
        repositoryRef: projectRepositoryRefSchema,
        name: projectNameSchema,
        description: Type.Optional(projectDescriptionSchema),
    },
    { additionalProperties: false },
);

/**
 * Ensure can be called immediately after detecting a repository. A host may
 * derive a display name when the caller has not supplied one.
 */
export const projectEnsureInputSchema = Type.Object(
    {
        operationId: Type.Optional(projectOperationIdSchema),
        repositoryRef: projectRepositoryRefSchema,
        name: Type.Optional(projectNameSchema),
        description: Type.Optional(projectDescriptionSchema),
    },
    { additionalProperties: false },
);

export const projectEnsureToolInputSchema = Type.Object(
    {
        repositoryRef: projectRepositoryRefSchema,
        name: Type.Optional(projectNameSchema),
        description: Type.Optional(projectDescriptionSchema),
    },
    { additionalProperties: false },
);

export const projectRenameInputSchema = Type.Object(
    {
        projectId: projectIdSchema,
        name: projectNameSchema,
        operationId: Type.Optional(projectOperationIdSchema),
    },
    { additionalProperties: false },
);

export const projectRenameToolInputSchema = Type.Object(
    {
        projectId: projectIdSchema,
        name: projectNameSchema,
    },
    { additionalProperties: false },
);

/** Positional mutation changes for hosts that already carry the project ID. */
export const projectRenameChangesSchema = Type.Object(
    {
        name: projectNameSchema,
        operationId: Type.Optional(projectOperationIdSchema),
    },
    { additionalProperties: false },
);

export const projectArchiveOptionsSchema = Type.Object(
    { operationId: Type.Optional(projectOperationIdSchema) },
    { additionalProperties: false },
);

export const projectSettingsUpdateInputSchema = Type.Object(
    {
        projectId: projectIdSchema,
        settings: projectSettingsSchema,
        operationId: Type.Optional(projectOperationIdSchema),
    },
    { additionalProperties: false },
);

export const projectSettingsUpdateToolInputSchema = Type.Object(
    {
        projectId: projectIdSchema,
        settings: projectSettingsSchema,
    },
    { additionalProperties: false },
);

export type ProjectId = Static<typeof projectIdSchema>;
export type ProjectAgentId = Static<typeof projectAgentIdSchema>;
export type ProjectRepositoryRef = Static<typeof projectRepositoryRefSchema>;
export type ProjectName = Static<typeof projectNameSchema>;
export type ProjectDescription = Static<typeof projectDescriptionSchema>;
export type ProjectOperationId = Static<typeof projectOperationIdSchema>;
export type ProjectOperationFingerprint = Static<typeof projectOperationFingerprintSchema>;
export type ProjectEventId = Static<typeof projectEventIdSchema>;
export type ProjectTimestamp = Static<typeof projectTimestampSchema>;
export type ProjectStatus = Static<typeof projectStatusSchema>;
export type ProjectMutationOperation = Static<typeof projectMutationOperationSchema>;
export type ProjectOperationState = Static<typeof projectOperationStateSchema>;
export type ProjectSettingsValue = Static<typeof projectSettingsValueSchema>;
export type ProjectSettings = Static<typeof projectSettingsSchema>;
export type Project = Static<typeof projectSchema>;
export type ProjectCreateInput = Static<typeof projectCreateInputSchema>;
export type ProjectCreateToolInput = Static<typeof projectCreateToolInputSchema>;
export type ProjectEnsureInput = Static<typeof projectEnsureInputSchema>;
export type ProjectEnsureToolInput = Static<typeof projectEnsureToolInputSchema>;
export type ProjectRenameInput = Static<typeof projectRenameInputSchema>;
export type ProjectRenameChanges = Static<typeof projectRenameChangesSchema>;
export type ProjectRenameToolInput = Static<typeof projectRenameToolInputSchema>;
export type ProjectArchiveOptions = Static<typeof projectArchiveOptionsSchema>;
export type ProjectSettingsUpdateInput = Static<typeof projectSettingsUpdateInputSchema>;
export type ProjectSettingsUpdateToolInput = Static<typeof projectSettingsUpdateToolInputSchema>;
