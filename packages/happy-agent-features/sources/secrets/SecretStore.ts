import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import {
    secretAgentIdSchema,
    secretAttachInputSchema,
    secretAttachmentSchema,
    secretHostEnvironmentSchema,
    secretIdSchema,
    secretListQuerySchema,
    secretMutationOperationSchema,
    secretOperationFingerprintSchema,
    secretOperationIdSchema,
    secretPageSchema,
    secretReferenceSchema,
    secretRegistrationSchema,
    secretScopeRefSchema,
    secretUpdateInputSchema,
    type SecretAttachment,
    type SecretHostEnvironment,
    type SecretMutationOperation,
    type SecretOperationFingerprint,
    type SecretOperationId,
    type SecretReference,
    type SecretPage,
} from "./Secret.js";
import { secretContextSchema } from "./SecretEvent.js";

const unknownPromiseSchema = Type.Promise(Type.Unknown());
const voidPromiseSchema = Type.Promise(Type.Void());

export const secretMutationRequestSchema = Type.Object(
    {
        operationId: secretOperationIdSchema,
        fingerprint: secretOperationFingerprintSchema,
    },
    { additionalProperties: false },
);

export type SecretMutationRequest = Static<typeof secretMutationRequestSchema>;

export const secretStoreRegisterResultSchema = Type.Object(
    {
        operation: Type.Literal("register"),
        operationId: secretOperationIdSchema,
        fingerprint: secretOperationFingerprintSchema,
        changed: Type.Boolean(),
        reference: secretReferenceSchema,
    },
    { additionalProperties: false },
);

export const secretStoreUpdateResultSchema = Type.Object(
    {
        operation: Type.Literal("update"),
        operationId: secretOperationIdSchema,
        fingerprint: secretOperationFingerprintSchema,
        changed: Type.Boolean(),
        secretId: secretIdSchema,
        reference: Type.Optional(secretReferenceSchema),
    },
    { additionalProperties: false },
);

export const secretStoreRemoveResultSchema = Type.Object(
    {
        operation: Type.Literal("remove"),
        operationId: secretOperationIdSchema,
        fingerprint: secretOperationFingerprintSchema,
        removed: Type.Boolean(),
        secretId: secretIdSchema,
        reference: Type.Optional(secretReferenceSchema),
    },
    { additionalProperties: false },
);

export const secretStoreAttachResultSchema = Type.Object(
    {
        operation: Type.Literal("attach"),
        operationId: secretOperationIdSchema,
        fingerprint: secretOperationFingerprintSchema,
        changed: Type.Boolean(),
        attachment: secretAttachmentSchema,
        /** Optional on the host mutation envelope; required in persisted feature receipts. */
        reference: Type.Optional(secretReferenceSchema),
    },
    { additionalProperties: false },
);

export const secretStoreDetachResultSchema = Type.Object(
    {
        operation: Type.Literal("detach"),
        operationId: secretOperationIdSchema,
        fingerprint: secretOperationFingerprintSchema,
        detached: Type.Boolean(),
        attachment: Type.Optional(secretAttachmentSchema),
    },
    { additionalProperties: false },
);

/** Every host mutation result carries the exact requested operation identity. */
export const secretStoreMutationResultSchema = Type.Union([
    secretStoreRegisterResultSchema,
    secretStoreUpdateResultSchema,
    secretStoreRemoveResultSchema,
    secretStoreAttachResultSchema,
    secretStoreDetachResultSchema,
]);

/**
 * Immutable host proof for generated identity or destructive/no-op mutation state. Receipts are
 * retry records and may be rewritten by a host store; proofs independently bind the generated
 * register ID or the exact historical before state and mutation outcome.
 */
export const secretRemoveProofSchema = Type.Object(
    {
        agentId: secretAgentIdSchema,
        operation: Type.Literal("remove"),
        operationId: secretOperationIdSchema,
        fingerprint: secretOperationFingerprintSchema,
        secretId: secretIdSchema,
        before: Type.Union([secretReferenceSchema, Type.Null()]),
        removed: Type.Boolean(),
    },
    { additionalProperties: false },
);

