import { Type, type Static } from "@sinclair/typebox";
import type { Context } from "@steve.kite/stdlib";

import { workflowAgentIdSchema, workflowRunSchema, workflowTimestampSchema } from "./Workflow.js";

export const MAX_WORKFLOW_POST_COMMIT_ERROR_LENGTH = 500;

export const workflowEventIdSchema = Type.String({
    minLength: 1,
    maxLength: 256,
});

/** Bounded, value-free diagnostic passed to the advisory post-commit reporter. */
export const workflowPostCommitErrorSchema = Type.String({
    minLength: 1,
    maxLength: MAX_WORKFLOW_POST_COMMIT_ERROR_LENGTH,
    pattern: "^[^\\u0000]*$",
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
export type WorkflowPostCommitError = Static<typeof workflowPostCommitErrorSchema>;

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
