import { Type, type Static } from "@sinclair/typebox";
import type { Context } from "@steve.kite/stdlib";

import {
    projectAgentIdSchema,
    projectEventIdSchema,
    projectIdSchema,
    projectNameSchema,
    projectSchema,
    projectSettingsSchema,
    projectTimestampSchema,
} from "./Project.js";

/** Context is host-owned and opaque to this feature. */
export const projectContextSchema = Type.Unsafe<Context>(
    Type.Object({}, { additionalProperties: false }),
);

const projectEventEnvelope = {
    eventId: projectEventIdSchema,
    at: projectTimestampSchema,
    agentId: projectAgentIdSchema,
} as const;

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
            previousName: projectNameSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...projectEventEnvelope,
            type: Type.Literal("project_archived"),
            project: projectSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...projectEventEnvelope,
            type: Type.Literal("project_settings_updated"),
            projectId: projectIdSchema,
            settings: projectSettingsSchema,
        },
        { additionalProperties: false },
    ),
]);

const projectListenerResultSchema = Type.Union([Type.Void(), Type.Promise(Type.Void())]);

export const projectFeatureListenerSchema = Type.Object(
    {
        onEventTransactional: Type.Optional(
            Type.Function(
                [projectContextSchema, projectEventSchema],
                projectListenerResultSchema,
            ),
        ),
        onEvent: Type.Optional(
            Type.Function([projectContextSchema, projectEventSchema], projectListenerResultSchema),
        ),
    },
    { additionalProperties: false },
);

export type ProjectEvent = Static<typeof projectEventSchema>;
export type ProjectFeatureListener = Static<typeof projectFeatureListenerSchema>;