export const secretDetachProofSchema = Type.Object(
    {
        agentId: secretAgentIdSchema,
        operation: Type.Literal("detach"),
        operationId: secretOperationIdSchema,
        fingerprint: secretOperationFingerprintSchema,
        scopeRef: secretScopeRefSchema,
        secretId: secretIdSchema,
        before: Type.Union([secretAttachmentSchema, Type.Null()]),
        detached: Type.Boolean(),
    },
    { additionalProperties: false },
);

/** Immutable proof of the exact safe result returned by an attach mutation. */
export const secretAttachProofSchema = Type.Object(
    {
        agentId: secretAgentIdSchema,
        operation: Type.Literal("attach"),
        operationId: secretOperationIdSchema,
        fingerprint: secretOperationFingerprintSchema,
        scopeRef: secretScopeRefSchema,
        secretId: secretIdSchema,
        changed: Type.Boolean(),
        attachment: secretAttachmentSchema,
        reference: secretReferenceSchema,
    },
    { additionalProperties: false },
);

/** Immutable binding from one register operation to its feature-allocated secret identity. */
export const secretRegisterIdProofSchema = Type.Object(
    {
        agentId: secretAgentIdSchema,
        operation: Type.Literal("register"),
        operationId: secretOperationIdSchema,
        fingerprint: secretOperationFingerprintSchema,
        secretId: secretIdSchema,
    },
    { additionalProperties: false },
);

export const secretMutationProofSchema = Type.Union([
    secretRegisterIdProofSchema,
    secretRemoveProofSchema,
    secretDetachProofSchema,
    secretAttachProofSchema,
]);

/**
 * Durable receipt retained by the host store. A receipt is only a retry record
 * for mutable catalog operations; attach receipts also retain the bounded safe
 * reference snapshot required to render a historical tool replay.
 */
export const secretOperationReceiptSchema = Type.Object(
    {
        agentId: secretAgentIdSchema,
        operation: secretMutationOperationSchema,
        operationId: secretOperationIdSchema,
        fingerprint: secretOperationFingerprintSchema,
        result: secretStoreMutationResultSchema,
    },
    { additionalProperties: false },
);

export type SecretStoreRegisterResult = Static<typeof secretStoreRegisterResultSchema>;
export type SecretStoreUpdateResult = Static<typeof secretStoreUpdateResultSchema>;
export type SecretStoreRemoveResult = Static<typeof secretStoreRemoveResultSchema>;
export type SecretStoreAttachResult = Static<typeof secretStoreAttachResultSchema>;
export type SecretStoreDetachResult = Static<typeof secretStoreDetachResultSchema>;
export type SecretStoreMutationResult = Static<typeof secretStoreMutationResultSchema>;
export type SecretRemoveProof = Static<typeof secretRemoveProofSchema>;
export type SecretDetachProof = Static<typeof secretDetachProofSchema>;
export type SecretAttachProof = Static<typeof secretAttachProofSchema>;
export type SecretRegisterIdProof = Static<typeof secretRegisterIdProofSchema>;
export type SecretMutationProof = Static<typeof secretMutationProofSchema>;
export type SecretOperationReceipt = Static<typeof secretOperationReceiptSchema>;

/** Resolver results contain values only on the trusted host path. */
export const secretResolverSchema = Type.Function(
    [
        secretContextSchema,
        secretAgentIdSchema,
        secretScopeRefSchema,
        Type.Optional(Type.Array(secretIdSchema, { maxItems: 256 })),
    ],
    Type.Promise(secretHostEnvironmentSchema),
);

export type SecretResolver = Static<typeof secretResolverSchema>;

export const secretAuthorizationOperationSchema = Type.Union([
    Type.Literal("list"),
    Type.Literal("reference"),
    Type.Literal("register"),
    Type.Literal("update"),
    Type.Literal("remove"),
    Type.Literal("attach"),
    Type.Literal("detach"),
    Type.Literal("resolve"),
]);

