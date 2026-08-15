import { createHash } from "node:crypto";

import {
    agentId as agentRunningInside,
    type AgentBaseInference,
    type AgentFeature,
    type AgentFeatureAction,
    type AgentFeatureScope,
    type AgentKV,
    type AnyAgentTool,
} from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

import {
    goalEventSchema,
    goalFeatureListenerSchema,
    goalContextSchema,
    goalVoidOrPromiseVoidSchema,
    type GoalEvent,
    type GoalFeatureListener,
} from "./GoalEvent.js";
import {
    goalWakeMessageIdSchema,
    goalWakeReadResultSchema,
    goalWakeSchedulerSchema,
    goalWakeStateSchema,
    MAX_GOAL_WAKE_STATE_BYTES,
    type GoalWakeScheduler,
    type GoalWakeState,
} from "./GoalWakeScheduler.js";
import { createGoalContinuationPrompt } from "./impl/createGoalContinuationPrompt.js";
import {
    clearGoal,
    clearAutomaticBlockEvidence,
    clearCallOperationEvidence,
    GOAL_AUTO_BLOCK_OPERATION_ID_KEY,
    GOAL_CONTINUATION_ID_KEY,
    GOAL_FAILURE_COUNT_KEY,
    GOAL_LIFECYCLE_KEY,
    GOAL_LAST_INFERENCE_KEY,
    GOAL_OBSERVED_LIFECYCLE_ID_KEY,
    goalAuthoritativeStateSchema,
    goalOperationEvidenceSchema,
    goalStorageSchema,
    readAutomaticBlockEvidence,
    readCallOperationEvidence,
    readGoal,
    readGoalAuthoritativeState,
    readProof,
    readReceipt,
    writeAutomaticBlockEvidence,
    writeCompletedCallOperation,
    writeEvidence,
    writeGoal,
    writeGoalLifecycle,
    writePendingCallOperation,
    type GoalAuthoritativeState,
    type GoalCallOperationEvidence,
    type GoalLifecycleState,
    type GoalOperationEvidence,
    type GoalStorage,
} from "./impl/goalStore.js";
import { goalKV, goalToolKV } from "./impl/goalKV.js";
import { normalizeGoalObjective } from "./impl/normalizeGoalObjective.js";
import {
    assertGoalEvidence,
    goalAutomaticBlockOperationId,
    goalOperationFingerprint,
} from "./impl/goalValidation.js";
import {
    FAILED_TURNS_BEFORE_BLOCKED,
    goalAgentIdSchema,
    goalMutationOptionsSchema,
    goalMutationProofSchema,
    goalMutationResultSchema,
    goalOperationIdSchema,
    goalOperationRequestSchema,
    goalLifecycleIdSchema,
    goalStatusSchema,
    goalTimestampSchema,
    MAX_GOAL_OUTPUT_CHARACTERS,
    sessionGoalSchema,
    type GoalMutationOptions,
    type GoalMutationProof,
    type GoalMutationResult,
    type GoalOperation,
    type GoalOperationId,
    type GoalOperationRequest,
    type GoalOperationReceipt,
    type GoalStatus,
    type SessionGoal,
} from "./SessionGoal.js";
import { createGoalTool } from "./tools/create_goal.js";
import { clearGoalTool } from "./tools/clear_goal.js";
import { getGoalTool } from "./tools/get_goal.js";
import { updateGoalTool } from "./tools/update_goal.js";

export { FAILED_TURNS_BEFORE_BLOCKED } from "./SessionGoal.js";

const goalInferenceSchema = Type.Object(
    {
        state: Type.Optional(
            Type.Union([
                Type.Literal("cancelled"),
                Type.Literal("normal"),
                Type.Literal("tool_call"),
                Type.Literal("length"),
                Type.Literal("error"),
            ]),
        ),
    },
    { additionalProperties: false },
);
const goalOutputCharactersSchema = Type.Integer({
    minimum: 256,
    maximum: MAX_GOAL_OUTPUT_CHARACTERS,
});
const goalAfterCommitCallbackSchema = Type.Function(
    [goalContextSchema, Type.Function([goalContextSchema], Type.Promise(Type.Void()))],
    Type.Void(),
);
const goalIdFactorySchema = Type.Function(
    [goalContextSchema, goalAgentIdSchema],
    Type.Union([goalOperationIdSchema, Type.Promise(goalOperationIdSchema)]),
);
const goalEventIdFactorySchema = Type.Function(
    [goalContextSchema, goalAgentIdSchema],
    Type.Union([goalOperationIdSchema, Type.Promise(goalOperationIdSchema)]),
);
const goalClockSchema = Type.Function(
    [],
    Type.Union([goalTimestampSchema, Type.Promise(goalTimestampSchema)]),
);
const goalFactoryPromiseSchema = Type.Promise(
    Type.Union([goalOperationIdSchema, goalTimestampSchema]),
);
const goalVoidPromiseSchema = Type.Promise(Type.Void());
const goalWakeReadPromiseSchema = Type.Promise(goalWakeReadResultSchema);
const goalObserverErrorSchema = Type.String({ minLength: 1, maxLength: 500 });

/** TypeBox-first constructor contract for the complete Goal feature. */
export const goalFeatureOptionsSchema = Type.Object(
    {
        storage: goalStorageSchema,
        listener: Type.Optional(goalFeatureListenerSchema),
        idFactory: Type.Optional(goalIdFactorySchema),
        eventIdFactory: Type.Optional(goalEventIdFactorySchema),
        clock: Type.Optional(goalClockSchema),
        maxOutputCharacters: Type.Optional(goalOutputCharactersSchema),
        /**
         * Host-owned durable latest-state outbox for activations made outside the owning agent.
         * Its reconcile write must join the transaction carried by the supplied context.
         */
        wakeScheduler: Type.Optional(goalWakeSchedulerSchema),
        afterCommit: goalAfterCommitCallbackSchema,
        onPostCommitError: Type.Optional(
            Type.Function(
                [goalContextSchema, goalEventSchema, goalObserverErrorSchema],
                goalVoidOrPromiseVoidSchema,
            ),
        ),
    },
    { additionalProperties: false },
);

export type GoalFeatureOptions = Static<typeof goalFeatureOptionsSchema>;

type GoalSetResult = Extract<GoalMutationResult, { readonly operation: "set" }>;
type GoalStatusResult = Extract<GoalMutationResult, { readonly operation: "status" }>;
type GoalClearResult = Extract<GoalMutationResult, { readonly operation: "clear" }>;
type GoalSetRequest = Extract<GoalOperationRequest, { readonly operation: "set" }>;
type GoalStatusRequest = Extract<GoalOperationRequest, { readonly operation: "status" }>;
type GoalSetProof = Extract<GoalMutationProof, { readonly operation: "set" }>;
type GoalStatusProof = Extract<GoalMutationProof, { readonly operation: "status" }>;
type GoalClearProof = Extract<GoalMutationProof, { readonly operation: "clear" }>;

type GoalOperationExecution = {
    readonly request: GoalOperationRequest;
    readonly toolKV?: AgentKV;
};
type GoalEvidenceBoundary =
    | { readonly kind: "host" }
    | { readonly kind: "tool"; readonly kv: AgentKV }
    | { readonly kind: "automatic" };
