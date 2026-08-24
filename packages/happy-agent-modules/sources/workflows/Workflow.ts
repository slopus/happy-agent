import { Type, type Static, type TSchema } from "@sinclair/typebox";

/*
 * Run identities are shown verbatim to the model. Keep their individual bounds small enough
 * that the minimum model-output budget can still contain one complete `id + workflow` row and
 * its pagination marker. The host may choose a larger output budget, but no caller should have
 * to trade away the identity needed to use the follow-up status/log tools.
 */
export const MAX_WORKFLOW_ID_LENGTH = 96;
export const MAX_WORKFLOW_AGENT_ID_LENGTH = 256;
export const MAX_WORKFLOW_NAME_LENGTH = 96;
export const MAX_WORKFLOW_SCRIPT_LENGTH = 524_288;
export const MAX_WORKFLOW_SCRIPT_PATH_LENGTH = 4_096;
export const MAX_WORKFLOW_DESCRIPTION_LENGTH = 1_000;
export const MAX_WORKFLOW_ARGS_DEPTH = 8;
export const MAX_WORKFLOW_ARGS_ITEMS = 64;
export const MAX_WORKFLOW_ARGS_PROPERTIES = 64;
export const MAX_WORKFLOW_ARGS_KEY_LENGTH = 128;
export const MAX_WORKFLOW_ARGS_STRING_LENGTH = 2_000;
export const MAX_WORKFLOW_ARGS_BYTES = 65_536;
export const MAX_WORKFLOW_AGENT_COUNT = 1_000;
export const MAX_WORKFLOW_ERROR_LENGTH = 4_000;
export const MAX_WORKFLOW_PAGE_SIZE = 100;
export const MAX_WORKFLOW_LOG_LINES = 500;
export const MAX_WORKFLOW_LOG_LINE_LENGTH = 4_000;
export const MAX_WORKFLOW_OUTPUT_CHARACTERS = 20_000;
export const MAX_WORKFLOW_CURSOR = Number.MAX_SAFE_INTEGER;

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

/** A sandboxed Python workflow source, run by this module rather than by anything outside it. */
export const workflowScriptSchema = Type.String({
    maxLength: MAX_WORKFLOW_SCRIPT_LENGTH,
});

/** A path to a saved Python workflow source, read through the agent's own filesystem boundary. */
export const workflowScriptPathSchema = Type.String({
    minLength: 1,
    maxLength: MAX_WORKFLOW_SCRIPT_PATH_LENGTH,
    pattern: "^[^\\u0000\\r\\n]+$",
});

export const workflowDescriptionSchema = Type.String({
    maxLength: MAX_WORKFLOW_DESCRIPTION_LENGTH,
});

const workflowArgsLeafSchema = Type.Union([
    Type.Null(),
    Type.Boolean(),
    Type.Number({
        minimum: -Number.MAX_SAFE_INTEGER,
        maximum: Number.MAX_SAFE_INTEGER,
    }),
    Type.String({ maxLength: MAX_WORKFLOW_ARGS_STRING_LENGTH }),
]);

/*
 * Keep the recursive argument contract finite. Per-level item and property limits do not bound
 * an arbitrarily deep JSON tree, so the schema itself stops at a fixed depth.
 */
function workflowArgsAtDepth(depth: number): TSchema {
    if (depth <= 0) return workflowArgsLeafSchema;
    const child = workflowArgsAtDepth(depth - 1);
    return Type.Union([
        workflowArgsLeafSchema,
        Type.Array(child, { maxItems: MAX_WORKFLOW_ARGS_ITEMS }),
        Type.Record(Type.String({ maxLength: MAX_WORKFLOW_ARGS_KEY_LENGTH }), child, {
            maxProperties: MAX_WORKFLOW_ARGS_PROPERTIES,
        }),
    ]);
}

/** JSON input exposed to a workflow script as its `args` global. */
export const workflowArgsSchema = workflowArgsAtDepth(MAX_WORKFLOW_ARGS_DEPTH);

export const workflowAgentCountSchema = Type.Integer({
    minimum: 0,
    maximum: MAX_WORKFLOW_AGENT_COUNT,
});

/** One accumulated progress line returned with a workflow status or wait result. */
export const workflowAccumulatedLogSchema = Type.String({
    maxLength: MAX_WORKFLOW_LOG_LINE_LENGTH,
});

/**
 * Where a run is in its life.
 *
 * A running workflow recovers automatically after a process restart. `paused` is reserved for a
 * run whose executable launch cannot be reconstructed automatically; `resume_workflow` continues
 * it when that launch is available.
 */
