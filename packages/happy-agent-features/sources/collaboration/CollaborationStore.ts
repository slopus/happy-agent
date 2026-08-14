import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { agentConfigSchema } from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";

import {
    collaborationAgentIdSchema,
    collaborationAgentPageQuerySchema,
    collaborationAgentPageSchema,
    collaborationAgentSchema,
    collaborationFingerprintSchema,
    collaborationMetadataSchema,
    collaborationOperationIdSchema,
    type CollaborationAgentPage,
} from "./CollaborationAgent.js";
import { collaborationEventSchema } from "./CollaborationEvent.js";
import {
    collaborationMessageIdSchema,
    collaborationMessageSchema,
    collaborationObligationIdSchema,
    collaborationObligationPageQuerySchema,
    collaborationObligationPageSchema,
    collaborationObligationSchema,
    collaborationScheduleIdSchema,
    collaborationScheduleSchema,
    collaborationSendResultSchema,
    type CollaborationObligationPage,
} from "./CollaborationMessage.js";

/**
 * Contexts are owned by Agent Base and the host. Collaboration only carries them through the
 * injected boundary; it neither inspects nor constructs a context.
 */
export const collaborationContextSchema = Type.Unsafe<Context>(
    Type.Object({}, { additionalProperties: true }),
);
const asyncVoidResultSchema = Type.Promise(Type.Void());
const postCommitCallbackSchema = Type.Function(
    [collaborationContextSchema],
    Type.Union([Type.Void(), Type.Promise(Type.Void())]),
);

export const collaborationAuthorizationActionSchema = Type.Union([
    Type.Literal("create"),
    Type.Literal("read"),
    Type.Literal("list"),
    Type.Literal("send"),
    Type.Literal("reply"),
    Type.Literal("wait"),
    Type.Literal("schedule"),
]);

/**
 * Host policy for relationships that are not covered by durable ownership. Returning false is a
 * denial; the feature never treats a missing policy as authorization for another agent.
 */
export const collaborationAuthorizationSchema = Type.Object(
    {
        authorize: Type.Function(
            [
                collaborationContextSchema,
                collaborationAgentIdSchema,
                collaborationAgentIdSchema,
                collaborationAuthorizationActionSchema,
            ],
            Type.Promise(Type.Boolean()),
        ),
    },
    { additionalProperties: false },
);

/** The only Agent Base message shape Collaboration sends. */
export const collaborationBrokerMessageSchema = Type.Object(
    {
        role: Type.Literal("user"),
        content: Type.Array(
            Type.Object(
                {
                    type: Type.Literal("text"),
                    text: Type.String({ minLength: 1, maxLength: 50_000 }),
                },
                { additionalProperties: false },
            ),
            { minItems: 1, maxItems: 1 },
        ),
    },
    { additionalProperties: false },
);

export const collaborationBrokerSendOptionsSchema = Type.Object(
    {
        id: collaborationMessageIdSchema,
        metadata: Type.Optional(collaborationMetadataSchema),
    },
    { additionalProperties: false },
);

export const collaborationBrokerCreateOptionsSchema = Type.Object(
    {
        id: collaborationAgentIdSchema,
        parent: Type.Union([collaborationAgentIdSchema, Type.Null()]),
    },
    { additionalProperties: false },
);

export const collaborationBrokerAgentResultSchema = Type.Object(
    { id: collaborationAgentIdSchema },
    { additionalProperties: false },
);

export const collaborationBrokerScheduleRequestSchema = Type.Object(
    {
        id: collaborationScheduleIdSchema,
        ownerAgentId: collaborationAgentIdSchema,
        targetAgentId: collaborationAgentIdSchema,
        message: Type.String({ minLength: 1, maxLength: 50_000 }),
        dueAt: Type.Integer({ minimum: 0 }),
    },
    { additionalProperties: false },
);

