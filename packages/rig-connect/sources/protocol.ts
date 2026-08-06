/**
 * The parts of Rig's session protocol this library reads.
 *
 * They are declared here rather than imported so a browser bundle carries no
 * daemon code. `tests/protocolConformance.test.ts` checks these declarations
 * against the daemon's own types at build time, so a drift is a failed
 * type-check rather than a runtime surprise.
 */

import { Type, type Static } from "@sinclair/typebox";

export type EventId = string;
export type MutationId = string;

const sessionShareExact = { additionalProperties: false } as const;
const sessionShareIdentifierSchema = Type.String({ maxLength: 256, minLength: 1 });
const sessionShareTimestampSchema = Type.Integer({
    maximum: Number.MAX_SAFE_INTEGER,
    minimum: 0,
});

export const sessionShareStateSchema = Type.Union([
    Type.Literal("active"),
    Type.Literal("degraded"),
    Type.Literal("stopped"),
]);
export type SessionShareState = Static<typeof sessionShareStateSchema>;

export const sessionShareMemberStateSchema = Type.Union([
    Type.Literal("active"),
    Type.Literal("revoked"),
    Type.Literal("stopped"),
]);
export type SessionShareMemberState = Static<typeof sessionShareMemberStateSchema>;

export const sessionShareGrantSchema = Type.Object(
    {
        grantEpoch: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 1 }),
        murmurPeerId: sessionShareIdentifierSchema,
        shareId: sessionShareIdentifierSchema,
        shareMemberId: sessionShareIdentifierSchema,
    },
    sessionShareExact,
);
export type SessionShareGrant = Static<typeof sessionShareGrantSchema>;

/**
 * What one member may do beyond reading the transcript.
 *
 * Only capabilities Rig enforces appear here. Widening the union later is one
 * line; a literal nothing enforces is a promise the product cannot take back.
 */
export const sessionSharePeerCapabilitySchema = Type.Union([Type.Literal("terminal_view")]);
export type SessionSharePeerCapability = Static<typeof sessionSharePeerCapabilitySchema>;

export const sessionShareMemberSchema = Type.Object(
    {
        /** Capabilities this member holds right now, at their current grant epoch. */
        capabilities: Type.Array(sessionSharePeerCapabilitySchema, { maxItems: 16 }),
        /** The same list written for a person to read, ready to show as-is. */
        capabilitiesDescription: Type.String({ maxLength: 512, minLength: 1 }),
        createdAt: sessionShareTimestampSchema,
        currentGrantEpoch: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 1 }),
        displayName: Type.String({ maxLength: 512, minLength: 1 }),
        murmurPeerId: sessionShareIdentifierSchema,
        shareId: sessionShareIdentifierSchema,
        shareMemberId: sessionShareIdentifierSchema,
        state: sessionShareMemberStateSchema,
        updatedAt: sessionShareTimestampSchema,
    },
    sessionShareExact,
);
export type SessionShareMember = Static<typeof sessionShareMemberSchema>;

/** One capability this project may offer, and why it cannot when it cannot. */
export const sessionShareOfferableCapabilitySchema = Type.Object(
    {
        capability: sessionSharePeerCapabilitySchema,
        /** What it lets the other person do, in one sentence. */
        description: Type.String({ maxLength: 512, minLength: 1 }),
        /**
         * What granting this alone costs that no later action can undo.
         *
         * Shown at grant time, before the owner confirms, not only in a settings
         * page they may never open: anything already seen cannot be recalled, and
         * a credential that crossed a shared terminal has to be rotated.
         */
        grantWarning: Type.String({ maxLength: 1_024, minLength: 1 }),
        label: Type.String({ maxLength: 128, minLength: 1 }),
        offerable: Type.Boolean(),
        /** Present only when `offerable` is false, and always readable English. */
        unavailableReason: Type.Optional(Type.String({ maxLength: 512, minLength: 1 })),
    },
    sessionShareExact,
);
export type SessionShareOfferableCapability = Static<typeof sessionShareOfferableCapabilitySchema>;

export const setSessionShareMemberCapabilitiesRequestSchema = Type.Object(
    {
        /** The complete set this member should hold. Not a delta, on purpose. */
        capabilities: Type.Array(sessionSharePeerCapabilitySchema, {
            maxItems: 16,
            uniqueItems: true,
        }),
        mutationId: sessionShareIdentifierSchema,
    },
    sessionShareExact,
);
export type SetSessionShareMemberCapabilitiesRequest = Static<
    typeof setSessionShareMemberCapabilitiesRequestSchema
>;

export const sessionSharePeerActivityEntrySchema = Type.Object(
    {
        action: Type.String({ maxLength: 128, minLength: 1 }),
        capability: sessionSharePeerCapabilitySchema,
        createdAt: sessionShareTimestampSchema,
        /** The whole row as one English sentence, ready to show as-is. */
        description: Type.String({ maxLength: 1_024, minLength: 1 }),
        detail: Type.Optional(Type.String({ maxLength: 512, minLength: 1 })),
        grantEpoch: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 1 }),
        outcome: Type.Union([Type.Literal("allowed"), Type.Literal("denied")]),
        seq: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 1 }),
        shareId: sessionShareIdentifierSchema,
        shareMemberId: sessionShareIdentifierSchema,
    },
    sessionShareExact,
);
export type SessionSharePeerActivityEntry = Static<typeof sessionSharePeerActivityEntrySchema>;

export const getSessionSharePeerActivityResponseSchema = Type.Object(
    {
        complete: Type.Boolean(),
        entries: Type.Array(sessionSharePeerActivityEntrySchema, { maxItems: 100 }),
        nextCursor: Type.Optional(sessionShareIdentifierSchema),
    },
    sessionShareExact,
);
export type GetSessionSharePeerActivityResponse = Static<
    typeof getSessionSharePeerActivityResponseSchema
>;

export const listSessionShareReplicaCapabilitiesResponseSchema = Type.Object(
    {
        capabilities: Type.Array(sessionSharePeerCapabilitySchema, { maxItems: 16 }),
        /** What this replica may do, in the words its own holder reads. */
        description: Type.String({ maxLength: 512, minLength: 1 }),
        shareId: sessionShareIdentifierSchema,
    },
    sessionShareExact,
);
export type ListSessionShareReplicaCapabilitiesResponse = Static<
    typeof listSessionShareReplicaCapabilitiesResponseSchema
>;

/**
 * How much of each tool's work a share replicates.
 *
 * `summaries` is what a share has unless its owner asked for more, including a
 * request that leaves the field out. `full` additionally replicates the raw
 * arguments and output of the tools that declared themselves disclosable.
 */
export const sessionShareToolOutputSchema = Type.Union([
    Type.Literal("summaries"),
    Type.Literal("full"),
]);
export type SessionShareToolOutput = Static<typeof sessionShareToolOutputSchema>;

/**
 * The sentence the daemon sends for a given setting.
 *
 * `rig-connect` predicts an owner's change locally before the daemon confirms
 * it, so it has to know the wording the daemon will echo back. This mirrors
 * `describeSharedToolOutput` in the daemon's own session-sharing module, the
 * same way every schema here mirrors its daemon original.
 */
export function describeSessionShareToolOutput(toolOutput: SessionShareToolOutput): string {
    return toolOutput === "full"
        ? "Friends see what each tool did and the output it produced."
        : "Friends see what each tool did, without the output it produced.";
}

export const sessionSharedMetadataSchema = Type.Object(
    {
        /**
         * What members who currently hold a capability may actually do, as a
         * phrase ready to follow "can" — computed from what is granted right
         * now, never from `offerableCapabilities`, so it stays a correct
         * sentence even after the project's own offer disappears out from
         * under an existing grant.
         */
        activeCapabilitiesDescription: Type.String({ maxLength: 512, minLength: 1 }),
        /** How many members hold at least one capability right now. */
        capabilityMemberCount: Type.Integer({ maximum: 10_000, minimum: 0 }),
        includeFriendMessagesInModel: Type.Boolean(),
        memberCount: Type.Integer({ maximum: 10_000, minimum: 0 }),
        /** Every capability this project could offer, and why when it cannot. */
        offerableCapabilities: Type.Array(sessionShareOfferableCapabilitySchema, { maxItems: 16 }),
        shareId: sessionShareIdentifierSchema,
        state: sessionShareStateSchema,
        toolOutput: sessionShareToolOutputSchema,
        /** Sentence describing what friends currently see, ready to show as-is. */
        toolOutputDescription: Type.String({ maxLength: 512, minLength: 1 }),
    },
    sessionShareExact,
);
export type SessionSharedMetadata = Static<typeof sessionSharedMetadataSchema>;

export const sessionShareFriendInputSchema = Type.Object(
    {
        displayName: Type.String({ maxLength: 512, minLength: 1 }),
        peerId: sessionShareIdentifierSchema,
    },
    sessionShareExact,
);
export type SessionShareFriendInput = Static<typeof sessionShareFriendInputSchema>;

export const createSessionShareRequestSchema = Type.Object(
    {
        friends: Type.Array(sessionShareFriendInputSchema, {
            maxItems: 100,
            minItems: 1,
            uniqueItems: true,
        }),
        includeFriendMessagesInModel: Type.Boolean(),
        mutationId: sessionShareIdentifierSchema,
        /** Omitted means summaries: full output is only ever something asked for. */
        toolOutput: Type.Optional(sessionShareToolOutputSchema),
    },
    sessionShareExact,
);
export type CreateSessionShareRequest = Static<typeof createSessionShareRequestSchema>;

export const addSessionShareMemberRequestSchema = Type.Object(
    {
        friend: sessionShareFriendInputSchema,
        mutationId: sessionShareIdentifierSchema,
    },
    sessionShareExact,
);
export type AddSessionShareMemberRequest = Static<typeof addSessionShareMemberRequestSchema>;

export const revokeSessionShareMemberRequestSchema = Type.Object(
    { mutationId: sessionShareIdentifierSchema },
    sessionShareExact,
);
export type RevokeSessionShareMemberRequest = Static<typeof revokeSessionShareMemberRequestSchema>;

export const stopSessionShareRequestSchema = Type.Object(
    { mutationId: sessionShareIdentifierSchema },
    sessionShareExact,
);
export type StopSessionShareRequest = Static<typeof stopSessionShareRequestSchema>;

export const setSessionShareFriendMessagesRequestSchema = Type.Object(
    {
        includeFriendMessagesInModel: Type.Boolean(),
        mutationId: sessionShareIdentifierSchema,
    },
    sessionShareExact,
);
export type SetSessionShareFriendMessagesRequest = Static<
    typeof setSessionShareFriendMessagesRequestSchema
>;

export const setSessionShareToolOutputRequestSchema = Type.Object(
    {
        mutationId: sessionShareIdentifierSchema,
        toolOutput: sessionShareToolOutputSchema,
    },
    sessionShareExact,
);
export type SetSessionShareToolOutputRequest = Static<
    typeof setSessionShareToolOutputRequestSchema
>;

export const postSessionShareFriendMessageRequestSchema = Type.Object(
    {
        clientMessageId: sessionShareIdentifierSchema,
        grant: sessionShareGrantSchema,
        text: Type.String({ maxLength: 100_000, minLength: 1 }),
    },
    sessionShareExact,
);
export type PostSessionShareFriendMessageRequest = Static<
    typeof postSessionShareFriendMessageRequestSchema
>;

export const sessionShareOwnerResponseSchema = Type.Object(
    {
        members: Type.Array(sessionShareMemberSchema, { maxItems: 10_000 }),
        share: sessionSharedMetadataSchema,
    },
    sessionShareExact,
);
export type SessionShareOwnerResponse = Static<typeof sessionShareOwnerResponseSchema>;

export const postSessionShareFriendMessageResponseSchema = Type.Object(
    {
        accepted: Type.Boolean(),
        clientMessageId: sessionShareIdentifierSchema,
    },
    sessionShareExact,
);
export type PostSessionShareFriendMessageResponse = Static<
    typeof postSessionShareFriendMessageResponseSchema
>;

export const sessionShareReplicaSchema = Type.Object(
    {
        createdAt: sessionShareTimestampSchema,
        endedAt: Type.Optional(sessionShareTimestampSchema),
        endedReason: Type.Optional(Type.String({ maxLength: 2_048, minLength: 1 })),
        grant: sessionShareGrantSchema,
        memberCount: Type.Integer({ maximum: 10_000, minimum: 0 }),
        ownerPeerId: sessionShareIdentifierSchema,
        state: Type.Union([Type.Literal("active"), Type.Literal("ended")]),
        title: Type.String({ maxLength: 2_048 }),
        updatedAt: sessionShareTimestampSchema,
    },
    sessionShareExact,
);
export type SessionShareReplica = Static<typeof sessionShareReplicaSchema>;

export const listSessionShareReplicasResponseSchema = Type.Object(
    { replicas: Type.Array(sessionShareReplicaSchema, { maxItems: 1_000 }) },
    sessionShareExact,
);
export type ListSessionShareReplicasResponse = Static<
    typeof listSessionShareReplicasResponseSchema
>;

