import type { AgentPersistence, AgentRecord, AgentKV } from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

import { goalContextSchema } from "../GoalEvent.js";
import {
    FAILED_TURNS_BEFORE_BLOCKED,
    goalMutationProofSchema,
    goalLifecycleIdSchema,
    goalOperationRequestSchema,
    goalOperationReceiptSchema,
    goalAgentIdSchema,
    MAX_GOAL_EVIDENCE_BYTES,
    MAX_GOAL_LEDGER_BYTES,
    MAX_GOAL_RECEIPTS,
    sessionGoalSchema,
    goalOperationIdSchema,
    type GoalMutationProof,
    type GoalOperationRequest,
    type GoalOperationReceipt,
    type SessionGoal,
} from "../SessionGoal.js";
import {
    assertGoalEvidence,
    assertSessionGoalSemantics,
    goalAutomaticBlockOperationId,
} from "./goalValidation.js";

/** The one state key holding the current goal. */
export const GOAL_KEY = "goal";
/** One bounded ledger holds durable operation evidence in the same feature-owned KV. */
export const GOAL_OPERATIONS_KEY = "operations";
export const GOAL_FAILURE_COUNT_KEY = "failureCount";
export const GOAL_LAST_INFERENCE_KEY = "lastInference";
export const GOAL_CONTINUATION_ID_KEY = "continuationId";
/** Exact identity and Goal snapshot for the current active lifecycle. */
export const GOAL_LIFECYCLE_KEY = "lifecycle";
/** Run-scoped snapshot used to reject stale after-agent-loop hooks. */
export const GOAL_OBSERVED_LIFECYCLE_ID_KEY = "observedLifecycleId";
/** The idempotency identity reserved for one automatic block attempt. */
export const GOAL_AUTO_BLOCK_OPERATION_ID_KEY = "autoBlockOperationId";
/** One complete automatic-block evidence pair, replaced with the active lifecycle. */
export const GOAL_AUTO_BLOCK_EVIDENCE_KEY = "autoBlockEvidence";
/** One pending or completed durable mutation owned by an Agent Base tool call. */
export const GOAL_CALL_OPERATION_KEY = "operation";
/** Final encoded-byte cap for one call-scoped pending/completed operation. */
export const MAX_GOAL_CALL_EVIDENCE_BYTES = MAX_GOAL_EVIDENCE_BYTES;

const GOAL_MAX_PERSISTENCE_KEY_LENGTH = 4_096;
const GOAL_MAX_PERSISTENCE_ENTRIES = MAX_GOAL_RECEIPTS + 8;
const MAX_GOAL_PERSISTENCE_READ_BYTES = 2_000_000;

export const goalOperationEvidenceSchema = Type.Object(
    {
        receipt: goalOperationReceiptSchema,
        proof: goalMutationProofSchema,
    },
    { additionalProperties: false },
);
const goalOperationLedgerSchema = Type.Array(goalOperationEvidenceSchema, {
    maxItems: MAX_GOAL_RECEIPTS,
});
export type GoalOperationEvidence = Static<typeof goalOperationEvidenceSchema>;
export const goalLifecycleStateSchema = Type.Object(
    {
        activation: Type.Union([Type.Literal("agent"), Type.Literal("external")]),
        id: goalLifecycleIdSchema,
        goal: sessionGoalSchema,
    },
    { additionalProperties: false },
);
export type GoalLifecycleState = Static<typeof goalLifecycleStateSchema>;
const goalStoredFailureCountSchema = Type.Integer({
    minimum: 1,
    maximum: FAILED_TURNS_BEFORE_BLOCKED - 1,
});
/** Exact current Goal state and lifecycle-owned sidecars at one persistence boundary. */
export const goalAuthoritativeStateSchema = Type.Object(
    {
        goal: Type.Union([sessionGoalSchema, Type.Undefined()]),
        lifecycle: Type.Union([goalLifecycleStateSchema, Type.Undefined()]),
        automaticBlockOperationId: Type.Union([goalOperationIdSchema, Type.Undefined()]),
        failureCount: Type.Union([goalStoredFailureCountSchema, Type.Undefined()]),
        automaticBlockEvidence: Type.Union([goalOperationEvidenceSchema, Type.Undefined()]),
    },
    { additionalProperties: false },
);
export type GoalAuthoritativeState = Static<typeof goalAuthoritativeStateSchema>;