/** Structural Agent Base/host broker capability used by Collaboration. */
export const collaborationBrokerSchema = Type.Object(
    {
        create: Type.Function(
            [collaborationContextSchema, agentConfigSchema, collaborationBrokerCreateOptionsSchema],
            Type.Promise(collaborationBrokerAgentResultSchema),
        ),
        config: Type.Function(
            [collaborationContextSchema, collaborationAgentIdSchema],
            Type.Promise(Type.Union([agentConfigSchema, Type.Undefined()])),
        ),
        send: Type.Function(
            [
                collaborationContextSchema,
                collaborationAgentIdSchema,
                collaborationBrokerMessageSchema,
                collaborationBrokerSendOptionsSchema,
            ],
            asyncVoidResultSchema,
        ),
        wait: Type.Function(
            [
                collaborationContextSchema,
                collaborationAgentIdSchema,
                collaborationObligationIdSchema,
            ],
            Type.Promise(collaborationObligationSchema),
        ),
        schedule: Type.Function(
            [
                collaborationContextSchema,
                collaborationAgentIdSchema,
                collaborationBrokerScheduleRequestSchema,
            ],
            Type.Promise(collaborationScheduleSchema),
        ),
        getSchedule: Type.Function(
            [collaborationContextSchema, collaborationAgentIdSchema, collaborationScheduleIdSchema],
            Type.Promise(Type.Union([collaborationScheduleSchema, Type.Undefined()])),
        ),
    },
    { additionalProperties: false },
);

/** The authoritative host roster. It is separate from message/receipt persistence. */
export const collaborationRosterSchema = Type.Object(
    {
        readAgent: Type.Function(
            [collaborationContextSchema, collaborationAgentIdSchema],
            Type.Promise(Type.Union([collaborationAgentSchema, Type.Undefined()])),
        ),
        writeAgent: Type.Function(
            [collaborationContextSchema, collaborationAgentSchema],
            asyncVoidResultSchema,
        ),
        listAgents: Type.Function(
            [
                collaborationContextSchema,
                collaborationAgentIdSchema,
                collaborationAgentPageQuerySchema,
            ],
            Type.Promise(collaborationAgentPageSchema),
        ),
    },
    { additionalProperties: false },
);

export const collaborationMutationKindSchema = Type.Union([
    Type.Literal("create"),
    Type.Literal("send"),
    Type.Literal("reply"),
    Type.Literal("wait"),
    Type.Literal("schedule"),
    Type.Literal("status"),
]);

export const collaborationMutationResultSchema = Type.Union([
    collaborationAgentSchema,
    collaborationSendResultSchema,
    collaborationObligationSchema,
    collaborationScheduleSchema,
]);

/**
 * A closed mutation envelope. The feature snapshots this value before returning from the
 * transaction callback and rejects a host adapter that substitutes or mutates it afterwards.
 */
export const collaborationTransactionChangeSchema = Type.Object(
    {
        kind: collaborationMutationKindSchema,
        operationId: collaborationOperationIdSchema,
        actingAgentId: collaborationAgentIdSchema,
        result: collaborationMutationResultSchema,
        changed: Type.Boolean(),
        events: Type.Array(collaborationEventSchema, { maxItems: 8 }),
    },
    { additionalProperties: false },
);

/** Durable replay receipt. The host owns its retention and persistence. */
export const collaborationMutationReceiptSchema = Type.Object(
    {
        kind: collaborationMutationKindSchema,
        operationId: collaborationOperationIdSchema,
        actingAgentId: collaborationAgentIdSchema,
        fingerprint: collaborationFingerprintSchema,
        result: collaborationMutationResultSchema,
    },
    { additionalProperties: false },
);

/**
 * Host-owned collaboration persistence. `transaction` is the serialization boundary for every
 * mutation. `afterCommit` registers against the host's outermost transaction.
 */
