import { sql } from "drizzle-orm";
import type { Model, ServiceTier } from "@slopus/rig-execution";
import { Value } from "@sinclair/typebox/value";

import type { Message } from "../../agent/types.js";
import type { DockerExecutionConfig } from "../../execution/index.js";
import type { DurableSkillDefinition } from "../../external-skills/index.js";
import type { ExternalToolDefinition } from "../../external-tools/index.js";
import type { SessionGoal } from "../../goals/index.js";
import { parsePermissionMode } from "../../permissions/index.js";
import type {
    CreateSessionRequest,
    SessionAgentMetadata,
    SessionInterruption,
    SessionTitleStatus,
    SessionTokenCount,
    SessionUnreadReason,
} from "../../protocol/index.js";
import type {
    PersistedQueuedRun,
    PersistedSessionState,
    PersistedWorkflowRun,
} from "../../session/InMemorySession.js";
import {
    sessionWorkspaceTransferStateSchema,
    type SessionWorkspaceTransferState,
} from "../../session/sessionWorkspaceTransferState.js";
import type { TX } from "../Transaction.js";
import { parsePersistedUsage } from "./impl/persistedUsage.js";
import { parseStoredHostedCapabilities } from "./impl/parseStoredHostedCapabilities.js";
import {
    readNumber,
    readOptionalNumber,
    readOptionalString,
    readString,
} from "./impl/sqliteRow.js";
import { queryDurableUserInputs } from "./queryDurableUserInputs.js";
import { queryExternalToolCallsForSession } from "./queryExternalToolCallsForSession.js";
import { querySessionHasEarlierStoredMessage } from "./querySessionHasEarlierStoredMessage.js";
import { querySessionPartialMessages } from "./querySessionPartialMessages.js";
import { queryPendingContextMessages } from "./queryPendingContextMessages.js";
import { querySessionTranscriptPage } from "./querySessionTranscriptPage.js";
import { queryDurableWaits } from "../scheduling/queryDurableWaits.js";
import { queryScheduledMessages } from "../scheduling/queryScheduledMessages.js";

export interface SessionRestore {
    lastEventId?: string;
    projectId: string;
    request: CreateSessionRequest;
    restore: PersistedSessionState;
    workspaceId?: string;
}

