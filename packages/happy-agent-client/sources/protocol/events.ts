/**
 * Events: everything that changes on the daemon, announced on one journal.
 *
 * A client opens with REST snapshots and follows events to stay current. The
 * journal is a bounded window: a cursor that fell out of it cannot be replayed,
 * and the daemon says so rather than silently skipping what was lost.
 */

import { type Static, Type } from "@sinclair/typebox";

import {
    cuid2Schema,
    type Cuid2,
    type EventCursor,
    type ResourceVersion,
    type Timestamp,
    mutationIdSchema,
    resourceVersionSchema,
} from "./common.js";
import type { Agent, AgentDraftSnapshot } from "./agents.js";
import { botSchema } from "./bots.js";
import type { Cloud } from "./cloud.js";
import type { GitState } from "./git.js";
import type { HappyIntegration } from "./integrations.js";
import type { Message, Run } from "./messages.js";
import type { BackgroundProcess } from "./processes.js";
import type { Profile } from "./profile.js";
import type { Project } from "./projects.js";
import type { Question } from "./questions.js";
import type { Terminal } from "./terminals.js";
import type { AgentContextUsage } from "./usage.js";
import type { Workspace } from "./workspaces.js";
import type { SlashCommand } from "./slashCommands.js";

/**
 * What every `*.updated` payload carries beside the resource's own ID.
 *
 * A client whose cached `version` equals `previousVersion` merges `changes` and
 * adopts the new version; when they differ its copy is dirty and it refetches
 * that one resource.
 */
export interface ResourceUpdate<TResource> {
    /** The resource's version before this change. */
    previousVersion: ResourceVersion;
    /** Its version after. */
    version: ResourceVersion;
    /** Only the fields that changed; `updatedAt` is always among them. */
    changes: Partial<TResource>;
    /** Echoed when the mutation behind this change supplied one. */
    mutationId?: string;
}

/** What every mutation-caused payload may carry. */
export interface MutationEcho {
    mutationId?: string;
}

/** This daemon process entered its sticky read-only drain phase. */
export interface DaemonDrainingPayload {
    daemonId: Cuid2;
    draining: true;
}

export type ProjectCreatedPayload = MutationEcho & { project: Project };
export type ProjectUpdatedPayload = ResourceUpdate<Project> & { projectId: Cuid2 };

export type WorkspaceCreatedPayload = MutationEcho & { workspace: Workspace };
export type WorkspaceUpdatedPayload = ResourceUpdate<Workspace> & { workspaceId: Cuid2 };

/** A bot was created together with its dedicated workspace and one agent. */
export const botCreatedPayloadSchema = Type.Object({
    bot: botSchema,
    mutationId: Type.Optional(mutationIdSchema),
});
export type BotCreatedPayload = Static<typeof botCreatedPayloadSchema>;

/** A version-chained change to a bot's own fields. */
export const botUpdatedPayloadSchema = Type.Object({
    botId: cuid2Schema,
    changes: Type.Partial(botSchema),
    mutationId: Type.Optional(mutationIdSchema),
    previousVersion: resourceVersionSchema,
    version: resourceVersionSchema,
});
export type BotUpdatedPayload = Static<typeof botUpdatedPayloadSchema>;

export type TerminalCreatedPayload = MutationEcho & { terminal: Terminal };
export type TerminalUpdatedPayload = ResourceUpdate<Terminal> & { terminalId: Cuid2 };

/** Git state is computed, so it has no version chain: the payload is the whole snapshot. */
export interface GitUpdatedPayload {
    workspaceId: Cuid2;
    git: GitState;
}

/** File state is computed, so clients refetch the affected visible paths. */
export interface FilesUpdatedPayload {
    workspaceId: Cuid2;
    /** Relative paths, or `null` when the safe scope is every visible path in the workspace. */
    paths: string[] | null;
}

export type AgentCreatedPayload = MutationEcho & { agent: Agent };
export type AgentUpdatedPayload = ResourceUpdate<Agent> & { agentId: Cuid2 };

/** Current context is computed state, so it carries a complete replacement and no version chain. */
export interface AgentContextUpdatedPayload {
    agentId: Cuid2;
    context: AgentContextUsage | null;
}

/** Draft state is a complete current-value replacement rather than part of the agent resource. */
export interface AgentDraftUpdatedPayload extends MutationEcho {
    agentId: Cuid2;
    draft: AgentDraftSnapshot;
}

