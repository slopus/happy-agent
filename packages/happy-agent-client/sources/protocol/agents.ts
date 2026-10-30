/** Agents: one conversation running in a workspace, its transcript and its activity. */

import { type Static, Type } from "@sinclair/typebox";

import type {
    Cuid2,
    Effort,
    EventCursor,
    MessageMode,
    PermissionMode,
    ServiceTier,
    Timestamp,
} from "./common.js";
import {
    cuid2Schema,
    eventCursorSchema,
    Nullable,
    resourceVersionSchema,
    timestampSchema,
} from "./common.js";
import type { BackgroundProcess } from "./processes.js";
import type { CompactionMessage, Run, ServiceMessage } from "./messages.js";
import type { SlashCommandCatalog } from "./slashCommands.js";

export const MAX_AGENT_PROFILES = 256;
export const MAX_AGENT_PROFILE_ID_LENGTH = 512;
export const MAX_AGENT_PROFILE_NAME_LENGTH = 128;
export const MAX_AGENT_PROFILE_DESCRIPTION_LENGTH = 1_024;

/** One request profile offered by one focused agent. */
export const agentProfileSchema = Type.Object({
    /** The opaque value sent in a message's `profile` field. */
    id: Type.String({ minLength: 1, maxLength: MAX_AGENT_PROFILE_ID_LENGTH }),
    /** A short human-readable label. */
    name: Type.String({ minLength: 1, maxLength: MAX_AGENT_PROFILE_NAME_LENGTH }),
    /** A concise explanation of when to use the profile. */
    description: Type.String({
        minLength: 1,
        maxLength: MAX_AGENT_PROFILE_DESCRIPTION_LENGTH,
    }),
});
export type AgentProfile = Static<typeof agentProfileSchema>;

/** A focused agent's complete ordered request-profile catalog. */
export const agentProfileCatalogSchema = Type.Array(agentProfileSchema, {
    maxItems: MAX_AGENT_PROFILES,
});

/** A response shape carrying one agent's complete current profile catalog. */
export interface AgentProfileCatalog {
    /** Absent only when talking to an older compatible daemon. */
    profiles?: AgentProfile[];
}

/** What the agent is doing right now. */
export const agentStatusSchema = Type.Union([
    Type.Literal("idle"),
    Type.Literal("thinking"),
    Type.Literal("working"),
    Type.Literal("generating_tools"),
    Type.Literal("running_tools"),
]);
export type AgentStatus = Static<typeof agentStatusSchema>;

/** The interval of an active durable scheduling wait. */
export const agentWaitSchema = Type.Object({
    startedAt: Type.Integer({ minimum: 0 }),
    dueAt: Type.Integer({ minimum: 0 }),
});
export type AgentWait = Static<typeof agentWaitSchema>;

/**
 * An automatic recovery in progress inside the current run, protocol 30 or newer. `kind` is a
 * failure kind: a provider retry carries the kind it is retrying, and the one retry after a
 * context reset carries `context_too_long`.
 */
export const agentRetryingSchema = Type.Object({
    attempt: Type.Integer({ minimum: 1 }),
    maxAttempts: Type.Integer({ minimum: 1 }),
    kind: Type.String({ minLength: 1, maxLength: 64 }),
    /** The vendor being retried as named in a sentence, such as "Claude". */
    vendorName: Type.String({ minLength: 1, maxLength: 128 }),
});
export type AgentRetrying = Static<typeof agentRetryingSchema>;

/** Why the agent has something the person has not looked at. */
export const agentUnreadSchema = Type.Object({
    reason: Type.String(),
    since: timestampSchema,
});
export type AgentUnread = Static<typeof agentUnreadSchema>;

/** The whole composer state, so a message can be finished on another device. */
export interface AgentDraft {
    text: string;
    providerId: string;
    modelId: string;
    effort: Effort;
    serviceTier: ServiceTier | null;
    permissionMode: PermissionMode;
}

/** The longest status line an agent may set. */
export const MAX_AGENT_STATUS_LINE_LENGTH = 120;

