import { Type, type Static } from "@sinclair/typebox";

/** Bounds shared by every Goal public and persisted contract. */
export const MAX_GOAL_AGENT_ID_LENGTH = 256;
export const MAX_GOAL_OPERATION_ID_LENGTH = 128;
export const MAX_GOAL_OBJECTIVE_CHARS = 20_000;
export const MAX_GOAL_RECEIPTS = 256;
export const MAX_GOAL_EVIDENCE_BYTES = 1_000_000;
export const MAX_GOAL_LEDGER_BYTES = 1_000_000;
export const MAX_GOAL_OUTPUT_CHARACTERS = 100_000;
/** Consecutive failed active turns before Goal performs its one automatic block transition. */
export const FAILED_TURNS_BEFORE_BLOCKED = 3;

export const goalAgentIdSchema = Type.String({
    minLength: 1,
    maxLength: MAX_GOAL_AGENT_ID_LENGTH,
});
export const goalOperationIdSchema = Type.String({
    minLength: 1,
    maxLength: MAX_GOAL_OPERATION_ID_LENGTH,
});
export const goalOperationFingerprintSchema = Type.String({
    pattern: "^[a-f0-9]{64}$",
});
/** Identity of one active goal lifecycle, carried only by internal status proofs. */
export const goalLifecycleIdSchema = Type.String({
    minLength: 1,
    maxLength: MAX_GOAL_OPERATION_ID_LENGTH,
});
export const goalTimestampSchema = Type.Integer({ minimum: 0 });
export const goalObjectiveSchema = Type.String({
    minLength: 1,
    maxLength: MAX_GOAL_OBJECTIVE_CHARS,
});

/**
 * Where a goal stands. Only complete and blocked are model-terminal states; paused is a
 * caller-controlled stop that preserves the objective.
 */
export const goalStatusSchema = Type.Union([
    Type.Literal("active"),
    Type.Literal("paused"),
    Type.Literal("blocked"),
    Type.Literal("complete"),
]);

/** The complete goal stored in the feature's agent-owned KV. */
export const sessionGoalSchema = Type.Object(
    {
        createdAt: goalTimestampSchema,
        objective: goalObjectiveSchema,
        status: goalStatusSchema,
        updatedAt: goalTimestampSchema,
    },
    { additionalProperties: false },
);

/** Optional caller-owned durable identity for public mutations. */
export const goalMutationOptionsSchema = Type.Object(
    {
        operationId: Type.Optional(goalOperationIdSchema),
    },
    { additionalProperties: false },
);

/** The three durable mutations supported by Goal. */
export const goalOperationSchema = Type.Union([
    Type.Literal("set"),
    Type.Literal("status"),
    Type.Literal("clear"),
]);

const goalSetResultSchema = Type.Object(
    {
        operation: Type.Literal("set"),
        changed: Type.Boolean(),
        goal: sessionGoalSchema,
    },
    { additionalProperties: false },
);
const goalStatusResultSchema = Type.Object(
    {
        operation: Type.Literal("status"),
        changed: Type.Boolean(),
        goal: sessionGoalSchema,
    },
    { additionalProperties: false },
);
const goalClearResultSchema = Type.Object(
    {
        operation: Type.Literal("clear"),
        changed: Type.Boolean(),
        cleared: Type.Boolean(),
    },
    { additionalProperties: false },
);

/** The result retained by an idempotent Goal operation receipt. */
export const goalMutationResultSchema = Type.Union([
    goalSetResultSchema,
    goalStatusResultSchema,
    goalClearResultSchema,
]);

const goalBeforeSchema = Type.Union([sessionGoalSchema, Type.Null()]);
export const goalSetInputSchema = Type.Object(
    { objective: goalObjectiveSchema },
    { additionalProperties: false },
);
export const goalStatusInputSchema = Type.Object(
    {
        status: goalStatusSchema,
        lifecycleId: Type.Optional(goalLifecycleIdSchema),
    },
    { additionalProperties: false },
);
export const goalClearInputSchema = Type.Object({}, { additionalProperties: false });

