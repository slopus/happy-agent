import type { Context } from "@steve.kite/stdlib";

import { sql } from "drizzle-orm";
import type { Model, ServiceTier } from "../../protocol/index.js";
import { Value } from "@sinclair/typebox/value";

import type { Message } from "../../agent/types.js";
import type { DockerExecutionConfig } from "../../execution/index.js";
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
import type { PersistedSessionState, PersistedWorkflowRun } from "../../session/InMemorySession.js";
import {
    sessionWorkspaceTransferStateSchema,
    type SessionWorkspaceTransferState,
} from "../../session/sessionWorkspaceTransferState.js";
import type { TX } from "../Transaction.js";
import { inReadTx } from "../inReadTx.js";
import { parsePersistedUsage } from "./impl/persistedUsage.js";
import {
    readNumber,
    readOptionalNumber,
    readOptionalString,
    readString,
} from "./impl/sqliteRow.js";
import { querySessionHasEarlierStoredMessage } from "./querySessionHasEarlierStoredMessage.js";
import { querySessionTranscriptPage } from "./querySessionTranscriptPage.js";
import { queryScheduledMessages } from "../scheduling/queryScheduledMessages.js";
import { sessionScopeFromRow } from "./impl/sessionScope.js";

export interface SessionRestore {
    lastEventId?: string;
    request: CreateSessionRequest;
    restore: PersistedSessionState;
}

export async function querySessionRestore(
    ctx: Context,
    sessionId: string,
): Promise<SessionRestore | undefined> {
    return await inReadTx(ctx, "rig.sql.session.query_session_restore", async (ctx) => {
        const tx = ctx.tx;
        const row = await tx.get<Record<string, unknown>>(sql`
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
        const transcriptMessages =
            (await querySessionTranscriptPage(ctx, sessionId, 80))?.messages ?? [];
        const messages = [...transcriptMessages].sort(
            (left, right) => left.position - right.position,
        );
        const hasEarlierTranscript = await querySessionHasEarlierStoredMessage(
            ctx,
            sessionId,
            transcriptMessages[0]?.position,
        );
        const lastMessageAt = readOptionalNumber(row, "last_message_at_ms");
        const modelId = readString(row, "model_id");
        const title = readOptionalString(row, "title");
        const titleError = readOptionalString(row, "title_error");
        const recap = readOptionalString(row, "recap");
        const profileId = readOptionalString(row, "profile_id");
        const permissionMode = parsePermissionMode(readString(row, "permission_mode"));
        const parentSessionId = readOptionalString(row, "parent_session_id");
        const delegatedBySessionId = readOptionalString(row, "delegated_by_session_id");
        const parentToolCallId = readOptionalString(row, "parent_tool_call_id");
        const taskName = readOptionalString(row, "task_name");
        const description = readOptionalString(row, "description");
        const goalJson = readOptionalString(row, "goal_json");
        const lastEventId = readOptionalString(row, "last_event_id");
        const id = readString(row, "id");
        const scope = sessionScopeFromRow(row);
        const unsortedSince = readOptionalNumber(row, "unsorted_since_ms");
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
            agent,
            agentId: readString(row, "agent_id"),
            ownerInstanceId: readString(row, "owner_instance_id"),
            ...(profileId === undefined ? {} : { profileId }),
            archived,
            trackUnread,
            ...(unreadReason !== undefined && unreadSince !== undefined
                ? { unread: { reason: unreadReason as SessionUnreadReason, since: unreadSince } }
                : {}),
            ...(appendSystemPrompt !== undefined ? { appendSystemPrompt } : {}),
            ...(systemPrompt !== undefined ? { systemPrompt } : {}),
            createdAt: readNumber(row, "created_at_ms"),
            credentialBindingId: await queryCredentialBinding(tx, id),
            cwd: readString(row, "cwd"),
            ...(draft === undefined ? {} : { draft }),
            ...(draftUpdatedAt === undefined ? {} : { draftUpdatedAt }),
            scope,
            ...(unsortedSince === undefined ? {} : { unsortedSince }),
            ...(dockerJson === undefined
                ? {}
                : { docker: JSON.parse(dockerJson) as DockerExecutionConfig }),
            contextMessages: await queryContextMessages(tx, sessionId),
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
            modelId,
            models: JSON.parse(readString(row, "models_json")) as Model[],
            orderKey: readString(row, "order_key"),
            providerId: readString(row, "provider_id"),
            permissionMode,
            workspaceTransfer,
            secretIds: secretIdsJson === undefined ? [] : (JSON.parse(secretIdsJson) as string[]),
            scheduledMessages: [...(await queryScheduledMessages(ctx, sessionId))],
            status: readString(row, "status") as PersistedSessionState["status"],
            tasks: JSON.parse(readString(row, "tasks_json")) as PersistedSessionState["tasks"],
            workflows: JSON.parse(readString(row, "workflows_json")) as PersistedWorkflowRun[],
            workflowsEnabled: readNumber(row, "workflows_enabled") !== 0,
            nextTaskId: readNumber(row, "next_task_id"),
            ...(title !== undefined ? { title } : {}),
            ...(titleError !== undefined ? { titleError } : {}),
            ...(recap !== undefined ? { recap } : {}),
            titleStatus: readString(row, "title_status") as SessionTitleStatus,
            transcriptHasEarlier: hasEarlierTranscript,
            totalTokens: readNumber(row, "total_tokens"),
            lifetimeTotalTokens: readNumber(row, "lifetime_total_tokens"),
            ...(sessionTokenCountJson === undefined
                ? {}
                : { sessionTokenCount: JSON.parse(sessionTokenCountJson) as SessionTokenCount }),
            ...(persistedUsage === undefined ? {} : { usage: persistedUsage.committed }),
            ...(persistedUsage?.summary === undefined
                ? {}
                : { usageSummary: persistedUsage.summary }),
            ...(persistedUsage?.throughEventId === undefined
                ? {}
                : { usageSummaryEventId: persistedUsage.throughEventId }),
            ...(persistedUsage?.permissionReviews === undefined
                ? {}
                : { permissionReviews: persistedUsage.permissionReviews }),
            tools: JSON.parse(readString(row, "tools_json")) as string[],
        };
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
            request,
            restore,
        };
    });
}

function parseWorkspaceTransferState(value: string): SessionWorkspaceTransferState {
    const parsed: unknown = JSON.parse(value);
    if (!Value.Check(sessionWorkspaceTransferStateSchema, parsed)) {
        throw new Error("The stored session workspace transfer state is invalid.");
    }
    return parsed;
}

async function queryContextMessages(tx: TX, sessionId: string): Promise<Message[]> {
    return (
        await tx.all<Record<string, unknown>>(sql`
            SELECT message_json
            FROM session_context_messages
            WHERE session_id = ${sessionId}
            ORDER BY position
        `)
    ).map((row) => JSON.parse(readString(row, "message_json")) as Message);
}

async function queryCredentialBinding(tx: TX, sessionId: string): Promise<string> {
    const row = await tx.get<Record<string, unknown>>(sql`
        SELECT binding_id
        FROM session_credential_bindings
        WHERE session_id = ${sessionId}
    `);
    if (row === undefined) {
        throw new Error("The saved session credential binding is missing.");
    }
    const bindingId = readString(row, "binding_id");
    if (bindingId.length === 0) {
        throw new Error("The saved session credential binding is invalid.");
    }
    return bindingId;
}