/**
 * An agent's status line: plain text about where its work stands, on one line or on two lines
 * split by a single `\n`, neither of them empty.
 */
export const agentStatusLineSchema = Type.Object({
    text: Type.String({
        minLength: 1,
        maxLength: MAX_AGENT_STATUS_LINE_LENGTH,
        pattern: "^[^\\r\\n]+(?:\\n[^\\r\\n]+)?$",
    }),
    updatedAt: timestampSchema,
});
export type AgentStatusLine = Static<typeof agentStatusLineSchema>;

/** The agent object. */
export const agentSchema = Type.Recursive((agent) =>
    Type.Object({
        archivedAt: Nullable(timestampSchema),
        /** Whether the user-facing send route accepts messages for this agent. */
        canSendMessages: Type.Optional(Type.Boolean()),
        /** What the empty composer says in this conversation, when the daemon sets it. */
        composerPlaceholder: Type.Optional(Nullable(Type.String())),
        createdAt: timestampSchema,
        id: cuid2Schema,
        /**
         * When a person last wrote here or the status line last changed, else `createdAt`; it
         * never moves for runs, tool calls, or bookkeeping. Absent on older daemons.
         */
        lastActivityAt: Type.Optional(timestampSchema),
        /** The newest event cursor for this agent, so a stream opens where this left off. */
        lastCursor: eventCursorSchema,
        /** Whether another agent owns this agent's Agent Base ancestry. */
        managedByAnotherAgent: Type.Optional(Type.Boolean()),
        /** Owner-local order for a user-visible root; `null` on an ordinary hidden subagent. */
        orderKey: Nullable(Type.String()),
        /** `null` when no agent manages this one; otherwise the managing parent. */
        parentAgentId: Nullable(cuid2Schema),
        /** The open question when the run is waiting on the person. */
        pendingQuestionId: Nullable(cuid2Schema),
        /** How many background processes started by this agent are running now. */
        processes: Type.Object({ running: Type.Integer() }),
        status: agentStatusSchema,
        /**
         * What the agent last wrote about where its work stands, with `set_status`: shown under
         * the title of its sidebar row, on one line or on the two lines a single `\n` splits it
         * into. `null` when unset; absent on older daemons.
         */
        statusLine: Type.Optional(Nullable(agentStatusLineSchema)),
        /** How many subagents this agent spawned over its life, and how many run now. */
        subagents: Type.Object({ running: Type.Integer(), total: Type.Integer() }),
        /** A user-interactive, parent-managed subtask. Absent means false on older daemons. */
        subtask: Type.Optional(Type.Boolean()),
        /** Direct non-archived subtasks, recursively. Absent on older compatible daemons. */
        subtasks: Type.Optional(Type.Array(agent)),
        /** Order among the subtask's siblings; `null` until ordered, absent on older daemons. */
        subtaskOrderKey: Type.Optional(Nullable(Type.String())),
        title: Nullable(Type.String()),
        /** `"idle"` while no title has been generated yet. */
        titleStatus: Type.Union([Type.Literal("idle"), Type.Literal("ready")]),
        /** Own recorded input + output on activity rows; null when unmeasured, absent on older daemons. */
        totalTokens: Type.Optional(
            Nullable(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
        ),
        unread: Nullable(agentUnreadSchema),
        updatedAt: timestampSchema,
        /** Whether this agent belongs to a project or workspace's visible root-agent series. */
        userVisible: Type.Optional(Type.Boolean()),
        version: resourceVersionSchema,
        /** Scheduling-owned wait interval, null when cleared; absent on older daemons. */
        wait: Type.Optional(Nullable(agentWaitSchema)),
        /** Automatic recovery in progress, null when none; absent on older daemons. */
        retrying: Type.Optional(Nullable(agentRetryingSchema)),
        /** The workspace the agent runs in; its commands and edits land there. */
        workspaceId: cuid2Schema,
    }),
);
export type Agent = Static<typeof agentSchema>;

/** Every single-agent route answers with this. */
export interface AgentResponse extends SlashCommandCatalog, AgentProfileCatalog {
    agent: Agent;
}

/** `GET /v0/agents/:agentId/mode` */
export interface AgentModeResponse {
    /** Everything the last submitted message used; `null` before the first message. */
    mode: MessageMode | null;
}

/** Draft state is separate from agent lifecycle state and keeps clears ordered across clients. */
export interface AgentDraftSnapshot {
    value: AgentDraft | null;
    updatedAt: Timestamp | null;
}

/** `GET|PUT /v0/agents/:agentId/draft` */
export interface AgentDraftResponse {
    draft: AgentDraftSnapshot;
}

/** `POST /v0/agents/:agentId/abort` */
export interface AgentAbortResponse extends SlashCommandCatalog, AgentProfileCatalog {
    agent: Agent;
    /** The run winding down arrives through events from here. */
    cursor: EventCursor;
}

/** `POST /v0/agents/:agentId/compact` */
export interface AgentCompactResponse extends SlashCommandCatalog, AgentProfileCatalog {
    agent: Agent;
    /** The standalone maintenance run created for explicit compaction. */
    run: Run;
    /** The durable service message, normally carrying a running compaction block. */
    message: CompactionMessage;
    /** The run and message lifecycle arrive through events from here. */
    cursor: EventCursor;
}

/** `POST /v0/agents/:agentId/messages/:messageId/retry` */
export interface RetryFailedTurnRequest {
    mutationId?: string;
}

/** `POST /v0/agents/:agentId/messages/:messageId/switch` */
export interface SwitchAndContinueRequest {
    /**
     * A model the live catalog offers, from protocol 32; older daemons accept only one of the
     * failure's `fallbackProviders`.
     */
    providerId: string;
    modelId: string;
    mutationId?: string;
}

/** Both failure actions answer with the failed message, now carrying its resolution. */
export interface FailureResolutionResponse {
    agent: Agent;
    message: ServiceMessage;
    /** The continued run arrives through events from here. */
    cursor: EventCursor;
}

/** `GET /v0/agents/:agentId/activity` — everything the agent set in motion. */
export interface AgentActivityResponse {
    /** Full agent objects, newest first, finished ones included. */
    subagents: Agent[];
    /** Full process objects, newest first, exited ones included. */
    processes: BackgroundProcess[];
}

/** `POST /v0/agents` — creates a parentless, user-controlled workspace root. */
export interface CreateAgentRequest {
    /** The workspace the agent will run in. Must be active. */
    workspaceId: Cuid2;
    /** A titled agent keeps its title; the daemon never generates one over it. */
    title?: string;
    /** Optional client-supplied ID, which makes creation safely retryable. */
    id?: Cuid2;
    mutationId?: string;
}

/** `POST /v0/agents/:agentId/abort` */
export interface AbortAgentRequest {
    /** Abort only if this run is still the one running. */
    expectedRunId?: Cuid2;
    mutationId?: string;
}

/** `POST /v0/agents/:agentId/reorder` */
export interface ReorderAgentRequest {
    /** The agent to place this one after, or `null` to move it first. */
    afterId: Cuid2 | null;
    mutationId?: string;
}

/** `POST /v0/agents/:agentId/subtask-reorder` */
export interface ReorderSubtaskRequest {
    /** The sibling subtask to place this one after, or `null` to move it first. */
    afterId: Cuid2 | null;
    mutationId?: string;
}

/** `PUT /v0/agents/:agentId/draft` */
export interface SaveAgentDraftRequest {
    /** The composer state, or `null` to clear it. */
    draft: AgentDraft | null;
    /**
     * When the client last touched this draft. Drafts are last-write-wins: a
     * write carrying an older stamp than the stored draft is ignored. Omitted,
     * the write always applies.
     */
    updatedAt?: Timestamp;
    mutationId?: string;
}

/** A body carrying nothing but the optional mutation echo. */
export interface MutationOnlyRequest {
    mutationId?: string;
}
