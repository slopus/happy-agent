import { Type } from "@sinclair/typebox";
import { cuid2Schema } from "@slopus/happy-agent-base";
import { clientMetadataSchema } from "@slopus/happy-agent-client";

export { invokeSlashCommandRequestSchema } from "@slopus/happy-agent-client";

import { createTerminalInputSchema, resizeTerminalInputSchema } from "../terminals/index.js";

export const apiIdSchema = Type.String({
    minLength: 2,
    maxLength: 96,
    pattern: "^[a-z][a-z0-9]+$",
});

/** Question labels inside one user-input batch may use mixed case, underscores, and hyphens. */
export const questionIdSchema = Type.String({
    minLength: 1,
    maxLength: 96,
    pattern: "^[A-Za-z0-9][A-Za-z0-9_-]*$",
});

export const mutationIdSchema = Type.String({ minLength: 1, maxLength: 512 });

export const projectRegisterBodySchema = Type.Object(
    {
        mutationId: Type.Optional(mutationIdSchema),
        path: Type.String({ minLength: 1, maxLength: 4_096 }),
        projectId: Type.Optional(apiIdSchema),
    },
    { additionalProperties: false },
);

const remoteSourceSchema = Type.Union([
    Type.Object(
        {
            kind: Type.Literal("github"),
            repository: Type.String({ minLength: 3, maxLength: 201 }),
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            kind: Type.Literal("git"),
            url: Type.String({ minLength: 1, maxLength: 2_048 }),
        },
        { additionalProperties: false },
    ),
]);

export const projectCloneBodySchema = Type.Object(
    {
        mutationId: Type.Optional(mutationIdSchema),
        name: Type.String({ minLength: 1, maxLength: 500 }),
        projectId: Type.Optional(apiIdSchema),
        secret: Type.Optional(
            Type.Object({ kind: Type.Literal("github") }, { additionalProperties: false }),
        ),
        source: remoteSourceSchema,
    },
    { additionalProperties: false },
);

export const renameBodySchema = Type.Object(
    {
        mutationId: Type.Optional(mutationIdSchema),
        name: Type.String({ minLength: 1, maxLength: 500 }),
    },
    { additionalProperties: false },
);

export const reorderBodySchema = Type.Object(
    {
        afterId: Type.Union([apiIdSchema, Type.Null()]),
        mutationId: Type.Optional(mutationIdSchema),
    },
    { additionalProperties: false },
);

export const emptyMutationBodySchema = Type.Object(
    { mutationId: Type.Optional(mutationIdSchema) },
    { additionalProperties: false },
);

export const projectSettingsBodySchema = Type.Object(
    {
        defaultWorkspaceCompute: Type.Union([
            Type.Object({ type: Type.Literal("host") }, { additionalProperties: false }),
            Type.Object(
                {
                    image: Type.String({ minLength: 1, maxLength: 4_096 }),
                    type: Type.Literal("docker"),
                },
                { additionalProperties: false },
            ),
        ]),
        mutationId: Type.Optional(mutationIdSchema),
    },
    { additionalProperties: false },
);

export const workspaceCreateBodySchema = Type.Object(
    {
        agentId: Type.Optional(apiIdSchema),
        baseRef: Type.Optional(Type.String({ minLength: 1, maxLength: 1_024 })),
        id: Type.Optional(cuid2Schema),
        name: Type.String({ minLength: 1, maxLength: 500 }),
        nameConfigured: Type.Optional(Type.Boolean()),
        mutationId: Type.Optional(mutationIdSchema),
        parentId: apiIdSchema,
    },
    { additionalProperties: false },
);

export const terminalCreateBodySchema = Type.Composite(
    [createTerminalInputSchema, Type.Object({ mutationId: Type.Optional(mutationIdSchema) })],
    { additionalProperties: false },
);
export const terminalResizeBodySchema = Type.Composite(
    [resizeTerminalInputSchema, Type.Object({ mutationId: Type.Optional(mutationIdSchema) })],
    { additionalProperties: false },
);

