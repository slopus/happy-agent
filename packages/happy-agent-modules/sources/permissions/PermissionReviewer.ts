import type { AnyAgentTool } from "@slopus/happy-agent-base";
import { Type, type Static, type TSchema } from "@sinclair/typebox";
import type { Context } from "@steve.kite/stdlib";

const MAX_PERMISSION_AGENT_ID = 128;
const MAX_PERMISSION_CALL_ID = 256;
const MAX_PERMISSION_ACTION = 16_384;
const MAX_PERMISSION_REASON = 4_096;
const MAX_PERMISSION_ARGUMENT_STRING = 8_192;
const MAX_PERMISSION_ARGUMENT_ITEMS = 256;
const MAX_PERMISSION_ARGUMENT_DEPTH = 8;
const MAX_PERMISSION_ARGUMENT_BYTES = 65_536;

const permissionContextSchema = Type.Unsafe<Context>(
    Type.Object({}, { additionalProperties: false }),
);
const permissionAgentIdSchema = Type.String({
    minLength: 1,
    maxLength: MAX_PERMISSION_AGENT_ID,
});
const permissionCallIdSchema = Type.String({
    minLength: 1,
    maxLength: MAX_PERMISSION_CALL_ID,
});
const permissionToolSchema = Type.Unsafe<AnyAgentTool>(
    Type.Object(
        {
            name: Type.String({ minLength: 1, maxLength: 256 }),
            namespace: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        },
        { additionalProperties: true },
    ),
);
const permissionAbortSignalSchema = Type.Unsafe<AbortSignal>(
    Type.Object(
        {
            aborted: Type.Boolean(),
            addEventListener: Type.Function([], Type.Any()),
        },
        { additionalProperties: true },
    ),
);

function permissionReviewArgumentSchema(depth: number): TSchema {
    const scalar = Type.Union([
        Type.Undefined(),
        Type.Null(),
        Type.Boolean(),
        Type.Number(),
        Type.String({ maxLength: MAX_PERMISSION_ARGUMENT_STRING }),
    ]);
    if (depth === 0) return scalar;
    const child = permissionReviewArgumentSchema(depth - 1);
    return Type.Union([
        scalar,
        Type.Array(child, { maxItems: MAX_PERMISSION_ARGUMENT_ITEMS }),
        Type.Record(Type.String({ maxLength: 256 }), child, {
            maxProperties: MAX_PERMISSION_ARGUMENT_ITEMS,
        }),
    ]);
}

export const permissionReviewArgumentsSchema = permissionReviewArgumentSchema(
    MAX_PERMISSION_ARGUMENT_DEPTH,
);

export const permissionRiskSchema = Type.Union([
    Type.Literal("low"),
    Type.Literal("medium"),
    Type.Literal("high"),
    Type.Literal("critical"),
]);

export const permissionUserAuthorizationSchema = Type.Union([
    Type.Literal("unknown"),
    Type.Literal("low"),
    Type.Literal("medium"),
    Type.Literal("high"),
]);

const MAX_PERMISSION_REVIEW_ENTRIES = 60;
const MAX_PERMISSION_REVIEW_MODEL_ID = 256;

/**
 * The exact marker a truncated transcript entry ends with, byte-for-byte with Happy Agent v1. Parity is the
 * priority here, so the marker text is fixed and the schema is what bends to fit it.
 */
export const REVIEW_TRANSCRIPT_TRUNCATION_MARKER = "\n[...truncated...]";

/**
 * How much of one entry's text survives truncation, before the marker is appended. This is the v1
 * budget the transcript builder slices to.
 */
export const MAX_PERMISSION_REVIEW_ENTRY_TEXT_CHARACTERS = 2_000;

/**
 * The largest a stored entry can be, and the bound the schema enforces. A truncated entry is the
 * kept text plus the marker, so the schema has to allow both: bounding it at the text budget alone
 * would reject every truncated entry, and a long, well-reasoned review would fail its own
 * validation and be turned into a refusal — the action would become unproven purely because the
 * reviewer wrote too much.
 */
const MAX_PERMISSION_REVIEW_ENTRY_CHARACTERS =
    MAX_PERMISSION_REVIEW_ENTRY_TEXT_CHARACTERS + REVIEW_TRANSCRIPT_TRUNCATION_MARKER.length;

const permissionReviewEntryText = Type.String({
    maxLength: MAX_PERMISSION_REVIEW_ENTRY_CHARACTERS,
});

/**
 * One line of the reviewer's own work: what it thought, said, called, and got back. A review that
 * ran no inference has no entries, and a long review keeps only its most recent ones.
 */
export const permissionReviewTranscriptEntrySchema = Type.Union([
    Type.Object(
        { type: Type.Literal("thinking"), text: permissionReviewEntryText },
        { additionalProperties: false },
    ),
    Type.Object(
        { type: Type.Literal("text"), text: permissionReviewEntryText },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            type: Type.Literal("tool_call"),
            name: Type.String({ minLength: 1, maxLength: 256 }),
            arguments: permissionReviewEntryText,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            type: Type.Literal("tool_result"),
            name: Type.String({ minLength: 1, maxLength: 256 }),
            isError: Type.Boolean(),
            text: permissionReviewEntryText,
        },
        { additionalProperties: false },
    ),
]);