/** The complete current slash-command catalog is a replacement, not a versioned resource diff. */
export interface AgentSlashCommandsUpdatedPayload extends MutationEcho {
    agentId: Cuid2;
    slashCommands: SlashCommand[];
}

export type ProcessStartedPayload = MutationEcho & { process: BackgroundProcess };
export type ProcessUpdatedPayload = ResourceUpdate<BackgroundProcess> & { processId: Cuid2 };

export type QuestionCreatedPayload = MutationEcho & { question: Question };
export type QuestionUpdatedPayload = ResourceUpdate<Question> & { questionId: Cuid2 };

/** A run began; the agent left `"idle"`. */
export interface RunStartedPayload extends MutationEcho {
    agentId: Cuid2;
    run: Run;
    /** Visible messages accepted into the run, oldest first. */
    acceptedMessageIds: Cuid2[];
}

/** Steering atomically closed one run and opened its successor. */
export interface RunBoundaryPayload extends MutationEcho {
    agentId: Cuid2;
    finishedRun: Run;
    startedRun: Run;
    /** Visible steering messages accepted into the successor, oldest first. */
    acceptedMessageIds: Cuid2[];
}

/** A run reached a terminal state; the agent is `"idle"` again. */
export interface RunFinishedPayload extends MutationEcho {
    agentId: Cuid2;
    run: Run;
}

/** A message entered history; pending user messages arrive here first. */
export interface MessageCreatedPayload extends MutationEcho {
    agentId: Cuid2;
    /** `null` for a pending user message, which belongs to no run yet. */
    runId: Cuid2 | null;
    message: Message;
}

/** The whole message as of now, not a diff. */
export interface MessageUpdatedPayload extends MutationEcho {
    agentId: Cuid2;
    runId: Cuid2;
    message: Message;
}

/**
 * Streaming text: the one event that is not a full object.
 *
 * A client that misses deltas recovers the full message from the next
 * `message.updated` or from history.
 */
export const messageDeltaPayloadSchema = Type.Object({
    agentId: cuid2Schema,
    runId: cuid2Schema,
    messageId: cuid2Schema,
    /** Which content block grows. */
    blockIndex: Type.Integer({ minimum: 0 }),
    /** The block's prior UTF-16 code-unit length. */
    offset: Type.Integer({ minimum: 0 }),
    /** Text to concatenate onto that block. */
    append: Type.String(),
});

/** Streaming text with an absolute prior-text offset. */
export type MessageDeltaPayload = Static<typeof messageDeltaPayloadSchema>;

/**
 * The message is gone from history.
 *
 * Deletion happens only when the daemon resets a block of the transcript to
 * restart inference; the replacements arrive as ordinary `message.created`.
 */
export interface MessageDeletedPayload {
    agentId: Cuid2;
    runId: Cuid2;
    messageId: Cuid2;
}

/** Deliberately empty: a nudge to refetch the config endpoints when convenient. */
export type ConfigUpdatedPayload = Record<string, never>;

/** The profile changed; the payload is the whole profile, not a diff. */
export interface ProfileUpdatedPayload extends MutationEcho {
    profile: Profile;
}

/** Cloud state is a complete replacement rather than a version-chain diff. */
export interface CloudUpdatedPayload extends MutationEcho {
    cloud: Cloud;
}

/** Happy Cloud owns the profile, so this event is a compact refetch invalidation. */
export type CloudProfileUpdatedPayload = MutationEcho;

/** Happy integration state is computed, so the payload is a complete replacement. */
export interface HappyIntegrationUpdatedPayload {
    integration: HappyIntegration;
}

/** Compact sharing invalidation; clients refetch only when this version is newer. */
export const sharingUpdatedPayloadSchema = Type.Object({
    mutationId: Type.Optional(mutationIdSchema),
    version: resourceVersionSchema,
});
export type SharingUpdatedPayload = Static<typeof sharingUpdatedPayloadSchema>;

/** One event on the journal. */
export interface EventEnvelope<TType extends string, TPayload> {
    /** This event's place in the journal; never a resource identity. */
    cursor: EventCursor;
    type: TType;
    occurredAt: Timestamp;
    payload: TPayload;
}