export const sessionShareReplicaHistoryEntrySchema = Type.Object(
    {
        canonicalJson: Type.String({ maxLength: 1_048_576, minLength: 1 }),
        createdAt: sessionShareTimestampSchema,
        shareEventId: sessionShareIdentifierSchema,
        shareSequence: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 1 }),
    },
    sessionShareExact,
);
export type SessionShareReplicaHistoryEntry = Static<typeof sessionShareReplicaHistoryEntrySchema>;

export const getSessionShareReplicaHistoryResponseSchema = Type.Object(
    {
        complete: Type.Boolean(),
        entries: Type.Array(sessionShareReplicaHistoryEntrySchema, { maxItems: 100 }),
        nextCursor: Type.Optional(sessionShareIdentifierSchema),
        replica: sessionShareReplicaSchema,
    },
    sessionShareExact,
);
export type GetSessionShareReplicaHistoryResponse = Static<
    typeof getSessionShareReplicaHistoryResponseSchema
>;

export const sessionShareHealthSchema = Type.Object(
    {
        checkedAt: sessionShareTimestampSchema,
        detail: Type.Optional(Type.String({ maxLength: 2_048, minLength: 1 })),
        pendingBytes: Type.Integer({ maximum: 64 * 1024 * 1024, minimum: 0 }),
        pendingEntries: Type.Integer({ maximum: 100_000, minimum: 0 }),
        state: sessionShareStateSchema,
    },
    sessionShareExact,
);
export type SessionShareHealth = Static<typeof sessionShareHealthSchema>;

export const getSessionShareHealthResponseSchema = Type.Object(
    { health: sessionShareHealthSchema },
    sessionShareExact,
);
export type GetSessionShareHealthResponse = Static<typeof getSessionShareHealthResponseSchema>;

const serviceNoticeExact = { additionalProperties: false } as const;
const serviceNoticeText = Type.String({ minLength: 1 });
export const SERVICE_NOTICE_MESSAGE_MAX_LENGTH = 4_096;
export const SERVICE_NOTICE_TEXT_MAX_LENGTH = 8_192;
const computeErrorMessage = Type.String({
    maxLength: SERVICE_NOTICE_MESSAGE_MAX_LENGTH,
    minLength: 1,
});

const computeInstanceStateSchema = Type.Union([
    Type.Literal("unprovisioned"),
    Type.Literal("provisioning"),
    Type.Literal("ready"),
    Type.Literal("unavailable"),
    Type.Literal("failed"),
    Type.Literal("stopped"),
]);
const computeErrorState = {
    state: Type.Optional(computeInstanceStateSchema),
};
const computePreparationDetails = {
    elapsedMs: Type.Optional(Type.Integer({ minimum: 0 })),
    lastProgressAt: Type.Optional(Type.Integer({ minimum: 0 })),
    percent: Type.Optional(Type.Number({ maximum: 100, minimum: 0 })),
    phase: Type.Optional(Type.String({ maxLength: 128, minLength: 1 })),
    startedAt: Type.Optional(Type.Integer({ minimum: 0 })),
};
export const computeServiceErrorSchema = Type.Union([
    Type.Object(
        {
            ...computeErrorState,
            code: Type.Literal("capacity_exhausted"),
            message: computeErrorMessage,
            retryable: Type.Literal(true),
        },
        serviceNoticeExact,
    ),
    Type.Object(
        {
            ...computeErrorState,
            code: Type.Literal("deadline_exceeded"),
            message: computeErrorMessage,
            retryable: Type.Literal(true),
        },
        serviceNoticeExact,
    ),
    Type.Object(
        {
            ...computePreparationDetails,
            code: Type.Literal("preparing_compute"),
            message: computeErrorMessage,
            retryable: Type.Literal(true),
            state: Type.Union([
                Type.Literal("unprovisioned"),
                Type.Literal("provisioning"),
                Type.Literal("unavailable"),
            ]),
        },
        serviceNoticeExact,
    ),
    Type.Object(
        {
            ...computeErrorState,
            code: Type.Union([
                Type.Literal("invalid_request"),
                Type.Literal("invalid_response"),
                Type.Literal("instance_failed"),
                Type.Literal("instance_not_found"),
                Type.Literal("provider_lost"),
                Type.Literal("provider_not_found"),
                Type.Literal("provider_unhealthy"),
            ]),
            message: computeErrorMessage,
            retryable: Type.Literal(false),
        },
        serviceNoticeExact,
    ),
]);
export type ComputeServiceError = Static<typeof computeServiceErrorSchema>;

export const computePreparationNoticeSchema = Type.Object(
    {
        computeInstanceId: serviceNoticeText,
        elapsedMs: Type.Optional(Type.Integer({ minimum: 0 })),
        error: Type.Optional(computeServiceErrorSchema),
        kind: Type.Literal("compute_preparation"),
        lastProgressAt: Type.Optional(Type.Integer({ minimum: 0 })),
        message: Type.String({ maxLength: SERVICE_NOTICE_MESSAGE_MAX_LENGTH, minLength: 1 }),
        percent: Type.Optional(Type.Number({ maximum: 100, minimum: 0 })),
        phase: Type.String({ maxLength: 128, minLength: 1 }),
        provider: serviceNoticeText,
        startedAt: Type.Optional(Type.Integer({ minimum: 0 })),
        state: computeInstanceStateSchema,
    },
    serviceNoticeExact,
);
export type ComputePreparationNotice = Static<typeof computePreparationNoticeSchema>;

export const serviceNoticeSchema = Type.Union([computePreparationNoticeSchema]);
export type ServiceNotice = Static<typeof serviceNoticeSchema>;

export const systemNoticePayloadSchema = Type.Object(
    {
        structured: Type.Optional(serviceNoticeSchema),
        text: Type.String({ maxLength: SERVICE_NOTICE_TEXT_MAX_LENGTH, minLength: 1 }),
    },
    serviceNoticeExact,
);
export type SystemNoticePayload = Static<typeof systemNoticePayloadSchema>;

export type SessionActivityKind =
    | "idle"
    | "queued"
    | "thinking"
    | "generating_message"
    | "generating_tool_call"
    | "reviewing_tool_call"
    | "executing_tool_call"
    | "waiting"
    | "awaiting_input"
    | "compacting"
    | "retrying"
    | "stopped"
    | "error";

export interface SessionActivityToolCall {
    startedAt: number;
    status?: string;
    toolCallId: string;
    toolName: string;
}

export interface SessionActivityPermissionReview {
    action: string;
    startedAt: number;
    toolCallId: string;
    toolName: string;
}

export interface SessionActivityCompaction {
    compactionId: string;
    estimatedTokensBefore: number;
    reason: "context_window" | "manual" | "threshold";
    startedAt: number;
}

export interface SessionActivityRetry {
    attempt: number;
    reason: string;
}

export interface SessionActivityWait {
    dueAt: number;
    startedAt: number;
    toolCallId: string;
}

export interface SessionActivity {
    label: string;
    kind: SessionActivityKind;
    runId?: string;
    since: number;
    compaction?: SessionActivityCompaction;
    pendingInputRequestIds?: readonly string[];
    retry?: SessionActivityRetry;
    reviewingToolCalls?: readonly SessionActivityPermissionReview[];
    wait?: SessionActivityWait;
    toolCalls?: readonly SessionActivityToolCall[];
}

export interface TextBlock {
    type: "text";
    text: string;
}

export interface ImageBlock {
    type: "image";
    mediaType: string;
    data: string;
    detail?: "high" | "original";
}

export type Attachment =
    | {
          bytes: number;
          /** Session-scoped route for fetching this attachment. */
          downloadUrl?: string;
          height: number;
          id: string;
          kind: "image";
          mediaType: string;
          name: string;
          /** Origin URL or Rig-scoped locator such as generated/file.png. */
          source: string;
          thumbhash: string;
          width: number;
      }
    | {
          bytes: number;
          /** Session-scoped route for fetching the original video. */
          downloadUrl?: string;
          duration: number;
          height: number;
          id: string;
          kind: "video";
          mediaType?: string;
          name: string;
          preview: {
              /** Session-scoped route for fetching this first-frame image. */
              downloadUrl?: string;
              height: number;
              mediaType: "image/png";
              /** Rig-scoped generated-media locator. */
              path: string;
              thumbhash: string;
              width: number;
          };
          /** Rig-scoped locator such as generated/file.mp4. */
          source: string;
          width: number;
      }
    | {
          bytes: number;
          downloadUrl?: string;
          duration: number;
          id: string;
          kind: "audio";
          mediaType?: string;
          name: string;
          /** Rig-scoped locator such as generated/file.mp3. */
          source: string;
      }
    | {
          bytes: number;
          downloadUrl?: string;
          id: string;
          kind: "file";
          mediaType?: string;
          name: string;
          /** Rig-scoped locator such as generated/file.zip. */
          source: string;
      }
    | {
          description?: string;
          id: string;
          image?: string;
          kind: "url";
          siteName?: string;
          source: string;
          title: string;
      }
    | {
          description: string;
          id: string;
          image: string;
          kind: "webapp";
          name: string;
          path?: string;
          query?: Record<string, string>;
          thumbhash: string;
          webapp: string;
      };

export type ContentBlock = TextBlock | ImageBlock;

export interface ThinkingBlock {
    type: "thinking";
    thinking: string;
    encrypted?: string;
    redacted?: boolean;
}

export interface ToolCallBlock {
    type: "tool_call";
    id: string;
    providerToolCallId?: string;
    name: string;
    namespace?: string;
    arguments: unknown;
    incomplete?: boolean;
    kind?: "custom" | "function" | "tool_search";
    vendor?: unknown;
    presentation?: ToolCallPresentation;
}

export interface ToolResultFailure {
    kind: "execution_failed" | "interrupted" | "invalid_arguments" | "tool_unavailable";
    message?: string;
}

export interface ToolResultBlock {
    type: "tool_result";
    toolCallId: string;
    providerToolCallId?: string;
    toolName: string;
    rendered: readonly ContentBlock[];
    display: string;
    isError?: boolean;
    failure?: ToolResultFailure;
    presentation?: ToolResultPresentation;
    trustedUserEvidence?: readonly ContentBlock[];
    vendor?: unknown;
}

/**
 * How Rig describes what a tool is doing and what it produced.
 *
 * These mirror the daemon's own unions, which is what lets this library project
 * them into application values. `tests/protocolConformance.test.ts` fails to
 * compile if they drift.
 *
 * A consumer should read the projected `presentation` on a tool call rather than
 * these; they are exported because the projection is lossless only for the kinds
 * it knows.
 */
export type ExplorationOperation =
    | { readonly kind: "list"; readonly target: string }
    | { readonly kind: "read"; readonly name: string }
    | {
          readonly command: string;
          readonly kind: "search";
          readonly path?: string;
          readonly query?: string;
      };

export interface ExplorationToolCallPresentation {
    readonly type: "exploration";
    readonly operations: readonly ExplorationOperation[];
}

export interface ExecCommandToolCallPresentation {
    readonly command: string;
    readonly type: "exec_command";
}

/** One page a search consulted. */
export interface SearchSource {
    readonly url: string;
    readonly title?: string;
}

/** A search of the world outside the workspace, whoever ran it. */
export interface SearchToolCallPresentation {
    readonly type: "search";
    readonly target: "web" | "x";
    readonly query: string;
}

export interface SearchToolResultPresentation {
    readonly type: "search";
    readonly target: "web" | "x";
    readonly query: string;
    readonly sources: readonly SearchSource[];
}

export type ToolCallPresentation =
    | ExecCommandToolCallPresentation
    | ExplorationToolCallPresentation
    | SearchToolCallPresentation;

export type FileDiffKind = "add" | "delete" | "update";
export type FileDiffLineKind = "add" | "context" | "delete";

export interface FileDiffLine {
    readonly kind: FileDiffLineKind;
    readonly text: string;
}

export interface FileDiffHunk {
    readonly oldStart: number;
    readonly newStart: number;
    readonly lines: readonly FileDiffLine[];
}

export interface FileDiff {
    readonly path: string;
    readonly kind: FileDiffKind;
    readonly hunks: readonly FileDiffHunk[];
    readonly language?: string;
    readonly added?: number;
    readonly deleted?: number;
    readonly omittedLines?: number;
}

export interface FileDiffToolResultPresentation {
    readonly type: "file_diff";
    readonly files: readonly FileDiff[];
    readonly omittedFiles?: number;
}

export interface BackgroundTerminalInteractionPresentation {
    readonly command: string;
    readonly input: string;
    readonly sessionId: number;
    readonly type: "background_terminal_interaction";
}

export interface ExecCommandResultPresentation {
    readonly command: string;
    readonly output: string;
    readonly sessionId?: number;
    readonly type: "exec_command";
}

export type ToolResultPresentation =
    | BackgroundTerminalInteractionPresentation
    | ExecCommandResultPresentation
    | ExplorationToolCallPresentation
    | FileDiffToolResultPresentation
    | SearchToolResultPresentation;

export type AgentBlock = ContentBlock | ThinkingBlock | ToolCallBlock | ToolResultBlock;