/** Optional host policy for opaque scope access. The store remains authoritative for its catalog. */
export const secretAuthorizationSchema = Type.Function(
    [
        secretContextSchema,
        secretAgentIdSchema,
        secretAuthorizationOperationSchema,
        Type.Optional(secretScopeRefSchema),
    ],
    Type.Union([Type.Boolean(), Type.Promise(Type.Boolean())]),
);

export type SecretAuthorization = Static<typeof secretAuthorizationSchema>;

/**
 * Host-owned secret storage and resolver. Every call carries the acting agent ID so a host can
 * enforce ownership/collaboration policy without the feature interpreting agent or scope IDs.
 */
export const secretStoreSchema = Type.Object(
    {
        transaction: Type.Function(
            [secretContextSchema, Type.Function([secretContextSchema], unknownPromiseSchema)],
            unknownPromiseSchema,
        ),
        /**
         * Registration is synchronous: the callback is queued in the host's outermost
         * transaction and may itself be asynchronous after commit.
         */
        afterCommit: Type.Function(
            [
                secretContextSchema,
                Type.Function(
                    [secretContextSchema],
                    Type.Union([Type.Void(), Type.Promise(Type.Unknown())]),
                ),
            ],
            Type.Void(),
        ),
        list: Type.Function(
            [secretContextSchema, secretAgentIdSchema, secretListQuerySchema],
            Type.Promise(secretPageSchema),
        ),
        reference: Type.Function(
            [secretContextSchema, secretAgentIdSchema, secretIdSchema],
            Type.Promise(Type.Union([secretReferenceSchema, Type.Undefined()])),
        ),
        attachment: Type.Function(
            [secretContextSchema, secretAgentIdSchema, secretAttachInputSchema],
            Type.Promise(Type.Union([secretAttachmentSchema, Type.Undefined()])),
        ),
        register: Type.Function(
            [
                secretContextSchema,
                secretAgentIdSchema,
                secretRegistrationSchema,
                secretMutationRequestSchema,
            ],
            Type.Promise(secretStoreRegisterResultSchema),
        ),
        update: Type.Function(
            [
                secretContextSchema,
                secretAgentIdSchema,
                secretIdSchema,
                secretUpdateInputSchema,
                secretMutationRequestSchema,
            ],
            Type.Promise(secretStoreUpdateResultSchema),
        ),
        remove: Type.Function(
            [secretContextSchema, secretAgentIdSchema, secretIdSchema, secretMutationRequestSchema],
            Type.Promise(secretStoreRemoveResultSchema),
        ),
        attach: Type.Function(
            [
                secretContextSchema,
                secretAgentIdSchema,
                secretAttachInputSchema,
                secretMutationRequestSchema,
            ],
            Type.Promise(secretStoreAttachResultSchema),
        ),
        detach: Type.Function(
            [
                secretContextSchema,
                secretAgentIdSchema,
                secretAttachInputSchema,
                secretMutationRequestSchema,
            ],
            Type.Promise(secretStoreDetachResultSchema),
        ),
        readReceipt: Type.Function(
            [secretContextSchema, secretAgentIdSchema, secretOperationIdSchema],
            Type.Promise(Type.Union([secretOperationReceiptSchema, Type.Undefined()])),
        ),
        writeReceipt: Type.Function(
            [secretContextSchema, secretAgentIdSchema, secretOperationReceiptSchema],
            voidPromiseSchema,
        ),
        /**
         * Mutation proofs are append-only host records. A host must reject a
         * second write for the same operation unless it is byte-for-byte
         * identical, and must return the original proof from readMutationProof.
         */
        readMutationProof: Type.Function(
            [secretContextSchema, secretAgentIdSchema, secretOperationIdSchema],
            Type.Promise(Type.Union([secretMutationProofSchema, Type.Undefined()])),
        ),
        writeMutationProof: Type.Function(
            [secretContextSchema, secretAgentIdSchema, secretMutationProofSchema],
            voidPromiseSchema,
        ),
        resolveForHost: secretResolverSchema,
    },
    { additionalProperties: false },
);

