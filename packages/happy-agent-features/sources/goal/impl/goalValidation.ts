import { createHash } from "node:crypto";

import { Value } from "@sinclair/typebox/value";

import {
    goalLifecycleIdSchema,
    goalMutationProofSchema,
    goalOperationFingerprintSchema,
    goalOperationIdentitySchema,
    goalOperationIdSchema,
    goalOperationReceiptSchema,
    sessionGoalSchema,
    type GoalMutationProof,
    type GoalOperationReceipt,
    type SessionGoal,
} from "../SessionGoal.js";

const MAX_GOAL_OPERATION_CANONICAL_BYTES = 256_000;
const MAX_GOAL_OPERATION_CANONICAL_DEPTH = 8;

/** Compute the one bounded canonical digest used by requests, receipts, and immutable proofs. */
export function goalOperationFingerprint(identity: unknown): string {
    if (!Value.Check(goalOperationIdentitySchema, identity)) {
        throw new Error("Goal operation identity is invalid.");
    }
    const normalizedIdentity = identity;
    let encoded: string;
    try {
        encoded = JSON.stringify(sortJson(normalizedIdentity));
    } catch {
        throw new Error("Goal operation input is not canonicalizable.");
    }
    if (
        encoded.length === 0 ||
        Buffer.byteLength(encoded, "utf8") > MAX_GOAL_OPERATION_CANONICAL_BYTES
    ) {
        throw new Error("Goal operation input exceeds the durable receipt bound.");
    }
    const digest = createHash("sha256").update(encoded, "utf8").digest("hex");
    if (!Value.Check(goalOperationFingerprintSchema, digest)) {
        throw new Error("Goal operation fingerprint is invalid.");
    }
    return digest;
}

/** The automatic-block identity is an exact deterministic function of one active lifecycle. */
export function goalAutomaticBlockOperationId(lifecycleId: string): string {
    if (!Value.Check(goalLifecycleIdSchema, lifecycleId)) {
        throw new Error("Goal lifecycle ID is invalid.");
    }
    const operationId = `b${createHash("sha256")
        .update(JSON.stringify(["goal-auto-block", lifecycleId]), "utf8")
        .digest("hex")
        .slice(0, 31)}`;
    if (!Value.Check(goalOperationIdSchema, operationId)) {
        throw new Error("Goal automatic-block operation ID is invalid.");
    }
    return operationId;
}

/** TypeBox shape plus the timestamp ordering every persisted Goal row must satisfy. */
export function assertSessionGoalSemantics(value: unknown): asserts value is SessionGoal {
    if (!Value.Check(sessionGoalSchema, value)) {
        throw new Error("The stored goal is invalid.");
    }
    if (value.updatedAt < value.createdAt) {
        throw new Error("The stored goal has invalid timestamps.");
    }
}

/** Validate one complete proof independently of the mutable receipt wrapped around it. */
export function assertGoalMutationProofSemantics(
    value: unknown,
): asserts value is GoalMutationProof {
    if (!Value.Check(goalMutationProofSchema, value)) {
        throw new Error("The stored Goal mutation proof is invalid.");
    }
    const proof = value;
    if (
        goalOperationFingerprint({
            agentId: proof.agentId,
            operation: proof.operation,
            input: proof.input,
        }) !== proof.fingerprint
    ) {
        throw new Error("Goal mutation proof input does not match its operation fingerprint.");
    }
    if (proof.before !== null) assertSessionGoalSemantics(proof.before);
    if (proof.result.operation !== "clear") assertSessionGoalSemantics(proof.result.goal);

    switch (proof.operation) {
        case "set": {
            if (proof.result.goal.objective !== proof.input.objective) {
                throw new Error("Goal set proof does not preserve its requested objective.");
            }
            if (!proof.result.changed) {
                if (
                    proof.before === null ||
                    proof.before.status !== "active" ||
                    !Value.Equal(proof.before, proof.result.goal)
                ) {
                    throw new Error("Goal set proof has an invalid unchanged transition.");
                }
            } else if (
                (proof.before !== null && proof.before.status !== "complete") ||
                proof.result.goal.status !== "active" ||
                proof.result.goal.createdAt !== proof.result.goal.updatedAt
            ) {
                throw new Error("Goal set proof has an invalid transition.");
            }
            return;
        }
        case "status": {
            if (!proof.result.changed) {
                if (
                    !Value.Equal(proof.before, proof.result.goal) ||
                    proof.result.goal.status !== proof.input.status ||
                    proof.input.lifecycleId !== undefined
                ) {
                    throw new Error("Goal status proof has an invalid unchanged transition.");
                }
            } else if (
                proof.before.status === proof.result.goal.status ||
                proof.result.goal.status !== proof.input.status ||
                proof.before.createdAt !== proof.result.goal.createdAt ||
                proof.before.objective !== proof.result.goal.objective ||
                proof.result.goal.updatedAt < proof.before.updatedAt
            ) {
                throw new Error("Goal status proof has an invalid transition.");
            }
            if (
                proof.input.lifecycleId !== undefined &&
                (proof.input.status !== "blocked" ||
                    proof.before.status !== "active" ||
                    !proof.result.changed ||
                    proof.operationId !== goalAutomaticBlockOperationId(proof.input.lifecycleId))
            ) {
                throw new Error("Goal automatic-block proof has an invalid lifecycle transition.");
            }
            return;
        }
        case "clear":
            if (
                proof.result.changed !== (proof.before !== null) ||
                proof.result.cleared !== proof.result.changed
            ) {
                throw new Error("Goal clear proof has an invalid transition.");
            }
            return;
    }
}

/** Validate a persisted receipt/proof pair, including its immutable transition semantics. */
export function assertGoalEvidence(
    receiptValue: unknown,
    proofValue: unknown,
): asserts receiptValue is GoalOperationReceipt {
    if (!Value.Check(goalOperationReceiptSchema, receiptValue)) {
        throw new Error("The stored Goal operation receipt is invalid.");
    }
    assertGoalMutationProofSemantics(proofValue);
    const receipt = receiptValue;
    const proof = proofValue;
    if (
        receipt.operation !== receipt.result.operation ||
        proof.operation !== proof.result.operation ||
        receipt.operationId !== proof.operationId ||
        receipt.agentId !== proof.agentId ||
        receipt.operation !== proof.operation ||
        receipt.fingerprint !== proof.fingerprint ||
        receipt.createdAt !== proof.createdAt ||
        !Value.Equal(receipt.result, proof.result)
    ) {
        throw new Error("The stored goal operation ledger has mismatched receipt/proof evidence.");
    }
}

function sortJson(value: unknown, depth = 0, seen = new Set<object>()): unknown {
    if (depth > MAX_GOAL_OPERATION_CANONICAL_DEPTH) {
        throw new Error("Goal operation input is too deeply nested.");
    }
    if (Array.isArray(value)) {
        if (seen.has(value)) throw new Error("Goal operation input is cyclic.");
        seen.add(value);
        const result = value.map((item) => sortJson(item, depth + 1, seen));
        seen.delete(value);
        return result;
    }
    if (value === null || typeof value !== "object") return value;
    const object = value as Record<string, unknown>;
    if (seen.has(object)) throw new Error("Goal operation input is cyclic.");
    seen.add(object);
    const result = Object.fromEntries(
        Object.entries(object)
            .sort(([left], [right]) => compareCodeUnits(left, right))
            .map(([key, item]) => [key, sortJson(item, depth + 1, seen)]),
    );
    seen.delete(object);
    return result;
}

function compareCodeUnits(left: string, right: string): number {
    if (left === right) return 0;
    return left < right ? -1 : 1;
}