const goalDecisionSchema = Type.Object(
    {
        result: goalMutationResultSchema,
        proof: goalMutationProofSchema,
        event: Type.Union([goalEventSchema, Type.Undefined()]),
        wake: Type.Boolean(),
    },
    { additionalProperties: false },
);
type GoalDecision = Static<typeof goalDecisionSchema>;
const goalTransactionResultSchema = Type.Object(
    { wake: Type.Boolean() },
    { additionalProperties: false },
);
const goalOperationAuthoritativeStateSchema = Type.Object(
    {
        state: goalAuthoritativeStateSchema,
        evidence: goalOperationEvidenceSchema,
    },
    { additionalProperties: false },
);
type GoalOperationAuthoritativeState = Static<typeof goalOperationAuthoritativeStateSchema>;
const goalRunStateSchema = Type.Object(
    {
        observedLifecycleId: Type.Union([goalLifecycleIdSchema, Type.Undefined()]),
        continuationId: Type.Union([goalWakeMessageIdSchema, Type.Undefined()]),
        inference: Type.Union([goalInferenceSchema, Type.Undefined()]),
    },
    { additionalProperties: false },
);
type GoalRunState = Static<typeof goalRunStateSchema>;
const goalLoopAuthoritativeStateSchema = Type.Object(
    {
        state: goalAuthoritativeStateSchema,
        run: goalRunStateSchema,
    },
    { additionalProperties: false },
);
type GoalLoopAuthoritativeState = Static<typeof goalLoopAuthoritativeStateSchema>;
const goalAppliedMutationSchema = Type.Object(
    {
        authoritative: goalOperationAuthoritativeStateSchema,
        wakeState: Type.Union([goalWakeStateSchema, Type.Undefined()]),
    },
    { additionalProperties: false },
);
type GoalAppliedMutation = Static<typeof goalAppliedMutationSchema>;

/**
 * A durable, shared goal feature.
 *
 * Goal state, operation receipts, immutable before-state proofs, failure counters, and retry
 * identities live in supplied AgentKV/persistence. The feature owns no lock or authoritative
 * collection map. Agent Base serializes its own hooks; public mutations use the injected
 * persistence transaction.
 */
export class GoalFeature implements AgentFeature {
    readonly name = "goal";

    readonly #storage: GoalStorage;
    readonly #listener: GoalFeatureListener | undefined;
    readonly #idFactory: NonNullable<GoalFeatureOptions["idFactory"]>;
    readonly #eventIdFactory: NonNullable<GoalFeatureOptions["eventIdFactory"]>;
    readonly #clock: NonNullable<GoalFeatureOptions["clock"]>;
    readonly #maxOutputCharacters: number;
    readonly #wakeScheduler: GoalFeatureOptions["wakeScheduler"];
    readonly #afterCommit: GoalFeatureOptions["afterCommit"];
    readonly #onPostCommitError: NonNullable<GoalFeatureOptions["onPostCommitError"]> | undefined;
    constructor(options: GoalFeatureOptions) {
        assertGoalFeatureOptions(options);
        this.#storage = options.storage;
        this.#listener = options.listener;
        this.#idFactory = options.idFactory ?? (() => globalThis.crypto.randomUUID());
        this.#eventIdFactory = options.eventIdFactory ?? (() => globalThis.crypto.randomUUID());
        this.#clock = options.clock ?? (() => Date.now());
        this.#maxOutputCharacters = options.maxOutputCharacters ?? 12_000;
        this.#wakeScheduler = options.wakeScheduler;
        this.#afterCommit = options.afterCommit;
        this.#onPostCommitError = options.onPostCommitError;
    }

    /** Read one agent's durable goal, or undefined when it has never had one. */
    async goal(ctx: Context, agentId: string): Promise<SessionGoal | undefined> {
        this.#assertAgentId(agentId);
        return await readGoal(ctx, goalKV(this.#storage, agentId), agentId);
    }

    /** Start or idempotently retry an objective. */
    async setGoal(
        ctx: Context,
        agentId: string,
        objective: string,
        options?: GoalMutationOptions,
    ): Promise<SessionGoal> {
        this.#assertAgentId(agentId);
        const normalized = normalizeGoalObjective(objective);
        const operation = await this.#operation(
            ctx,
            agentId,
            "set",
            { objective: normalized },
            options,
        );
        const request = operation.request;
        if (request.operation !== "set") throw new Error("Goal operation request mismatch.");
        const kv = goalKV(this.#storage, agentId);
        const transaction = await this.#mutate(ctx, kv, operation, async (txCtx, existing) => {
            const before = existing === undefined ? null : structuredClone(existing);
            if (existing !== undefined && existing.status !== "complete") {
                if (existing.status === "active" && existing.objective === normalized) {
                    return this.#setDecision(txCtx, request, before, existing, false);
                }
                throw new Error(
                    "This agent already has an unfinished goal. Complete or clear it before starting another.",
                );
            }
            const at = await this.#timestamp(txCtx);
            const next: SessionGoal = {
                createdAt: at,
                objective: normalized,
                status: "active",
                updatedAt: at,
            };
            return await this.#setDecision(txCtx, request, before, next, true);
        });
        if (transaction.result.operation !== "set")
            throw new Error("Goal receipt operation mismatch.");
        return structuredClone(transaction.result.goal);
    }