export const workflowStatusSchema = Type.Union([
    Type.Literal("running"),
    Type.Literal("paused"),
    Type.Literal("completed"),
    Type.Literal("failed"),
    Type.Literal("cancelled"),
]);

export const workflowTimestampSchema = Type.Integer({
    minimum: 0,
    maximum: Number.MAX_SAFE_INTEGER,
});

const workflowOutputSchema = Type.String({ maxLength: MAX_WORKFLOW_OUTPUT_CHARACTERS });
const workflowErrorSchema = Type.String({ maxLength: MAX_WORKFLOW_ERROR_LENGTH });

const workflowRunFields = {
    id: workflowIdSchema,
    agentId: workflowAgentIdSchema,
    workflow: workflowNameSchema,
    description: workflowDescriptionSchema,
    /** How the script names what it is doing right now, from its last `phase(...)` call. */
    phase: Type.Optional(workflowNameSchema),
    /** How many agents the run has started, which is what makes a workflow expensive. */
    agentCount: workflowAgentCountSchema,
    /** The tail of the run's progress notes, bounded so a status read stays a status read. */
    logs: Type.Array(workflowAccumulatedLogSchema, { maxItems: MAX_WORKFLOW_LOG_LINES }),
    /** Whether older progress notes exist that `workflow_logs` can page through. */
    logsTruncated: Type.Boolean(),
    createdAt: workflowTimestampSchema,
    updatedAt: workflowTimestampSchema,
    startedAt: workflowTimestampSchema,
};

export const workflowRunningRunSchema = Type.Object(
    {
        ...workflowRunFields,
        status: Type.Literal("running"),
    },
    { additionalProperties: false },
);

export const workflowPausedRunSchema = Type.Object(
    {
        ...workflowRunFields,
        status: Type.Literal("paused"),
        pausedAt: workflowTimestampSchema,
    },
    { additionalProperties: false },
);

export const workflowCompletedRunSchema = Type.Object(
    {
        ...workflowRunFields,
        status: Type.Literal("completed"),
        finishedAt: workflowTimestampSchema,
        output: workflowOutputSchema,
    },
    { additionalProperties: false },
);

export const workflowFailedRunSchema = Type.Object(
    {
        ...workflowRunFields,
        status: Type.Literal("failed"),
        finishedAt: workflowTimestampSchema,
        error: workflowErrorSchema,
    },
    { additionalProperties: false },
);

export const workflowCancelledRunSchema = Type.Object(
    {
        ...workflowRunFields,
        status: Type.Literal("cancelled"),
        finishedAt: workflowTimestampSchema,
    },
    { additionalProperties: false },
);

/** Exact status-specific persisted workflow state. */
export const workflowRunSchema = Type.Union([
    workflowRunningRunSchema,
    workflowPausedRunSchema,
    workflowCompletedRunSchema,
    workflowFailedRunSchema,
    workflowCancelledRunSchema,
]);

const workflowLaunchFields = {
    args: Type.Optional(workflowArgsSchema),
    description: Type.Optional(workflowDescriptionSchema),
    name: Type.Optional(workflowNameSchema),
    resumeFromRunId: Type.Optional(workflowIdSchema),
};

/** Start a workflow from an inline script, or from one saved on disk. Exactly one of the two. */
export const workflowLaunchInputSchema = Type.Union([
    Type.Object(
        { ...workflowLaunchFields, script: workflowScriptSchema },
        {
            additionalProperties: false,
        },
    ),
    Type.Object(
        { ...workflowLaunchFields, scriptPath: workflowScriptPathSchema },
        {
            additionalProperties: false,
        },
    ),
]);

/** One launch after defaulting: the name, the description, and the source to actually run. */
export const workflowLaunchRequestSchema = Type.Object(
    {
        id: workflowIdSchema,
        workflow: workflowNameSchema,
        description: workflowDescriptionSchema,
        script: workflowScriptSchema,
        args: Type.Optional(workflowArgsSchema),
        resumeFromRunId: Type.Optional(workflowIdSchema),
    },
    { additionalProperties: false },
);

export const workflowCursorSchema = Type.Integer({
    minimum: 0,
    maximum: MAX_WORKFLOW_CURSOR,
});

export const workflowPageFromSchema = Type.Union([Type.Literal("start"), Type.Literal("end")]);

const workflowPageQueryFields = {
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_WORKFLOW_PAGE_SIZE })),
    includeTerminal: Type.Optional(Type.Boolean()),
};

