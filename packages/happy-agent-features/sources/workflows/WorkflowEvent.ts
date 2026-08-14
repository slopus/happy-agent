import { Type, type Static } from "@sinclair/typebox";
import type { Context } from "@steve.kite/stdlib";

import { workflowAgentIdSchema, workflowRunSchema, workflowTimestampSchema } from "./Workflow.js";

export const workflowEventIdSchema = Type.String({
    minLength: 1,
    maxLength: 256,
});

export const workflowEventSchema = Type.Union([
    Type.Object(
        {
            type: Type.Literal("workflow_started"),
            agentId: workflowAgentIdSchema,
            eventId: workflowEventIdSchema,
            at: workflowTimestampSchema,
            run: workflowRunSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            type: Type.Literal("workflow_updated"),
            agentId: workflowAgentIdSchema,
            eventId: workflowEventIdSchema,
            at: workflowTimestampSchema,
            run: workflowRunSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            type: Type.Literal("workflow_cancelled"),
            agentId: workflowAgentIdSchema,
            eventId: workflowEventIdSchema,
            at: workflowTimestampSchema,
            run: workflowRunSchema,
        },
        { additionalProperties: false },
    ),
]);

export type WorkflowEvent = Static<typeof workflowEventSchema>;

export const workflowFeatureListenerSchema = Type.Object(
    {
        onEventTransactional: Type.Optional(
            Type.Function(
                [
                    Type.Unsafe<Context>(Type.Object({}, { additionalProperties: false })),
                    workflowEventSchema,
                ],
                Type.Union([Type.Void(), Type.Promise(Type.Void())]),
            ),
        ),
        onEvent: Type.Optional(
            Type.Function(
                [
                    Type.Unsafe<Context>(Type.Object({}, { additionalProperties: false })),
                    workflowEventSchema,
                ],
                Type.Union([Type.Void(), Type.Promise(Type.Void())]),
            ),
        ),
    },
    { additionalProperties: false },
);

export type WorkflowFeatureListener = Static<typeof workflowFeatureListenerSchema>;