export interface SystemMessage {
    role: "system";
    id: string;
    blocks: readonly ContentBlock[];
    structured?: ServiceNotice;
    context?: "excluded";
    internal?: true;
}

export interface UserMessage {
    role: "user";
    id: string;
    blocks: readonly ContentBlock[];
    contextOnly?: true;
    friendAuthor?: {
        displayName: string;
        grantEpoch: number;
        kind: "friend";
        murmurPeerId: string;
        shareId: string;
        shareMemberId: string;
    };
    /** Durable context disposition assigned by the session-sharing owner. */
    friendMessageDisposition?: "included" | "overflow" | "pending";
    provenance?: "agent";
    internal?: true;
}

export interface AgentMessage {
    role: "agent";
    id: string;
    blocks: readonly AgentBlock[];
    attachments?: readonly Attachment[];
    usage?: Usage;
    contextTokens?: number;
    providerId?: string;
    requestedModelId?: string;
    responseModel?: string;
    internal?: true;
}

export interface CompactionMessage {
    role: "compaction";
    id: string;
    blocks: readonly ContentBlock[];
    replacedMessageIds: readonly string[];
    statistics: {
        before: { exact: true; tokens: number };
        after: { exact: boolean; tokens: number };
    };
    providerId: string;
    /** Model requested for the compaction inference. */
    requestedModelId?: string;
    /** Provider-reported model that performed the compaction inference. */
    responseModel?: string;
    /** Provider-reported usage spent producing this compaction. */
    usage?: Usage;
    internal?: never;
}

export interface ErrorMessage {
    role: "error";
    id: string;
    blocks: readonly ContentBlock[];
    outcome: "retried" | "continued" | "failed";
    attempt?: number;
    context?: "excluded";
    internal?: never;
}

export type Message = SystemMessage | UserMessage | AgentMessage | CompactionMessage | ErrorMessage;

export interface Usage {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    reasoning?: number;
    cost: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        total: number;
    };
}

export type ProviderQuotaWindow =
    | {
          capturedAt: number;
          status: "available";
          usedPercent: number;
          resetsAt: number;
          durationMs?: number;
      }
    | { status: "unavailable" };

export interface ProviderQuota {
    capturedAt: number;
    source: "claude" | "codex";
    windows: {
        fiveHour?: ProviderQuotaWindow;
        weekly?: ProviderQuotaWindow;
    };
}

export interface SessionUsageGroup {
    kind: "attributed";
    modelId: string;
    providerId: string;
    requestedModelId: string;
    role?: "permission_review";
    usage: Usage;
    responseModel?: string;
}

export interface SessionContextUsage {
    approximate: boolean;
    modelId: string;
    providerId: string;
    requestedModelId: string;
    responseModel?: string;
    totalTokens: number;
}

export interface SessionProviderQuota {
    providerId: string;
    quota: ProviderQuota;
}

export interface SessionUsageSnapshot {
    currentProviderId: string;
    groups: readonly SessionUsageGroup[];
    context?: SessionContextUsage;
    quotas: readonly SessionProviderQuota[];
    sessionTokenCount: SessionTokenCount;
}

export interface SessionTokenCount {
    /** Context window occupied after the latest inference or compaction. */
    lastContextTokens: number;
    /** Cumulative provider-reported usage across all model requests in the session. */
    totalTokens: number;
}

/**
 * Why a chat is waiting for the human.
 *
 * `attention_needed` outranks `turn_finished`: a chat that asked a question and
 * then stopped working is still asking, so the stronger reason stands rather
 * than decaying into the weaker one when the run ends.
 */
export type SessionUnreadReason = "attention_needed" | "friend_message" | "turn_finished";

export interface SessionUnreadState {
    reason: SessionUnreadReason;
    since: number;
}

export interface ModelSummary {
    autoCompactWindow?: number;
    contextWindow?: number;
    defaultThinkingLevel: string;
    id: string;
    name: string;
    thinkingLevels: readonly string[];
}

export interface ProviderModelCatalog {
    disabledReason?: "not_authenticated" | "not_enabled" | "no_models";
    providerId: string;
    providerType?: string;
    models: readonly ModelSummary[];
    serviceTiers?: readonly string[];
}

export interface ModelCatalog {
    defaultModelId: string;
    defaultProviderId: string;
    models: readonly ModelSummary[];
    providers: readonly ProviderModelCatalog[];
}

export interface DaemonIdentity {
    developmentBuildId?: string;
    version: string;
}

export interface UserInputOption {
    description: string;
    label: string;
}

export interface UserInputQuestion {
    header: string;
    id: string;
    multiSelect: boolean;
    options: readonly UserInputOption[];
    question: string;
    required?: boolean;
}

export interface UserInputRequest {
    autoResolutionMs?: number;
    questions: readonly UserInputQuestion[];
    requestId: string;
}

export interface InboxUserInput {
    answers?: Readonly<Record<string, readonly string[]>>;
    createdAt: number;
    questions: readonly UserInputQuestion[];
    requestId: string;
    resolvedAt?: number;
    status: "pending" | "answered";
}

export interface SessionTask {
    activeForm?: string;
    blockedBy: readonly string[];
    blocks: readonly string[];
    description: string;
    id: string;
    metadata?: Readonly<Record<string, unknown>>;
    owner?: string;
    status: "pending" | "in_progress" | "completed";
    subject: string;
}

export interface SessionGoal {
    createdAt: number;
    objective: string;
    status: "active" | "blocked" | "complete" | "paused";
    updatedAt: number;
}

export interface SubagentSummary {
    activeSince?: number;
    agentId: string;
    createdAt: number;
    depth: number;
    description: string;
    elapsedMs?: number;
    id: string;
    latestText?: string;
    modelId: string;
    parentSessionId: string;
    parentToolCallId?: string;
    prompt?: string;
    status: SessionStatus;
    taskName?: string;
    totalTokens?: number;
    sessionTokenCount?: SessionTokenCount;
    updatedAt: number;
    usage?: Usage;
}

export interface BackgroundProcess {
    command: string;
    cwd: string;
    sessionId: number;
    status: "running";
}

export interface BackgroundProcessSnapshot {
    command: string;
    cwd: string;
    exitCode: number | null;
    sessionId: number;
    status: "completed" | "killed" | "running";
    stderr: string;
    stderrDelta: string;
    stdout: string;
    stdoutDelta: string;
    timedOut: boolean;
}

export interface PendingSteeringMessage {
    createdAt: number;
    message: UserMessage;
    runId: string;
}

export interface SessionActiveTurn {
    runId: string;
    startedAt: number;
    kind?: "compaction";
}

export interface PermissionReviewState {
    action: string;
    decision: "allow" | "deny";
    fullAccessGranted?: true;
    reason: string;
    risk: "low" | "medium" | "high" | "critical";
    toolCallId: string;
    userAuthorization: "unknown" | "low" | "medium" | "high";
}

export interface ShellCommandState {
    command: string;
    commandId: string;
    errorMessage?: string;
    exitCode?: number | null;
    output?: string;
    sessionId?: number;
    status: "running" | "finished";
    timedOut?: boolean;
}

export type SessionExecutionEnvironment =
    | { type: "local" }
    | {
          kind: "container" | "image";
          reference: string;
          type: "docker";
          workingDirectory: string;
      };

export interface SessionAgentMetadata {
    depth: number;
    rootSessionId: string;
    type: "primary" | "subagent";
    description?: string;
    parentSessionId?: string;
    parentToolCallId?: string;
    taskName?: string;
}

export interface SessionInterruption {
    interruptedAt: number;
    message: string;
    reason: "crash" | "shutdown";
    runId?: string;
}

export interface McpServerSummary {
    errorMessage?: string;
    name: string;
    status: "blocked" | "connected" | "disabled" | "failed";
    promptSupport?: boolean;
    resourceSupport?: boolean;
    toolCount: number;
}

export interface WorkflowRun {
    agentCount: number;
    code: string;
    description: string;
    error?: string;
    finishedAt?: number;
    logs: readonly string[];
    name: string;
    output?: unknown;
    phase?: string;
    runId: string;
    startedAt: number;
    status: "completed" | "error" | "running" | "stopped";
    taskId: string;
}

export interface WorkflowRunUpdate extends Partial<Omit<WorkflowRun, "runId">> {
    log?: string;
    runId: string;
}

export interface DurableSkillDefinition {
    description: string;
    location: "durable";
    name: string;
}

export interface ExternalToolDefinition {
    description: string;
    label?: string;
    name: string;
    parameters: unknown;
}

export type ExternalToolCallResolution =
    | { status: "completed"; content?: readonly ContentBlock[]; output?: unknown }
    | {
          status: "failed";
          error: { code?: string; data?: unknown; message: string };
      };

export interface ExternalToolCall {
    arguments: unknown;
    batchId: string;
    consumed: boolean;
    createdAt: number;
    definition: ExternalToolDefinition;
    id: string;
    providerToolCallId?: string;
    resolution?: ExternalToolCallResolution;
    resolvedAt?: number;
    runId: string;
    sessionId: string;
    skill?: DurableSkillDefinition;
    status: "pending" | "completed" | "failed" | "cancelled";
    toolCallId: string;
    toolCallIndex: number;
}

export interface GitFileChange {
    binary: boolean;
    deletions?: number;
    insertions?: number;
    path: string;
    previousPath?: string;
    staged: boolean;
    status: string;
    unstaged: boolean;
}

export interface GitChangeSnapshot {
    base?: string;
    branch?: string;
    changedFiles: number;
    comparison: "ready" | "unavailable";
    conflicted: boolean;
    countsExact: boolean;
    deletions: number;
    error?: string;
    files: readonly GitFileChange[];
    filesTruncated: boolean;
    generation: string;
    insertions: number;
    /** Stable application revision for consumers that cache file projections. */
    revision?: string;
    scannedAt: number;
    version: number;
    /** Daemon wire facts; projected to top-level application fields by rig-connect. */
    facts?: GitRepositoryFacts;
}

export interface GitWatchResponse {
    snapshots: readonly GlobalEvent[];
}

export interface GitRepositoryFacts {
    ahead: number;
    behind: number;
    branch?: string;
    detached: boolean;
    head?: string;
    upstream?: string;
}

/**
 * The durable lifecycle status of a session, as distinct from what it is doing
 * at this moment. A session list uses this for archived, suspended, and failed
 * sessions and for authoritative run completion.
 */
export type SessionStatus =
    | "idle"
    | "queued"
    | "running"
    | "completed"
    | "aborted"
    | "suspended"
    | "error"
    | "archived";

export interface ProtocolSession {
    id: string;
    activity: SessionActivity;
    activeTurn?: SessionActiveTurn;
    agentId?: string;
    shared?: SessionSharedMetadata;
    agent?: SessionAgentMetadata;
    archived: boolean;
    appendSystemPrompt?: string;
    projectId: string;
    workspaceId?: string;
    /** Absent for a session with no place in an ordered list, such as a subagent. */
    orderKey?: string;
    cwd: string;
    draft?: string;
    draftUpdatedAt?: number;
    git?: GitChangeSnapshot;
    lastEventId?: EventId;
    modelId: string;
    providerId: string;
    permissionMode: string;
    effort?: string;
    serviceTier?: string;
    secretIds?: readonly string[];
    projectSecretIds?: readonly string[];
    sessionSecretIds?: readonly string[];
    environment?: SessionExecutionEnvironment;
    modelLocked: boolean;
    models: readonly ModelSummary[];
    snapshot: { messages: readonly Message[] };
    status: SessionStatus;
    title?: string;
    titleError?: string;
    titleStatus?: "error" | "generating" | "idle" | "ready";
    recap?: string;
    interruption?: SessionInterruption;
    pendingUserInputs: readonly UserInputRequest[];
    permissionReviews?: readonly PermissionReviewState[];
    pendingSteeringMessages?: readonly PendingSteeringMessage[];
    tasks: readonly SessionTask[];
    goal?: SessionGoal;
    subagents?: readonly SubagentSummary[];
    backgroundProcesses?: readonly BackgroundProcess[];
    shellCommands?: readonly ShellCommandState[];
    systemPrompt?: string;
    mcpServers?: readonly McpServerSummary[];
    workflowsEnabled?: boolean;
    workflows?: readonly WorkflowRun[];
    sessionTokenCount?: SessionTokenCount;
    externalTools?: readonly ExternalToolDefinition[];
    skills?: readonly DurableSkillDefinition[];
    pendingExternalToolCalls?: readonly ExternalToolCall[];
    scheduledMessages?: readonly ScheduledMessage[];
}

export interface ScheduledMessage {
    createdAt: number;
    dueAt: number;
    id: string;
    message: string;
    senderSessionId: string;
    status: "pending" | "delivered" | "undelivered" | "cancelled";
    targetAgentId: string;
    updatedAt: number;
    deliveredAt?: number;
    failure?: string;
}

export interface SessionPartialMessage {
    message: AgentMessage;
    runId: string;
}

export interface SessionTranscriptTurn {
    runId: string;
    kind?: "compaction";
    messageIds: readonly string[];
    startedAt: number;
    endedAt?: number;
    outcome?: "success" | "error" | "stopped";
    errorMessage?: string;
    groups?: readonly SessionTranscriptGroup[];
}

