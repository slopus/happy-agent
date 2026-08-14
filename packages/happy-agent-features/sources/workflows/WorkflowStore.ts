import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

import {
    workflowAgentIdSchema,
    workflowIdSchema,
    workflowLaunchInputSchema,
    workflowLogPageSchema,
    workflowLogQuerySchema,
    workflowMutationInputSchema,
    workflowMutationResultSchema,
    workflowPageQuerySchema,
    workflowPageSchema,
    workflowRunSchema,
    type WorkflowLogPage,
    type WorkflowMutationResult,
    type WorkflowPage,
    type WorkflowRun,
} from "./Workflow.js";
import { workflowEventSchema } from "./WorkflowEvent.js";

export const workflowTransactionChangeSchema = Type.Object(
    {
        agentId: workflowAgentIdSchema,
        operationId: workflowIdSchema,
        run: workflowRunSchema,
        changed: Type.Boolean(),
        event: Type.Optional(workflowEventSchema),
    },
    { additionalProperties: false },
);

/**
 * The host owns runner lifecycle and persistence. Its transaction must include any durable
 * workflow record mutation and the runner's staging boundary; the feature never starts a process
 * or owns a queue.
 */
export const workflowStoreSchema = Type.Object(
    {
        transaction: Type.Function(
            [
                Type.Unsafe<Context>(Type.Object({}, { additionalProperties: false })),
                workflowAgentIdSchema,
                Type.Function(
                    [Type.Unsafe<Context>(Type.Object({}, { additionalProperties: false }))],
                    Type.Promise(workflowTransactionChangeSchema),
                ),
            ],
            Type.Promise(workflowTransactionChangeSchema),
        ),
        afterCommit: Type.Function(
            [
                Type.Unsafe<Context>(Type.Object({}, { additionalProperties: false })),
                Type.Function(
                    [Type.Unsafe<Context>(Type.Object({}, { additionalProperties: false }))],
                    Type.Union([Type.Void(), Type.Promise(Type.Void())]),
                ),
            ],
            Type.Void(),
        ),
        launch: Type.Function(
            [
                Type.Unsafe<Context>(Type.Object({}, { additionalProperties: false })),
                workflowAgentIdSchema,
                workflowLaunchInputSchema,
            ],
            Type.Promise(workflowRunSchema),
        ),
        get: Type.Function(
            [
                Type.Unsafe<Context>(Type.Object({}, { additionalProperties: false })),
                workflowAgentIdSchema,
                workflowIdSchema,
            ],
            Type.Promise(Type.Union([workflowRunSchema, Type.Undefined()])),
        ),
        list: Type.Function(
            [
                Type.Unsafe<Context>(Type.Object({}, { additionalProperties: false })),
                workflowAgentIdSchema,
                workflowPageQuerySchema,
            ],
            Type.Promise(workflowPageSchema),
        ),
        cancel: Type.Function(
            [
                Type.Unsafe<Context>(Type.Object({}, { additionalProperties: false })),
                workflowAgentIdSchema,
                workflowMutationInputSchema,
            ],
            Type.Promise(workflowMutationResultSchema),
        ),
        resume: Type.Function(
            [
                Type.Unsafe<Context>(Type.Object({}, { additionalProperties: false })),
                workflowAgentIdSchema,
                workflowMutationInputSchema,
            ],
            Type.Promise(workflowMutationResultSchema),
        ),
        wait: Type.Function(
            [
                Type.Unsafe<Context>(Type.Object({}, { additionalProperties: false })),
                workflowAgentIdSchema,
                workflowIdSchema,
            ],
            Type.Promise(workflowRunSchema),
        ),
        logs: Type.Function(
            [
                Type.Unsafe<Context>(Type.Object({}, { additionalProperties: false })),
                workflowAgentIdSchema,
                workflowLogQuerySchema,
            ],
            Type.Promise(workflowLogPageSchema),
        ),
    },
    { additionalProperties: false },
);

export type WorkflowStore = Static<typeof workflowStoreSchema>;
export type WorkflowTransactionChange = Static<typeof workflowTransactionChangeSchema>;

export function assertWorkflowRun(value: unknown): asserts value is WorkflowRun {
    if (!Value.Check(workflowRunSchema, value)) {
        throw new Error("Workflow store returned an invalid run.");
    }
}

export function assertWorkflowPage(value: unknown): asserts value is WorkflowPage {
    if (!Value.Check(workflowPageSchema, value)) {
        throw new Error("Workflow store returned an invalid page.");
    }
}

export function assertWorkflowLogPage(value: unknown): asserts value is WorkflowLogPage {
    if (!Value.Check(workflowLogPageSchema, value)) {
        throw new Error("Workflow store returned an invalid log page.");
    }
}

export function assertWorkflowMutationResult(
    value: unknown,
): asserts value is WorkflowMutationResult {
    if (!Value.Check(workflowMutationResultSchema, value)) {
        throw new Error("Workflow store returned an invalid mutation result.");
    }
}

export function assertWorkflowTransactionChange(
    value: unknown,
): asserts value is WorkflowTransactionChange {
    if (!Value.Check(workflowTransactionChangeSchema, value)) {
        throw new Error("Workflow store transaction returned an invalid change.");
    }
}