export function querySessionRestore(tx: TX, sessionId: string): SessionRestore | undefined {
    const row = tx.get<Record<string, unknown>>(sql`
        SELECT * FROM sessions WHERE id = ${sessionId}
    `);
    if (row === undefined) return undefined;

    const effort = readOptionalString(row, "effort");
    const archived = readNumber(row, "archived") !== 0;
    const trackUnread = readNumber(row, "track_unread") !== 0;
    const unreadReason = readOptionalString(row, "unread_reason");
    const unreadSince = readOptionalNumber(row, "unread_since_ms");
    const serviceTier = readOptionalString(row, "service_tier");
    const draft = readOptionalString(row, "draft");
    const draftUpdatedAt = readOptionalNumber(row, "draft_updated_at_ms");
    const dockerJson = readOptionalString(row, "docker_json");
    const secretIdsJson = readOptionalString(row, "secret_ids_json");
    const instructions = readOptionalString(row, "instructions");
    const appendSystemPrompt = readOptionalString(row, "append_system_prompt");
    const systemPrompt = readOptionalString(row, "system_prompt");
    const interruptionJson = readOptionalString(row, "interruption_json");
    const sessionTokenCountJson = readOptionalString(row, "session_token_count_json");
    const persistedUsage = parsePersistedUsage(readOptionalString(row, "usage_json"));
    const transcriptMessages = querySessionTranscriptPage(tx, sessionId, 80)?.messages ?? [];
    const messages = [...transcriptMessages, ...querySessionPartialMessages(tx, sessionId)].sort(
        (left, right) => left.position - right.position,
    );
    const hasEarlierTranscript = querySessionHasEarlierStoredMessage(
        tx,
        sessionId,
        transcriptMessages[0]?.position,
    );
    const lastMessageAt = readOptionalNumber(row, "last_message_at_ms");
    const modelId = readString(row, "model_id");
    const title = readOptionalString(row, "title");
    const titleError = readOptionalString(row, "title_error");
    const recap = readOptionalString(row, "recap");
    const metadataUpdatedAt = readOptionalNumber(row, "metadata_updated_at_ms");
    const metadataRunId = readOptionalString(row, "metadata_run_id");
    const activeRunId = readOptionalString(row, "active_run_id");
    const activeSince = readOptionalNumber(row, "active_since_ms");
    const permissionMode = parsePermissionMode(readString(row, "permission_mode"));
    const hostedCapabilities = parseStoredHostedCapabilities(
        readOptionalString(row, "hosted_capabilities"),
    );
    const parentSessionId = readOptionalString(row, "parent_session_id");
    const delegatedBySessionId = readOptionalString(row, "delegated_by_session_id");
    const parentToolCallId = readOptionalString(row, "parent_tool_call_id");
    const taskName = readOptionalString(row, "task_name");
    const description = readOptionalString(row, "description");
    const goalJson = readOptionalString(row, "goal_json");
    const lastEventId = readOptionalString(row, "last_event_id");
    const id = readString(row, "id");
    const projectId = readString(row, "project_id");
    const workspaceId = readOptionalString(row, "workspace_id");
    const workspaceTransfer = parseWorkspaceTransferState(
        readString(row, "workspace_transfer_json"),
    );
    const agent: SessionAgentMetadata = {
        depth: readNumber(row, "depth"),
        rootSessionId: readOptionalString(row, "root_session_id") ?? id,
        type: readString(row, "session_kind") as SessionAgentMetadata["type"],
        ...(description !== undefined ? { description } : {}),
        ...(parentSessionId !== undefined ? { parentSessionId } : {}),
        ...(delegatedBySessionId !== undefined ? { delegatedBySessionId } : {}),
        ...(parentToolCallId !== undefined ? { parentToolCallId } : {}),
        ...(taskName !== undefined ? { taskName } : {}),
    };
    const restore: PersistedSessionState = {
        ...(activeSince !== undefined ? { activeSince } : {}),
        agent,
        agentId: readString(row, "agent_id"),
        archived,
        trackUnread,
        ...(unreadReason !== undefined && unreadSince !== undefined
            ? { unread: { reason: unreadReason as SessionUnreadReason, since: unreadSince } }
            : {}),
        ...(appendSystemPrompt !== undefined ? { appendSystemPrompt } : {}),
        ...(systemPrompt !== undefined ? { systemPrompt } : {}),
        createdAt: readNumber(row, "created_at_ms"),
        cwd: readString(row, "cwd"),
        ...(draft === undefined ? {} : { draft }),
        ...(draftUpdatedAt === undefined ? {} : { draftUpdatedAt }),
        elapsedMs: readNumber(row, "elapsed_ms"),
        ...(dockerJson === undefined
            ? {}
            : { docker: JSON.parse(dockerJson) as DockerExecutionConfig }),
        contextMessages: queryContextMessages(tx, sessionId),
        ...(effort !== undefined ? { effort } : {}),
        ...(serviceTier === "fast" ? { serviceTier } : {}),
        id,
        ...(instructions !== undefined ? { instructions } : {}),
        ...(goalJson === undefined ? {} : { goal: JSON.parse(goalJson) as SessionGoal }),
        ...(interruptionJson === undefined
            ? {}
            : { interruption: JSON.parse(interruptionJson) as SessionInterruption }),
        ...(lastMessageAt !== undefined ? { lastMessageAt } : {}),
        messages,
        durableUserInputs: [...queryDurableUserInputs(tx, sessionId)],
        durableWaits: [...queryDurableWaits(tx, sessionId)],
        externalToolCalls: [...queryExternalToolCallsForSession(tx, sessionId)],
        externalTools: JSON.parse(
            readString(row, "external_tools_json"),
        ) as ExternalToolDefinition[],
        skills: JSON.parse(readString(row, "durable_skills_json")) as DurableSkillDefinition[],
        modelId,
        models: JSON.parse(readString(row, "models_json")) as Model[],
        orderKey: readString(row, "order_key"),
        providerId: readString(row, "provider_id"),
        permissionMode,
        pendingContextMessages: queryPendingContextMessages(tx, sessionId),
        ...(hostedCapabilities === undefined ? {} : { hostedCapabilities }),
        projectId,
        ...(workspaceId === undefined ? {} : { workspaceId }),
        workspaceTransfer,
        workspaceQueueWaiting: readNumber(row, "workspace_queue_waiting") !== 0,
        secretIds: secretIdsJson === undefined ? [] : (JSON.parse(secretIdsJson) as string[]),
        queuedRuns: queryQueuedRuns(tx, sessionId),
        scheduledMessages: [...queryScheduledMessages(tx, sessionId)],
        status: readString(row, "status") as PersistedSessionState["status"],
        tasks: JSON.parse(readString(row, "tasks_json")) as PersistedSessionState["tasks"],
        workflows: JSON.parse(readString(row, "workflows_json")) as PersistedWorkflowRun[],
        workflowsEnabled: readNumber(row, "workflows_enabled") !== 0,
        nextTaskId: readNumber(row, "next_task_id"),
        ...(title !== undefined ? { title } : {}),
        ...(titleError !== undefined ? { titleError } : {}),
        ...(recap !== undefined ? { recap } : {}),
        ...(metadataUpdatedAt !== undefined ? { metadataUpdatedAt } : {}),
        ...(metadataRunId !== undefined ? { metadataRunId } : {}),
        titleStatus: readString(row, "title_status") as SessionTitleStatus,
        transcriptHasEarlier: hasEarlierTranscript,
        totalTokens: readNumber(row, "total_tokens"),
        lifetimeTotalTokens: readNumber(row, "lifetime_total_tokens"),
        ...(sessionTokenCountJson === undefined
            ? {}
            : { sessionTokenCount: JSON.parse(sessionTokenCountJson) as SessionTokenCount }),
        ...(persistedUsage === undefined ? {} : { usage: persistedUsage.committed }),
        ...(persistedUsage?.summary === undefined ? {} : { usageSummary: persistedUsage.summary }),
        ...(persistedUsage?.throughEventId === undefined
            ? {}
            : { usageSummaryEventId: persistedUsage.throughEventId }),
        ...(persistedUsage?.permissionReviews === undefined
            ? {}
            : { permissionReviews: persistedUsage.permissionReviews }),
        tools: JSON.parse(readString(row, "tools_json")) as string[],
    };
    if (activeRunId !== undefined) restore.activeRunId = activeRunId;

    const request: CreateSessionRequest = {
        ...(restore.appendSystemPrompt === undefined
            ? {}
            : { appendSystemPrompt: restore.appendSystemPrompt }),
        trackUnread: restore.trackUnread === true,
        cwd: restore.cwd,
        ...(restore.docker === undefined ? {} : { docker: restore.docker }),
        ...(restore.effort === undefined ? {} : { effort: restore.effort }),
        ...(restore.serviceTier === undefined ? {} : { serviceTier: restore.serviceTier }),
        ...(restore.instructions === undefined ? {} : { instructions: restore.instructions }),
        modelId,
        providerId: restore.providerId,
        secretIds: restore.secretIds ?? [],
        workflowsEnabled: restore.workflowsEnabled !== false,
    };
    return {
        ...(lastEventId === undefined ? {} : { lastEventId }),
        projectId,
        request,
        restore,
        ...(workspaceId === undefined ? {} : { workspaceId }),
    };
}

