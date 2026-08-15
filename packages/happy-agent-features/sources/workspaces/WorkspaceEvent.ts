import { Type, type Static } from "@sinclair/typebox";
import type { Context } from "@steve.kite/stdlib";

import {
    MAX_WORKSPACE_EVENT_ID_LENGTH,
    workspaceAgentIdSchema,
    workspaceIdSchema,
    workspaceProjectRefSchema,
    workspaceSchema,
    workspaceTimestampSchema,
} from "./Workspace.js";

/** Context is host-owned and opaque to this feature. */
export const workspaceContextSchema = Type.Unsafe<Context>(
    Type.Object({}, { additionalProperties: false }),
);

export const workspaceEventIdSchema = Type.String({
    minLength: 1,
    maxLength: MAX_WORKSPACE_EVENT_ID_LENGTH,
});

const eventEnvelope = {
    eventId: workspaceEventIdSchema,
    at: workspaceTimestampSchema,
    agentId: workspaceAgentIdSchema,
} as const;

export const workspaceEventSchema = Type.Union([
    Type.Object(
        {
            ...eventEnvelope,
            type: Type.Literal("workspace_created"),
            workspace: workspaceSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...eventEnvelope,
            type: Type.Literal("workspace_transferred"),
            workspace: workspaceSchema,
            previousProjectRef: Type.Optional(workspaceProjectRefSchema),
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...eventEnvelope,
            type: Type.Literal("workspace_archived"),
            workspace: workspaceSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...eventEnvelope,
            type: Type.Literal("workspace_transfer_scheduled"),
            targetWorkspaceId: workspaceIdSchema,
        },
        { additionalProperties: false },
    ),
]);

export type WorkspaceEvent = Static<typeof workspaceEventSchema>;

const workspaceListenerResultSchema = Type.Union([Type.Void(), Type.Promise(Type.Void())]);

/**
 * Both observers receive the exact same detached, deeply frozen event object.
 * The host calls the post-commit callback only once its outermost transaction
 * has committed.
 */
export const workspaceFeatureListenerSchema = Type.Object(
    {
        onEventTransactional: Type.Optional(
            Type.Function(
                [workspaceContextSchema, workspaceEventSchema],
                workspaceListenerResultSchema,
            ),
        ),
        onEvent: Type.Optional(
            Type.Function(
                [workspaceContextSchema, workspaceEventSchema],
                workspaceListenerResultSchema,
            ),
        ),
    },
    { additionalProperties: false },
);

export type WorkspaceFeatureListener = Static<typeof workspaceFeatureListenerSchema>;