export interface SessionTranscriptGroup {
    id: string;
    startedAt: number;
    endedAt?: number;
    outcome?: "success" | "error" | "stopped";
    reason?: "completed" | "steering" | "compaction" | "abort" | "error";
    errorMessage?: string;
}

export interface SessionTranscriptNotice {
    createdAt: number;
    eventId: EventId;
    message: SystemMessage;
}

export interface SessionTranscriptWindow {
    messages: readonly Message[];
    messageCreatedAt?: Readonly<Record<string, number>>;
    messageEventId?: Readonly<Record<string, EventId>>;
    /** When each steering message was actually applied to its run. */
    messageSteeredAt?: Readonly<Record<string, number>>;
    messageBoundaryGroupId?: Readonly<Record<string, string>>;
    messageGroupId?: Readonly<Record<string, string>>;
    notices?: readonly SessionTranscriptNotice[];
    /** True when this bounded window omitted older service notices in its position range. */
    noticesTruncated?: boolean;
    permissionReviews?: readonly PermissionReviewState[];
    /** Calls the provider ran itself during the assistant messages in this page. */
    providerToolCalls?: readonly ProviderToolCallRecord[];
    turns: readonly SessionTranscriptTurn[];
    /** False when the conversation began before the first turn in this window. */
    complete: boolean;
}

/**
 * A call the provider ran on its own backend, as the daemon durably recorded it.
 *
 * Rig never executes one, so it is deliberately not part of the assistant message and this is the
 * only place a reopened session can learn that the model reached the network at all.
 */
export interface ProviderToolCallRecord {
    arguments: string;
    callId: string;
    createdAt: number;
    /** The assistant message it accompanied, which is where a rebuilt transcript puts it back. */
    messageId: string;
    name: string;
    runId: string;
    /** `interrupted` means the turn ended before the provider reported back. */
    status: "completed" | "interrupted";
}

export interface SessionStreamHello {
    activity: SessionActivity;
    current?: SessionStreamCurrentState;
    usage?: SessionUsageSnapshot;
    session?: ProtocolSession;
    transcript?: SessionTranscriptWindow;
    partial?: SessionPartialMessage;
    lastEventId?: EventId;
    resumed: boolean;
}

/**
 * A session bootstrapped by request-response rather than by opening a stream.
 *
 * `cursor` is the live-stream position this payload reflects.
 */
export interface SessionStateResponse extends SessionStreamHello {
    /** The transcript continues what the client holds rather than replacing it. */
    append?: boolean;
    cursor: EventId;
}

export interface SessionStreamCurrentState {
    draft?: string;
    draftUpdatedAt?: number;
    externalTools?: readonly ExternalToolDefinition[];
    git?: GitChangeSnapshot;
    interruption?: SessionInterruption;
    mcpServers?: readonly McpServerSummary[];
    pendingExternalToolCalls?: readonly ExternalToolCall[];
    projectSecretIds?: readonly string[];
    secretIds?: readonly string[];
    sessionTokenCount?: SessionTokenCount;
    sessionSecretIds?: readonly string[];
    skills?: readonly DurableSkillDefinition[];
    scheduledMessages?: readonly ScheduledMessage[];
    titleError?: string;
    titleStatus?: "error" | "generating" | "idle" | "ready";
    workflows?: readonly WorkflowRun[];
    workflowsEnabled?: boolean;
}

export interface BaseSessionEvent<TType extends string, TData> {
    createdAt: number;
    data: TData;
    id: EventId;
    sessionId: string;
    type: TType;
}

/**
 * The events this library interprets.
 *
 * Rig emits more than these. Anything unrecognised is ordered and cursored like
 * the rest and then ignored, so a daemon that gained an event does not break a
 * client that has not learned it yet.
 */
export type InterpretedSessionEvent =
    | BaseSessionEvent<"session_updated", { mutationId?: MutationId; session: ProtocolSession }>
    | BaseSessionEvent<"session_activity_changed", { activity: SessionActivity }>
    | BaseSessionEvent<"session_archived", { archived: boolean; mutationId?: MutationId }>
    | BaseSessionEvent<"session_git_changed", { git: GitChangeSnapshot }>
    | BaseSessionEvent<"session_context_changed", { sessionTokenCount: SessionTokenCount }>
    | BaseSessionEvent<
          "session_configuration_changed",
          {
              effort?: string;
              modelId: string;
              mutationId?: MutationId;
              providerId: string;
              serviceTier: string | null;
          }
      >
    | BaseSessionEvent<
          "permission_mode_changed",
          { mutationId?: MutationId; permissionMode: string }
      >
    | BaseSessionEvent<
          "session_title_changed",
          { errorMessage?: string; recap?: string; status: string; title?: string }
      >
    | BaseSessionEvent<
          "session_draft_changed",
          { draft?: string; mutationId?: MutationId; origin?: string; updatedAt: number }
      >
    | BaseSessionEvent<"user_input_requested", UserInputRequest>
    | BaseSessionEvent<
          "user_input_resolved",
          {
              answers?: Readonly<Record<string, readonly string[]>>;
              mutationId?: MutationId;
              requestId: string;
              status: string;
          }
      >
    | BaseSessionEvent<
          "secrets_changed",
          {
              projectSecretIds: readonly string[];
              secretIds: readonly string[];
              sessionSecretIds: readonly string[];
              mutationId?: MutationId;
          }
      >
    | BaseSessionEvent<"mcp_servers_changed", { servers: readonly McpServerSummary[] }>
    | BaseSessionEvent<"mutation_applied", { mutationId: MutationId }>
    | BaseSessionEvent<"workflow_changed", { update: WorkflowRunUpdate }>
    | BaseSessionEvent<"external_tool_call_requested", { call: ExternalToolCall }>
    | BaseSessionEvent<"external_tool_call_resolved", { call: ExternalToolCall }>
    | BaseSessionEvent<
          "scheduled_message_changed",
          { message: ScheduledMessage; mutationId?: MutationId }
      >
    | BaseSessionEvent<"scheduled_messages_pruned", { messageIds: readonly string[] }>
    | BaseSessionEvent<"tasks_changed", { tasks: readonly SessionTask[] }>
    | BaseSessionEvent<"goal_changed", { goal: SessionGoal | null; mutationId?: MutationId }>
    | BaseSessionEvent<"subagent_changed", { subagent: SubagentSummary }>
    | BaseSessionEvent<
          "shell_command_started",
          { command: string; commandId: string; sessionId: number }
      >
    | BaseSessionEvent<
          "shell_command_finished",
          {
              command: string;
              commandId: string;
              errorMessage?: string;
              exitCode: number | null;
              output: string;
              sessionId?: number;
              timedOut: boolean;
          }
      >
    | BaseSessionEvent<"steering_applied", { messageIds: readonly string[]; runId: string }>
    | BaseSessionEvent<
          "message_submitted",
          {
              delivery?: "context" | "run" | "steer";
              displayText: string;
              message: UserMessage;
              mutationId?: MutationId;
              runId: string;
              source?: "notification";
          }
      >
    | BaseSessionEvent<"run_started", { runId: string; kind?: "compaction" }>
    | BaseSessionEvent<
          "abort_requested",
          { continuePendingSteering?: true; mutationId?: MutationId; runId?: string }
      >
    | BaseSessionEvent<"agent_message", { message: Message; runId: string }>
    | BaseSessionEvent<"agent_event", { event: AgentLoopEvent; runId: string }>
    | BaseSessionEvent<"provider_quota_observed", { providerId: string; quota: ProviderQuota }>
    | BaseSessionEvent<
          "run_finished",
          {
              attachmentMessageId?: string;
              attachments?: readonly Attachment[];
              errorMessage?: string;
              modelLocked: boolean;
              runId: string;
              stopReason: string;
          }
      >
    | BaseSessionEvent<"run_error", { errorMessage: string; modelLocked: boolean; runId: string }>
    | BaseSessionEvent<
          "session_reset",
          {
              snapshot: {
                  messages: readonly Message[];
                  modelId?: string;
                  providerId?: string;
              };
              transcript: SessionTranscriptWindow;
          }
      >
    | BaseSessionEvent<
          "session_rewound",
          {
              messageId: string;
              snapshot: {
                  messages: readonly Message[];
                  modelId?: string;
                  providerId?: string;
              };
              transcript: SessionTranscriptWindow;
          }
      >;

export type SessionEvent = InterpretedSessionEvent | BaseSessionEvent<string, unknown>;

/** The streaming and tool events carried inside `agent_event`. */
export type AgentLoopEvent =
    | { type: "inference_iteration_start"; iteration: number; messageId: string }
    | { type: "block_reset"; messageId: string; partial: { blocks?: readonly AgentBlock[] } }
    | { type: "text_start"; contentIndex: number; messageId: string }
    | { type: "text_delta"; contentIndex: number; delta: string; messageId: string }
    | { type: "text_end"; contentIndex: number; content: string; messageId: string }
    | { type: "thinking_start"; contentIndex: number; messageId: string }
    | { type: "thinking_delta"; contentIndex: number; delta: string; messageId: string }
    | { type: "thinking_end"; contentIndex: number; content: string; messageId: string }
    | { type: "toolcall_start"; contentIndex: number; messageId: string }
    | { type: "toolcall_delta"; contentIndex: number; delta: string; messageId: string }
    | {
          type: "toolcall_end";
          contentIndex: number;
          messageId: string;
          toolCall: { arguments?: unknown; id: string; name: string };
      }
    | { type: "server_toolcall_start"; callId: string; messageId: string; name: string }
    | { type: "server_toolcall_delta"; callId: string; delta: string; messageId: string }
    | {
          type: "server_toolcall_end";
          arguments: string;
          callId: string;
          messageId: string;
          name: string;
      }
    | { type: "tool_execution_start"; toolCall: ToolCallBlock }
    | { type: "tool_execution_progress"; display: string; toolCallId: string }
    | { type: "tool_execution_status"; status: string; toolCallId: string }
    | {
          type: "tool_execution_end";
          result: {
              display?: string;
              failure?: ToolResultFailure;
              isError?: boolean;
              presentation?: ToolResultPresentation;
              toolCallId: string;
              toolName: string;
          };
      }
    | {
          type: "context_compaction_started";
          compactionId: string;
          estimatedTokensBefore: number;
          reason: string;
      }
    | {
          type: "context_compacted";
          compactionId: string;
          compactedMessageCount: number;
          estimatedTokensAfter: number;
          estimatedTokensBefore: number;
      }
    | {
          type: "context_compaction_finished";
          compactionId: string;
          elapsedMs: number;
          status: "cancelled" | "completed" | "failed";
          errorMessage?: string;
      }
    | {
          type: "permission_review_started";
          action: string;
          toolCallId: string;
          toolName: string;
      }
    | {
          type: "permission_review";
          action: string;
          decision: "allow" | "deny";
          reason: string;
          risk: "low" | "medium" | "high" | "critical";
          toolCallId: string;
          transcript?: {
              modelId: string;
              providerId: string;
              usage: Usage;
          };
          userAuthorization: "unknown" | "low" | "medium" | "high";
      }
    | {
          action: string;
          reason: string;
          risk: "low" | "medium" | "high" | "critical";
          type: "temporary_full_access_started";
          toolCallId: string;
          userAuthorization: "unknown" | "low" | "medium" | "high";
      }
    | {
          type: "background_processes_changed";
          processes?: readonly BackgroundProcess[];
          running: number;
      }
    | { type: "retrying"; attempt: number; reason: string }
    | { type: string };

/** A folder or repository Rig has sessions in. */
export interface Project {
    archivedAt?: number;
    avatar?: {
        hash: string;
        height: number;
        mediaType: "image/webp";
        source: "repository" | "hosting" | "user";
        url: string;
        width: number;
    };
    avatarBuiltin?: "home";
    createdAt: number;
    defaultBranch?: string;
    git?: GitRepositoryFacts;
    id: string;
    initializationAttempt: number;
    initializationError?: string;
    initializationStatus: "initializing" | "ready" | "failed";
    kind: "regular" | "home";
    name: string;
    nameSource: "folder" | "git_remote" | "user";
    orderKey: string;
    path: string;
    presence: "present" | "missing";
    settings: {
        defaultWorkspaceCompute?:
            | { generation: number; type: "local" }
            | { generation: number; image: string; type: "docker" };
    };
    storageKey: string;
    updatedAt: number;
    version: number;
    worktreeSupport: "supported" | "unsupported" | "unknown";
    worktreeSupportReason?: string;
}

/** Durable Git facts. Only the branch is read here; the rest passes through. */
export interface GitRepositoryFacts {
    branch?: string;
}