const goalCallPendingOperationSchema = Type.Object(
    {
        state: Type.Literal("pending"),
        request: goalOperationRequestSchema,
    },
    { additionalProperties: false },
);
const goalCallCompletedOperationSchema = Type.Object(
    {
        state: Type.Literal("completed"),
        request: goalOperationRequestSchema,
        receipt: goalOperationReceiptSchema,
        proof: goalMutationProofSchema,
    },
    { additionalProperties: false },
);
/** Complete bounded call state retained until Agent Base commits the tool result. */
export const goalCallOperationEvidenceSchema = Type.Union([
    goalCallPendingOperationSchema,
    goalCallCompletedOperationSchema,
]);
export type GoalCallOperationEvidence = Static<typeof goalCallOperationEvidenceSchema>;

/*
 * The Goal persistence adapter only handles values written by Goal's own feature scope. Keeping
 * this union explicit makes the boundary useful: malformed host values are rejected before
 * AgentKV projects them, while Agent Base's unrelated AgentRecord data never needs a fake schema.
 */
const goalInferenceValueSchema = Type.Object(
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
const goalWakeResultSchema = Type.Object({ wake: Type.Boolean() }, { additionalProperties: false });
const goalPersistenceValueSchema = Type.Union([
    goalOperationIdSchema,
    sessionGoalSchema,
    goalOperationLedgerSchema,
    goalOperationEvidenceSchema,
    goalLifecycleStateSchema,
    goalCallOperationEvidenceSchema,
    goalInferenceValueSchema,
    Type.Integer({ minimum: 0, maximum: FAILED_TURNS_BEFORE_BLOCKED }),
    goalWakeResultSchema,
    Type.Boolean(),
]);
type GoalPersistenceValue = Static<typeof goalPersistenceValueSchema>;
const goalPersistenceEntriesSchema = Type.Readonly(
    Type.Array(
        Type.Object(
            {
                key: Type.String({
                    minLength: 1,
                    maxLength: GOAL_MAX_PERSISTENCE_KEY_LENGTH,
                }),
                value: goalPersistenceValueSchema,
            },
            { additionalProperties: false },
        ),
        { maxItems: GOAL_MAX_PERSISTENCE_ENTRIES },
    ),
);
type GoalPersistenceEntry = Static<typeof goalPersistenceEntriesSchema>[number];
const goalPersistencePromiseSchema = Type.Promise(goalPersistenceValueSchema);
const goalPersistenceWorkSchema = Type.Function([goalContextSchema], goalPersistencePromiseSchema);

/**
 * The narrow persistence surface Goal consumes. It deliberately excludes Agent Base's
 * append-only record methods: Goal never reads or writes those records, and modeling their
 * provider-specific message union here would make the feature contract broader and less safe.
 */
export const goalPersistenceSchema = Type.Object(
    {
        transaction: Type.Function(
            [goalContextSchema, goalPersistenceWorkSchema],
            goalPersistencePromiseSchema,
        ),
        readValues: Type.Function(
            [goalContextSchema, Type.String({ maxLength: GOAL_MAX_PERSISTENCE_KEY_LENGTH })],
            Type.Promise(goalPersistenceEntriesSchema),
        ),
        writeValue: Type.Function(
            [
                goalContextSchema,
                Type.String({ minLength: 1, maxLength: GOAL_MAX_PERSISTENCE_KEY_LENGTH }),
                goalPersistenceValueSchema,
            ],
            Type.Promise(Type.Void()),
        ),
        writeValueIfAbsent: Type.Function(
            [
                goalContextSchema,
                Type.String({ minLength: 1, maxLength: GOAL_MAX_PERSISTENCE_KEY_LENGTH }),
                goalPersistenceValueSchema,
            ],
            Type.Promise(Type.Boolean()),
        ),
        deleteValue: Type.Function(
            [
                goalContextSchema,
                Type.String({ minLength: 1, maxLength: GOAL_MAX_PERSISTENCE_KEY_LENGTH }),
            ],
            Type.Promise(Type.Void()),
        ),
    },
    { additionalProperties: false },
);

/** Structural storage contract consumed by Goal's public API. */
export const goalStorageSchema = Type.Object(
    {
        persistence: Type.Function([goalAgentIdSchema], goalPersistenceSchema),
    },
    { additionalProperties: false },
);

export type GoalStorage = Static<typeof goalStorageSchema>;
export type GoalPersistence = Static<typeof goalPersistenceSchema>;

type GoalPersistenceMethods = Pick<
    GoalPersistence,
    "transaction" | "readValues" | "writeValue" | "writeValueIfAbsent" | "deleteValue"
>;

/**
 * AgentStorage implementations are classes whose useful methods live on their prototype and
 * whose instances may carry unrelated fields. Validate a method-only view rather than the raw
 * instance, then always invoke the original method with its owner below.
 */
function persistenceMethodView(value: object): GoalPersistenceMethods {
    return {
        transaction: Reflect.get(value, "transaction") as GoalPersistence["transaction"],
        readValues: Reflect.get(value, "readValues") as GoalPersistence["readValues"],
        writeValue: Reflect.get(value, "writeValue") as GoalPersistence["writeValue"],
        writeValueIfAbsent: Reflect.get(
            value,
            "writeValueIfAbsent",
        ) as GoalPersistence["writeValueIfAbsent"],
        deleteValue: Reflect.get(value, "deleteValue") as GoalPersistence["deleteValue"],
    };
}

/** Validate a persistence factory result before constructing AgentKV over it. */
export function assertGoalPersistence(value: unknown): asserts value is GoalPersistence {
    if (typeof value !== "object" || value === null) {
        throw new Error("Goals storage returned invalid agent persistence.");
    }
    let candidate: unknown = value;
    try {
        if (isClassBacked(value)) candidate = persistenceMethodView(value);
    } catch {
        throw new Error("Goals storage returned invalid agent persistence.");
    }
    if (!Value.Check(goalPersistenceSchema, candidate)) {
        throw new Error("Goals storage returned invalid agent persistence.");
    }
}

function isClassBacked(value: object): boolean {
    const prototype = Object.getPrototypeOf(value);
    return prototype !== Object.prototype && prototype !== null;
}

/**
 * Adapt the narrow Goal persistence surface to AgentKV's complete structural type. The unused
 * Agent Base record methods are intentionally unreachable: Goal never calls them, while Agent Base
 * continues to receive the host's original AgentPersistence through AgentStorage.
 */
export function validatedGoalPersistence(value: GoalPersistence): AgentPersistence {
    assertGoalPersistence(value);
    return {
        transaction: async <Result>(
            ctx: Context,
            work: (txCtx: Context) => Promise<Result>,
        ): Promise<Result> => {
            const wrappedWork = async (txCtx: Context): Promise<GoalPersistenceValue> => {
                const result = work(txCtx);
                const resolved = await requirePromiseResult<GoalPersistenceValue>(
                    result,
                    "Goal persistence transaction work",
                    goalPersistenceValueSchema,
                );
                return resolved;
            };
            const result = Reflect.apply(value.transaction, value, [ctx, wrappedWork]);
            return (await requirePromiseResult<GoalPersistenceValue>(
                result,
                "Goal persistence transaction",
                goalPersistenceValueSchema,
            )) as Result;
        },
        load: async (): Promise<readonly AgentRecord[]> => {
            throw new Error("Goal persistence does not expose Agent Base records.");
        },
        append: async (_ctx: Context, _record: AgentRecord): Promise<void> => {
            throw new Error("Goal persistence does not expose Agent Base records.");
        },
        clearRecords: async (): Promise<void> => {
            throw new Error("Goal persistence does not expose Agent Base records.");
        },
        readValues: async (
            ctx: Context,
            prefix: string,
        ): Promise<readonly GoalPersistenceEntry[]> => {
            const result = Reflect.apply(value.readValues, value, [ctx, prefix]);
            const entries = await requirePromiseResult<Static<typeof goalPersistenceEntriesSchema>>(
                result,
                "Goal persistence readValues",
                goalPersistenceEntriesSchema,
            );
            validatePersistenceEntries(entries, prefix);
            return entries;
        },
        writeValue: async (
            ctx: Context,
            key: string,
            stored: GoalPersistenceValue,
        ): Promise<void> => {
            assertPersistenceValue(stored, "Goal persistence value");
            const result = Reflect.apply(value.writeValue, value, [ctx, key, stored]);
            await requireVoidPromise(result, "Goal persistence writeValue");
        },
        writeValueIfAbsent: async (
            ctx: Context,
            key: string,
            stored: GoalPersistenceValue,
        ): Promise<boolean> => {
            assertPersistenceValue(stored, "Goal persistence value");
            const result = Reflect.apply(value.writeValueIfAbsent, value, [ctx, key, stored]);
            return await requirePromiseResult(
                result,
                "Goal persistence writeValueIfAbsent",
                Type.Boolean(),
            );
        },
        deleteValue: async (ctx: Context, key: string): Promise<void> => {
            const result = Reflect.apply(value.deleteValue, value, [ctx, key]);
            await requireVoidPromise(result, "Goal persistence deleteValue");
        },
    };
}

async function requirePromiseResult<Result>(
    value: unknown,
    label: string,
    schema: Parameters<typeof Value.Check>[0],
): Promise<Result> {
    const promiseSchema = Type.Promise(schema);
    if (!Value.Check(promiseSchema, value)) {
        throw new Error(`${label} must return a Promise.`);
    }
    const resolved = await value;
    if (!Value.Check(schema, resolved)) {
        throw new Error(`${label} resolved to an invalid value.`);
    }
    return resolved as Result;
}

async function requireVoidPromise(value: unknown, label: string): Promise<void> {
    if (!Value.Check(Type.Promise(Type.Void()), value)) {
        throw new Error(`${label} must return a Promise.`);
    }
    const resolved = await value;
    if (!Value.Check(Type.Void(), resolved)) {
        throw new Error(`${label} must resolve to void.`);
    }
}

function assertPersistenceValue(value: unknown, label: string): void {
    if (!Value.Check(goalPersistenceValueSchema, value)) {
        throw new Error(`${label} is invalid.`);
    }
    assertEncodedBound(value, label, MAX_GOAL_LEDGER_BYTES);
    if (Value.Check(goalOperationLedgerSchema, value)) {
        validateLedger(value);
    }
    if (Value.Check(goalOperationEvidenceSchema, value)) {
        assertEncodedBound(value, label, MAX_GOAL_CALL_EVIDENCE_BYTES);
        validateEvidence([value]);
    }
    if (Value.Check(goalCallOperationEvidenceSchema, value)) {
        assertEncodedBound(value, label, MAX_GOAL_CALL_EVIDENCE_BYTES);
        if (value.state === "completed") {
            assertCallEvidence(value);
        }
    }
}

function validatePersistenceEntries(
    entries: readonly GoalPersistenceEntry[],
    prefix: string,
): void {
    assertEncodedBound(
        entries,
        "Goal persistence readValues result",
        MAX_GOAL_PERSISTENCE_READ_BYTES,
    );
    let previousKey: string | undefined;
    const keys = new Set<string>();
    for (const entry of entries) {
        if (!entry.key.startsWith(prefix)) {
            throw new Error("Goal persistence readValues returned an out-of-scope entry.");
        }
        if (previousKey !== undefined && entry.key < previousKey) {
            throw new Error("Goal persistence readValues returned unsorted entries.");
        }
        if (keys.has(entry.key)) {
            throw new Error("Goal persistence readValues returned duplicate entries.");
        }
        keys.add(entry.key);
        previousKey = entry.key;
        assertPersistenceValue(entry.value, "Goal persistence entry value");
    }
}

/** Read and validate the current goal from feature-owned KV. */
export async function readGoal(
    ctx: Context,
    kv: AgentKV,
    agentId: string,
): Promise<SessionGoal | undefined> {
    return (await readGoalAuthoritativeState(ctx, kv, agentId)).goal;
}

/**
 * Read and semantically validate the complete current Goal state once.
 *
 * This snapshot is used at transaction boundaries so a schema-valid adapter cannot substitute a
 * different goal while leaving its lifecycle sidecars internally coherent.
 */
export async function readGoalAuthoritativeState(
    ctx: Context,
    kv: AgentKV,
    agentId: string,
): Promise<GoalAuthoritativeState> {
    if (!Value.Check(goalAgentIdSchema, agentId)) {
        throw new Error("Goal agent ID is invalid.");
    }
    await readLedger(ctx, kv, agentId);
    const automaticBlock = await readAutomaticBlockEvidence(ctx, kv);
    const goal = await readGoalState(ctx, kv);
    const lifecycle = await readGoalLifecycle(ctx, kv);
    const automaticBlockOperationId = await kv.read(ctx, GOAL_AUTO_BLOCK_OPERATION_ID_KEY);
    const failureCount = await kv.read(ctx, GOAL_FAILURE_COUNT_KEY);
    assertDurableGoalState(
        goal,
        agentId,
        lifecycle,
        automaticBlockOperationId,
        failureCount,
        automaticBlock,
    );
    const state = {
        goal,
        lifecycle,
        automaticBlockOperationId,
        failureCount,
        automaticBlockEvidence: automaticBlock,
    };
    if (!Value.Check(goalAuthoritativeStateSchema, state)) {
        throw new Error("The authoritative Goal state is invalid.");
    }
    return structuredClone(state);
}

/** Read the exact active-lifecycle sidecar without inferring missing fields. */
export async function readGoalLifecycle(
    ctx: Context,
    kv: AgentKV,
): Promise<GoalLifecycleState | undefined> {
    const stored = await kv.read(ctx, GOAL_LIFECYCLE_KEY);
    if (stored === undefined) return undefined;
    if (!Value.Check(goalLifecycleStateSchema, stored)) {
        throw new Error("The stored Goal lifecycle sidecar is invalid.");
    }
    assertSessionGoalSemantics(stored.goal);
    return structuredClone(stored);
}

/** Write and read back the exact active-lifecycle sidecar. */
export async function writeGoalLifecycle(
    ctx: Context,
    kv: AgentKV,
    lifecycle: GoalLifecycleState,
): Promise<void> {
    if (!Value.Check(goalLifecycleStateSchema, lifecycle)) {
        throw new Error("Goal lifecycle sidecar is invalid.");
    }
    assertSessionGoalSemantics(lifecycle.goal);
    const expected = structuredClone(lifecycle);
    await kv.write(ctx, GOAL_LIFECYCLE_KEY, structuredClone(expected));
    const persisted = await readGoalLifecycle(ctx, kv);
    if (persisted === undefined || !Value.Equal(persisted, expected)) {
        throw new Error("Goal lifecycle sidecar was not durably retained.");
    }
}

/** Read only the authoritative current goal, without consulting historical host evidence. */
export async function readGoalState(ctx: Context, kv: AgentKV): Promise<SessionGoal | undefined> {
    const stored = await kv.read(ctx, GOAL_KEY);
    if (stored === undefined) return undefined;
    assertSessionGoalSemantics(stored);
    return structuredClone(stored) as SessionGoal;
}

/** Write a detached goal and prove the adapter retained the exact value. */
export async function writeGoal(ctx: Context, kv: AgentKV, goal: SessionGoal): Promise<void> {
    assertSessionGoalSemantics(goal);
    const expected = structuredClone(goal);
    await kv.write(ctx, GOAL_KEY, structuredClone(expected));
    const persisted = await kv.read(ctx, GOAL_KEY);
    if (!Value.Check(sessionGoalSchema, persisted) || !Value.Equal(persisted, expected)) {
        throw new Error("The goal store did not persist the expected goal.");
    }
}

/** Delete the goal and verify that the adapter did not leave it behind. */
export async function clearGoal(ctx: Context, kv: AgentKV): Promise<void> {
    await kv.delete(ctx, GOAL_KEY);
    if ((await kv.read(ctx, GOAL_KEY)) !== undefined) {
        throw new Error("The goal store did not clear the goal.");
    }
}

export async function readReceipt(
    ctx: Context,
    kv: AgentKV,
    operationId: string,
): Promise<GoalOperationReceipt | undefined> {
    assertOperationId(operationId);
    const entries = await readLedger(ctx, kv);
    const entry = entries.find((candidate) => candidate.receipt.operationId === operationId);
    return entry === undefined ? undefined : structuredClone(entry.receipt);
}

/** Atomically write and read back one complete immutable receipt/proof evidence pair. */
export async function writeEvidence(
    ctx: Context,
    kv: AgentKV,
    receipt: GoalOperationReceipt,
    proof: GoalMutationProof,
): Promise<void> {
    if (!Value.Check(goalOperationReceiptSchema, receipt)) {
        throw new Error("Goal operation receipt is invalid.");
    }
    if (!Value.Check(goalMutationProofSchema, proof)) {
        throw new Error("Goal mutation proof is invalid.");
    }
    const expectedReceipt = structuredClone(receipt);
    const expectedProof = structuredClone(proof);
    assertEncodedBound(expectedReceipt, "Goal operation receipt", MAX_GOAL_EVIDENCE_BYTES);
    assertEncodedBound(expectedProof, "Goal mutation proof", MAX_GOAL_EVIDENCE_BYTES);
    assertGoalEvidence(expectedReceipt, expectedProof);
    const entries = await readLedger(ctx, kv);
    const next = withEvidence(entries, expectedReceipt, expectedProof);
    await kv.write(ctx, GOAL_OPERATIONS_KEY, next);
    const persistedReceipt = await readReceipt(ctx, kv, receipt.operationId);
    if (persistedReceipt === undefined || !Value.Equal(persistedReceipt, expectedReceipt)) {
        throw new Error("The goal store did not persist the expected operation receipt.");
    }
    const persistedProof = await readProof(ctx, kv, proof.operationId);
    if (persistedProof === undefined || !Value.Equal(persistedProof, expectedProof)) {
        throw new Error("The goal store did not persist the expected mutation proof.");
    }
}

export async function readProof(
    ctx: Context,
    kv: AgentKV,
    operationId: string,
): Promise<GoalMutationProof | undefined> {
    assertOperationId(operationId);
    const entries = await readLedger(ctx, kv);
    const entry = entries.find((candidate) => candidate.proof.operationId === operationId);
    return entry === undefined ? undefined : structuredClone(entry.proof);
}

/** Read the one bounded automatic-block pair owned by the current/last lifecycle. */
export async function readAutomaticBlockEvidence(
    ctx: Context,
    kv: AgentKV,
): Promise<GoalOperationEvidence | undefined> {
    const stored = await kv.read(ctx, GOAL_AUTO_BLOCK_EVIDENCE_KEY);
    if (stored === undefined) return undefined;
    if (!Value.Check(goalOperationEvidenceSchema, stored)) {
        throw new Error("The stored Goal automatic-block evidence is invalid.");
    }
    assertEncodedBound(
        stored,
        "The stored Goal automatic-block evidence",
        MAX_GOAL_CALL_EVIDENCE_BYTES,
    );
    validateEvidence([stored]);
    return structuredClone(stored);
}

/** Write and read back the single complete automatic-block pair. */
export async function writeAutomaticBlockEvidence(
    ctx: Context,
    kv: AgentKV,
    receipt: GoalOperationReceipt,
    proof: GoalMutationProof,
): Promise<void> {
    const expected: GoalOperationEvidence = {
        receipt: structuredClone(receipt),
        proof: structuredClone(proof),
    };
    if (!Value.Check(goalOperationEvidenceSchema, expected)) {
        throw new Error("Goal automatic-block evidence is invalid.");
    }
    validateEvidence([expected]);
    await kv.write(ctx, GOAL_AUTO_BLOCK_EVIDENCE_KEY, structuredClone(expected));
    const persisted = await readAutomaticBlockEvidence(ctx, kv);
    if (persisted === undefined || !Value.Equal(persisted, expected)) {
        throw new Error("The goal store did not persist the automatic-block evidence.");
    }
}

/** Remove the lifecycle-owned automatic-block pair and prove it is gone. */
export async function clearAutomaticBlockEvidence(ctx: Context, kv: AgentKV): Promise<void> {
    await kv.delete(ctx, GOAL_AUTO_BLOCK_EVIDENCE_KEY);
    if ((await kv.read(ctx, GOAL_AUTO_BLOCK_EVIDENCE_KEY)) !== undefined) {
        throw new Error("The goal store did not clear automatic-block evidence.");
    }
}

/** Read and fully validate the one operation retained under an Agent Base call scope. */
export async function readCallOperationEvidence(
    ctx: Context,
    kv: AgentKV,
): Promise<GoalCallOperationEvidence | undefined> {
    const stored = await kv.read(ctx, GOAL_CALL_OPERATION_KEY);
    if (stored === undefined) return undefined;
    if (!Value.Check(goalCallOperationEvidenceSchema, stored)) {
        throw new Error("The stored Goal call operation evidence is invalid.");
    }
    assertEncodedBound(
        stored,
        "The stored Goal call operation evidence",
        MAX_GOAL_CALL_EVIDENCE_BYTES,
    );
    if (stored.state === "completed") {
        assertCallEvidence(stored);
    }
    return structuredClone(stored);
}

/** Retain one pending request before a durable Goal tool mutates shared state. */
export async function writePendingCallOperation(
    ctx: Context,
    kv: AgentKV,
    request: GoalOperationRequest,
): Promise<void> {
    const expected: GoalCallOperationEvidence = {
        state: "pending",
        request: structuredClone(request),
    };
    await writeCallOperationEvidence(ctx, kv, expected);
}

/** Replace the exact pending call with its complete immutable result evidence. */
export async function writeCompletedCallOperation(
    ctx: Context,
    kv: AgentKV,
    request: GoalOperationRequest,
    receipt: GoalOperationReceipt,
    proof: GoalMutationProof,
): Promise<void> {
    const current = await readCallOperationEvidence(ctx, kv);
    if (
        current === undefined ||
        !Value.Equal(current.request, request) ||
        (current.state === "completed" &&
            (!Value.Equal(current.receipt, receipt) || !Value.Equal(current.proof, proof)))
    ) {
        throw new Error("Goal call operation evidence does not match its pending request.");
    }
    const expected: GoalCallOperationEvidence = {
        state: "completed",
        request: structuredClone(request),
        receipt: structuredClone(receipt),
        proof: structuredClone(proof),
    };
    await writeCallOperationEvidence(ctx, kv, expected);
}

/** Clear pending/completed call evidence when Agent Base durably appends its tool result. */
export async function clearCallOperationEvidence(ctx: Context, kv: AgentKV): Promise<void> {
    const current = await readCallOperationEvidence(ctx, kv);
    if (current === undefined) return;
    await kv.delete(ctx, GOAL_CALL_OPERATION_KEY);
    if ((await kv.read(ctx, GOAL_CALL_OPERATION_KEY)) !== undefined) {
        throw new Error("The goal store did not clear call operation evidence.");
    }
}

async function writeCallOperationEvidence(
    ctx: Context,
    kv: AgentKV,
    evidence: GoalCallOperationEvidence,
): Promise<void> {
    if (!Value.Check(goalCallOperationEvidenceSchema, evidence)) {
        throw new Error("Goal call operation evidence is invalid.");
    }
    assertEncodedBound(evidence, "Goal call operation evidence", MAX_GOAL_CALL_EVIDENCE_BYTES);
    if (evidence.state === "completed") {
        assertCallEvidence(evidence);
    }
    const expected = structuredClone(evidence);
    await kv.write(ctx, GOAL_CALL_OPERATION_KEY, structuredClone(expected));
    const persisted = await readCallOperationEvidence(ctx, kv);
    if (persisted === undefined || !Value.Equal(persisted, expected)) {
        throw new Error("The goal store did not persist the expected call operation evidence.");
    }
}

async function readLedger(
    ctx: Context,
    kv: AgentKV,
    expectedAgentId?: string,
): Promise<readonly GoalOperationEvidence[]> {
    const value = await kv.read(ctx, GOAL_OPERATIONS_KEY);
    if (value === undefined) return [];
    if (!Value.Check(goalOperationLedgerSchema, value)) {
        throw new Error("The stored goal operation ledger is invalid.");
    }
    validateLedger(value, expectedAgentId);
    return structuredClone(value);
}

function withEvidence(
    entries: readonly GoalOperationEvidence[],
    receipt: GoalOperationReceipt,
    proof: GoalMutationProof,
): readonly GoalOperationEvidence[] {
    const previous = entries.find(
        (entry) =>
            entry.receipt.operationId === receipt.operationId ||
            entry.proof.operationId === receipt.operationId,
    );
    if (previous !== undefined && !Value.Equal(previous.receipt, receipt)) {
        throw new Error("The goal operation receipt is immutable.");
    }
    if (previous !== undefined && !Value.Equal(previous.proof, proof)) {
        throw new Error("The goal mutation proof is immutable.");
    }
    if (previous !== undefined) return structuredClone(entries);
    if (entries.length >= MAX_GOAL_RECEIPTS) {
        throw new Error("Goal host operation evidence capacity is full.");
    }
    const next = [
        ...entries,
        {
            receipt: structuredClone(receipt),
            proof: structuredClone(proof),
        },
    ];
    if (encodedBytes(next) > MAX_GOAL_LEDGER_BYTES) {
        throw new Error("Goal host operation evidence byte capacity is full.");
    }
    validateLedger(next);
    return structuredClone(next);
}

function validateLedger(value: readonly GoalOperationEvidence[], expectedAgentId?: string): void {
    if (!Value.Check(goalOperationLedgerSchema, value)) {
        throw new Error("The Goal operation ledger is invalid.");
    }
    assertEncodedBound(value, "The Goal operation ledger", MAX_GOAL_LEDGER_BYTES);
    validateEvidence(value, expectedAgentId);
}

function validateEvidence(value: readonly GoalOperationEvidence[], expectedAgentId?: string): void {
    const ids = new Set<string>();
    for (const entry of value) {
        assertEncodedBound(
            entry.receipt,
            "The stored Goal operation receipt",
            MAX_GOAL_EVIDENCE_BYTES,
        );
        assertEncodedBound(entry.proof, "The stored Goal mutation proof", MAX_GOAL_EVIDENCE_BYTES);
        assertGoalEvidence(entry.receipt, entry.proof);
        if (expectedAgentId !== undefined && entry.receipt.agentId !== expectedAgentId) {
            throw new Error("The stored Goal operation evidence belongs to another agent.");
        }
        if (ids.has(entry.receipt.operationId)) {
            throw new Error("The stored goal operation ledger has duplicate evidence.");
        }
        ids.add(entry.receipt.operationId);
    }
}

function assertCallEvidence(evidence: Extract<GoalCallOperationEvidence, { state: "completed" }>) {
    assertGoalEvidence(evidence.receipt, evidence.proof);
    if (
        evidence.request.agentId !== evidence.receipt.agentId ||
        evidence.request.operation !== evidence.receipt.operation ||
        evidence.request.operationId !== evidence.receipt.operationId ||
        evidence.request.fingerprint !== evidence.receipt.fingerprint ||
        !Value.Equal(evidence.request.input, evidence.proof.input)
    ) {
        throw new Error("The stored Goal call evidence does not match its operation request.");
    }
}

function assertDurableGoalState(
    goal: SessionGoal | undefined,
    agentId: string,
    lifecycle: GoalLifecycleState | undefined,
    automaticBlockOperationId: unknown,
    failureCount: unknown,
    automaticBlock: GoalOperationEvidence | undefined,
): void {
    if (goal?.status === "active") {
        if (lifecycle === undefined || !Value.Equal(lifecycle.goal, goal)) {
            throw new Error("An active Goal requires its exact lifecycle sidecar.");
        }
        if (
            !Value.Check(goalOperationIdSchema, automaticBlockOperationId) ||
            automaticBlockOperationId !== goalAutomaticBlockOperationId(lifecycle.id)
        ) {
            throw new Error(
                "An active Goal requires its exact automatic-block operation identity.",
            );
        }
        if (
            failureCount !== undefined &&
            !Value.Check(
                Type.Integer({
                    minimum: 1,
                    maximum: FAILED_TURNS_BEFORE_BLOCKED - 1,
                }),
                failureCount,
            )
        ) {
            throw new Error("The active Goal failure count is invalid.");
        }
        if (automaticBlock !== undefined) {
            throw new Error("An active Goal cannot retain automatic-block evidence.");
        }
        return;
    }

    if (
        lifecycle !== undefined ||
        automaticBlockOperationId !== undefined ||
        failureCount !== undefined
    ) {
        throw new Error("An inactive Goal retains active-lifecycle state.");
    }
    if (automaticBlock === undefined) return;
    const proof = automaticBlock.proof;
    if (
        goal === undefined ||
        goal.status !== "blocked" ||
        automaticBlock.receipt.agentId !== agentId ||
        proof.operation !== "status" ||
        proof.input.status !== "blocked" ||
        proof.input.lifecycleId === undefined ||
        !proof.result.changed ||
        proof.result.goal.status !== "blocked" ||
        automaticBlock.receipt.operationId !==
            goalAutomaticBlockOperationId(proof.input.lifecycleId) ||
        !Value.Equal(goal, proof.result.goal)
    ) {
        throw new Error("The stored Goal automatic-block evidence is inconsistent.");
    }
}

function assertOperationId(operationId: string): void {
    if (!Value.Check(goalOperationIdSchema, operationId)) {
        throw new Error("Goal operation ID is invalid.");
    }
}

function encodedBytes(value: unknown): number {
    let encoded: string | undefined;
    try {
        encoded = JSON.stringify(value);
    } catch {
        throw new Error("Goal persistence value is not JSON encodable.");
    }
    if (encoded === undefined) throw new Error("Goal persistence value is not JSON encodable.");
    return Buffer.byteLength(encoded, "utf8");
}

function assertEncodedBound(value: unknown, label: string, maximum: number): void {
    if (encodedBytes(value) > maximum) {
        throw new Error(`${label} exceeds its persistence bound.`);
    }
}
