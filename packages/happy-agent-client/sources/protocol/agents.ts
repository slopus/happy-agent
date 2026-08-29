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
import type { CompactionMessage, Run } from "./messages.js";
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

/** The agent object. */
export const agentSchema = Type.Object({
    archivedAt: Nullable(timestampSchema),
    /** Whether the user-facing send route accepts messages for this agent. */
    canSendMessages: Type.Optional(Type.Boolean()),
    createdAt: timestampSchema,
    id: cuid2Schema,
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
    /** How many subagents this agent spawned over its life, and how many run now. */
    subagents: Type.Object({ running: Type.Integer(), total: Type.Integer() }),
    title: Nullable(Type.String()),
    /** `"idle"` while no title has been generated yet. */
    titleStatus: Type.Union([Type.Literal("idle"), Type.Literal("ready")]),
    unread: Nullable(agentUnreadSchema),
    updatedAt: timestampSchema,
    /** Whether this agent belongs to a project or workspace's visible root-agent series. */
    userVisible: Type.Optional(Type.Boolean()),
    version: resourceVersionSchema,
    /** The workspace the agent runs in; its commands and edits land there. */
    workspaceId: cuid2Schema,
});
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

/** `GET /v0/agents/:agentId/activity` — everything the agent set in motion. */
export interface AgentActivityResponse {
    /** Full agent objects, newest first, finished ones included. */
    subagents: Agent[];
    /** Full process objects, newest first, exited ones included. */
    processes: BackgroundProcess[];
}

/** `POST /v0/agents` — creation always makes a user-visible workspace root. */
export interface CreateAgentRequest {
    /** The workspace the agent will run in. Must be active. */
    workspaceId: Cuid2;
    /** Retains this different-workspace parent while creating a visible managed root. */
    parentAgentId?: Cuid2;
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