/** Exact provider token usage a review spent, attributed to the model that actually ran it. */
export const permissionReviewUsageSchema = Type.Object(
    {
        input: Type.Integer({ minimum: 0 }),
        output: Type.Integer({ minimum: 0 }),
        cacheRead: Type.Integer({ minimum: 0 }),
        cacheWrite: Type.Integer({ minimum: 0 }),
        totalTokens: Type.Integer({ minimum: 0 }),
        reasoning: Type.Optional(Type.Integer({ minimum: 0 })),
    },
    { additionalProperties: false },
);

/**
 * What one review did to reach its verdict, and what that cost. The reviewer spends real tokens on
 * the user's account, so its usage is attributed to the model that ran the review rather than
 * folded into the agent it reviewed. Permissions never reads this to decide anything; it carries
 * it through to the events so a decision can be explained after the fact.
 */
export const permissionReviewTranscriptSchema = Type.Object(
    {
        entries: Type.Array(permissionReviewTranscriptEntrySchema, {
            maxItems: MAX_PERMISSION_REVIEW_ENTRIES,
        }),
        modelId: Type.String({ minLength: 1, maxLength: MAX_PERMISSION_REVIEW_MODEL_ID }),
        providerId: Type.String({ minLength: 1, maxLength: MAX_PERMISSION_REVIEW_MODEL_ID }),
        usage: permissionReviewUsageSchema,
    },
    { additionalProperties: false },
);

export type PermissionReviewTranscriptEntry = Static<typeof permissionReviewTranscriptEntrySchema>;
export type PermissionReviewUsage = Static<typeof permissionReviewUsageSchema>;
export type PermissionReviewTranscript = Static<typeof permissionReviewTranscriptSchema>;

export const permissionReviewRequestSchema = Type.Object(
    {
        agentId: permissionAgentIdSchema,
        callId: permissionCallIdSchema,
        tool: permissionToolSchema,
        arguments: permissionReviewArgumentsSchema,
        action: Type.String({ minLength: 1, maxLength: MAX_PERMISSION_ACTION }),
        mode: Type.Literal("auto"),
        elevates: Type.Boolean(),
        signal: permissionAbortSignalSchema,
    },
    { additionalProperties: false },
);

const allowedPermissionReviewDecisionSchema = Type.Object(
    {
        outcome: Type.Literal("allowed"),
        reason: Type.Optional(Type.String({ maxLength: MAX_PERMISSION_REASON })),
        risk: permissionRiskSchema,
        userAuthorization: permissionUserAuthorizationSchema,
        // Carried through to the reviewed event so a verdict can be explained; never read to decide.
        transcript: Type.Optional(permissionReviewTranscriptSchema),
        userEvidenceOmitted: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
);

const deniedPermissionReviewDecisionSchema = Type.Object(
    {
        outcome: Type.Literal("denied"),
        reason: Type.String({ minLength: 1, maxLength: MAX_PERMISSION_REASON }),
        risk: Type.Optional(permissionRiskSchema),
        userAuthorization: Type.Optional(permissionUserAuthorizationSchema),
        // Carried through to the denied event so a verdict can be explained; never read to decide.
        transcript: Type.Optional(permissionReviewTranscriptSchema),
        userEvidenceOmitted: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
);

/**
 * The reviewer must return the risk and authorization it relied on. Permissions applies its own
 * policy to an allowed result: critical actions never pass, and high-risk actions require at
 * least medium user authorization.
 */
export const permissionReviewDecisionSchema = Type.Union([
    allowedPermissionReviewDecisionSchema,
    deniedPermissionReviewDecisionSchema,
]);

export type PermissionReviewRequest = Static<typeof permissionReviewRequestSchema>;
export type PermissionReviewDecision = Static<typeof permissionReviewDecisionSchema>;

export const permissionReviewerSchema = Type.Object(
    {
        review: Type.Function(
            [permissionContextSchema, permissionReviewRequestSchema],
            Type.Promise(permissionReviewDecisionSchema),
        ),
    },
    { additionalProperties: true },
);

/**
 * Whoever decides, on the user's behalf, whether one Auto action may go ahead. Review is
 * automatic: it must never become a question put to the person, and it must answer in bounded
 * time.
 */
export type PermissionReviewer = Static<typeof permissionReviewerSchema>;

export {
    MAX_PERMISSION_ACTION,
    MAX_PERMISSION_ARGUMENT_BYTES,
    MAX_PERMISSION_ARGUMENT_DEPTH,
    MAX_PERMISSION_ARGUMENT_ITEMS,
    MAX_PERMISSION_ARGUMENT_STRING,
    MAX_PERMISSION_AGENT_ID,
    MAX_PERMISSION_CALL_ID,
    MAX_PERMISSION_REASON,
};