export interface SessionSummary {
    id: string;
    archived: boolean;
    shared?: SessionSharedMetadata;
    projectId: string;
    workspaceId?: string;
    cwd: string;
    draft?: string;
    draftUpdatedAt?: number;
    providerId: string;
    modelId: string;
    /** Absent for a session with no place in an ordered list, such as a subagent. */
    orderKey?: string;
    permissionMode: string;
    effort?: string;
    serviceTier?: string;
    status: SessionStatus;
    title?: string;
    titleError?: string;
    titleStatus: string;
    recap?: string;
    sessionTokenCount?: SessionTokenCount;
    metadataUpdatedAt?: number;
    metadataRunId?: string;
    createdAt: number;
    updatedAt: number;
    lastMessageAt?: number;
    lastEventId?: EventId;
    /** The session's current activity wait, present while the agent is inside a scheduled wait. */
    wait?: SessionActivityWait;
    /** Whether the daemon keeps unread state for this chat at all. */
    trackUnread?: boolean;
    unread?: SessionUnreadState;
    inboxItems?: readonly InboxUserInput[];
}

export interface RemoteTerminalSummary {
    cols: number;
    epoch: string;
    exitCode: number | null;
    id: string;
    rows: number;
    status: "exited" | "running";
}

export interface RemoteTerminalGroupState {
    projectId: string;
    workspaceId?: string;
    terminals: readonly RemoteTerminalSummary[];
}

/** One presence state the user can be in. */
export interface PresenceSummary {
    /** How long a question may wait for an answer. `null` waits indefinitely, `0` never waits. */
    answerWaitMs: number | null;
    emoji: string;
    id: string;
    prompt: string;
    title: string;
}

/** Where the user is right now, and everything they can switch to. */
export interface PresenceSnapshot {
    /** When the current presence expires and the fallback takes over, when that is known. */
    changesAt?: number;
    fallbackPresenceId?: string;
    presence: PresenceSummary;
    presences: readonly PresenceSummary[];
    since: number;
}

export interface PluginAppContribution {
    appId: string;
    generation: string;
    id: string;
    page: string;
    pluginFolder: string;
    resourceUri: string;
    resources: readonly {
        mimeType: string;
        path: string;
        size: number;
        uri: string;
    }[];
    sidebar: {
        icon?: string;
        label: string;
        order: number;
    };
    title: string;
    tools: readonly {
        _meta: {
            ui: {
                resourceUri: string;
                visibility: readonly ("app" | "model")[];
            };
        };
        description: string;
        name: string;
        server: string;
    }[];
}

const exact = { additionalProperties: false } as const;
export const PROJECT_WORKSPACE_ERROR_MAX_LENGTH = 500;

const projectGitFactsSchema = Type.Object(
    {
        ahead: Type.Number(),
        behind: Type.Number(),
        branch: Type.Optional(Type.String()),
        detached: Type.Boolean(),
        head: Type.Optional(Type.String()),
        upstream: Type.Optional(Type.String()),
    },
    exact,
);

const projectWorkspaceComputeSchema = Type.Union([
    Type.Object(
        {
            generation: Type.Integer({ minimum: 1 }),
            type: Type.Literal("local"),
        },
        exact,
    ),
    Type.Object(
        {
            generation: Type.Integer({ minimum: 1 }),
            image: Type.String({ minLength: 1 }),
            type: Type.Literal("docker"),
        },
        exact,
    ),
]);

/** The exact worktree entity Rig sends over its protocol. */
export const projectWorkspaceSchema = Type.Object(
    {
        archivedAt: Type.Optional(Type.Number()),
        baseCommit: Type.Optional(Type.String()),
        baseRef: Type.Optional(Type.String()),
        createdAt: Type.Number(),
        error: Type.Optional(Type.String({ maxLength: PROJECT_WORKSPACE_ERROR_MAX_LENGTH })),
        git: Type.Optional(projectGitFactsSchema),
        gitCommonDir: Type.String(),
        id: Type.String({ minLength: 1 }),
        kind: Type.Literal("git_worktree"),
        name: Type.String(),
        orderKey: Type.String(),
        path: Type.String(),
        presence: Type.Union([Type.Literal("present"), Type.Literal("missing")]),
        projectId: Type.String({ minLength: 1 }),
        status: Type.Union([
            Type.Literal("initializing"),
            Type.Literal("ready"),
            Type.Literal("failed"),
            Type.Literal("archiving"),
            Type.Literal("archived"),
        ]),
        storageKey: Type.String(),
        title: Type.Optional(Type.String()),
        updatedAt: Type.Number(),
        version: Type.Number(),
    },
    exact,
);

/** A worktree inside a project. */
export type ProjectWorkspace = Static<typeof projectWorkspaceSchema>;

export const projectSchema = Type.Object(
    {
        archivedAt: Type.Optional(Type.Number()),
        avatar: Type.Optional(
            Type.Object(
                {
                    hash: Type.String(),
                    height: Type.Number(),
                    mediaType: Type.Literal("image/webp"),
                    source: Type.Union([
                        Type.Literal("repository"),
                        Type.Literal("hosting"),
                        Type.Literal("user"),
                    ]),
                    url: Type.String(),
                    width: Type.Number(),
                },
                exact,
            ),
        ),
        avatarBuiltin: Type.Optional(Type.Literal("home")),
        createdAt: Type.Number(),
        defaultBranch: Type.Optional(Type.String()),
        git: Type.Optional(projectGitFactsSchema),
        id: Type.String({ minLength: 1 }),
        initializationAttempt: Type.Integer({ minimum: 0 }),
        initializationError: Type.Optional(Type.String()),
        initializationStatus: Type.Union([
            Type.Literal("initializing"),
            Type.Literal("ready"),
            Type.Literal("failed"),
        ]),
        kind: Type.Union([Type.Literal("regular"), Type.Literal("home")]),
        name: Type.String(),
        nameSource: Type.Union([
            Type.Literal("folder"),
            Type.Literal("git_remote"),
            Type.Literal("user"),
        ]),
        orderKey: Type.String(),
        path: Type.String(),
        presence: Type.Union([Type.Literal("present"), Type.Literal("missing")]),
        settings: Type.Object(
            {
                defaultWorkspaceCompute: Type.Optional(projectWorkspaceComputeSchema),
            },
            exact,
        ),
        storageKey: Type.String(),
        updatedAt: Type.Number(),
        version: Type.Number(),
        worktreeSupport: Type.Union([
            Type.Literal("supported"),
            Type.Literal("unsupported"),
            Type.Literal("unknown"),
        ]),
        worktreeSupportReason: Type.Optional(Type.String()),
    },
    exact,
);

export const projectResponseSchema = Type.Object({ project: projectSchema }, exact);

export const projectRegistrationErrorCodeSchema = Type.Union([
    Type.Literal("invalid_request"),
    Type.Literal("path_missing"),
    Type.Literal("not_directory"),
    Type.Literal("path_inaccessible"),
    Type.Literal("not_git_repository"),
    Type.Literal("not_git_top_level"),
    Type.Literal("project_id_conflict"),
    Type.Literal("managed_workspace_unavailable"),
]);
export type ProjectRegistrationErrorCode = Static<typeof projectRegistrationErrorCodeSchema>;

export const projectRegistrationErrorResponseSchema = Type.Object(
    {
        error: Type.Object(
            {
                code: projectRegistrationErrorCodeSchema,
                message: Type.String({ minLength: 1 }),
            },
            exact,
        ),
    },
    exact,
);
const pluginResourcePathSchema = Type.String({
    maxLength: 160,
    minLength: 1,
    pattern: "^(?!/)(?!.*//)(?!.*(?:^|/)\\.{1,2}(?:/|$))(?!.*\\\\)[A-Za-z0-9][A-Za-z0-9._/-]*$",
});
const pluginResourceUriSchema = Type.String({
    pattern: "^ui://[^/?#]+/[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?/[A-Za-z0-9][A-Za-z0-9._/-]*$",
});

/**
 * Browser-safe runtime boundary for the locally re-declared plugin catalog.
 *
 * `protocolConformance.test.ts` pins the corresponding TypeScript interface to Rig's daemon
 * declaration. This schema deliberately lives here rather than importing the Node-oriented plugin
 * SDK into the browser client.
 */
export const pluginAppContributionSchema = Type.Object(
    {
        appId: Type.String({
            maxLength: 64,
            minLength: 1,
            pattern: "^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$",
        }),
        generation: Type.String({ minLength: 1 }),
        id: Type.String({ minLength: 1 }),
        page: pluginResourcePathSchema,
        pluginFolder: Type.String({ minLength: 1 }),
        resourceUri: pluginResourceUriSchema,
        resources: Type.Array(
            Type.Object(
                {
                    mimeType: Type.String(),
                    path: pluginResourcePathSchema,
                    size: Type.Integer({ maximum: 256 * 1024, minimum: 0 }),
                    uri: pluginResourceUriSchema,
                },
                exact,
            ),
            { maxItems: 64, minItems: 1 },
        ),
        sidebar: Type.Object(
            {
                icon: Type.Optional(pluginResourcePathSchema),
                label: Type.String({ maxLength: 64, minLength: 1 }),
                order: Type.Integer({ maximum: 1_000, minimum: -1_000 }),
            },
            exact,
        ),
        title: Type.String({ maxLength: 128, minLength: 1 }),
        tools: Type.Array(
            Type.Object(
                {
                    _meta: Type.Object(
                        {
                            ui: Type.Object(
                                {
                                    resourceUri: pluginResourceUriSchema,
                                    visibility: Type.Array(
                                        Type.Union([Type.Literal("model"), Type.Literal("app")]),
                                        { maxItems: 2, minItems: 1, uniqueItems: true },
                                    ),
                                },
                                exact,
                            ),
                        },
                        exact,
                    ),
                    description: Type.String({ minLength: 1 }),
                    name: Type.String({ minLength: 1 }),
                    server: Type.String({ minLength: 1 }),
                },
                exact,
            ),
        ),
    },
    exact,
);

export const pluginCategorySchema = Type.Union([
    Type.Literal("automation"),
    Type.Literal("collaboration"),
    Type.Literal("data"),
    Type.Literal("developer-tools"),
    Type.Literal("media"),
    Type.Literal("productivity"),
    Type.Literal("utilities"),
    Type.Literal("other"),
]);
export type PluginCategory = Static<typeof pluginCategorySchema>;

export const pluginIconSchema = Type.Object(
    {
        generation: Type.String({
            maxLength: 64,
            minLength: 64,
            pattern: "^[a-f0-9]{64}$",
        }),
        mediaType: Type.Literal("image/png"),
        size: Type.Integer({ maximum: 4 * 1024 * 1024, minimum: 1 }),
    },
    exact,
);
export type PluginIcon = Static<typeof pluginIconSchema>;

export const pluginSummarySchema = Type.Object(
    {
        apps: Type.Array(pluginAppContributionSchema, { maxItems: 8 }),
        author: Type.String({
            maxLength: 80,
            minLength: 1,
            pattern:
                "^(?!\\s)(?!.*\\s$)[^\\x00-\\x1F\\x7F-\\x9F\\u061C\\u200E\\u200F\\u202A-\\u202E\\u2066-\\u2069]+$",
        }),
        category: pluginCategorySchema,
        compute: Type.Optional(Type.Unknown()),
        dataDirectory: Type.String({ minLength: 1 }),
        description: Type.String({ maxLength: 512, minLength: 1 }),
        directory: Type.String({ minLength: 1 }),
        error: Type.Optional(Type.String()),
        folder: Type.String({ minLength: 1 }),
        icon: pluginIconSchema,
        logAvailable: Type.Boolean(),
        name: Type.String({ maxLength: 128, minLength: 1 }),
        status: Type.Union([
            Type.Literal("failed"),
            Type.Literal("running"),
            Type.Literal("stopped"),
        ]),
        statusMessage: Type.Optional(Type.String()),
        version: Type.String({ minLength: 1 }),
    },
    exact,
);
type ValidatedPluginSummary = Static<typeof pluginSummarySchema>;
export type PluginSummary = Omit<ValidatedPluginSummary, "apps"> & {
    readonly apps: readonly PluginAppContribution[];
};

export interface PluginLogSnapshot {
    error?: string;
    folder: string;
    name: string;
    source: "current_run" | "error";
    status: PluginSummary["status"];
    text: string;
    truncated: boolean;
    updatedAt: number;
}

export const listPluginsResponseSchema = Type.Object(
    {
        cursor: Type.String({ minLength: 1 }),
        failures: Type.Array(
            Type.Object(
                {
                    error: Type.String(),
                    folder: Type.String({ minLength: 1 }),
                },
                exact,
            ),
        ),
        plugins: Type.Array(pluginSummarySchema),
        version: Type.String({ minLength: 1 }),
    },
    exact,
);
type ValidatedListPluginsResponse = Static<typeof listPluginsResponseSchema>;
export type ListPluginsResponse = Omit<ValidatedListPluginsResponse, "failures" | "plugins"> & {
    readonly failures: readonly { error: string; folder: string }[];
    readonly plugins: readonly PluginSummary[];
};

export interface PluginLogResponse {
    log: PluginLogSnapshot;
}

export const pluginInstallClassificationSchema = Type.Union([
    Type.Literal("fresh-install"),
    Type.Literal("upgrade"),
    Type.Literal("downgrade"),
    Type.Literal("reinstall"),
]);
export type PluginInstallClassification = Static<typeof pluginInstallClassificationSchema>;