export const collaborationStoreSchema = Type.Object(
    {
        transaction: Type.Function(
            [
                collaborationContextSchema,
                collaborationAgentIdSchema,
                Type.Function(
                    [collaborationContextSchema],
                    Type.Promise(collaborationTransactionChangeSchema),
                ),
            ],
            Type.Promise(collaborationTransactionChangeSchema),
        ),
        afterCommit: Type.Function(
            [collaborationContextSchema, postCommitCallbackSchema],
            Type.Void(),
        ),
        readMessage: Type.Function(
            [collaborationContextSchema, collaborationMessageIdSchema],
            Type.Promise(Type.Union([collaborationMessageSchema, Type.Undefined()])),
        ),
        writeMessage: Type.Function(
            [collaborationContextSchema, collaborationMessageSchema],
            asyncVoidResultSchema,
        ),
        readObligation: Type.Function(
            [collaborationContextSchema, collaborationObligationIdSchema],
            Type.Promise(Type.Union([collaborationObligationSchema, Type.Undefined()])),
        ),
        writeObligation: Type.Function(
            [collaborationContextSchema, collaborationObligationSchema],
            asyncVoidResultSchema,
        ),
        listObligations: Type.Function(
            [
                collaborationContextSchema,
                collaborationAgentIdSchema,
                collaborationObligationPageQuerySchema,
            ],
            Type.Promise(collaborationObligationPageSchema),
        ),
        readReceipt: Type.Function(
            [
                collaborationContextSchema,
                collaborationAgentIdSchema,
                collaborationOperationIdSchema,
            ],
            Type.Promise(Type.Union([collaborationMutationReceiptSchema, Type.Undefined()])),
        ),
        writeReceipt: Type.Function(
            [collaborationContextSchema, collaborationMutationReceiptSchema],
            asyncVoidResultSchema,
        ),
    },
    { additionalProperties: false },
);

export type CollaborationAuthorization = Static<typeof collaborationAuthorizationSchema>;
export type CollaborationBroker = Static<typeof collaborationBrokerSchema>;
export type CollaborationRoster = Static<typeof collaborationRosterSchema>;
export type CollaborationMutationKind = Static<typeof collaborationMutationKindSchema>;
export type CollaborationMutationResult = Static<typeof collaborationMutationResultSchema>;
export type CollaborationTransactionChange = Static<typeof collaborationTransactionChangeSchema>;
export type CollaborationMutationReceipt = Static<typeof collaborationMutationReceiptSchema>;
export type CollaborationStore = Static<typeof collaborationStoreSchema>;

export function assertCollaborationAgentPage(
    value: unknown,
): asserts value is CollaborationAgentPage {
    if (!Value.Check(collaborationAgentPageSchema, value)) {
        throw new Error("Collaboration roster returned an invalid agent page.");
    }
}

export function assertCollaborationObligationPage(
    value: unknown,
): asserts value is CollaborationObligationPage {
    if (!Value.Check(collaborationObligationPageSchema, value)) {
        throw new Error("Collaboration store returned an invalid obligation page.");
    }
}

export function assertCollaborationTransactionChange(
    value: unknown,
): asserts value is CollaborationTransactionChange {
    if (!Value.Check(collaborationTransactionChangeSchema, value)) {
        throw new Error("Collaboration store transaction returned an invalid change.");
    }
}

export function assertCollaborationMutationReceipt(
    value: unknown,
): asserts value is CollaborationMutationReceipt {
    if (!Value.Check(collaborationMutationReceiptSchema, value)) {
        throw new Error("Collaboration store returned an invalid mutation receipt.");
    }
}

export function assertCollaborationVoidResult(value: unknown, operation: string): void {
    if (value !== undefined) {
        throw new Error(`Collaboration ${operation} must return undefined.`);
    }
}

export function assertCollaborationBrokerAgentResult(
    value: unknown,
): asserts value is Static<typeof collaborationBrokerAgentResultSchema> {
    if (!Value.Check(collaborationBrokerAgentResultSchema, value)) {
        throw new Error("Collaboration broker returned an invalid agent result.");
    }
}

export function assertCollaborationSchedule(
    value: unknown,
): asserts value is Static<typeof collaborationScheduleSchema> {
    if (!Value.Check(collaborationScheduleSchema, value)) {
        throw new Error("Collaboration broker returned an invalid schedule.");
    }
}

export function assertCollaborationContext(value: unknown): asserts value is Context {
    if (!Value.Check(collaborationContextSchema, value)) {
        throw new Error("Collaboration context is invalid.");
    }
}
