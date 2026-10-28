import { agentMetadataSchema, agentPermissionModeSchema } from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";

import { delegatedPermissionFlagSchemas } from "../impl/delegatedPermissionMode.js";

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
        /** Who runs the subtask's loop: Happy's own or a foreign agent's, by harness ID. */
        harness: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        provider: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        serviceTier: Type.Optional(Type.Literal("priority")),
        /** The subtask runs in its coordinator's own mode unless one of these says otherwise. */
        ...delegatedPermissionFlagSchemas,
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

/**
 * A subtask whose conversation another module drives, such as one guest's chat with an exported
 * bot. It has no opening task; `metadata` carries the caller's own fields beside the
 * subtask's, which always win.
 */
export const createConversationSubtaskInputSchema = Type.Object(
    {
        title: Type.String({ minLength: 1, maxLength: 256 }),
        metadata: Type.Optional(agentMetadataSchema),
    },
    { additionalProperties: false },
);
export type CreateConversationSubtaskInput = Static<typeof createConversationSubtaskInputSchema>;

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
        /**
         * The mode creation settled while the coordinator's own was known; the start runs on a
         * context that names no agent. A start recorded before modes were kept has none.
         */
        permissionMode: Type.Optional(agentPermissionModeSchema),
    },
    { additionalProperties: false },
);
export type SubtaskStart = Static<typeof subtaskStartSchema>;

export const subtaskMetadataSchema = Type.Object({ subtask: Type.Literal(true) });
export const workspaceSubtaskMetadataSchema = Type.Object({
    subtask: Type.Literal(true),
    subtaskWorkspaceId: subtaskIdSchema,
});
/** A subtask holding a conversation another module delivers, created by `createConversation`. */
export const conversationSubtaskMetadataSchema = Type.Object({
    subtask: Type.Literal(true),
    subtaskConversation: Type.Literal(true),
});
export const archivedMetadataSchema = Type.Object({ archivedAt: Type.Number() });
export const restoredMetadataSchema = Type.Object({ archivedAt: Type.Null() });
export const versionedMetadataSchema = Type.Object({ version: Type.Integer({ minimum: 1 }) });
export const orderedSubtaskMetadataSchema = Type.Object({
    subtask: Type.Literal(true),
    subtaskOrderKey: Type.String({ minLength: 1, pattern: "^[0-9]+$" }),
});
export const archiveSubtaskInputSchema = Type.Object(
    { agentId: subtaskIdSchema },
    { additionalProperties: false },
);
export type ArchiveSubtaskInput = Static<typeof archiveSubtaskInputSchema>;

export const SUBTASK_START_FUNCTION = "subtasks.start";
export const SUBTASK_ARCHIVE_FUNCTION = "subtasks.archive";

export class SubtaskInputError extends Error {}