const pluginVersionSchema = Type.String({
    pattern:
        "^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-((?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)(?:\\.(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$",
});
const githubRepositorySchema = Type.String({
    maxLength: 201,
    pattern: "^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,99})/[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$",
});
const githubGitRefSchema = Type.String({
    maxLength: 1024,
    minLength: 1,
    pattern: "^(?!/)(?!.*//)(?!.*(?:^|/)\\.{1,2}(?:/|$))[A-Za-z0-9._/-]*[A-Za-z0-9._-]$",
});
const githubRevisionSchema = Type.String({
    maxLength: 40,
    minLength: 40,
    pattern: "^[a-f0-9]{40}$",
});
const githubPluginCatalogIdSchema = Type.String({
    maxLength: 64,
    minLength: 64,
    pattern: "^[a-f0-9]{64}$",
});
export const githubPluginCatalogEntrySchema = Type.Object(
    {
        description: Type.String({ maxLength: 4096, minLength: 1 }),
        displayName: Type.String({ maxLength: 128, minLength: 1 }),
        name: Type.String({
            maxLength: 128,
            minLength: 1,
            pattern: "^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,127})$",
        }),
        path: Type.String({
            maxLength: 1024,
            minLength: 1,
            pattern:
                "^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$))(?!.*(?:^|/)\\.(?:/|$))(?!.*\\\\)(?:[^/]+/)*[^/]+$",
        }),
        version: pluginVersionSchema,
    },
    exact,
);
export type GitHubPluginCatalogEntry = Static<typeof githubPluginCatalogEntrySchema>;

export const githubPluginPackageSourceSchema = Type.Object(
    {
        catalogId: githubPluginCatalogIdSchema,
        plugin: githubPluginCatalogEntrySchema,
        ref: Type.Optional(githubGitRefSchema),
        repository: githubRepositorySchema,
        revision: githubRevisionSchema,
        type: Type.Literal("github"),
    },
    exact,
);
export type GitHubPluginPackageSource = Static<typeof githubPluginPackageSourceSchema>;

export const githubPluginCatalogSchema = Type.Object(
    {
        catalogId: githubPluginCatalogIdSchema,
        plugins: Type.Array(
            Type.Object(
                {
                    availability: Type.Union([
                        Type.Literal("not-installed"),
                        Type.Literal("update-available"),
                        Type.Literal("downgrade-available"),
                        Type.Literal("reinstall-available"),
                    ]),
                    description: githubPluginCatalogEntrySchema.properties.description,
                    displayName: githubPluginCatalogEntrySchema.properties.displayName,
                    installed: Type.Optional(
                        Type.Object(
                            {
                                folder: Type.String({ maxLength: 128, minLength: 1 }),
                                name: Type.String({ maxLength: 128, minLength: 1 }),
                                version: pluginVersionSchema,
                            },
                            exact,
                        ),
                    ),
                    name: githubPluginCatalogEntrySchema.properties.name,
                    source: githubPluginPackageSourceSchema,
                    version: pluginVersionSchema,
                },
                exact,
            ),
            { maxItems: 1_000 },
        ),
        ref: Type.Optional(githubGitRefSchema),
        repository: githubRepositorySchema,
        revision: githubRevisionSchema,
    },
    exact,
);
export type GitHubPluginCatalog = Static<typeof githubPluginCatalogSchema>;

export const discoverPluginCatalogRequestSchema = Type.Object(
    { ref: Type.Optional(githubGitRefSchema), repository: githubRepositorySchema },
    exact,
);
export type DiscoverPluginCatalogRequest = Static<typeof discoverPluginCatalogRequestSchema>;

export const installPluginRequestSchema = Type.Object(
    {
        requestId: Type.String({ maxLength: 256, minLength: 1 }),
        source: Type.Union([
            Type.Object(
                {
                    sourceDirectory: Type.String({ maxLength: 16_384, minLength: 1 }),
                    type: Type.Literal("local-directory"),
                },
                exact,
            ),
            githubPluginPackageSourceSchema,
        ]),
    },
    exact,
);
export type InstallPluginRequest = Static<typeof installPluginRequestSchema>;

export interface InstalledPluginSummary {
    classification: PluginInstallClassification;
    description: string;
    directory: string;
    folder: string;
    name: string;
    version: string;
}

export interface UninstalledPluginSummary {
    dataDirectory: string;
    folder: string;
    name: string;
}

export interface InstallPluginResponse {
    plugin: InstalledPluginSummary;
}

export interface UninstallPluginResponse {
    plugin: UninstalledPluginSummary;
}

export type PluginManagementErrorCode =
    | "catalog_invalid"
    | "catalog_not_found"
    | "install_failed"
    | "invalid_request"
    | "plugin_not_found"
    | "plugins_unavailable"
    | "repository_not_found"
    | "source_changed"
    | "source_unavailable"
    | "uninstall_failed";

export type PluginCatalogErrorCode =
    | "catalog_invalid"
    | "catalog_not_found"
    | "invalid_request"
    | "plugins_unavailable"
    | "repository_not_found"
    | "source_changed"
    | "source_unavailable";

export interface PluginManagementErrorResponse {
    error: {
        code: PluginManagementErrorCode;
        message: string;
    };
}

/** The catalog snapshot returned by `GET /catalog`. */
export interface GlobalStreamHello {
    catalog: ModelCatalog;
    cursor: string;
    identity: DaemonIdentity;
    presence: PresenceSnapshot;
    protocolVersion: number;
    projects: readonly Project[];
    terminalGroups: readonly RemoteTerminalGroupState[];
    workspaces: readonly ProjectWorkspace[];
    sessions: readonly SessionSummary[];
    sessionsComplete: boolean;
}

/** How much of Rig one timeline covers. */
export type TimelineScope =
    | { kind: "global" }
    | { kind: "project"; projectId: string }
    | { kind: "session"; sessionId: string }
    | { kind: "workspace"; projectId: string; workspaceId: string };

export type TimelineSpanKind = "asking" | "waiting" | "working";

export type TimelineSpanOutcome =
    | "aborted"
    | "answered"
    | "cancelled"
    | "completed"
    | "error"
    | "interrupted";

export interface TimelineSpan {
    startedAt: number;
    endedAt?: number;
    kind: TimelineSpanKind;
    outcome?: TimelineSpanOutcome;
    requestId?: string;
    runId?: string;
}

export interface TimelineAgent {
    agentId: string;
    createdAt: number;
    depth: number;
    label: string;
    modelId: string;
    parentSessionId?: string;
    parentToolCallId?: string;
    projectId: string;
    providerId: string;
    sessionId: string;
    spans: readonly TimelineSpan[];
    type: "primary" | "subagent";
    workspaceId?: string;
}

export interface GetTimelineRequest {
    includeArchived?: boolean;
    scope: TimelineScope;
    since?: number;
}

/** The chart snapshot returned by `POST /timeline`. */
export interface GetTimelineResponse {
    agents: readonly TimelineAgent[];
    cursor: string;
    scope: TimelineScope;
}

export interface BaseGlobalEvent<TType extends string, TData> {
    createdAt: number;
    data: TData;
    id: string;
    projectId: string;
    type: TType;
    workspaceId?: string;
}

export interface ComputePreparationEvent {
    computeInstanceId: string;
    createdAt: number;
    data: {
        elapsedMs?: number;
        error?:
            | {
                  code: "capacity_exhausted" | "deadline_exceeded";
                  message: string;
                  retryable: true;
                  state?:
                      | "unprovisioned"
                      | "provisioning"
                      | "ready"
                      | "unavailable"
                      | "failed"
                      | "stopped";
              }
            | {
                  code: "preparing_compute";
                  elapsedMs?: number;
                  lastProgressAt?: number;
                  message: string;
                  percent?: number;
                  phase?: string;
                  retryable: true;
                  startedAt?: number;
                  state: "unprovisioned" | "provisioning" | "unavailable";
              }
            | {
                  code:
                      | "invalid_request"
                      | "invalid_response"
                      | "instance_failed"
                      | "instance_not_found"
                      | "provider_lost"
                      | "provider_not_found"
                      | "provider_unhealthy";
                  message: string;
                  retryable: false;
                  state?:
                      | "unprovisioned"
                      | "provisioning"
                      | "ready"
                      | "unavailable"
                      | "failed"
                      | "stopped";
              };
        lastProgressAt?: number;
        message: string;
        percent?: number;
        phase: string;
        provider: string;
        startedAt?: number;
        state: ComputePreparationNotice["state"];
    };
    id: string;
    type: "compute_preparation";
}

export const murmurFriendshipEventDirectionSchema = Type.Union([
    Type.Literal("incoming"),
    Type.Literal("outgoing"),
    Type.Literal("mutual"),
]);
export type MurmurFriendshipEventDirection = Static<typeof murmurFriendshipEventDirectionSchema>;

export const murmurFriendshipChangedReasonSchema = Type.Union([
    Type.Literal("request_received"),
    Type.Literal("request_sent"),
    Type.Literal("accepted"),
    Type.Literal("rejected"),
    Type.Literal("auto_accepted"),
    Type.Literal("profile_updated"),
]);
export type MurmurFriendshipChangedReason = Static<typeof murmurFriendshipChangedReasonSchema>;

export const murmurFriendshipEventStateSchema = Type.Union([
    Type.Literal("incoming_pending"),
    Type.Literal("outgoing_pending"),
    Type.Literal("friends"),
    Type.Literal("rejected_incoming"),
    Type.Literal("rejected_outgoing"),
]);
export type MurmurFriendshipEventState = Static<typeof murmurFriendshipEventStateSchema>;

export const murmurFriendshipChangedEventSchema = Type.Object(
    {
        createdAt: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 }),
        data: Type.Object(
            {
                direction: murmurFriendshipEventDirectionSchema,
                reason: murmurFriendshipChangedReasonSchema,
                state: murmurFriendshipEventStateSchema,
            },
            { additionalProperties: false },
        ),
        id: Type.String({ maxLength: 256, minLength: 1 }),
        murmurPeerId: Type.String({ maxLength: 256, minLength: 1 }),
        type: Type.Literal("murmur_friendship_changed"),
    },
    { additionalProperties: false },
);
export type MurmurFriendshipChangedEvent = Static<typeof murmurFriendshipChangedEventSchema>;

/**
 * One member's capabilities changed on a share this daemon owns or replicates.
 *
 * Light and live-only: capability metadata alone, never terminal bytes, so one
 * frame is enough for a client to reconcile a revoke without a bulk payload.
 * Keyed by `shareId`/`shareMemberId` inside `data`, the way every session-share
 * entity is, not by session.
 */
export const sessionShareCapabilitiesChangedEventSchema = Type.Object(
    {
        createdAt: sessionShareTimestampSchema,
        data: Type.Object(
            {
                capabilities: Type.Array(sessionSharePeerCapabilitySchema, { maxItems: 16 }),
                capabilitiesDescription: Type.String({ maxLength: 512, minLength: 1 }),
                memberState: sessionShareMemberStateSchema,
                shareId: sessionShareIdentifierSchema,
                shareMemberId: sessionShareIdentifierSchema,
            },
            sessionShareExact,
        ),
        id: sessionShareIdentifierSchema,
        type: Type.Literal("session_share_capabilities_changed"),
    },
    sessionShareExact,
);
export type SessionShareCapabilitiesChangedEvent = Static<
    typeof sessionShareCapabilitiesChangedEventSchema
>;

export const p2pPeerConnectionStatusSchema = Type.Union([
    Type.Literal("connecting"),
    Type.Literal("connected"),
    Type.Literal("unreachable"),
]);
export const p2pPeerStatusSchema = Type.Object(
    {
        address: Type.String({ minLength: 1 }),
        error: Type.Optional(Type.String()),
        lastSeenAt: Type.Optional(Type.Number()),
        name: Type.Optional(Type.String({ maxLength: 128, minLength: 1 })),
        peerId: Type.Optional(
            Type.String({
                maxLength: 32,
                minLength: 2,
                pattern: "^[a-z][a-z0-9]+$",
            }),
        ),
        publicKey: Type.Optional(
            Type.String({
                maxLength: 43,
                minLength: 43,
                pattern: "^[A-Za-z0-9_-]+$",
            }),
        ),
        rttMs: Type.Optional(Type.Number({ minimum: 0 })),
        status: p2pPeerConnectionStatusSchema,
    },
    { additionalProperties: false },
);
export const p2pTransportKindSchema = Type.Union([
    Type.Literal("direct"),
    Type.Literal("iroh"),
    Type.Literal("ssh"),
]);
export const p2pTransportStatusSchema = Type.Union([
    Type.Object(
        {
            error: Type.String({ minLength: 1 }),
            state: Type.Literal("unavailable"),
            transport: p2pTransportKindSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            apiExposed: Type.Optional(Type.Boolean()),
            localAddress: Type.String({ minLength: 1 }),
            peers: Type.Array(p2pPeerStatusSchema),
            relayUrl: Type.Optional(Type.String({ minLength: 1 })),
            state: Type.Literal("ready"),
            transport: Type.Literal("iroh"),
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            apiExposed: Type.Optional(Type.Boolean()),
            localAddress: Type.Optional(Type.String({ minLength: 1 })),
            peers: Type.Array(p2pPeerStatusSchema),
            state: Type.Literal("ready"),
            transport: Type.Literal("direct"),
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            direction: Type.Literal("outbound"),
            peers: Type.Array(p2pPeerStatusSchema),
            state: Type.Literal("ready"),
            transport: Type.Literal("ssh"),
        },
        { additionalProperties: false },
    ),
]);
export const p2pStatusSchema = Type.Object(
    {
        instanceId: Type.Optional(
            Type.String({
                maxLength: 32,
                minLength: 2,
                pattern: "^[a-z][a-z0-9]+$",
            }),
        ),
        name: Type.Optional(Type.String({ maxLength: 128, minLength: 1 })),
        publicKey: Type.Optional(
            Type.String({
                maxLength: 43,
                minLength: 43,
                pattern: "^[A-Za-z0-9_-]+$",
            }),
        ),
        transports: Type.Array(p2pTransportStatusSchema),
    },
    { additionalProperties: false },
);
export type P2pStatus = Static<typeof p2pStatusSchema>;

