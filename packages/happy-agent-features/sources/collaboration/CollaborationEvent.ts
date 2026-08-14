import { Type, type Static } from "@sinclair/typebox";
import type { Context } from "@steve.kite/stdlib";

import {
    collaborationAgentIdSchema,
    collaborationAgentSchema,
    collaborationAgentStatusSchema,
} from "./CollaborationAgent.js";
import {
    collaborationMessageIdSchema,
    collaborationMessageSchema,
    collaborationObligationIdSchema,
    collaborationObligationSchema,
    collaborationScheduleSchema,
} from "./CollaborationMessage.js";

export const collaborationEventIdSchema = Type.String({
    minLength: 2,
    maxLength: 128,
    pattern: "^[a-z][a-z0-9-]*$",
});

const eventEnvelope = {
    eventId: collaborationEventIdSchema,
    at: Type.Integer({ minimum: 0 }),
    actingAgentId: collaborationAgentIdSchema,
};

/** Events are immutable snapshots delivered inside and after the host transaction. */
export const collaborationEventSchema = Type.Union([
    Type.Object(
        {
            ...eventEnvelope,
            type: Type.Literal("agent_created"),
            agent: collaborationAgentSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...eventEnvelope,
            type: Type.Literal("agent_status_changed"),
            agentId: collaborationAgentIdSchema,
            status: collaborationAgentStatusSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...eventEnvelope,
            type: Type.Literal("message_sent"),
            message: collaborationMessageSchema,
            obligation: Type.Optional(collaborationObligationSchema),
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...eventEnvelope,
            type: Type.Literal("reply_answered"),
            obligationId: collaborationObligationIdSchema,
            answerMessageId: collaborationMessageIdSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...eventEnvelope,
            type: Type.Literal("schedule_created"),
            schedule: collaborationScheduleSchema,
        },
        { additionalProperties: false },
    ),
]);

export type CollaborationEvent = Static<typeof collaborationEventSchema>;

const opaqueContextSchema = Type.Unsafe<Context>(Type.Object({}, { additionalProperties: true }));
const listenerReturnSchema = Type.Union([Type.Void(), Type.Promise(Type.Void())]);

/** Runtime contract for transactional and outermost post-commit observers. */
export const collaborationFeatureListenerSchema = Type.Object(
    {
        onEventTransactional: Type.Optional(
            Type.Function([opaqueContextSchema, collaborationEventSchema], listenerReturnSchema),
        ),
        onEvent: Type.Optional(
            Type.Function([opaqueContextSchema, collaborationEventSchema], listenerReturnSchema),
        ),
    },
    { additionalProperties: false },
);

export type CollaborationFeatureListener = Static<typeof collaborationFeatureListenerSchema>;
