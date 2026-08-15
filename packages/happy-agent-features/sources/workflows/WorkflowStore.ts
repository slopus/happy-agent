import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

import {
    workflowAgentIdSchema,
    workflowIdSchema,
    workflowLaunchRequestSchema,
    workflowLogPageSchema,
    workflowLogQuerySchema,
    workflowMutationProofSchema,
    workflowMutationRequestSchema,
    workflowMutationResultSchema,
    workflowOperationReceiptSchema,
    workflowPageQuerySchema,
    workflowPageSchema,
    workflowRunSchema,
    type WorkflowLogPage,
    type WorkflowMutationProof,
    type WorkflowMutationResult,
    type WorkflowOperationReceipt,
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
                workflowLaunchRequestSchema,
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
                workflowMutationRequestSchema,
            ],
            Type.Promise(workflowMutationResultSchema),
        ),
        resume: Type.Function(
            [
                Type.Unsafe<Context>(Type.Object({}, { additionalProperties: false })),
                workflowAgentIdSchema,
                workflowMutationRequestSchema,
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
        readReceipt: Type.Function(
            [
                Type.Unsafe<Context>(Type.Object({}, { additionalProperties: false })),
                workflowAgentIdSchema,
                workflowIdSchema,
            ],
            Type.Promise(Type.Union([workflowOperationReceiptSchema, Type.Undefined()])),
        ),
        writeReceipt: Type.Function(
            [
                Type.Unsafe<Context>(Type.Object({}, { additionalProperties: false })),
                workflowAgentIdSchema,
                workflowOperationReceiptSchema,
            ],
            Type.Promise(Type.Void()),
        ),
        readMutationProof: Type.Function(
            [
                Type.Unsafe<Context>(Type.Object({}, { additionalProperties: false })),
                workflowAgentIdSchema,
                workflowIdSchema,
            ],
            Type.Promise(Type.Union([workflowMutationProofSchema, Type.Undefined()])),
        ),
        writeMutationProof: Type.Function(
            [
                Type.Unsafe<Context>(Type.Object({}, { additionalProperties: false })),
                workflowAgentIdSchema,
                workflowMutationProofSchema,
            ],
            Type.Promise(Type.Void()),
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
    if (value.updatedAt < value.createdAt) {
        throw new Error("Workflow store returned a run with invalid timestamp ordering.");
    }
    if ("startedAt" in value && value.startedAt !== undefined) {
        if (value.startedAt < value.createdAt || value.startedAt > value.updatedAt) {
            throw new Error("Workflow store returned a run with invalid start time.");
        }
    }
    if (value.status === "paused" && value.pausedAt !== value.updatedAt) {
        throw new Error("Workflow store returned a paused run with invalid pause time.");
    }
    if (
        (value.status === "completed" ||
            value.status === "failed" ||
            value.status === "cancelled" ||
            value.status === "unavailable") &&
        value.finishedAt !== value.updatedAt
    ) {
        throw new Error("Workflow store returned a terminal run with invalid finish time.");
    }
}

export function assertWorkflowPage(value: unknown): asserts value is WorkflowPage {
    if (!Value.Check(workflowPageSchema, value)) {
        throw new Error("Workflow store returned an invalid page.");
    }
    for (const run of value.runs) assertWorkflowRun(run);
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
    assertWorkflowRun(value.run);
}

export function assertWorkflowOperationReceipt(
    value: unknown,
): asserts value is WorkflowOperationReceipt {
    if (!Value.Check(workflowOperationReceiptSchema, value)) {
        throw new Error("Workflow store returned an invalid operation receipt.");
    }
    assertWorkflowRun(value.operation === "launch" ? value.result : value.result.run);
}

export function assertWorkflowMutationProof(
    value: unknown,
): asserts value is WorkflowMutationProof {
    if (!Value.Check(workflowMutationProofSchema, value)) {
        throw new Error("Workflow store returned an invalid mutation proof.");
    }
    if (value.operation === "launch") {
        assertWorkflowRun(value.after);
        assertWorkflowRun(value.result);
        return;
    }
    assertWorkflowRun(value.before);
    assertWorkflowRun(value.after);
    assertWorkflowRun(value.result.run);
}

export function assertWorkflowTransactionChange(
    value: unknown,
): asserts value is WorkflowTransactionChange {
    if (!Value.Check(workflowTransactionChangeSchema, value)) {
        throw new Error("Workflow store transaction returned an invalid change.");
    }
    assertWorkflowRun(value.run);
    if (value.event !== undefined) assertWorkflowRun(value.event.run);
}