const p2pPairingInstanceIdSchema = Type.String({
    maxLength: 32,
    minLength: 2,
    pattern: "^[a-z][a-z0-9]+$",
});
const p2pPairingPublicKeySchema = Type.String({
    maxLength: 43,
    minLength: 43,
    pattern: "^[A-Za-z0-9_-]+$",
});

export const createP2pInvitationResponseSchema = Type.Object(
    {
        id: p2pPairingInstanceIdSchema,
        invitation: Type.String({ maxLength: 8_192, minLength: 1 }),
    },
    { additionalProperties: false },
);
export type CreateP2pInvitationResponse = Static<typeof createP2pInvitationResponseSchema>;

export const joinP2pInvitationResponseSchema = Type.Object(
    { id: p2pPairingInstanceIdSchema },
    { additionalProperties: false },
);
export type JoinP2pInvitationResponse = Static<typeof joinP2pInvitationResponseSchema>;

export const p2pPairingPeerSchema = Type.Object(
    {
        instanceId: p2pPairingInstanceIdSchema,
        name: Type.String({
            maxLength: 128,
            minLength: 1,
            pattern: "^[^\\u0000-\\u001f\\u007f]+$",
        }),
        publicKey: p2pPairingPublicKeySchema,
    },
    { additionalProperties: false },
);
const p2pPairingBase = {
    expiresAt: Type.Integer({ minimum: 0 }),
    id: p2pPairingInstanceIdSchema,
    role: Type.Union([Type.Literal("inviter"), Type.Literal("joiner")]),
};
export const p2pPairingStateSchema = Type.Union([
    Type.Object(
        {
            ...p2pPairingBase,
            phase: Type.Union([Type.Literal("connecting"), Type.Literal("waiting")]),
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...p2pPairingBase,
            emojis: Type.Tuple([Type.String(), Type.String(), Type.String(), Type.String()]),
            peer: p2pPairingPeerSchema,
            phase: Type.Literal("verifying"),
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...p2pPairingBase,
            peer: p2pPairingPeerSchema,
            phase: Type.Literal("connected"),
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...p2pPairingBase,
            error: Type.Optional(Type.String({ maxLength: 1_024, minLength: 1 })),
            phase: Type.Union([
                Type.Literal("expired"),
                Type.Literal("failed"),
                Type.Literal("rejected"),
            ]),
        },
        { additionalProperties: false },
    ),
]);
export type P2pPairingState = Static<typeof p2pPairingStateSchema>;
export const p2pStatusChangedEventSchema = Type.Object(
    {
        createdAt: Type.Number(),
        data: Type.Object({ status: p2pStatusSchema }, { additionalProperties: false }),
        id: Type.String({ minLength: 1 }),
        type: Type.Literal("p2p_status_changed"),
    },
    { additionalProperties: false },
);
export type P2pStatusChangedEvent = Static<typeof p2pStatusChangedEventSchema>;

export type GlobalEvent =
    | ComputePreparationEvent
    | HappyCloudChangedEvent
    | P2pStatusChangedEvent
    | SessionShareCapabilitiesChangedEvent
    | BaseGlobalEvent<"project_created", { mutationId?: MutationId; project: Project }>
    | BaseGlobalEvent<"project_updated", { mutationId?: MutationId; project: Project }>
    | BaseGlobalEvent<"workspace_created", { mutationId?: MutationId; workspace: ProjectWorkspace }>
    | BaseGlobalEvent<"workspace_updated", { mutationId?: MutationId; workspace: ProjectWorkspace }>
    | BaseGlobalEvent<"project_git_changed", { git: GitChangeSnapshot }>
    | BaseGlobalEvent<"workspace_git_changed", { git: GitChangeSnapshot }>
    | BaseGlobalEvent<"remote_terminals_changed", { terminals: readonly RemoteTerminalSummary[] }>
    | BaseSessionEvent<"session_current", { session: SessionSummary }>
    | {
          createdAt: number;
          data: { presence: PresenceSnapshot };
          id: string;
          type: "presence_changed";
      }
    | {
          createdAt: number;
          data: {
              failures: readonly { error: string; folder: string }[];
              /**
               * Best-effort metadata that may be absent when another catalog change supersedes
               * the installation event before publication.
               */
              installation?: InstalledPluginSummary;
              plugins: readonly PluginSummary[];
              version: string;
          };
          id: string;
          type: "plugins_changed";
      }
    | {
          createdAt: number;
          data: { entries: readonly SlotEntry[] };
          id: string;
          type: "slots_changed";
      }
    | {
          createdAt: number;
          data: { webapps: readonly Webapp[] };
          id: string;
          type: "webapps_changed";
      }
    | MurmurFriendshipChangedEvent
    | SessionEvent;

/** The fixed Happy UI locations an agent can plug content into. */
export type SlotName = "above-composer" | "sidebar" | "status-line" | "title";

export type SlotScope = "everywhere" | "project" | "session" | "workspace";

export type SlotAction =
    | { message: string; type: "send-current-chat" }
    | {
          path?: string;
          query?: Record<string, string>;
          type: "open-webapp";
          webapp: string;
      }
    | { message: string; sessionId: string; type: "send-chat" }
    | { message: string; sessionId: string; type: "draft-chat" }
    | {
          effort?: string;
          model?: string;
          projectId?: string;
          prompt?: string;
          provider?: string;
          readOnly?: boolean;
          serviceTier?: "fast";
          title?: string;
          type: "new-chat";
          workspaceId?: string;
      };

export type SlotContent =
    | { markdown: string; type: "text" }
    | { action: SlotAction; label: string; type: "button" };

export type SlotEntryAuthor =
    | { sessionId: string; type: "agent" }
    | { folder: string; name: string; type: "plugin" };

export interface SlotEntry {
    author: SlotEntryAuthor;
    content: SlotContent;
    createdAt: number;
    description: string;
    id: string;
    projectId?: string;
    purpose: string;
    scope: SlotScope;
    sessionId?: string;
    slot: SlotName;
    updatedAt: number;
}

export interface WebappVersion {
    changeDescription: string;
    createdAt: number;
    version: number;
}

/** An imported, versioned webapp whose current version rig serves as static files. */
export interface Webapp {
    allowedScopes: readonly SlotScope[];
    authorSessionId: string;
    createdAt: number;
    currentVersion: number;
    description: string;
    iconThumbhash: string;
    iconUrl: string;
    name: string;
    purpose: string;
    sourceDescription?: string;
    updatedAt: number;
    versions: readonly WebappVersion[];
}

export interface ResolveWebappOpenRequest {
    path?: string;
    projectId?: string;
    query?: Record<string, string>;
    sessionId?: string;
    workspaceId?: string;
}

export interface ResolveWebappOpenResponse {
    url: string;
}

export interface WebappContext {
    projectId?: string;
    sessionId?: string;
    version: number;
    webapp: string;
    workspaceId?: string;
}

export interface MutationRequest {
    mutationId: MutationId;
}

export interface SendMessageMutationRequest extends MutationRequest {
    clientSubmissionId: MutationId;
    content?: readonly ContentBlock[];
    displayText?: string;
    text: string;
}

export interface SwitchModelMutationRequest extends MutationRequest {
    modelId: string;
    providerId?: string;
}

export interface RenameGroupMutationRequest extends MutationRequest {
    name: string;
}

/** One rate-limit or spend window a provider reports. */
export interface ProviderUsageWindow {
    usedPercent: number;
    resetsAt: number | null;
    startsAt: number | null;
    durationMs: number | null;
}

/** Money an account can still spend once its rate-limit window is used up. */
export interface ProviderUsageCredits {
    available: boolean;
    remainingCents: number | null;
    unlimited: boolean;
    usedPercent: number | null;
}

/** One reading of an account's usage, normalized across vendors. */
export interface ProviderUsage {
    providerId: string;
    vendor: "claude" | "codex" | "grok";
    capturedAt: number;
    planName: string | null;
    exhausted: boolean;
    windows: {
        fiveHour: ProviderUsageWindow | null;
        weekly: ProviderUsageWindow | null;
        monthly: ProviderUsageWindow | null;
    };
    credits: ProviderUsageCredits | null;
}

export interface ProviderUsageEntry {
    providerId: string;
    usage: ProviderUsage | null;
    checkedAt: number | null;
    error: string | null;
}

export interface ListProviderUsageResponse {
    providers: readonly ProviderUsageEntry[];
}

const happyCloudExact = { additionalProperties: false } as const;
const happyCloudTimestampSchema = Type.Integer({
    maximum: Number.MAX_SAFE_INTEGER,
    minimum: 0,
});
const happyCloudVersionSchema = Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 });
export const HAPPY_CLOUD_CIPHERTEXT_MAX_LENGTH = 2 * 1024 * 1024;
const happyCloudCiphertextSchema = Type.String({
    maxLength: HAPPY_CLOUD_CIPHERTEXT_MAX_LENGTH,
    minLength: 1,
    pattern: "^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-][AQgw]|[A-Za-z0-9_-]{2}[AEIMQUYcgkosw048])?$",
});
const happyCloudSessionIdSchema = Type.String({ maxLength: 256, minLength: 1 });
export const HAPPY_CLOUD_CONTRACT_VERSION = 1 as const;
export const happyCloudCapabilitySchema = Type.Union([
    Type.Literal("friends"),
    Type.Literal("group_chats"),
    Type.Literal("live_session_sharing"),
    Type.Literal("remote_control"),
    Type.Literal("session_blob_persistence"),
    Type.Literal("happy_profile"),
]);
export type HappyCloudCapability = Static<typeof happyCloudCapabilitySchema>;
export const happyCloudConsentSchema = Type.Union([
    Type.Literal("denied"),
    Type.Literal("granted"),
]);
export type HappyCloudConsent = Static<typeof happyCloudConsentSchema>;
export const happyCloudCapabilityStatusSchema = Type.Object(
    { changedAt: happyCloudTimestampSchema, consent: happyCloudConsentSchema },
    happyCloudExact,
);
export type HappyCloudCapabilityStatus = Static<typeof happyCloudCapabilityStatusSchema>;
export const happyCloudStatusSchema = Type.Object(
    {
        authority: Type.Literal("local_record_only"),
        capabilities: Type.Object(
            {
                friends: happyCloudCapabilityStatusSchema,
                group_chats: happyCloudCapabilityStatusSchema,
                happy_profile: happyCloudCapabilityStatusSchema,
                live_session_sharing: happyCloudCapabilityStatusSchema,
                remote_control: happyCloudCapabilityStatusSchema,
                session_blob_persistence: happyCloudCapabilityStatusSchema,
            },
            happyCloudExact,
        ),
        contractVersion: Type.Literal(HAPPY_CLOUD_CONTRACT_VERSION),
        enrollment: Type.Object(
            {
                changedAt: happyCloudTimestampSchema,
                state: Type.Union([Type.Literal("not_enrolled"), Type.Literal("enrolled")]),
            },
            happyCloudExact,
        ),
        profile: Type.Object(
            {
                changedAt: happyCloudTimestampSchema,
                state: Type.Union([Type.Literal("not_created"), Type.Literal("created")]),
            },
            happyCloudExact,
        ),
        updatedAt: happyCloudTimestampSchema,
        version: happyCloudVersionSchema,
    },
    happyCloudExact,
);
export type HappyCloudStatus = Static<typeof happyCloudStatusSchema>;
export const happyCloudChangedEventSchema = Type.Object(
    {
        createdAt: happyCloudTimestampSchema,
        data: Type.Object(
            {
                mutationId: Type.String({ maxLength: 256, minLength: 1 }),
                version: happyCloudVersionSchema,
            },
            happyCloudExact,
        ),
        id: Type.String({ maxLength: 256, minLength: 1 }),
        type: Type.Literal("happy_cloud_changed"),
    },
    happyCloudExact,
);
export type HappyCloudChangedEvent = Static<typeof happyCloudChangedEventSchema>;
const happyCloudCommandBase = {
    contractVersion: Type.Literal(HAPPY_CLOUD_CONTRACT_VERSION),
    expectedVersion: happyCloudVersionSchema,
    mutationId: Type.String({ maxLength: 256, minLength: 1 }),
};
export const happyCloudCommandSchema = Type.Union([
    Type.Object(
        {
            ...happyCloudCommandBase,
            action: Type.Literal("set_enrollment"),
            state: Type.Union([Type.Literal("not_enrolled"), Type.Literal("enrolled")]),
        },
        happyCloudExact,
    ),
    Type.Object(
        {
            ...happyCloudCommandBase,
            action: Type.Literal("set_capability"),
            capability: happyCloudCapabilitySchema,
            consent: happyCloudConsentSchema,
        },
        happyCloudExact,
    ),
    Type.Object(
        {
            ...happyCloudCommandBase,
            action: Type.Literal("put_profile"),
            ciphertext: happyCloudCiphertextSchema,
        },
        happyCloudExact,
    ),
    Type.Object(
        { ...happyCloudCommandBase, action: Type.Literal("delete_profile") },
        happyCloudExact,
    ),
    Type.Object(
        {
            ...happyCloudCommandBase,
            action: Type.Literal("put_session_blob"),
            ciphertext: happyCloudCiphertextSchema,
            sessionId: happyCloudSessionIdSchema,
        },
        happyCloudExact,
    ),
    Type.Object(
        {
            ...happyCloudCommandBase,
            action: Type.Literal("delete_session_blob"),
            sessionId: happyCloudSessionIdSchema,
        },
        happyCloudExact,
    ),
]);
export type HappyCloudCommand = Static<typeof happyCloudCommandSchema>;
export const happyCloudCommandResponseSchema = Type.Object(
    { status: happyCloudStatusSchema },
    happyCloudExact,
);
export type HappyCloudCommandResponse = Static<typeof happyCloudCommandResponseSchema>;
export const happyCloudCommandErrorResponseSchema = Type.Object(
    {
        code: Type.Union([
            Type.Literal("capability_not_granted"),
            Type.Literal("mutation_reused"),
            Type.Literal("not_enrolled"),
            Type.Literal("version_conflict"),
        ]),
        error: Type.String({ minLength: 1 }),
        status: happyCloudStatusSchema,
    },
    happyCloudExact,
);
export type HappyCloudCommandErrorResponse = Static<typeof happyCloudCommandErrorResponseSchema>;
export const happyCloudProfileCiphertextResponseSchema = Type.Object(
    { ciphertext: happyCloudCiphertextSchema, version: happyCloudVersionSchema },
    happyCloudExact,
);
export type HappyCloudProfileCiphertextResponse = Static<
    typeof happyCloudProfileCiphertextResponseSchema