function parseWorkspaceTransferState(value: string): SessionWorkspaceTransferState {
    const parsed: unknown = JSON.parse(value);
    if (!Value.Check(sessionWorkspaceTransferStateSchema, parsed)) {
        throw new Error("The stored session workspace transfer state is invalid.");
    }
    return parsed;
}

function queryContextMessages(tx: TX, sessionId: string): Message[] {
    return tx
        .all<Record<string, unknown>>(sql`
            SELECT message_json
            FROM session_context_messages
            WHERE session_id = ${sessionId}
            ORDER BY position
        `)
        .map((row) => JSON.parse(readString(row, "message_json")) as Message);
}

function queryQueuedRuns(tx: TX, sessionId: string): PersistedQueuedRun[] {
    return tx
        .all<Record<string, unknown>>(sql`
            SELECT queued_runs.run_id, queued_runs.debug, queued_runs.debug_directory,
                queued_runs.display_text, queued_runs.kind, queued_runs.text,
                queued_runs.user_message_json, queued_runs.integration_config_json
            FROM queued_runs
            LEFT JOIN session_turns
                ON session_turns.session_id = queued_runs.session_id
                AND session_turns.run_id = queued_runs.run_id
            WHERE queued_runs.session_id = ${sessionId}
            ORDER BY session_turns.first_position ASC, queued_runs.created_at_ms ASC,
                queued_runs.run_id ASC
        `)
        .map((row) => {
            const debugDirectory = readOptionalString(row, "debug_directory");
            const configJson = readOptionalString(row, "integration_config_json");
            const config =
                configJson === undefined
                    ? {}
                    : (JSON.parse(configJson) as {
                          effort?: string;
                          externalTools?: readonly ExternalToolDefinition[];
                          modelId?: string;
                          providerId?: string;
                          serviceTier?: ServiceTier | null;
                          skills?: readonly DurableSkillDefinition[];
                          systemPrompt?: string | null;
                      });
            const debug = readNumber(row, "debug") !== 0;
            const userMessage = JSON.parse(
                readString(row, "user_message_json"),
            ) as PersistedQueuedRun["userMessage"];
            return {
                ...(debug ? { debug: true, debugRequestContent: userMessage.blocks } : {}),
                ...(debugDirectory === undefined ? {} : { debugDirectory }),
                displayText: readString(row, "display_text"),
                kind: readString(row, "kind") as PersistedQueuedRun["kind"],
                runId: readString(row, "run_id"),
                text: readString(row, "text"),
                userMessage,
                ...config,
            };
        }) as PersistedQueuedRun[];
}