/** Every event the specification names today. */
export type HappyAgentEvent =
    | EventEnvelope<"daemon.draining", DaemonDrainingPayload>
    | EventEnvelope<"project.created", ProjectCreatedPayload>
    | EventEnvelope<"project.updated", ProjectUpdatedPayload>
    | EventEnvelope<"workspace.created", WorkspaceCreatedPayload>
    | EventEnvelope<"workspace.updated", WorkspaceUpdatedPayload>
    | EventEnvelope<"bot.created", BotCreatedPayload>
    | EventEnvelope<"bot.updated", BotUpdatedPayload>
    | EventEnvelope<"terminal.created", TerminalCreatedPayload>
    | EventEnvelope<"terminal.updated", TerminalUpdatedPayload>
    | EventEnvelope<"git.updated", GitUpdatedPayload>
    | EventEnvelope<"files.updated", FilesUpdatedPayload>
    | EventEnvelope<"agent.created", AgentCreatedPayload>
    | EventEnvelope<"agent.updated", AgentUpdatedPayload>
    | EventEnvelope<"agent.context.updated", AgentContextUpdatedPayload>
    | EventEnvelope<"agent.draft.updated", AgentDraftUpdatedPayload>
    | EventEnvelope<"agent.slash_commands.updated", AgentSlashCommandsUpdatedPayload>
    | EventEnvelope<"process.started", ProcessStartedPayload>
    | EventEnvelope<"process.updated", ProcessUpdatedPayload>
    | EventEnvelope<"process.exited", ProcessUpdatedPayload>
    | EventEnvelope<"question.created", QuestionCreatedPayload>
    | EventEnvelope<"question.updated", QuestionUpdatedPayload>
    | EventEnvelope<"run.started", RunStartedPayload>
    | EventEnvelope<"run.boundary", RunBoundaryPayload>
    | EventEnvelope<"run.finished", RunFinishedPayload>
    | EventEnvelope<"message.created", MessageCreatedPayload>
    | EventEnvelope<"message.updated", MessageUpdatedPayload>
    | EventEnvelope<"message.delta", MessageDeltaPayload>
    | EventEnvelope<"message.deleted", MessageDeletedPayload>
    | EventEnvelope<"config.updated", ConfigUpdatedPayload>
    | EventEnvelope<"profile.updated", ProfileUpdatedPayload>
    | EventEnvelope<"cloud.updated", CloudUpdatedPayload>
    | EventEnvelope<"cloud.profile.updated", CloudProfileUpdatedPayload>
    | EventEnvelope<"happy.integration.updated", HappyIntegrationUpdatedPayload>
    | EventEnvelope<"sharing.updated", SharingUpdatedPayload>;

/** The name of an event this client build knows. */
export type HappyAgentEventType = HappyAgentEvent["type"];

/** `GET /v0/events` query parameters. */
export interface EventPageQuery {
    /** The cursor to read from, exclusive; omitted, reading starts at the oldest. */
    after?: EventCursor;
    /** An inclusive upper bound, for pulling the changes between two cursors. */
    until?: EventCursor;
    /** Default 100. */
    limit?: number;
}

/** `GET /v0/events` */
export interface EventPageResponse {
    /** Oldest first. */
    events: HappyAgentEvent[];
    /** Where this page ended; pass it as the next `after`. */
    cursor: EventCursor;
    /** The newest event the daemon holds, so a client knows how far behind it is. */
    latestCursor: EventCursor;
}

/** The `hello` frame `GET /v0/events/stream` opens with. */
export interface EventStreamHello {
    /** The position the stream continues from. */
    cursor: EventCursor;
    /**
     * The supplied cursor was lost to the journal window. The stream is live
     * from now, but the client must resync its snapshots.
     */
    gap: boolean;
    /** The supplied cursor was honored; everything since it follows, in order. */
    resumed: boolean;
    connectedAt: Timestamp;
    /** This daemon process's identity. Absent on older compatible daemons. */
    daemonId?: Cuid2;
    /** When this daemon process started. Absent on older compatible daemons. */
    daemonStartedAt?: Timestamp;
    /** Whether this daemon process is draining. Absent on older compatible daemons. */
    draining?: boolean;
}

/** One frame read off `GET /v0/events/stream`. */
export type EventStreamFrame =
    | { kind: "hello"; hello: EventStreamHello }
    | { kind: "event"; event: HappyAgentEvent; cursor: EventCursor };

/** `GET /v0/events/stream` options. */
export interface EventStreamOptions {
    /** The cursor to resume from, sent as the `after` query parameter. */
    after?: EventCursor | undefined;
    /**
     * The cursor to resume from, sent as the standard `Last-Event-ID` header.
     * Equivalent to `after`; both forms exist because SSE reconnects use the
     * header and a first connection usually names the cursor in the query.
     */
    lastEventId?: EventCursor | undefined;
    /** Closes the connection and ends the iteration. */
    signal?: AbortSignal | undefined;
}
