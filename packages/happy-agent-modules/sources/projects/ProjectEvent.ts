import { Type, type Static } from "@sinclair/typebox";
import type { Context } from "@steve.kite/stdlib";

import {
    projectAgentIdSchema,
    projectEventIdSchema,
    projectIdSchema,
    projectNameSchema,
    projectOrderKeySchema,
    projectSchema,
    projectTimestampSchema,
} from "./Project.js";
import { projectAgentAssociationSchema } from "./ProjectAgentAssociation.js";
import { projectSettingsSchema } from "./ProjectSettings.js";

/** Context is host-owned and opaque to this module. */
export const projectContextSchema = Type.Unsafe<Context>(
    Type.Object({}, { additionalProperties: false }),
);

const projectEventEnvelope = {
    eventId: projectEventIdSchema,
    at: projectTimestampSchema,
} as const;

/**
 * Why a lifecycle write happened. Probe, Git and initialization updates all
 * carry the whole project, so one event type with a stated reason keeps the
 * listener contract small.
 */
export const projectStateChangeReasonSchema = Type.Union([
    Type.Literal("probe"),
    Type.Literal("git_facts"),
    Type.Literal("default_branch"),
    Type.Literal("remote_name"),
    Type.Literal("clone_ready"),
    Type.Literal("initialization_ready"),
    Type.Literal("initialization_failed"),
    Type.Literal("initialization_retried"),
    Type.Literal("refresh"),
    Type.Literal("workspace_setup_commands"),
]);

export const projectEventSchema = Type.Union([
    Type.Object(
        {
            ...projectEventEnvelope,
            type: Type.Literal("project_created"),
            project: projectSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...projectEventEnvelope,
            type: Type.Literal("project_renamed"),
            project: projectSchema,
            previousProject: projectSchema,
            previousName: projectNameSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...projectEventEnvelope,
            type: Type.Literal("project_archived"),
            project: projectSchema,
            previousProject: projectSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...projectEventEnvelope,
            type: Type.Literal("project_restored"),
            project: projectSchema,
            previousProject: projectSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...projectEventEnvelope,
            type: Type.Literal("project_reordered"),
            previousOrderKey: projectOrderKeySchema,
            project: projectSchema,
            previousProject: projectSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...projectEventEnvelope,
            type: Type.Literal("project_avatar_updated"),
            project: projectSchema,
            previousProject: projectSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...projectEventEnvelope,
            type: Type.Literal("project_avatar_cleared"),
            project: projectSchema,
            previousProject: projectSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...projectEventEnvelope,
            type: Type.Literal("project_settings_updated"),
            projectId: projectIdSchema,
            project: projectSchema,
            previousProject: projectSchema,
            settings: projectSettingsSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...projectEventEnvelope,
            type: Type.Literal("project_agent_attached"),
            association: projectAgentAssociationSchema,
            project: projectSchema,
            previousProject: projectSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...projectEventEnvelope,
            type: Type.Literal("project_agent_reordered"),
            association: projectAgentAssociationSchema,
            previousOrderKey: projectOrderKeySchema,
            project: projectSchema,
            previousProject: projectSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...projectEventEnvelope,
            type: Type.Literal("project_agent_visibility_changed"),
            agentId: projectAgentIdSchema,
            visible: Type.Boolean(),
            project: projectSchema,
            previousProject: projectSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...projectEventEnvelope,
            type: Type.Literal("project_state_changed"),
            reason: projectStateChangeReasonSchema,
            project: projectSchema,
            previousProject: projectSchema,
        },
        { additionalProperties: false },
    ),
]);

const projectListenerResultSchema = Type.Union([Type.Void(), Type.Promise(Type.Void())]);

/** One subscriber taken after construction. */
export const projectEventListenerSchema = Type.Function(
    [projectContextSchema, projectEventSchema],
    projectListenerResultSchema,
);

export type ProjectStateChangeReason = Static<typeof projectStateChangeReasonSchema>;
export type ProjectEvent = Static<typeof projectEventSchema>;
export type ProjectEventListener = Static<typeof projectEventListenerSchema>;

/** Ends a subscription. Calling it more than once does nothing further. */
export type ProjectUnsubscribe = () => void;
