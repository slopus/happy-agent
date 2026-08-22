/** Agents: one conversation running in a workspace, its transcript and its activity. */

import type {
    Cuid2,
    Effort,
    EventCursor,
    MessageMode,
    PermissionMode,
    ResourceVersion,
    ServiceTier,
    Timestamp,
} from "./common.js";
import type { BackgroundProcess } from "./processes.js";
import type { CompactionMessage, Run } from "./messages.js";
import type { SlashCommandCatalog } from "./slashCommands.js";

/** What the agent is doing right now. */
export type AgentStatus = "idle" | "thinking" | "working" | "generating_tools" | "running_tools";

/** Why the agent has something the person has not looked at. */
export interface AgentUnread {
    reason: string;
    since: Timestamp;
}

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
export interface Agent {
    id: Cuid2;
    /** The workspace the agent runs in; its commands and edits land there. */
    workspaceId: Cuid2;
    /** `null` when no agent manages this one; otherwise the managing parent. */
    parentAgentId: Cuid2 | null;
    /** Whether this agent belongs to a project or workspace's visible root-agent series. */
    userVisible?: boolean;
    /** Whether another agent owns this agent's Agent Base ancestry. */
    managedByAnotherAgent?: boolean;
    /** Whether the user-facing send route accepts messages for this agent. */
    canSendMessages?: boolean;
    title: string | null;
    /** `"idle"` while no title has been generated yet. */
    titleStatus: "idle" | "ready";
    status: AgentStatus;
    /** How many subagents this agent spawned over its life, and how many run now. */
    subagents: { total: number; running: number };
    /** How many background processes started by this agent are running now. */
    processes: { running: number };
    /** The open question when the run is waiting on the person. */
    pendingQuestionId: Cuid2 | null;
    unread: AgentUnread | null;
    /** Owner-local order for a user-visible root; `null` on an ordinary hidden subagent. */
    orderKey: string | null;
    /** The newest event cursor for this agent, so a stream opens where this left off. */
    lastCursor: EventCursor;
    version: ResourceVersion;
    createdAt: Timestamp;
    updatedAt: Timestamp;
    archivedAt: Timestamp | null;
}

/** Every single-agent route answers with this. */
export interface AgentResponse extends SlashCommandCatalog {
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
export interface AgentAbortResponse extends SlashCommandCatalog {
    agent: Agent;
    /** The run winding down arrives through events from here. */
    cursor: EventCursor;
}

/** `POST /v0/agents/:agentId/compact` */
export interface AgentCompactResponse extends SlashCommandCatalog {
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
