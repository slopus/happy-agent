import { Type, type Static } from "@sinclair/typebox";

export const subtaskIdSchema = Type.String({
    minLength: 2,
    maxLength: 32,
    pattern: "^[a-z][a-z0-9]*$",
});

export const createSubtaskInputSchema = Type.Object(
    {
        title: Type.String({ minLength: 1, maxLength: 256 }),
        text: Type.String({ minLength: 1, maxLength: 50_000 }),
        model: Type.String({ minLength: 1, maxLength: 256 }),
        effort: Type.Union([
            Type.Literal("off"),
            Type.Literal("minimal"),
            Type.Literal("low"),
            Type.Literal("medium"),
            Type.Literal("high"),
            Type.Literal("xhigh"),
            Type.Literal("max"),
        ]),
        provider: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        serviceTier: Type.Optional(Type.Literal("priority")),
        workspace: Type.Optional(
            Type.Object(
                {
                    projectId: subtaskIdSchema,
                    name: Type.String({ minLength: 1, maxLength: 256 }),
                    baseRef: Type.Optional(Type.String({ minLength: 1, maxLength: 1_024 })),
                },
                { additionalProperties: false },
            ),
        ),
    },
    { additionalProperties: false },
);
export type CreateSubtaskInput = Static<typeof createSubtaskInputSchema>;

export const subtaskResultSchema = Type.Object(
    {
        agentId: subtaskIdSchema,
        workspaceId: Type.Optional(subtaskIdSchema),
    },
    { additionalProperties: false },
);
export type SubtaskResult = Static<typeof subtaskResultSchema>;

export const subtaskStartSchema = Type.Object(
    {
        agentId: subtaskIdSchema,
        parentAgentId: subtaskIdSchema,
        workspaceId: Type.Optional(subtaskIdSchema),
        input: createSubtaskInputSchema,
    },
    { additionalProperties: false },
);
export type SubtaskStart = Static<typeof subtaskStartSchema>;

export const subtaskMetadataSchema = Type.Object({ subtask: Type.Literal(true) });
export const workspaceSubtaskMetadataSchema = Type.Object({
    subtask: Type.Literal(true),
    subtaskWorkspaceId: subtaskIdSchema,
});
export const archivedMetadataSchema = Type.Object({ archivedAt: Type.Number() });

export const SUBTASK_START_FUNCTION = "subtasks.start";

export class SubtaskInputError extends Error {}
