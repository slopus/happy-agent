import { Type, type Static } from "@sinclair/typebox";

import {
    COLLABORATION_MAX_TIMESTAMP,
    collaborationAgentIdSchema,
    collaborationMetadataSchema,
    collaborationOperationIdSchema,
} from "./CollaborationAgent.js";

export const collaborationMessageIdSchema = Type.String({
    minLength: 2,
    maxLength: 128,
    pattern: "^[a-z][a-z0-9-]*$",
});

export const collaborationObligationIdSchema = Type.String({
    minLength: 2,
    maxLength: 128,
    pattern: "^[a-z][a-z0-9-]*$",
});

export const collaborationScheduleIdSchema = Type.String({
    minLength: 2,
    maxLength: 128,
    pattern: "^[a-z][a-z0-9-]*$",
});

export const collaborationMessageTextSchema = Type.String({
    minLength: 1,
    maxLength: 50_000,
});

/** The durable message projected by the host store. */
export const collaborationMessageSchema = Type.Object(
    {
        id: collaborationMessageIdSchema,
        fromAgentId: collaborationAgentIdSchema,
        toAgentId: collaborationAgentIdSchema,
        text: collaborationMessageTextSchema,
        replyTo: Type.Optional(collaborationObligationIdSchema),
        obligationId: Type.Optional(collaborationObligationIdSchema),
        metadata: Type.Optional(collaborationMetadataSchema),
        createdAt: Type.Integer({ minimum: 0, maximum: COLLABORATION_MAX_TIMESTAMP }),
    },
    { additionalProperties: false },
);

export const collaborationObligationStatusSchema = Type.Union([
    Type.Literal("pending"),
    Type.Literal("answered"),
    Type.Literal("cancelled"),
]);

/** A directed answer obligation. The requester is the only agent allowed to wait. */
const collaborationObligationCommonProperties = {
    id: collaborationObligationIdSchema,
    requesterAgentId: collaborationAgentIdSchema,
    responderAgentId: collaborationAgentIdSchema,
    messageId: collaborationMessageIdSchema,
    createdAt: Type.Integer({ minimum: 0, maximum: COLLABORATION_MAX_TIMESTAMP }),
    updatedAt: Type.Integer({ minimum: 0, maximum: COLLABORATION_MAX_TIMESTAMP }),
};

export const collaborationObligationSchema = Type.Union([
    Type.Object(
        {
            ...collaborationObligationCommonProperties,
            status: Type.Literal("pending"),
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...collaborationObligationCommonProperties,
            status: Type.Literal("answered"),
            answerMessageId: collaborationMessageIdSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...collaborationObligationCommonProperties,
            status: Type.Literal("cancelled"),
        },
        { additionalProperties: false },
    ),
]);

export const collaborationObligationPageQuerySchema = Type.Object(
    {
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
        cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
        status: Type.Optional(collaborationObligationStatusSchema),
        requesterAgentId: Type.Optional(collaborationAgentIdSchema),
        responderAgentId: Type.Optional(collaborationAgentIdSchema),
    },
    { additionalProperties: false },
);

export const collaborationObligationPageSchema = Type.Object(
    {
        obligations: Type.Array(collaborationObligationSchema, { maxItems: 100 }),
        limit: Type.Integer({ minimum: 1, maximum: 100 }),
        nextCursor: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    },
    { additionalProperties: false },
);

const collaborationSendCommonProperties = {
    operationId: Type.Optional(collaborationOperationIdSchema),
    toAgentId: collaborationAgentIdSchema,
    text: collaborationMessageTextSchema,
    messageId: Type.Optional(collaborationMessageIdSchema),
    metadata: Type.Optional(collaborationMetadataSchema),
};

/**
 * A send either starts a reply obligation or is a plain message. Replies have their own public
 * operation so create/send/reply receipts cannot be confused with one another.
 */
export const collaborationSendInputSchema = Type.Union([
    Type.Object(
        {
            ...collaborationSendCommonProperties,
            expectReply: Type.Literal(true),
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...collaborationSendCommonProperties,
            expectReply: Type.Optional(Type.Literal(false)),
        },
        { additionalProperties: false },
    ),
]);

/** Model input omits feature-owned operation and message identities. */
export const collaborationSendToolInputSchema = Type.Union([
    Type.Object(
        {
            toAgentId: collaborationAgentIdSchema,
            text: collaborationMessageTextSchema,
            metadata: Type.Optional(collaborationMetadataSchema),
            expectReply: Type.Literal(true),
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            toAgentId: collaborationAgentIdSchema,
            text: collaborationMessageTextSchema,
            metadata: Type.Optional(collaborationMetadataSchema),
            expectReply: Type.Optional(Type.Literal(false)),
        },
        { additionalProperties: false },
    ),
]);