export const workflowPageQuerySchema = Type.Union([
    Type.Object(
        {
            ...workflowPageQueryFields,
            cursor: Type.Optional(workflowCursorSchema),
            from: Type.Optional(Type.Literal("start")),
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...workflowPageQueryFields,
            from: Type.Literal("end"),
        },
        { additionalProperties: false },
    ),
]);

export const workflowPageSchema = Type.Object(
    {
        agentId: workflowAgentIdSchema,
        cursor: workflowCursorSchema,
        runs: Type.Array(workflowRunSchema, { maxItems: MAX_WORKFLOW_PAGE_SIZE }),
        totalRuns: workflowCursorSchema,
        nextCursor: Type.Optional(workflowCursorSchema),
        previousCursor: Type.Optional(workflowCursorSchema),
    },
    { additionalProperties: false },
);

const workflowLogQueryFields = {
    id: workflowIdSchema,
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_WORKFLOW_LOG_LINES })),
};

export const workflowLogQuerySchema = Type.Union([
    Type.Object(
        {
            ...workflowLogQueryFields,
            cursor: Type.Optional(workflowCursorSchema),
            from: Type.Optional(Type.Literal("start")),
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...workflowLogQueryFields,
            from: Type.Literal("end"),
        },
        { additionalProperties: false },
    ),
]);

export const workflowLogLineSchema = Type.Object(
    {
        position: Type.Integer({ minimum: 0, maximum: MAX_WORKFLOW_CURSOR }),
        text: Type.String({ maxLength: MAX_WORKFLOW_LOG_LINE_LENGTH }),
    },
    { additionalProperties: false },
);

export const workflowLogPageSchema = Type.Object(
    {
        agentId: workflowAgentIdSchema,
        id: workflowIdSchema,
        cursor: workflowCursorSchema,
        lines: Type.Array(workflowLogLineSchema, { maxItems: MAX_WORKFLOW_LOG_LINES }),
        totalLines: workflowCursorSchema,
        nextCursor: Type.Optional(workflowCursorSchema),
        previousCursor: Type.Optional(workflowCursorSchema),
    },
    { additionalProperties: false },
);

export type WorkflowId = Static<typeof workflowIdSchema>;
export type WorkflowAgentId = Static<typeof workflowAgentIdSchema>;
export type WorkflowName = Static<typeof workflowNameSchema>;
export type WorkflowScript = Static<typeof workflowScriptSchema>;
export type WorkflowScriptPath = Static<typeof workflowScriptPathSchema>;
export type WorkflowDescription = Static<typeof workflowDescriptionSchema>;
export type WorkflowArgs = Static<typeof workflowArgsSchema>;
export type WorkflowStatus = Static<typeof workflowStatusSchema>;
export type WorkflowAgentCount = Static<typeof workflowAgentCountSchema>;
export type WorkflowAccumulatedLog = Static<typeof workflowAccumulatedLogSchema>;
export type WorkflowRunningRun = Static<typeof workflowRunningRunSchema>;
export type WorkflowPausedRun = Static<typeof workflowPausedRunSchema>;
export type WorkflowCompletedRun = Static<typeof workflowCompletedRunSchema>;
export type WorkflowFailedRun = Static<typeof workflowFailedRunSchema>;
export type WorkflowCancelledRun = Static<typeof workflowCancelledRunSchema>;
export type WorkflowRun = Static<typeof workflowRunSchema>;
export type WorkflowLaunchInput = Static<typeof workflowLaunchInputSchema>;
export type WorkflowLaunchRequest = Static<typeof workflowLaunchRequestSchema>;
export type WorkflowCursor = Static<typeof workflowCursorSchema>;
export type WorkflowPageFrom = Static<typeof workflowPageFromSchema>;
export type WorkflowPageQuery = Static<typeof workflowPageQuerySchema>;
export type WorkflowPage = Static<typeof workflowPageSchema>;
export type WorkflowLogQuery = Static<typeof workflowLogQuerySchema>;
export type WorkflowLogLine = Static<typeof workflowLogLineSchema>;
export type WorkflowLogPage = Static<typeof workflowLogPageSchema>;

/** Whether a run has stopped for good, so nothing more will happen to it. */
export function isWorkflowTerminalStatus(status: WorkflowStatus): boolean {
    return status === "completed" || status === "failed" || status === "cancelled";
}

/** How a run reads to a person: a sentence rather than an enum value. */
export function describeWorkflowStatus(status: WorkflowStatus): string {
    switch (status) {
        case "running":
            return "running";
        case "paused":
            return "paused, and can be resumed";
        case "completed":
            return "completed";
        case "failed":
            return "failed";
        case "cancelled":
            return "cancelled";
    }
}