/** Canonical input to the bounded operation fingerprint. */
export const goalOperationIdentitySchema = Type.Union([
    Type.Object(
        {
            operation: Type.Literal("set"),
            agentId: goalAgentIdSchema,
            input: goalSetInputSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            operation: Type.Literal("status"),
            agentId: goalAgentIdSchema,
            input: goalStatusInputSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            operation: Type.Literal("clear"),
            agentId: goalAgentIdSchema,
            input: goalClearInputSchema,
        },
        { additionalProperties: false },
    ),
]);

/** Complete normalized identity of one durable Goal mutation. */
export const goalOperationRequestSchema = Type.Union([
    Type.Object(
        {
            operation: Type.Literal("set"),
            agentId: goalAgentIdSchema,
            operationId: goalOperationIdSchema,
            fingerprint: goalOperationFingerprintSchema,
            input: goalSetInputSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            operation: Type.Literal("status"),
            agentId: goalAgentIdSchema,
            operationId: goalOperationIdSchema,
            fingerprint: goalOperationFingerprintSchema,
            input: goalStatusInputSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            operation: Type.Literal("clear"),
            agentId: goalAgentIdSchema,
            operationId: goalOperationIdSchema,
            fingerprint: goalOperationFingerprintSchema,
            input: goalClearInputSchema,
        },
        { additionalProperties: false },
    ),
]);

const goalSetProofSchema = Type.Object(
    {
        operation: Type.Literal("set"),
        agentId: goalAgentIdSchema,
        operationId: goalOperationIdSchema,
        fingerprint: goalOperationFingerprintSchema,
        input: goalSetInputSchema,
        before: goalBeforeSchema,
        result: goalSetResultSchema,
        createdAt: goalTimestampSchema,
    },
    { additionalProperties: false },
);
const goalStatusProofSchema = Type.Object(
    {
        operation: Type.Literal("status"),
        agentId: goalAgentIdSchema,
        operationId: goalOperationIdSchema,
        fingerprint: goalOperationFingerprintSchema,
        input: goalStatusInputSchema,
        before: sessionGoalSchema,
        result: goalStatusResultSchema,
        createdAt: goalTimestampSchema,
    },
    { additionalProperties: false },
);
const goalClearProofSchema = Type.Object(
    {
        operation: Type.Literal("clear"),
        agentId: goalAgentIdSchema,
        operationId: goalOperationIdSchema,
        fingerprint: goalOperationFingerprintSchema,
        input: goalClearInputSchema,
        before: goalBeforeSchema,
        result: goalClearResultSchema,
        createdAt: goalTimestampSchema,
    },
    { additionalProperties: false },
);

/** Immutable before-state proof retained alongside every mutation receipt. */
export const goalMutationProofSchema = Type.Union([
    goalSetProofSchema,
    goalStatusProofSchema,
    goalClearProofSchema,
]);

/** Durable idempotency result. It is never authoritative over current goal state. */
export const goalOperationReceiptSchema = Type.Object(
    {
        operation: Type.Union([Type.Literal("set"), Type.Literal("status"), Type.Literal("clear")]),
        agentId: goalAgentIdSchema,
        operationId: goalOperationIdSchema,
        fingerprint: goalOperationFingerprintSchema,
        result: goalMutationResultSchema,
        createdAt: goalTimestampSchema,
    },
    { additionalProperties: false },
);

export type GoalAgentId = Static<typeof goalAgentIdSchema>;
export type GoalOperationId = Static<typeof goalOperationIdSchema>;
export type GoalOperationFingerprint = Static<typeof goalOperationFingerprintSchema>;
export type GoalStatus = Static<typeof goalStatusSchema>;
export type SessionGoal = Static<typeof sessionGoalSchema>;
export type GoalMutationOptions = Static<typeof goalMutationOptionsSchema>;
export type GoalOperation = Static<typeof goalOperationSchema>;
export type GoalOperationIdentity = Static<typeof goalOperationIdentitySchema>;
export type GoalOperationRequest = Static<typeof goalOperationRequestSchema>;
export type GoalMutationResult = Static<typeof goalMutationResultSchema>;
export type GoalMutationProof = Static<typeof goalMutationProofSchema>;
export type GoalOperationReceipt = Static<typeof goalOperationReceiptSchema>;