    /** Move an existing goal to any valid lifecycle status. */
    async changeGoalStatus(
        ctx: Context,
        agentId: string,
        status: GoalStatus,
        options?: GoalMutationOptions,
    ): Promise<SessionGoal> {
        this.#assertAgentId(agentId);
        this.#assertStatus(status);
        const operation = await this.#operation(ctx, agentId, "status", { status }, options);
        const request = operation.request;
        if (request.operation !== "status") throw new Error("Goal operation request mismatch.");
        const kv = goalKV(this.#storage, agentId);
        const transaction = await this.#mutate(ctx, kv, operation, async (txCtx, existing) => {
            if (existing === undefined) throw new Error("This agent does not have a goal.");
            const before = structuredClone(existing);
            if (existing.status === status) {
                return await this.#statusDecision(txCtx, request, before, existing, false);
            }
            const next: SessionGoal = {
                ...existing,
                status,
                updatedAt: await this.#timestamp(txCtx),
            };
            return await this.#statusDecision(txCtx, request, before, next, true);
        });
        if (transaction.result.operation !== "status") {
            throw new Error("Goal receipt operation mismatch.");
        }
        return structuredClone(transaction.result.goal);
    }

    /** Clear a goal and return whether one existed at the historical mutation point. */
    async clearGoal(
        ctx: Context,
        agentId: string,
        options?: GoalMutationOptions,
    ): Promise<boolean> {
        this.#assertAgentId(agentId);
        const operation = await this.#operation(ctx, agentId, "clear", {}, options);
        const request = operation.request;
        if (request.operation !== "clear") throw new Error("Goal operation request mismatch.");
        const kv = goalKV(this.#storage, agentId);
        const transaction = await this.#mutate(ctx, kv, operation, async (txCtx, existing) => {
            const before = existing === undefined ? null : structuredClone(existing);
            const result: GoalClearResult = {
                operation: "clear",
                changed: existing !== undefined,
                cleared: existing !== undefined,
            };
            const proof: GoalClearProof = {
                operation: "clear",
                agentId: request.agentId,
                operationId: request.operationId,
                fingerprint: request.fingerprint,
                input: request.input,
                before,
                result,
                createdAt: await this.#timestamp(txCtx),
            };
            const event =
                existing === undefined
                    ? undefined
                    : await this.#event(txCtx, {
                          type: "goal_cleared",
                          agentId: request.agentId,
                      });
            return { result, proof, event, wake: false };
        });
        if (transaction.result.operation !== "clear") {
            throw new Error("Goal receipt operation mismatch.");
        }
        return transaction.result.cleared;
    }

    readonly tools = (_ctx: Context, scope: AgentFeatureScope): readonly AnyAgentTool[] => [
        createGoalTool(
            this,
            scope.agent.id,
            this.#maxOutputCharacters,
            async (toolCtx, goal) => await this.#observeActiveLifecycleForRun(toolCtx, scope, goal),
        ),
        getGoalTool(this, scope.agent.id, this.#maxOutputCharacters),
        updateGoalTool(this, scope.agent.id, this.#maxOutputCharacters),
        clearGoalTool(this, scope.agent.id),
    ];

    /**
     * Agent Base invokes this on the same call-scoped feature KV in the transaction appending the
     * tool result. A rollback therefore leaves the evidence available for the durable retry.
     */
    readonly afterToolCallTransact = async (
        ctx: Context,
        scope: AgentFeatureScope,
    ): Promise<void> => {
        const evidence = await readCallOperationEvidence(ctx, scope.kv);
        if (evidence !== undefined) {
            this.#assertCallRequest(
                evidence,
                evidence.request.agentId,
                evidence.request.operation,
                evidence.request.input,
                evidence.request.fingerprint,
                evidence.request.operationId,
            );
        }
        await clearCallOperationEvidence(ctx, scope.kv);
    };

    readonly afterInference = async (
        ctx: Context,
        scope: AgentFeatureScope,
        inference: AgentBaseInference,
    ): Promise<void> => {
        const value = inference.state === undefined ? {} : { state: inference.state };
        if (!Value.Check(goalInferenceSchema, value)) {
            throw new Error("Goal inference state is invalid.");
        }
        await scope.runKV.write(ctx, GOAL_LAST_INFERENCE_KEY, value);
    };

    readonly beforeAgentLoop = async (ctx: Context, scope: AgentFeatureScope): Promise<void> => {
        let expectedReturned: Static<typeof goalTransactionResultSchema> | undefined;
        let expectedState: GoalLoopAuthoritativeState | undefined;
        const returned = await scope.kv.transaction(ctx, async (txKv, txCtx) => {
            const before = await this.#readLoopAuthoritativeState(txCtx, scope);
            await scope.runKV.delete(txCtx, GOAL_CONTINUATION_ID_KEY);
            const current = before.state.goal;
            let observedLifecycleId: string | undefined;
            if (current?.status !== "active") {
                await scope.runKV.delete(txCtx, GOAL_OBSERVED_LIFECYCLE_ID_KEY);
            } else {
                const lifecycle = before.state.lifecycle;
                if (lifecycle === undefined) {
                    throw new Error("An active Goal requires its exact lifecycle sidecar.");
                }
                observedLifecycleId = lifecycle.id;
                await scope.runKV.write(txCtx, GOAL_OBSERVED_LIFECYCLE_ID_KEY, observedLifecycleId);
            }
            expectedState = this.#validatedLoopAuthoritativeState({
                state: before.state,
                run: {
                    ...before.run,
                    continuationId: undefined,
                    observedLifecycleId,
                },
            });
            await this.#assertLoopAuthoritativeState(txCtx, scope, expectedState);
            expectedReturned = { wake: false };
            return structuredClone(expectedReturned);
        });
        if (expectedReturned === undefined || expectedState === undefined) {
            throw new Error("Goal before-loop transaction did not produce its expected state.");
        }
        this.#assertTransactionResult(returned, expectedReturned, "Goal before-loop");
        await this.#assertLoopAuthoritativeState(ctx, scope, expectedState);
    };

    readonly afterAgentLoop = async (
        ctx: Context,
        scope: AgentFeatureScope,
    ): Promise<readonly AgentFeatureAction[] | undefined> => {
        const observedBeforeTransaction = (await this.#readRunState(ctx, scope))
            .observedLifecycleId;
        if (observedBeforeTransaction === undefined) return undefined;
        let continuation: { readonly goal: SessionGoal; readonly id: string } | undefined;
        let expectedReturned: Static<typeof goalTransactionResultSchema> | undefined;
        let expectedState: GoalLoopAuthoritativeState | undefined;
        let expectedWakeState: GoalWakeState | undefined;
        const returned = await scope.kv.transaction(ctx, async (txKv, txCtx) => {
            const before = await this.#readLoopAuthoritativeState(txCtx, scope);
            const current = before.state.goal;
            const observedStored = before.run.observedLifecycleId;
            let nextGoalState = structuredClone(before.state);
            let nextRunState = structuredClone(before.run);
            if (
                current?.status === "active" &&
                observedStored === observedBeforeTransaction &&
                before.state.lifecycle?.id === observedStored
            ) {
                const currentLifecycleId = observedStored;
                const inference = before.run.inference;
                const failed =
                    inference === undefined ||
                    inference.state === undefined ||
                    inference.state === "error";
                const failures = before.state.failureCount ?? 0;
                if (failed) {
                    const nextFailures = Math.min(FAILED_TURNS_BEFORE_BLOCKED, failures + 1);
                    await txKv.write(txCtx, GOAL_FAILURE_COUNT_KEY, nextFailures);
                    if (nextFailures >= FAILED_TURNS_BEFORE_BLOCKED) {
                        const operationId = await this.#automaticBlockOperationIdInTransaction(
                            txCtx,
                            txKv,
                            currentLifecycleId,
                        );
                        const operation = this.#automaticBlockOperation(
                            scope.agent.id,
                            operationId,
                            currentLifecycleId,
                        );
                        const decision = await this.#statusDecision(
                            txCtx,
                            operation,
                            current,
                            {
                                ...current,
                                status: "blocked",
                                updatedAt: await this.#timestamp(txCtx),
                            },
                            true,
                        );
                        const existingAutomatic = await this.#readBoundaryEvidence(
                            txCtx,
                            txKv,
                            operation,
                            { kind: "automatic" },
                        );
                        if (existingAutomatic !== undefined) {
                            throw new Error(
                                "An active Goal cannot replay automatic-block evidence.",
                            );
                        }
                        const applied = await this.#mutateInTransaction(
                            txCtx,
                            txKv,
                            operation,
                            decision,
                            { kind: "automatic" },
                            false,
                            before.state,
                        );
                        nextGoalState = structuredClone(applied.authoritative.state);
                        expectedWakeState =
                            applied.wakeState === undefined
                                ? undefined
                                : structuredClone(applied.wakeState);
                    } else {
                        nextGoalState.failureCount = nextFailures;
                    }
                } else {
                    await txKv.delete(txCtx, GOAL_FAILURE_COUNT_KEY);
                    nextGoalState.failureCount = undefined;
                    const continuationId = await this.#continuationActionId(txCtx, scope);
                    continuation = {
                        goal: structuredClone(current),
                        id: continuationId,
                    };
                    nextRunState.continuationId = continuationId;
                }
            }
            expectedState = this.#validatedLoopAuthoritativeState({
                state: nextGoalState,
                run: nextRunState,
            });
            await this.#assertLoopAuthoritativeState(txCtx, scope, expectedState);
            expectedReturned = { wake: false };
            return structuredClone(expectedReturned);
        });
        if (expectedReturned === undefined || expectedState === undefined) {
            throw new Error("Goal after-loop transaction did not produce its expected state.");
        }
        this.#assertTransactionResult(returned, expectedReturned, "Goal after-loop");
        await this.#assertLoopAuthoritativeState(ctx, scope, expectedState);
        if (expectedWakeState !== undefined) {
            await this.#assertWakeState(ctx, scope.agent.id, expectedWakeState);
        }
        if (continuation === undefined) return undefined;
        return [
            {
                type: "send",
                id: continuation.id,
                message: {
                    role: "user",
                    content: [
                        { type: "text", text: createGoalContinuationPrompt(continuation.goal) },
                    ],
                },
            },
        ];
    };

    async #setDecision(
        ctx: Context,
        operation: GoalSetRequest,
        before: SessionGoal | null,
        goal: SessionGoal,
        changed: boolean,
    ): Promise<GoalDecision> {
        const result: GoalSetResult = { operation: "set", changed, goal: structuredClone(goal) };
        const proof: GoalSetProof = {
            operation: "set",
            agentId: operation.agentId,
            operationId: operation.operationId,
            fingerprint: operation.fingerprint,
            input: structuredClone(operation.input),
            before,
            result,
            createdAt: await this.#timestamp(ctx),
        };
        const event =
            changed && goal.status === "active"
                ? await this.#event(ctx, { type: "goal_set", agentId: operation.agentId, goal })
                : undefined;
        return { result, proof, event, wake: changed && goal.status === "active" };
    }

    async #statusDecision(
        ctx: Context,
        operation: GoalStatusRequest,
        before: SessionGoal,
        goal: SessionGoal,
        changed: boolean,
    ): Promise<GoalDecision> {
        const result: GoalStatusResult = {
            operation: "status",
            changed,
            goal: structuredClone(goal),
        };
        const proof: GoalStatusProof = {
            operation: "status",
            agentId: operation.agentId,
            operationId: operation.operationId,
            fingerprint: operation.fingerprint,
            input: structuredClone(operation.input),
            before,
            result,
            createdAt: await this.#timestamp(ctx),
        };
        const event =
            changed && goal.status === "active"
                ? await this.#event(ctx, {
                      type: "goal_status_changed",
                      agentId: operation.agentId,
                      goal,
                  })
                : changed && goal.status !== "active"
                  ? await this.#event(ctx, {
                        type: "goal_status_changed",
                        agentId: operation.agentId,
                        goal,
                    })
                  : undefined;
        return { result, proof, event, wake: changed && goal.status === "active" };
    }

    async #mutateInTransaction(
        ctx: Context,
        kv: AgentKV,
        operation: GoalOperationRequest,
        decision: GoalDecision,
        boundary: GoalEvidenceBoundary,
        externalCaller: boolean,
        beforeState: GoalAuthoritativeState,
    ): Promise<GoalAppliedMutation> {
        if (!Value.Check(goalDecisionSchema, decision)) {
            throw new Error("Goal feature created an invalid mutation decision.");
        }
        const stableEvent = decision.event;
        const expectedDecision = structuredClone(decision);
        if (!Value.Check(goalDecisionSchema, expectedDecision)) {
            throw new Error("Goal feature created an invalid mutation decision.");
        }
        if (!Value.Check(goalMutationResultSchema, expectedDecision.result)) {
            throw new Error("Goal feature created an invalid mutation result.");
        }
        if (!Value.Check(goalMutationProofSchema, expectedDecision.proof)) {
            throw new Error("Goal feature created an invalid mutation proof.");
        }
        if (expectedDecision.result.operation !== operation.operation) {
            throw new Error("Goal mutation operation mismatch.");
        }
        const nextReceipt: GoalOperationReceipt = {
            operation: operation.operation,
            agentId: operation.agentId,
            operationId: operation.operationId,
            fingerprint: operation.fingerprint,
            result: structuredClone(expectedDecision.result),
            createdAt: expectedDecision.proof.createdAt,
        };
        const evidence: GoalOperationEvidence = {
            receipt: structuredClone(nextReceipt),
            proof: structuredClone(expectedDecision.proof),
        };
        this.#assertEvidence(nextReceipt, expectedDecision.proof, operation);
        const expectedAuthoritative: GoalOperationAuthoritativeState = {
            state: this.#expectedGoalState(
                beforeState,
                operation,
                expectedDecision,
                evidence,
                boundary,
                externalCaller,
            ),
            evidence: structuredClone(evidence),
        };
        if (!Value.Check(goalOperationAuthoritativeStateSchema, expectedAuthoritative)) {
            throw new Error("Goal feature created an invalid authoritative mutation state.");
        }
        const wakeState = await this.#reconcileWakeState(
            ctx,
            operation,
            expectedDecision,
            externalCaller,
            beforeState.lifecycle,
        );
        if (boundary.kind === "host") {
            await writeEvidence(ctx, kv, nextReceipt, expectedDecision.proof);
        } else if (boundary.kind === "tool") {
            await writeCompletedCallOperation(
                ctx,
                boundary.kv,
                operation,
                nextReceipt,
                expectedDecision.proof,
            );
        } else {
            await writeAutomaticBlockEvidence(ctx, kv, nextReceipt, expectedDecision.proof);
        }
        if (expectedDecision.result.changed) {
            if (expectedDecision.result.operation === "clear") {
                await clearGoal(ctx, kv);
            } else {
                await writeGoal(ctx, kv, expectedDecision.result.goal);
            }
        }
        if (operation.operation === "clear") {
            await kv.delete(ctx, GOAL_LIFECYCLE_KEY);
            await kv.delete(ctx, GOAL_FAILURE_COUNT_KEY);
            await kv.delete(ctx, GOAL_AUTO_BLOCK_OPERATION_ID_KEY);
            await clearAutomaticBlockEvidence(ctx, kv);
        } else if (expectedDecision.result.operation === "set" && expectedDecision.result.changed) {
            await this.#writeLifecycle(
                ctx,
                kv,
                operation.operationId,
                expectedDecision.result.goal,
                externalCaller,
            );
            await this.#writeAutomaticBlockOperationId(ctx, kv, operation.operationId);
            await kv.delete(ctx, GOAL_FAILURE_COUNT_KEY);
            await clearAutomaticBlockEvidence(ctx, kv);
        } else if (
            operation.operation === "status" &&
            expectedDecision.result.changed &&
            expectedDecision.result.operation === "status"
        ) {
            if (expectedDecision.result.goal.status === "active") {
                await this.#writeLifecycle(
                    ctx,
                    kv,
                    operation.operationId,
                    expectedDecision.result.goal,
                    externalCaller,
                );
                await this.#writeAutomaticBlockOperationId(ctx, kv, operation.operationId);
                await kv.delete(ctx, GOAL_FAILURE_COUNT_KEY);
                await clearAutomaticBlockEvidence(ctx, kv);
            } else {
                await kv.delete(ctx, GOAL_LIFECYCLE_KEY);
                await kv.delete(ctx, GOAL_FAILURE_COUNT_KEY);
                await kv.delete(ctx, GOAL_AUTO_BLOCK_OPERATION_ID_KEY);
                if (boundary.kind !== "automatic") {
                    await clearAutomaticBlockEvidence(ctx, kv);
                }
            }
        }
        if (stableEvent !== undefined) {
            const event = stableEvent;
            if (!Value.Check(goalEventSchema, event)) {
                throw new Error("Goal feature created an invalid event.");
            }
            const transactional = this.#listener?.onEventTransactional;
            if (transactional !== undefined) {
                await this.#awaitVoidResult(
                    transactional.call(this.#listener, ctx, event),
                    "Goal transactional listener",
                );
            }
            const registration = this.#afterCommit(ctx, (postCommitCtx) =>
                this.#notifyPostCommit(postCommitCtx, event),
            );
            this.#assertSynchronousVoid(registration, "Goal afterCommit");
        }
        await this.#assertOperationAuthoritativeState(
            ctx,
            kv,
            operation,
            boundary,
            expectedAuthoritative,
        );
        if (wakeState !== undefined) {
            await this.#assertWakeState(ctx, operation.agentId, wakeState);
        }
        const applied = {
            authoritative: structuredClone(expectedAuthoritative),
            wakeState: wakeState === undefined ? undefined : structuredClone(wakeState),
        };
        if (!Value.Check(goalAppliedMutationSchema, applied)) {
            throw new Error("Goal feature created an invalid applied mutation state.");
        }
        return structuredClone(applied);
    }

    #expectedGoalState(
        before: GoalAuthoritativeState,
        operation: GoalOperationRequest,
        decision: GoalDecision,
        evidence: GoalOperationEvidence,
        boundary: GoalEvidenceBoundary,
        externalCaller: boolean,
    ): GoalAuthoritativeState {
        const expected = structuredClone(before);
        if (decision.result.changed) {
            expected.goal =
                decision.result.operation === "clear"
                    ? undefined
                    : structuredClone(decision.result.goal);
        }
        if (operation.operation === "clear") {
            expected.lifecycle = undefined;
            expected.failureCount = undefined;
            expected.automaticBlockOperationId = undefined;
            expected.automaticBlockEvidence = undefined;
        } else if (decision.result.operation === "set" && decision.result.changed) {
            expected.lifecycle = {
                activation: externalCaller ? "external" : "agent",
                id: operation.operationId,
                goal: structuredClone(decision.result.goal),
            };
            expected.failureCount = undefined;
            expected.automaticBlockOperationId = goalAutomaticBlockOperationId(
                operation.operationId,
            );
            expected.automaticBlockEvidence = undefined;
        } else if (
            operation.operation === "status" &&
            decision.result.operation === "status" &&
            decision.result.changed
        ) {
            expected.failureCount = undefined;
            if (decision.result.goal.status === "active") {
                expected.lifecycle = {
                    activation: externalCaller ? "external" : "agent",
                    id: operation.operationId,
                    goal: structuredClone(decision.result.goal),
                };
                expected.automaticBlockOperationId = goalAutomaticBlockOperationId(
                    operation.operationId,
                );
                expected.automaticBlockEvidence = undefined;
            } else {
                expected.lifecycle = undefined;
                expected.automaticBlockOperationId = undefined;
                expected.automaticBlockEvidence =
                    boundary.kind === "automatic" ? structuredClone(evidence) : undefined;
            }
        }
        if (!Value.Check(goalAuthoritativeStateSchema, expected)) {
            throw new Error("Goal feature derived an invalid authoritative state.");
        }
        return structuredClone(expected);
    }

    async #mutate(
        ctx: Context,
        kv: AgentKV,
        execution: GoalOperationExecution,
        decide: (ctx: Context, existing: SessionGoal | undefined) => Promise<GoalDecision>,
    ): Promise<{ readonly result: GoalMutationResult; readonly wake: boolean }> {
        const operation = execution.request;
        const externalCaller = agentRunningInside(ctx) !== operation.agentId;
        const boundary: GoalEvidenceBoundary =
            execution.toolKV === undefined
                ? { kind: "host" }
                : { kind: "tool", kv: execution.toolKV };
        let expectedReturned: { readonly wake: boolean } | undefined;
        let expectedAuthoritative: GoalOperationAuthoritativeState | undefined;
        let expectedWakeState: GoalWakeState | undefined;
        const returned = await kv.transaction(ctx, async (txKv, txCtx) => {
            const beforeState = await readGoalAuthoritativeState(txCtx, txKv, operation.agentId);
            const existing = await this.#readBoundaryEvidence(txCtx, txKv, operation, boundary);
            if (existing !== undefined) {
                expectedAuthoritative = this.#validatedOperationAuthoritativeState({
                    state: beforeState,
                    evidence: existing,
                });
                const expected = {
                    wake: false,
                };
                if (!Value.Check(goalTransactionResultSchema, expected)) {
                    throw new Error("Goal feature created an invalid transaction result.");
                }
                expectedReturned = structuredClone(expected);
                return structuredClone(expected);
            }
            const decision = await decide(txCtx, beforeState.goal);
            const applied = await this.#mutateInTransaction(
                txCtx,
                txKv,
                operation,
                decision,
                boundary,
                externalCaller,
                beforeState,
            );
            expectedAuthoritative = structuredClone(applied.authoritative);
            expectedWakeState =
                applied.wakeState === undefined ? undefined : structuredClone(applied.wakeState);
            const expected = { wake: false };
            if (!Value.Check(goalTransactionResultSchema, expected)) {
                throw new Error("Goal feature created an invalid transaction result.");
            }
            expectedReturned = structuredClone(expected);
            return structuredClone(expected);
        });
        if (
            expectedReturned === undefined ||
            expectedAuthoritative === undefined ||
            !Value.Check(goalTransactionResultSchema, expectedReturned) ||
            !Value.Check(goalOperationAuthoritativeStateSchema, expectedAuthoritative) ||
            !Value.Check(goalTransactionResultSchema, returned) ||
            !Value.Equal(returned, expectedReturned)
        ) {
            throw new Error("Goal transaction returned a result different from its decision.");
        }
        await this.#assertOperationAuthoritativeState(
            ctx,
            kv,
            operation,
            boundary,
            expectedAuthoritative,
        );
        if (expectedWakeState !== undefined) {
            await this.#assertWakeState(ctx, operation.agentId, expectedWakeState);
        }
        return {
            result: structuredClone(expectedAuthoritative.evidence.receipt.result),
            wake: expectedReturned.wake,
        };
    }

    async #operation(
        ctx: Context,
        agentId: string,
        operation: GoalOperation,
        input: unknown,
        options: GoalMutationOptions | undefined,
    ): Promise<GoalOperationExecution> {
        if (options !== undefined && !Value.Check(goalMutationOptionsSchema, options)) {
            throw new Error("Goal mutation options are invalid.");
        }
        const normalizedInput = structuredClone(input);
        const fingerprint = goalOperationFingerprint({
            agentId,
            operation,
            input: normalizedInput,
        });
        const requested = options?.operationId;
        const create = async (createCtx: Context): Promise<GoalOperationId> => {
            if (requested !== undefined) return requested;
            return await this.#factoryValue(
                this.#idFactory(createCtx, agentId),
                goalOperationIdSchema,
                "Goal operation ID",
            );
        };
        const callStore = goalToolKV(ctx);
        if (callStore !== undefined) {
            await callStore.transaction(ctx, async (kv, txCtx) => {
                const current = await readCallOperationEvidence(txCtx, kv);
                if (current !== undefined) {
                    this.#assertCallRequest(
                        current,
                        agentId,
                        operation,
                        normalizedInput,
                        fingerprint,
                        requested,
                    );
                    return current.request.operationId;
                }
                const operationId = await create(txCtx);
                const request = this.#operationRequest(
                    agentId,
                    operation,
                    operationId,
                    fingerprint,
                    normalizedInput,
                );
                await writePendingCallOperation(txCtx, kv, request);
                return operationId;
            });
            const persisted = await readCallOperationEvidence(ctx, callStore);
            if (persisted === undefined) {
                throw new Error("Goal call operation evidence disappeared.");
            }
            this.#assertCallRequest(
                persisted,
                agentId,
                operation,
                normalizedInput,
                fingerprint,
                requested,
            );
            return { request: structuredClone(persisted.request), toolKV: callStore };
        }
        const operationId = await create(ctx);
        return {
            request: this.#operationRequest(
                agentId,
                operation,
                operationId,
                fingerprint,
                normalizedInput,
            ),
        };
    }

    #operationRequest(
        agentId: string,
        operation: GoalOperation,
        operationId: GoalOperationId,
        fingerprint: string,
        input: unknown,
    ): GoalOperationRequest {
        const request = {
            agentId,
            operation,
            operationId,
            fingerprint,
            input: structuredClone(input),
        };
        if (!Value.Check(goalOperationRequestSchema, request)) {
            throw new Error("Goal operation request is invalid.");
        }
        return structuredClone(request);
    }

    #assertCallRequest(
        evidence: GoalCallOperationEvidence,
        agentId: string,
        operation: GoalOperation,
        input: unknown,
        fingerprint: string,
        requestedOperationId: string | undefined,
    ): void {
        const request = evidence.request;
        if (
            request.agentId !== agentId ||
            request.operation !== operation ||
            request.fingerprint !== fingerprint ||
            !Value.Equal(request.input, input) ||
            (requestedOperationId !== undefined && request.operationId !== requestedOperationId)
        ) {
            throw new Error("Goal call operation does not match its original input.");
        }
        if (
            goalOperationFingerprint({
                agentId: request.agentId,
                operation: request.operation,
                input: request.input,
            }) !== request.fingerprint
        ) {
            throw new Error("Goal call operation input does not match its fingerprint.");
        }
        if (evidence.state === "completed") {
            this.#assertEvidence(evidence.receipt, evidence.proof, request);
        }
    }

    async #readBoundaryEvidence(
        ctx: Context,
        kv: AgentKV,
        operation: GoalOperationRequest,
        boundary: GoalEvidenceBoundary,
    ): Promise<GoalOperationEvidence | undefined> {
        if (boundary.kind === "tool") {
            const evidence = await readCallOperationEvidence(ctx, boundary.kv);
            if (evidence === undefined) {
                throw new Error("Goal call operation evidence is missing.");
            }
            this.#assertCallRequest(
                evidence,
                operation.agentId,
                operation.operation,
                operation.input,
                operation.fingerprint,
                operation.operationId,
            );
            if (evidence.state === "pending") return undefined;
            return {
                receipt: structuredClone(evidence.receipt),
                proof: structuredClone(evidence.proof),
            };
        }
        if (boundary.kind === "automatic") {
            const evidence = await readAutomaticBlockEvidence(ctx, kv);
            if (evidence !== undefined) {
                this.#assertEvidence(evidence.receipt, evidence.proof, operation);
            }
            return evidence;
        }
        const receipt = await readReceipt(ctx, kv, operation.operationId);
        const proof = await readProof(ctx, kv, operation.operationId);
        if (receipt === undefined && proof === undefined) return undefined;
        if (receipt === undefined) {
            throw new Error("Goal mutation proof has no operation receipt.");
        }
        if (proof === undefined) {
            throw new Error("Goal operation receipt has no immutable proof.");
        }
        this.#assertEvidence(receipt, proof, operation);
        return { receipt, proof };
    }

    #validatedOperationAuthoritativeState(value: unknown): GoalOperationAuthoritativeState {
        if (!Value.Check(goalOperationAuthoritativeStateSchema, value)) {
            throw new Error("Goal authoritative operation state is invalid.");
        }
        return structuredClone(value);
    }

    async #readOperationAuthoritativeState(
        ctx: Context,
        kv: AgentKV,
        operation: GoalOperationRequest,
        boundary: GoalEvidenceBoundary,
    ): Promise<GoalOperationAuthoritativeState> {
        const state = await readGoalAuthoritativeState(ctx, kv, operation.agentId);
        const evidence = await this.#readBoundaryEvidence(ctx, kv, operation, boundary);
        if (evidence === undefined) {
            throw new Error("Goal operation evidence disappeared.");
        }
        return this.#validatedOperationAuthoritativeState({ state, evidence });
    }

    async #assertOperationAuthoritativeState(
        ctx: Context,
        kv: AgentKV,
        operation: GoalOperationRequest,
        boundary: GoalEvidenceBoundary,
        expected: GoalOperationAuthoritativeState,
    ): Promise<void> {
        const detachedExpected = this.#validatedOperationAuthoritativeState(expected);
        const persisted = await this.#readOperationAuthoritativeState(ctx, kv, operation, boundary);
        if (!Value.Equal(persisted, detachedExpected)) {
            throw new Error(
                "Goal authoritative state does not match the completed transaction decision.",
            );
        }
    }

    async #event(
        ctx: Context,
        payload:
            | { readonly type: "goal_set"; readonly agentId: string; readonly goal: SessionGoal }
            | {
                  readonly type: "goal_status_changed";
                  readonly agentId: string;
                  readonly goal: SessionGoal;
              }
            | { readonly type: "goal_cleared"; readonly agentId: string },
    ): Promise<GoalEvent> {
        const eventId = await this.#factoryValue(
            this.#eventIdFactory(ctx, payload.agentId),
            goalOperationIdSchema,
            "Goal event ID",
        );
        const at = await this.#factoryValue(this.#clock(), goalTimestampSchema, "Goal clock");
        const event = { ...payload, eventId, at } as unknown;
        if (!Value.Check(goalEventSchema, event)) throw new Error("Goal event is invalid.");
        return deepFreeze(structuredClone(event) as GoalEvent);
    }

    async #timestamp(_ctx: Context): Promise<number> {
        return await this.#factoryValue(this.#clock(), goalTimestampSchema, "Goal clock");
    }

    async #factoryValue<T>(
        value: unknown,
        schema: Parameters<typeof Value.Check>[0],
        label: string,
    ): Promise<T> {
        const resolved = Value.Check(goalFactoryPromiseSchema, value) ? await value : value;
        if (!Value.Check(schema, resolved)) throw new Error(`${label} returned an invalid value.`);
        return resolved as T;
    }

    async #awaitVoidResult(value: unknown, label: string): Promise<void> {
        const resolved = Value.Check(goalVoidPromiseSchema, value) ? await value : value;
        if (!Value.Check(Type.Void(), resolved)) {
            throw new Error(`${label} must return void or a Promise<void>.`);
        }
    }

    #assertSynchronousVoid(value: unknown, label: string): void {
        if (value === undefined) return;
        if (Value.Check(goalVoidPromiseSchema, value)) {
            void (value as Promise<unknown>).catch(() => undefined);
            throw new Error(`${label} must register synchronously.`);
        }
        throw new Error(`${label} must return void.`);
    }

    async #notifyPostCommit(ctx: Context, event: GoalEvent): Promise<void> {
        try {
            const callback = this.#listener?.onEvent;
            if (callback !== undefined) {
                await this.#awaitVoidResult(
                    callback.call(this.#listener, ctx, event),
                    "Goal post-commit listener",
                );
            }
        } catch (error: unknown) {
            try {
                const reporter = this.#onPostCommitError;
                if (reporter !== undefined) {
                    await this.#awaitVoidResult(
                        reporter(ctx, event, normalizeObserverError(error)),
                        "Goal post-commit error reporter",
                    );
                }
            } catch {
                // Reporting is advisory after durable state has committed.
            }
        }
    }

    async #reconcileWakeState(
        ctx: Context,
        operation: GoalOperationRequest,
        decision: GoalDecision,
        externalCaller: boolean,
        previousLifecycle: GoalLifecycleState | undefined,
    ): Promise<GoalWakeState | undefined> {
        if (!decision.result.changed) return undefined;
        const scheduler = this.#wakeScheduler;
        let desired: GoalWakeState | undefined;
        if (decision.result.operation !== "clear" && decision.result.goal.status === "active") {
            if (!externalCaller) return undefined;
            if (scheduler === undefined) {
                throw new Error("External Goal activation requires a durable wake scheduler.");
            }
            const goal = decision.result.goal;
            desired = {
                state: "scheduled",
                agentId: operation.agentId,
                lifecycleId: operation.operationId,
                messageId: continuationMessageId(operation.agentId, operation.operationId, goal),
                prompt: createGoalContinuationPrompt(goal),
            };
        } else if (previousLifecycle?.activation === "external") {
            if (scheduler === undefined) {
                throw new Error(
                    "Superseding an external Goal activation requires a durable wake scheduler.",
                );
            }
            desired = {
                state: "cancelled",
                agentId: operation.agentId,
                operationId: operation.operationId,
            };
        }
        if (desired === undefined) return undefined;
        if (!Value.Check(goalWakeStateSchema, desired)) {
            throw new Error("Goal wake reconciliation state is invalid.");
        }
        if (scheduler === undefined) {
            throw new Error("Goal wake reconciliation requires its scheduler.");
        }
        const requiredScheduler: GoalWakeScheduler = scheduler;
        const expected = structuredClone(desired);
        if (encodedBytes(expected) > MAX_GOAL_WAKE_STATE_BYTES) {
            throw new Error("Goal wake reconciliation state exceeds its encoded-byte bound.");
        }
        const returned = requiredScheduler.reconcile.call(
            requiredScheduler,
            ctx,
            structuredClone(expected),
        );
        if (!Value.Check(goalVoidPromiseSchema, returned)) {
            throw new Error("Goal wake scheduler must return a Promise.");
        }
        const resolved = await returned;
        if (!Value.Check(Type.Void(), resolved)) {
            throw new Error("Goal wake scheduler reconcile must resolve to void.");
        }
        await this.#assertWakeState(ctx, operation.agentId, expected);
        return structuredClone(expected);
    }

    async #assertWakeState(ctx: Context, agentId: string, expected: GoalWakeState): Promise<void> {
        if (
            !Value.Check(goalWakeStateSchema, expected) ||
            expected.agentId !== agentId ||
            encodedBytes(expected) > MAX_GOAL_WAKE_STATE_BYTES
        ) {
            throw new Error("Goal expected wake state is invalid.");
        }
        const scheduler = this.#wakeScheduler;
        if (scheduler === undefined) {
            throw new Error("Goal wake reconciliation requires its scheduler.");
        }
        const readResult = scheduler.read.call(scheduler, ctx, agentId);
        if (!Value.Check(goalWakeReadPromiseSchema, readResult)) {
            throw new Error("Goal wake scheduler read must return a Promise.");
        }
        const persisted = await readResult;
        if (
            !Value.Check(goalWakeReadResultSchema, persisted) ||
            !Value.Equal(persisted, expected)
        ) {
            throw new Error("Goal wake scheduler did not retain the requested latest state.");
        }
    }

    async #readRunState(ctx: Context, scope: AgentFeatureScope): Promise<GoalRunState> {
        const observedLifecycleId = await scope.runKV.read(ctx, GOAL_OBSERVED_LIFECYCLE_ID_KEY);
        const continuationId = await scope.runKV.read(ctx, GOAL_CONTINUATION_ID_KEY);
        const inference = await scope.runKV.read(ctx, GOAL_LAST_INFERENCE_KEY);
        const state = { observedLifecycleId, continuationId, inference };
        if (!Value.Check(goalRunStateSchema, state)) {
            throw new Error("The stored Goal run state is invalid.");
        }
        return structuredClone(state);
    }

    #validatedLoopAuthoritativeState(value: unknown): GoalLoopAuthoritativeState {
        if (!Value.Check(goalLoopAuthoritativeStateSchema, value)) {
            throw new Error("Goal loop authoritative state is invalid.");
        }
        return structuredClone(value);
    }

    async #readLoopAuthoritativeState(
        ctx: Context,
        scope: AgentFeatureScope,
    ): Promise<GoalLoopAuthoritativeState> {
        return this.#validatedLoopAuthoritativeState({
            state: await readGoalAuthoritativeState(ctx, scope.kv, scope.agent.id),
            run: await this.#readRunState(ctx, scope),
        });
    }

    async #assertLoopAuthoritativeState(
        ctx: Context,
        scope: AgentFeatureScope,
        expected: GoalLoopAuthoritativeState,
    ): Promise<void> {
        const detachedExpected = this.#validatedLoopAuthoritativeState(expected);
        const persisted = await this.#readLoopAuthoritativeState(ctx, scope);
        if (!Value.Equal(persisted, detachedExpected)) {
            throw new Error("Goal loop state does not match the completed transaction decision.");
        }
    }

    #assertTransactionResult(
        returned: unknown,
        expected: unknown,
        label: string,
    ): asserts expected is Static<typeof goalTransactionResultSchema> {
        if (
            !Value.Check(goalTransactionResultSchema, expected) ||
            !Value.Check(goalTransactionResultSchema, returned) ||
            !Value.Equal(returned, expected)
        ) {
            throw new Error(`${label} transaction returned an unexpected result.`);
        }
    }

    async #observeActiveLifecycleForRun(
        ctx: Context,
        scope: AgentFeatureScope,
        expectedGoal: SessionGoal,
    ): Promise<void> {
        if (!Value.Check(sessionGoalSchema, expectedGoal)) {
            throw new Error("Goal lifecycle observation received an invalid goal.");
        }
        let expectedReturned: Static<typeof goalTransactionResultSchema> | undefined;
        let expectedState: GoalLoopAuthoritativeState | undefined;
        const returned = await scope.kv.transaction(ctx, async (txKv, txCtx) => {
            const before = await this.#readLoopAuthoritativeState(txCtx, scope);
            const current = before.state.goal;
            let observedLifecycleId = before.run.observedLifecycleId;
            if (
                current?.status === "active" &&
                Value.Equal(current, expectedGoal) &&
                agentRunningInside(ctx) === scope.agent.id
            ) {
                const lifecycle = before.state.lifecycle;
                if (lifecycle === undefined) {
                    throw new Error("An active Goal requires its exact lifecycle sidecar.");
                }
                observedLifecycleId = lifecycle.id;
                await scope.runKV.write(txCtx, GOAL_OBSERVED_LIFECYCLE_ID_KEY, observedLifecycleId);
            }
            expectedState = this.#validatedLoopAuthoritativeState({
                state: before.state,
                run: {
                    ...before.run,
                    observedLifecycleId,
                },
            });
            await this.#assertLoopAuthoritativeState(txCtx, scope, expectedState);
            expectedReturned = { wake: false };
            return structuredClone(expectedReturned);
        });
        if (expectedReturned === undefined || expectedState === undefined) {
            throw new Error("Goal lifecycle observation did not produce its expected state.");
        }
        this.#assertTransactionResult(returned, expectedReturned, "Goal lifecycle observation");
        await this.#assertLoopAuthoritativeState(ctx, scope, expectedState);
    }

    async #continuationActionId(ctx: Context, scope: AgentFeatureScope): Promise<string> {
        const existing = await scope.runKV.read(ctx, GOAL_CONTINUATION_ID_KEY);
        if (existing !== undefined) {
            if (!Value.Check(goalWakeMessageIdSchema, existing)) {
                throw new Error("The stored Goal continuation ID is invalid.");
            }
            return existing as string;
        }
        const source = await this.#factoryValue<string>(
            this.#idFactory(ctx, scope.agent.id),
            goalOperationIdSchema,
            "Goal continuation ID",
        );
        const id = `g${createHash("sha256").update(source, "utf8").digest("hex").slice(0, 31)}`;
        if (!Value.Check(goalWakeMessageIdSchema, id)) {
            throw new Error("Goal continuation ID is invalid.");
        }
        await scope.runKV.write(ctx, GOAL_CONTINUATION_ID_KEY, id);
        if ((await scope.runKV.read(ctx, GOAL_CONTINUATION_ID_KEY)) !== id) {
            throw new Error("Goal continuation ID was not durably retained.");
        }
        return id;
    }

    #automaticBlockOperation(
        agentId: string,
        operationId: GoalOperationId,
        lifecycleId: string,
    ): GoalStatusRequest {
        const input = { status: "blocked" as const, lifecycleId };
        const request = this.#operationRequest(
            agentId,
            "status",
            operationId,
            goalOperationFingerprint({ agentId, operation: "status", input }),
            input,
        );
        if (request.operation !== "status") {
            throw new Error("Goal automatic block operation request is invalid.");
        }
        return request;
    }

    /**
     * Retain one stable identity for the current automatic block attempt. It is derived from the
     * lifecycle and written before any failed turn, so a crash can replay the same status
     * operation even though the failed-turn decision itself remains one transaction.
     */
    async #automaticBlockOperationIdInTransaction(
        ctx: Context,
        kv: AgentKV,
        lifecycleId: string,
    ): Promise<GoalOperationId> {
        const expected = goalAutomaticBlockOperationId(lifecycleId);
        const stored = await kv.read(ctx, GOAL_AUTO_BLOCK_OPERATION_ID_KEY);
        if (!Value.Check(goalOperationIdSchema, stored)) {
            throw new Error("Stored Goal automatic block operation ID is invalid.");
        }
        if (stored !== expected) {
            throw new Error(
                "Stored Goal automatic block operation ID does not match its lifecycle.",
            );
        }
        return stored;
    }

    async #writeAutomaticBlockOperationId(
        ctx: Context,
        kv: AgentKV,
        lifecycleId: string,
    ): Promise<void> {
        const operationId = goalAutomaticBlockOperationId(lifecycleId);
        await kv.write(ctx, GOAL_AUTO_BLOCK_OPERATION_ID_KEY, operationId);
        if ((await kv.read(ctx, GOAL_AUTO_BLOCK_OPERATION_ID_KEY)) !== operationId) {
            throw new Error("Goal automatic block operation ID was not durably retained.");
        }
    }

    async #writeLifecycle(
        ctx: Context,
        kv: AgentKV,
        lifecycleId: string,
        goal: SessionGoal,
        externalCaller: boolean,
    ): Promise<void> {
        if (!Value.Check(goalLifecycleIdSchema, lifecycleId)) {
            throw new Error("Goal lifecycle ID is invalid.");
        }
        await writeGoalLifecycle(ctx, kv, {
            activation: externalCaller ? "external" : "agent",
            id: lifecycleId,
            goal: structuredClone(goal),
        });
    }

    #assertEvidence(
        receipt: GoalOperationReceipt,
        proof: GoalMutationProof,
        operation: GoalOperationRequest,
    ): void {
        assertGoalEvidence(receipt, proof);
        if (
            receipt.agentId !== operation.agentId ||
            receipt.operation !== operation.operation ||
            receipt.operationId !== operation.operationId ||
            receipt.fingerprint !== operation.fingerprint
        ) {
            throw new Error("Goal operation receipt does not match the requested operation.");
        }
        if (
            proof.agentId !== operation.agentId ||
            proof.operation !== operation.operation ||
            proof.operationId !== operation.operationId ||
            proof.fingerprint !== operation.fingerprint ||
            proof.createdAt !== receipt.createdAt ||
            !Value.Equal(proof.result, receipt.result)
        ) {
            throw new Error("Goal mutation proof does not match its operation receipt.");
        }
        if (!Value.Equal(proof.input, operation.input)) {
            throw new Error("Goal mutation proof input does not match the requested operation.");
        }
        if (
            goalOperationFingerprint({
                agentId: proof.agentId,
                operation: proof.operation,
                input: proof.input,
            }) !== operation.fingerprint
        ) {
            throw new Error("Goal mutation proof input does not match its operation fingerprint.");
        }
    }

    #assertAgentId(agentId: string): void {
        if (!Value.Check(goalAgentIdSchema, agentId)) throw new Error("Goal agent ID is invalid.");
    }

    #assertStatus(status: string): asserts status is GoalStatus {
        if (!Value.Check(goalStatusSchema, status)) throw new Error("Goal status is invalid.");
    }
}

