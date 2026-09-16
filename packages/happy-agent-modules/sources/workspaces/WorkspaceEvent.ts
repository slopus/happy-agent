import { Type, type Static } from "@sinclair/typebox";
import type { Context } from "@steve.kite/stdlib";

import {
    MAX_WORKSPACE_EVENT_ID_LENGTH,
    workspaceAgentIdSchema,
    workspaceNameSchema,
    workspaceOrderKeySchema,
    workspaceSchema,
    workspaceTimestampSchema,
} from "./Workspace.js";
import { workspaceAgentAssociationSchema } from "./WorkspaceAgent.js";

/** Context is host-owned and opaque to this module. */
export const workspaceContextSchema = Type.Unsafe<Context>(
    Type.Object({}, { additionalProperties: false }),
);

export const workspaceEventIdSchema = Type.String({
    minLength: 1,
    maxLength: MAX_WORKSPACE_EVENT_ID_LENGTH,
});

/**
 * The lifecycle step behind a `workspace_updated` event. These transitions are host bookkeeping —
 * Git discovery, readiness, failure, and the start of archival — rather than something a person
 * asked for by name, so they share one event and say which step they were.
 */
export const workspaceUpdateChangeSchema = Type.Union([
    Type.Literal("record_initialization"),
    Type.Literal("mark_ready"),
    Type.Literal("mark_failed"),
    Type.Literal("mark_initialization_failed"),
    Type.Literal("set_branch"),
    Type.Literal("begin_archive"),
    Type.Literal("apply_git_facts"),
    Type.Literal("apply_probe"),
    Type.Literal("set_service_cleanup"),
]);

const eventEnvelope = {
    eventId: workspaceEventIdSchema,
    at: workspaceTimestampSchema,
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
            type: Type.Literal("workspace_updated"),
            change: workspaceUpdateChangeSchema,
            workspace: workspaceSchema,
            previousWorkspace: workspaceSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...eventEnvelope,
            type: Type.Literal("workspace_renamed"),
            workspace: workspaceSchema,
            previousWorkspace: workspaceSchema,
            previousName: workspaceNameSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...eventEnvelope,
            type: Type.Literal("workspace_reordered"),
            workspace: workspaceSchema,
            previousWorkspace: workspaceSchema,
            previousOrderKey: workspaceOrderKeySchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...eventEnvelope,
            type: Type.Literal("workspace_archived"),
            workspace: workspaceSchema,
            previousWorkspace: workspaceSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...eventEnvelope,
            type: Type.Literal("workspace_agent_attached"),
            association: workspaceAgentAssociationSchema,
            workspace: workspaceSchema,
            previousWorkspace: workspaceSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...eventEnvelope,
            type: Type.Literal("workspace_agent_reordered"),
            association: workspaceAgentAssociationSchema,
            previousOrderKey: workspaceOrderKeySchema,
            workspace: workspaceSchema,
            previousWorkspace: workspaceSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...eventEnvelope,
            type: Type.Literal("workspace_agent_visibility_changed"),
            agentId: workspaceAgentIdSchema,
            visible: Type.Boolean(),
            workspace: workspaceSchema,
            previousWorkspace: workspaceSchema,
        },
        { additionalProperties: false },
    ),
]);

export type WorkspaceUpdateChange = Static<typeof workspaceUpdateChangeSchema>;
export type WorkspaceEvent = Static<typeof workspaceEventSchema>;

const workspaceListenerResultSchema = Type.Union([Type.Void(), Type.Promise(Type.Void())]);

/**
 * One subscriber taken after construction.
 *
 * Both kinds of subscriber receive the exact same detached, deeply frozen event object. A
 * transactional subscriber sees it inside the transaction the change commits in; a post-commit
 * subscriber only once that transaction has committed.
 */
export const workspaceEventListenerSchema = Type.Function(
    [workspaceContextSchema, workspaceEventSchema],
    workspaceListenerResultSchema,
);

export type WorkspaceEventListener = Static<typeof workspaceEventListenerSchema>;

/** Ends a subscription. Calling it more than once does nothing further. */
export type WorkspaceUnsubscribe = () => void;