const permissionModeSchema = Type.Union([
    Type.Literal("read_only"),
    Type.Literal("workspace_write"),
    Type.Literal("auto"),
    Type.Literal("full_access"),
]);

export const agentModeSchema = Type.Object(
    {
        effort: Type.String({ minLength: 1, maxLength: 64 }),
        modelId: Type.String({ minLength: 1, maxLength: 512 }),
        permissionMode: permissionModeSchema,
        providerId: Type.String({ minLength: 1, maxLength: 128 }),
        serviceTier: Type.Union([Type.Null(), Type.String({ minLength: 1, maxLength: 64 })]),
    },
    { additionalProperties: false },
);

export const agentCreateBodySchema = Type.Object(
    {
        id: Type.Optional(apiIdSchema),
        mutationId: Type.Optional(mutationIdSchema),
        parentAgentId: Type.Optional(apiIdSchema),
        title: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
        workspaceId: apiIdSchema,
    },
    { additionalProperties: false },
);

export const messageSendBodySchema = Type.Object(
    {
        clientMetadata: Type.Optional(clientMetadataSchema),
        content: Type.Optional(
            Type.Array(
                Type.Union([
                    Type.Object(
                        { text: Type.String(), type: Type.Literal("text") },
                        { additionalProperties: false },
                    ),
                    Type.Object(
                        {
                            data: Type.String(),
                            mimeType: Type.String({ minLength: 1, maxLength: 256 }),
                            type: Type.Literal("image"),
                        },
                        { additionalProperties: false },
                    ),
                ]),
                { maxItems: 64 },
            ),
        ),
        delivery: Type.Optional(Type.Union([Type.Literal("queue"), Type.Literal("steer")])),
        id: Type.Optional(apiIdSchema),
        mode: agentModeSchema,
        text: Type.String({ minLength: 1, maxLength: 1_000_000 }),
    },
    { additionalProperties: false },
);

export const abortBodySchema = Type.Object(
    {
        expectedRunId: Type.Optional(apiIdSchema),
        mutationId: Type.Optional(mutationIdSchema),
    },
    { additionalProperties: false },
);

export const questionAnswerBodySchema = Type.Object(
    {
        answers: Type.Record(
            questionIdSchema,
            Type.Array(Type.String({ maxLength: 100_000 }), {
                minItems: 1,
                maxItems: 128,
            }),
            { minProperties: 1, maxProperties: 128 },
        ),
        mutationId: Type.Optional(mutationIdSchema),
    },
    { additionalProperties: false },
);

export const documentBodySchema = Type.Object(
    {
        instructions: Type.String({ maxLength: 256 * 1_024 }),
        mutationId: Type.Optional(mutationIdSchema),
    },
    { additionalProperties: false },
);

export const securityDocumentBodySchema = Type.Object(
    {
        mutationId: Type.Optional(mutationIdSchema),
        policy: Type.String({ maxLength: 32 * 1_024 }),
    },
    { additionalProperties: false },
);

export const profilePatchBodySchema = Type.Object(
    {
        email: Type.Optional(
            Type.Union([Type.Null(), Type.String({ minLength: 3, maxLength: 254 })]),
        ),
        mutationId: Type.Optional(mutationIdSchema),
        name: Type.Optional(
            Type.Union([Type.Null(), Type.String({ minLength: 1, maxLength: 128 })]),
        ),
    },
    { additionalProperties: false, minProperties: 1 },
);

export const gitWatchBodySchema = Type.Object(
    {
        workspaceIds: Type.Array(apiIdSchema, {
            maxItems: 256,
            uniqueItems: true,
        }),
    },
    { additionalProperties: false },
);

export const draftBodySchema = Type.Object(
    {
        draft: Type.Union([
            Type.Null(),
            Type.Composite([
                agentModeSchema,
                Type.Object({ text: Type.String({ maxLength: 1_000_000 }) }),
            ]),
        ]),
        mutationId: Type.Optional(mutationIdSchema),
        updatedAt: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
    },
    { additionalProperties: false },
);