export function assertGoalFeatureOptions(value: unknown): asserts value is GoalFeatureOptions {
    let candidate: unknown = value;
    try {
        if (isObjectRecord(value)) {
            const option = { ...value };
            const storage = option.storage;
            if (isClassBacked(storage)) {
                option.storage = {
                    persistence: Reflect.get(storage, "persistence"),
                };
            }
            const listener = option.listener;
            if (isClassBacked(listener)) {
                option.listener = {
                    onEventTransactional: Reflect.get(listener, "onEventTransactional"),
                    onEvent: Reflect.get(listener, "onEvent"),
                };
            }
            const wakeScheduler = option.wakeScheduler;
            if (isClassBacked(wakeScheduler)) {
                option.wakeScheduler = {
                    read: Reflect.get(wakeScheduler, "read"),
                    reconcile: Reflect.get(wakeScheduler, "reconcile"),
                };
            }
            candidate = option;
        }
    } catch {
        candidate = undefined;
    }
    if (!Value.Check(goalFeatureOptionsSchema, candidate)) {
        throw new Error("Goal feature options are invalid.");
    }
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function isClassBacked(value: unknown): value is object {
    if (!isObjectRecord(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype !== Object.prototype && prototype !== null;
}

function deepFreeze<T>(value: T): T {
    if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    return Object.freeze(value);
}

function normalizeObserverError(error: unknown): string {
    try {
        if (error instanceof Error) {
            try {
                if (typeof error.message === "string" && error.message.length > 0) {
                    return error.message.slice(0, 500);
                }
            } catch {
                // Fall through to the guarded conversion.
            }
        }
        try {
            const converted = String(error);
            if (converted.length > 0) return converted.slice(0, 500);
        } catch {
            // Fall through to the bounded fallback.
        }
    } catch {
        // Hostile thrown values can even fail instanceof/property inspection.
    }
    return "Unknown Goal observer error.";
}

function continuationMessageId(
    agentId: string,
    lifecycleId: GoalOperationId,
    goal: SessionGoal,
): string {
    return `g${createHash("sha256")
        .update(
            JSON.stringify([
                "goal-external-wake",
                agentId,
                lifecycleId,
                goal.createdAt,
                goal.updatedAt,
                goal.objective,
            ]),
            "utf8",
        )
        .digest("hex")
        .slice(0, 31)}`;
}

function encodedBytes(value: unknown): number {
    let encoded: string | undefined;
    try {
        encoded = JSON.stringify(value);
    } catch {
        throw new Error("Goal wake reconciliation state is not JSON encodable.");
    }
    if (encoded === undefined) {
        throw new Error("Goal wake reconciliation state is not JSON encodable.");
    }
    return Buffer.byteLength(encoded, "utf8");
}