export const collaborationReplyInputSchema = Type.Object(
    {
        operationId: Type.Optional(collaborationOperationIdSchema),
        toAgentId: collaborationAgentIdSchema,
        text: collaborationMessageTextSchema,
        messageId: Type.Optional(collaborationMessageIdSchema),
        metadata: Type.Optional(collaborationMetadataSchema),
        replyTo: collaborationObligationIdSchema,
    },
    { additionalProperties: false },
);

/** Model input omits feature-owned operation and message identities. */
export const collaborationReplyToolInputSchema = Type.Omit(collaborationReplyInputSchema, [
    "operationId",
    "messageId",
]);

export const collaborationWaitInputSchema = Type.Object(
    {
        operationId: Type.Optional(collaborationOperationIdSchema),
        obligationId: collaborationObligationIdSchema,
    },
    { additionalProperties: false },
);

/** Model input omits the feature-owned durable operation identity. */
export const collaborationWaitToolInputSchema = Type.Omit(collaborationWaitInputSchema, [
    "operationId",
]);

/** A host-owned durable scheduled delivery. No timer or queue is owned by the feature. */
export const collaborationScheduleSchema = Type.Object(
    {
        id: collaborationScheduleIdSchema,
        ownerAgentId: collaborationAgentIdSchema,
        targetAgentId: collaborationAgentIdSchema,
        message: collaborationMessageTextSchema,
        dueAt: Type.Integer({ minimum: 0, maximum: COLLABORATION_MAX_TIMESTAMP }),
        status: Type.Union([
            Type.Literal("pending"),
            Type.Literal("delivered"),
            Type.Literal("undelivered"),
            Type.Literal("cancelled"),
        ]),
        createdAt: Type.Integer({ minimum: 0, maximum: COLLABORATION_MAX_TIMESTAMP }),
        updatedAt: Type.Integer({ minimum: 0, maximum: COLLABORATION_MAX_TIMESTAMP }),
        deliveredAt: Type.Optional(
            Type.Integer({ minimum: 0, maximum: COLLABORATION_MAX_TIMESTAMP }),
        ),
        failure: Type.Optional(Type.String({ minLength: 1, maxLength: 2_000 })),
    },
    { additionalProperties: false },
);

export const collaborationScheduleInputSchema = Type.Object(
    {
        operationId: Type.Optional(collaborationOperationIdSchema),
        id: Type.Optional(collaborationScheduleIdSchema),
        targetAgentId: collaborationAgentIdSchema,
        message: collaborationMessageTextSchema,
        dueAt: Type.Integer({ minimum: 0, maximum: COLLABORATION_MAX_TIMESTAMP }),
    },
    { additionalProperties: false },
);

/** Model input omits feature-owned schedule and operation identities. */
export const collaborationScheduleToolInputSchema = Type.Omit(collaborationScheduleInputSchema, [
    "operationId",
    "id",
]);

export const collaborationSendResultSchema = Type.Object(
    {
        message: collaborationMessageSchema,
        obligation: Type.Optional(collaborationObligationSchema),
    },
    { additionalProperties: false },
);

export type CollaborationMessageId = Static<typeof collaborationMessageIdSchema>;
export type CollaborationObligationId = Static<typeof collaborationObligationIdSchema>;
export type CollaborationScheduleId = Static<typeof collaborationScheduleIdSchema>;
export type CollaborationMessage = Static<typeof collaborationMessageSchema>;
export type CollaborationObligationStatus = Static<typeof collaborationObligationStatusSchema>;
export type CollaborationObligation = Static<typeof collaborationObligationSchema>;
export type CollaborationObligationPageQuery = Static<
    typeof collaborationObligationPageQuerySchema
>;
export type CollaborationObligationPage = Static<typeof collaborationObligationPageSchema>;
export type CollaborationSendInput = Static<typeof collaborationSendInputSchema>;
export type CollaborationSendToolInput = Static<typeof collaborationSendToolInputSchema>;
export type CollaborationReplyInput = Static<typeof collaborationReplyInputSchema>;
export type CollaborationReplyToolInput = Static<typeof collaborationReplyToolInputSchema>;
export type CollaborationWaitInput = Static<typeof collaborationWaitInputSchema>;
export type CollaborationWaitToolInput = Static<typeof collaborationWaitToolInputSchema>;
export type CollaborationSchedule = Static<typeof collaborationScheduleSchema>;
export type CollaborationScheduleInput = Static<typeof collaborationScheduleInputSchema>;
export type CollaborationScheduleToolInput = Static<typeof collaborationScheduleToolInputSchema>;
export type CollaborationSendResult = Static<typeof collaborationSendResultSchema>;