>;
export const happyCloudSessionBlobResponseSchema = Type.Object(
    {
        ciphertext: happyCloudCiphertextSchema,
        sessionId: happyCloudSessionIdSchema,
        version: happyCloudVersionSchema,
    },
    happyCloudExact,
);
export type HappyCloudSessionBlobResponse = Static<typeof happyCloudSessionBlobResponseSchema>;

const murmurProtocolExact = { additionalProperties: false } as const;
const murmurBase64Schema = Type.String({
    maxLength: 32 * 1024 * 1024,
    minLength: 1,
    pattern: "^[A-Za-z0-9+/]*={0,2}$",
});
const murmurIdentifierSchema = Type.String({ maxLength: 256, minLength: 1 });
const murmurNameSchema = Type.String({ maxLength: 128, minLength: 1 });
const murmurProfileLastNameSchema = Type.String({ maxLength: 128 });
const murmurThumbhashSchema = Type.String({ maxLength: 1_024, minLength: 1 });
const murmurTimestampSchema = Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 });
const murmurTokenSchema = Type.String({ maxLength: 4_096, minLength: 1 });

export const murmurPhotoInputSchema = Type.Object(
    {
        data: murmurBase64Schema,
        mediaType: Type.String({ maxLength: 128, minLength: 1 }),
    },
    murmurProtocolExact,
);
export type MurmurPhotoInput = Static<typeof murmurPhotoInputSchema>;

export const murmurPhotoSchema = Type.Object(
    {
        bytes: Type.Integer({ maximum: 24 * 1024 * 1024, minimum: 0 }),
        data: murmurBase64Schema,
        height: Type.Integer({ maximum: 16_384, minimum: 1 }),
        mediaType: Type.Literal("image/webp"),
        thumbhash: murmurThumbhashSchema,
        width: Type.Integer({ maximum: 16_384, minimum: 1 }),
    },
    murmurProtocolExact,
);
export type MurmurPhoto = Static<typeof murmurPhotoSchema>;

export const murmurProfileSchema = Type.Object(
    {
        firstName: murmurNameSchema,
        lastName: murmurProfileLastNameSchema,
        photo: Type.Optional(murmurPhotoSchema),
    },
    murmurProtocolExact,
);
export type MurmurProfile = Static<typeof murmurProfileSchema>;

export const murmurAccountSchema = Type.Object(
    {
        id: murmurIdentifierSchema,
        profile: murmurProfileSchema,
        token: murmurTokenSchema,
    },
    murmurProtocolExact,
);
export type MurmurAccount = Static<typeof murmurAccountSchema>;

export const murmurServiceStateSchema = Type.Object(
    {
        relayUrls: Type.Array(Type.String({ maxLength: 2_048, minLength: 1 }), {
            maxItems: 16,
            uniqueItems: true,
        }),
        status: Type.Union([Type.Literal("running"), Type.Literal("stopped")]),
    },
    murmurProtocolExact,
);
export type MurmurServiceState = Static<typeof murmurServiceStateSchema>;

export const murmurFriendshipStateSchema = Type.Union([
    Type.Literal("incoming_pending"),
    Type.Literal("outgoing_pending"),
    Type.Literal("friends"),
    Type.Literal("rejected_incoming"),
    Type.Literal("rejected_outgoing"),
]);
export type MurmurFriendshipState = Static<typeof murmurFriendshipStateSchema>;

export const murmurFriendshipDirectionSchema = Type.Union([
    Type.Literal("incoming"),
    Type.Literal("outgoing"),
    Type.Literal("mutual"),
]);
export type MurmurFriendshipDirection = Static<typeof murmurFriendshipDirectionSchema>;

export const murmurFriendshipHistorySchema = Type.Object(
    {
        accepted: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 }),
        autoAccepted: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 }),
        received: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 }),
        rejected: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 }),
        sent: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 }),
    },
    murmurProtocolExact,
);
export type MurmurFriendshipHistory = Static<typeof murmurFriendshipHistorySchema>;

export const murmurFriendshipSchema = Type.Object(
    {
        answeredAt: Type.Optional(murmurTimestampSchema),
        autoAcceptEligible: Type.Boolean(),
        direction: murmurFriendshipDirectionSchema,
        firstSeenAt: murmurTimestampSchema,
        history: murmurFriendshipHistorySchema,
        peerId: murmurIdentifierSchema,
        profile: Type.Optional(murmurProfileSchema),
        requestId: Type.Optional(murmurIdentifierSchema),
        state: murmurFriendshipStateSchema,
        token: murmurTokenSchema,
        updatedAt: murmurTimestampSchema,
        version: murmurIdentifierSchema,
    },
    murmurProtocolExact,
);
export type MurmurFriendship = Static<typeof murmurFriendshipSchema>;

export const murmurFriendStatsSchema = Type.Object(
    {
        acceptedRequests: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 }),
        autoAcceptedRequests: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 }),
        contacts: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 }),
        incomingPending: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 }),
        outgoingPending: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 }),
        rejectedRequests: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 }),
    },
    murmurProtocolExact,
);
export type MurmurFriendStats = Static<typeof murmurFriendStatsSchema>;

export const getMurmurAccountResponseSchema = Type.Object(
    {
        account: Type.Optional(murmurAccountSchema),
        service: murmurServiceStateSchema,
    },
    murmurProtocolExact,
);
export type GetMurmurAccountResponse = Static<typeof getMurmurAccountResponseSchema>;

export const signupMurmurAccountRequestSchema = Type.Object(
    {
        firstName: murmurNameSchema,
        lastName: murmurNameSchema,
        photo: Type.Optional(murmurPhotoInputSchema),
    },
    murmurProtocolExact,
);
export type SignupMurmurAccountRequest = Static<typeof signupMurmurAccountRequestSchema>;

export const signupMurmurAccountResponseSchema = Type.Object(
    {
        account: murmurAccountSchema,
        service: murmurServiceStateSchema,
    },
    murmurProtocolExact,
);
export type SignupMurmurAccountResponse = Static<typeof signupMurmurAccountResponseSchema>;

export const startMurmurServiceRequestSchema = Type.Object(
    {
        relayUrls: Type.Optional(
            Type.Array(Type.String({ maxLength: 2_048, minLength: 1 }), {
                maxItems: 16,
                uniqueItems: true,
            }),
        ),
    },
    murmurProtocolExact,
);
export type StartMurmurServiceRequest = Static<typeof startMurmurServiceRequestSchema>;

export const startMurmurServiceResponseSchema = Type.Object(
    { service: murmurServiceStateSchema },
    murmurProtocolExact,
);
export type StartMurmurServiceResponse = Static<typeof startMurmurServiceResponseSchema>;

export const stopMurmurServiceResponseSchema = Type.Object(
    { service: murmurServiceStateSchema },
    murmurProtocolExact,
);
export type StopMurmurServiceResponse = Static<typeof stopMurmurServiceResponseSchema>;

export const deleteMurmurAccountResponseSchema = Type.Object(
    { deleted: Type.Boolean() },
    murmurProtocolExact,
);
export type DeleteMurmurAccountResponse = Static<typeof deleteMurmurAccountResponseSchema>;

export const sendMurmurFriendRequestRequestSchema = Type.Object(
    { token: murmurTokenSchema },
    murmurProtocolExact,
);
export type SendMurmurFriendRequestRequest = Static<typeof sendMurmurFriendRequestRequestSchema>;

export const sendMurmurFriendRequestResponseSchema = Type.Object(
    {
        friendship: murmurFriendshipSchema,
        queued: Type.Boolean(),
        recipientId: murmurIdentifierSchema,
        stats: murmurFriendStatsSchema,
    },
    murmurProtocolExact,
);
export type SendMurmurFriendRequestResponse = Static<typeof sendMurmurFriendRequestResponseSchema>;

export const murmurFriendRequestSchema = Type.Object(
    {
        id: murmurIdentifierSchema,
        profile: murmurProfileSchema,
        receivedAt: murmurTimestampSchema,
        senderId: murmurIdentifierSchema,
        senderToken: murmurTokenSchema,
    },
    murmurProtocolExact,
);
export type MurmurFriendRequest = Static<typeof murmurFriendRequestSchema>;

export const listMurmurFriendRequestsResponseSchema = Type.Object(
    {
        requests: Type.Array(murmurFriendRequestSchema, { maxItems: 10_000 }),
    },
    murmurProtocolExact,
);
export type ListMurmurFriendRequestsResponse = Static<
    typeof listMurmurFriendRequestsResponseSchema
>;

export const answerMurmurFriendRequestRequestSchema = Type.Object(
    {
        answer: Type.Union([Type.Literal("accept"), Type.Literal("reject")]),
    },
    murmurProtocolExact,
);
export type AnswerMurmurFriendRequestRequest = Static<
    typeof answerMurmurFriendRequestRequestSchema
>;

export const murmurContactSchema = Type.Object(
    {
        addedAt: murmurTimestampSchema,
        id: murmurIdentifierSchema,
        profile: murmurProfileSchema,
        token: murmurTokenSchema,
        updatedAt: murmurTimestampSchema,
    },
    murmurProtocolExact,
);
export type MurmurContact = Static<typeof murmurContactSchema>;

export const answerMurmurFriendRequestResponseSchema = Type.Object(
    {
        answer: Type.Union([Type.Literal("accept"), Type.Literal("reject")]),
        contact: Type.Optional(murmurContactSchema),
        friendship: murmurFriendshipSchema,
        stats: murmurFriendStatsSchema,
    },
    murmurProtocolExact,
);
export type AnswerMurmurFriendRequestResponse = Static<
    typeof answerMurmurFriendRequestResponseSchema
>;

export const listMurmurContactsResponseSchema = Type.Object(
    {
        contacts: Type.Array(murmurContactSchema, { maxItems: 10_000 }),
    },
    murmurProtocolExact,
);
export type ListMurmurContactsResponse = Static<typeof listMurmurContactsResponseSchema>;

export const getMurmurFriendsResponseSchema = Type.Object(
    {
        account: Type.Optional(murmurAccountSchema),
        contacts: Type.Array(murmurContactSchema, { maxItems: 10_000 }),
        friendships: Type.Array(murmurFriendshipSchema, { maxItems: 10_000 }),
        service: murmurServiceStateSchema,
        stats: murmurFriendStatsSchema,
    },
    murmurProtocolExact,
);
export type GetMurmurFriendsResponse = Static<typeof getMurmurFriendsResponseSchema>;