/** Host contracts are inferred directly from their TypeBox schemas. */
export type SecretStore = Static<typeof secretStoreSchema>;

export function assertSecretPage(value: unknown): asserts value is SecretPage {
    if (!Value.Check(secretPageSchema, value)) {
        throw new Error("Secret store returned an invalid bounded page.");
    }
}

export function assertSecretReference(value: unknown): asserts value is SecretReference {
    if (!Value.Check(secretReferenceSchema, value)) {
        throw new Error("Secret store returned invalid safe metadata.");
    }
}

export function assertSecretAttachment(value: unknown): asserts value is SecretAttachment {
    if (!Value.Check(secretAttachmentSchema, value)) {
        throw new Error("Secret store returned an invalid attachment.");
    }
}

export function assertSecretHostEnvironment(
    value: unknown,
): asserts value is SecretHostEnvironment {
    if (!Value.Check(secretHostEnvironmentSchema, value)) {
        throw new Error("Secret resolver returned an invalid host environment.");
    }
}

export function assertSecretMutationRequest(
    value: unknown,
): asserts value is SecretMutationRequest {
    if (!Value.Check(secretMutationRequestSchema, value)) {
        throw new Error("Secret mutation request is invalid.");
    }
}

export function assertSecretStoreMutationResult(
    value: unknown,
): asserts value is SecretStoreMutationResult {
    if (!Value.Check(secretStoreMutationResultSchema, value)) {
        throw new Error("Secret store returned an invalid mutation result.");
    }
}

export function assertSecretOperationReceipt(
    value: unknown,
): asserts value is SecretOperationReceipt {
    if (!Value.Check(secretOperationReceiptSchema, value)) {
        throw new Error("Secret store returned an invalid operation receipt.");
    }
}

export function assertSecretMutationProof(value: unknown): asserts value is SecretMutationProof {
    if (!Value.Check(secretMutationProofSchema, value)) {
        throw new Error("Secret store returned an invalid immutable mutation proof.");
    }
    const proof = value as SecretMutationProof;
    if (proof.operation === "remove") {
        if (
            proof.removed !== (proof.before !== null) ||
            (proof.before !== null && proof.before.id !== proof.secretId)
        ) {
            throw new Error("Secret remove proof has an invalid before-state marker.");
        }
        return;
    }
    if (proof.operation === "register") {
        if (proof.secretId === "") {
            throw new Error("Secret registration identity proof has an invalid secret ID.");
        }
        return;
    }
    if (proof.operation === "attach") {
        if (
            proof.scopeRef === "" ||
            proof.secretId === "" ||
            proof.attachment.scopeRef !== proof.scopeRef ||
            proof.attachment.secretId !== proof.secretId ||
            proof.reference.id !== proof.secretId
        ) {
            throw new Error("Secret attach proof has an invalid result snapshot.");
        }
        return;
    }
    if (
        proof.detached !== (proof.before !== null) ||
        proof.scopeRef === "" ||
        proof.secretId === "" ||
        (proof.before !== null &&
            (proof.before.scopeRef !== proof.scopeRef || proof.before.secretId !== proof.secretId))
    ) {
        throw new Error("Secret detach proof has an invalid before-state marker.");
    }
}

export function assertSecretStore(value: unknown): asserts value is SecretStore {
    if (!Value.Check(secretStoreSchema, value)) {
        throw new Error("Secrets feature received an invalid host store.");
    }
}

export function assertSecretResolver(value: unknown): asserts value is SecretResolver {
    if (!Value.Check(secretResolverSchema, value)) {
        throw new Error("Secrets feature received an invalid host resolver.");
    }
}

export function assertSecretAuthorization(value: unknown): asserts value is SecretAuthorization {
    if (!Value.Check(secretAuthorizationSchema, value)) {
        throw new Error("Secrets feature received an invalid authorization policy.");
    }
}

export type {
    SecretAttachment,
    SecretHostEnvironment,
    SecretMutationOperation,
    SecretOperationFingerprint,
    SecretOperationId,
    SecretReference,
};
