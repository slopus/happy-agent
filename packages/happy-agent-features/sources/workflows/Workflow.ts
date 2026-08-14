import { Type, type Static } from "@sinclair/typebox";

/*
 * Run identities are shown verbatim to the model. Keep their individual bounds small enough
 * that the minimum model-output budget can still contain one complete `id + workflow` row and
 * its pagination marker. The host may choose a larger output budget, but no caller should have
 * to trade away the identity needed to use the follow-up status/log tools.
 */
export const MAX_WORKFLOW_ID_LENGTH = 96;
export const MAX_WORKFLOW_AGENT_ID_LENGTH = 256;
export const MAX_WORKFLOW_NAME_LENGTH = 96;
export const MAX_WORKFLOW_INPUT_LENGTH = 20_000;
export const MAX_WORKFLOW_ERROR_LENGTH = 4_000;
export const MAX_WORKFLOW_PAGE_SIZE = 100;
export const MAX_WORKFLOW_LOG_LINES = 500;
export const MAX_WORKFLOW_LOG_LINE_LENGTH = 4_000;
export const MAX_WORKFLOW_OUTPUT_CHARACTERS = 20_000;
export const MAX_WORKFLOW_OPERATION_FINGERPRINT_LENGTH = 64_000;

export const workflowIdSchema = Type.String({
    minLength: 1,
    maxLength: MAX_WORKFLOW_ID_LENGTH,
    pattern: "^[^\\u0000\\r\\n]+$",
});

/** The stable owner identity every workflow read and mutation is scoped to. */
export const workflowAgentIdSchema = Type.String({
    minLength: 1,
    maxLength: MAX_WORKFLOW_AGENT_ID_LENGTH,
    pattern: "^[^\\u0000\\r\\n]+$",
});

export const workflowNameSchema = Type.String({
    minLength: 1,
    maxLength: MAX_WORKFLOW_NAME_LENGTH,
    pattern: "^[^\\u0000\\r\\n]+$",
});

export const workflowInputSchema = Type.String({
    maxLength: MAX_WORKFLOW_INPUT_LENGTH,
});

export const workflowStatusSchema = Type.Union([
    Type.Literal("queued"),
    Type.Literal("running"),
    Type.Literal("completed"),
    Type.Literal("failed"),
    Type.Literal("cancelled"),
    Type.Literal("unavailable"),
]);

export const workflowTimestampSchema = Type.Integer({
    minimum: 0,
    maximum: Number.MAX_SAFE_INTEGER,
});

export const workflowRunSchema = Type.Object(
    {
        id: workflowIdSchema,
        agentId: workflowAgentIdSchema,
        workflow: workflowNameSchema,
        status: workflowStatusSchema,
        input: Type.Optional(workflowInputSchema),
        output: Type.Optional(Type.String({ maxLength: MAX_WORKFLOW_OUTPUT_CHARACTERS })),
        error: Type.Optional(Type.String({ maxLength: MAX_WORKFLOW_ERROR_LENGTH })),
        createdAt: workflowTimestampSchema,
        updatedAt: workflowTimestampSchema,
    },
    { additionalProperties: false },
);

export const workflowLaunchInputSchema = Type.Object(
    {
        workflow: workflowNameSchema,
        input: Type.Optional(workflowInputSchema),
        /**
         * Host callers may supply an idempotency identity. The common tool deliberately omits it;
         * the feature allocates one in call-scoped AgentKV for durable replay.
         */
        operationId: Type.Optional(workflowIdSchema),
    },
    { additionalProperties: false },
);

export const workflowLaunchToolInputSchema = Type.Object(
    {
        workflow: workflowNameSchema,
        input: Type.Optional(workflowInputSchema),
    },
    { additionalProperties: false },
);

export const workflowOperationFingerprintSchema = Type.String({
    minLength: 1,
    maxLength: MAX_WORKFLOW_OPERATION_FINGERPRINT_LENGTH,
});

/** Durable call-scoped receipt tying an operation identity to its exact request. */
export const workflowOperationReceiptSchema = Type.Object(
    {
        operationId: workflowIdSchema,
        fingerprint: workflowOperationFingerprintSchema,
    },
    { additionalProperties: false },
);

export const workflowMutationInputSchema = Type.Object(
    {
        id: workflowIdSchema,
        operationId: Type.Optional(workflowIdSchema),
    },
    { additionalProperties: false },
);

export const workflowMutationToolInputSchema = Type.Object(
    {
        id: workflowIdSchema,
    },
    { additionalProperties: false },
);

export const workflowPageQuerySchema = Type.Object(
    {
        cursor: Type.Optional(Type.Integer({ minimum: 0, maximum: 100_000 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_WORKFLOW_PAGE_SIZE })),
        includeTerminal: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
);

export const workflowPageSchema = Type.Object(
    {
        agentId: workflowAgentIdSchema,
        runs: Type.Array(workflowRunSchema, { maxItems: MAX_WORKFLOW_PAGE_SIZE }),
        nextCursor: Type.Optional(Type.Integer({ minimum: 0, maximum: 100_000 })),
    },
    { additionalProperties: false },
);

export const workflowLogQuerySchema = Type.Object(
    {
        id: workflowIdSchema,
        cursor: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_WORKFLOW_LOG_LINES })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_WORKFLOW_LOG_LINES })),
    },
    { additionalProperties: false },
);

export const workflowLogPageSchema = Type.Object(
    {
        agentId: workflowAgentIdSchema,
        id: workflowIdSchema,
        lines: Type.Array(Type.String({ maxLength: MAX_WORKFLOW_LOG_LINE_LENGTH }), {
            maxItems: MAX_WORKFLOW_LOG_LINES,
        }),
        nextCursor: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_WORKFLOW_LOG_LINES })),
    },
    { additionalProperties: false },
);

export const workflowMutationResultSchema = Type.Object(
    {
        agentId: workflowAgentIdSchema,
        operationId: workflowIdSchema,
        run: workflowRunSchema,
        changed: Type.Boolean(),
    },
    { additionalProperties: false },
);

export type WorkflowId = Static<typeof workflowIdSchema>;
export type WorkflowAgentId = Static<typeof workflowAgentIdSchema>;
export type WorkflowName = Static<typeof workflowNameSchema>;
export type WorkflowInput = Static<typeof workflowInputSchema>;
export type WorkflowStatus = Static<typeof workflowStatusSchema>;
export type WorkflowRun = Static<typeof workflowRunSchema>;
export type WorkflowLaunchInput = Static<typeof workflowLaunchInputSchema>;
export type WorkflowLaunchToolInput = Static<typeof workflowLaunchToolInputSchema>;
export type WorkflowOperationFingerprint = Static<typeof workflowOperationFingerprintSchema>;
export type WorkflowOperationReceipt = Static<typeof workflowOperationReceiptSchema>;
export type WorkflowMutationInput = Static<typeof workflowMutationInputSchema>;
export type WorkflowMutationToolInput = Static<typeof workflowMutationToolInputSchema>;
export type WorkflowMutationResult = Static<typeof workflowMutationResultSchema>;
export type WorkflowPageQuery = Static<typeof workflowPageQuerySchema>;
export type WorkflowPage = Static<typeof workflowPageSchema>;
export type WorkflowLogQuery = Static<typeof workflowLogQuerySchema>;
export type WorkflowLogPage = Static<typeof workflowLogPageSchema>;
