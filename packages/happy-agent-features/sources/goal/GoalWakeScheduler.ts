import { Type, type Static } from "@sinclair/typebox";

import { goalContextSchema } from "./GoalEvent.js";
import { goalAgentIdSchema, goalLifecycleIdSchema, goalOperationIdSchema } from "./SessionGoal.js";
import { goalContinuationPromptSchema } from "./impl/createGoalContinuationPrompt.js";

/** Final encoded-byte cap for one latest scheduler state. */
export const MAX_GOAL_WAKE_STATE_BYTES = 256_000;

/** Stable Agent Base message identity owned by one Goal lifecycle. */
export const goalWakeMessageIdSchema = Type.String({
    minLength: 2,
    maxLength: 32,
    pattern: "^[a-z][a-z0-9]*$",
});

const goalWakeScheduledStateSchema = Type.Object(
    {
        state: Type.Literal("scheduled"),
        agentId: goalAgentIdSchema,
        lifecycleId: goalLifecycleIdSchema,
        messageId: goalWakeMessageIdSchema,
        prompt: goalContinuationPromptSchema,
    },
    { additionalProperties: false },
);
const goalWakeCancelledStateSchema = Type.Object(
    {
        state: Type.Literal("cancelled"),
        agentId: goalAgentIdSchema,
        operationId: goalOperationIdSchema,
    },
    { additionalProperties: false },
);

/**
 * The desired durable latest wake state for one agent.
 *
 * A host scheduler stores exactly one latest state per agent in the transaction carried by the
 * supplied context. A scheduled state survives restart and may deliver only while it remains the
 * latest state: its worker must compare the complete state again in the shared transaction that
 * accepts the Agent Base message. A cancelled state is a durable tombstone that supersedes every
 * earlier schedule.
 */
export const goalWakeStateSchema = Type.Union([
    goalWakeScheduledStateSchema,
    goalWakeCancelledStateSchema,
]);
export const goalWakeReadResultSchema = Type.Union([goalWakeStateSchema, Type.Undefined()]);
export const goalWakeSchedulerSchema = Type.Object(
    {
        read: Type.Function(
            [goalContextSchema, goalAgentIdSchema],
            Type.Promise(goalWakeReadResultSchema),
        ),
        reconcile: Type.Function(
            [goalContextSchema, goalWakeStateSchema],
            Type.Promise(Type.Void()),
        ),
    },
    { additionalProperties: false },
);

export type GoalWakeState = Static<typeof goalWakeStateSchema>;
export type GoalWakeReadResult = Static<typeof goalWakeReadResultSchema>;
export type GoalWakeScheduler = Static<typeof goalWakeSchedulerSchema>;
