import { and, eq, gte, sql } from "drizzle-orm";

import type { Message } from "../../agent/types.js";
import { sessionContextMessages, sessions } from "../database/schema.js";
import type { PersistedSessionState } from "../../session/InMemorySession.js";
import { inTx } from "../inTx.js";
import type { TX } from "../Transaction.js";

export function sessionSave(
    tx: TX,
    state: PersistedSessionState,
    input: {
        contextMessages: readonly Message[];
        now: number;
        projectId: string;
    },
): void {
    inTx(tx, (tx) => {
        const values = {
            activeRunId: state.activeRunId ?? null,
            activeSinceMs: state.activeSince ?? null,
            agentId: state.agentId,
            appendSystemPrompt: state.appendSystemPrompt ?? null,
            archived: state.archived === true,
            createdAtMs: input.now,
            cwd: state.cwd,
            depth: state.agent.depth,
            description: state.agent.description ?? null,
            dockerJson: state.docker === undefined ? null : JSON.stringify(state.docker),
            draft: state.draft ?? null,
            draftUpdatedAtMs: state.draftUpdatedAt ?? null,
            durableSkillsJson: JSON.stringify(state.skills ?? []),
            effort: state.effort ?? null,
            elapsedMs: state.elapsedMs ?? 0,
            externalToolsJson: JSON.stringify(state.externalTools ?? []),
            goalJson: state.goal === undefined ? null : JSON.stringify(state.goal),
            id: state.id,
            instructions: state.instructions ?? null,
            interrupted: state.interruption !== undefined,
            interruptionJson:
                state.interruption === undefined ? null : JSON.stringify(state.interruption),
            lastMessageAtMs: state.lastMessageAt ?? null,
            metadataRunId: state.metadataRunId ?? null,
            metadataUpdatedAtMs: state.metadataUpdatedAt ?? null,
            modelId: state.modelId,
            modelsJson: JSON.stringify(state.models),
            nextTaskId: state.nextTaskId,
            orderKey: state.orderKey,
            parentSessionId: state.agent.parentSessionId ?? null,
            delegatedBySessionId: state.agent.delegatedBySessionId ?? null,
            parentToolCallId: state.agent.parentToolCallId ?? null,
            permissionMode: state.permissionMode,
            projectId: input.projectId,
            providerId: state.providerId,
            recap: state.recap ?? null,
            rootSessionId: state.agent.rootSessionId,
            secretIdsJson: JSON.stringify(state.secretIds ?? []),
            serviceTier: state.serviceTier ?? null,
            sessionKind: state.agent.type,
            sessionTokenCountJson:
                state.sessionTokenCount === undefined
                    ? null
                    : JSON.stringify(state.sessionTokenCount),
            status: state.status,
            systemPrompt: state.systemPrompt ?? null,
            taskName: state.agent.taskName ?? null,
            tasksJson: JSON.stringify(state.tasks),
            title: state.title ?? null,
            titleError: state.titleError ?? null,
            titleStatus: state.titleStatus,
            toolsJson: JSON.stringify(state.tools),
            totalTokens: state.totalTokens ?? 0,
            lifetimeTotalTokens: state.lifetimeTotalTokens ?? state.usage?.totalTokens ?? 0,
            trackUnread: state.trackUnread === true,
            unreadReason: state.unread?.reason ?? null,
            unreadSinceMs: state.unread?.since ?? null,
            updatedAtMs: input.now,
            usageJson:
                state.usage === undefined
                    ? null
                    : JSON.stringify({
                          committed: state.usage,
                          ...(state.usageSummary === undefined
                              ? {}
                              : { summary: state.usageSummary }),
                          ...(state.usageSummaryEventId === undefined
                              ? {}
                              : { throughEventId: state.usageSummaryEventId }),
                          permissionReviews: state.permissionReviews ?? [],
                      }),
            workflowsEnabled: state.workflowsEnabled !== false,
            workflowsJson: JSON.stringify(state.workflows ?? []),
            workspaceId: state.workspaceId ?? null,
            workspaceQueueWaiting: state.workspaceQueueWaiting === true,
            workspaceTransferJson: JSON.stringify(state.workspaceTransfer ?? { status: "idle" }),
        };
        const { createdAtMs: _createdAtMs, id: _id, ...updates } = values;
        tx.insert(sessions)
            .values(values)
            .onConflictDoUpdate({ set: updates, target: sessions.id })
            .run();
        replaceContextMessages(tx, state.id, input.contextMessages);
    });
}

export function replaceContextMessages(
    tx: TX,
    sessionId: string,
    messages: readonly Message[],
): void {
    tx.delete(sessionContextMessages)
        .where(
            and(
                eq(sessionContextMessages.sessionId, sessionId),
                gte(sessionContextMessages.position, messages.length),
            ),
        )
        .run();
    messages.forEach((message, position) => {
        tx.insert(sessionContextMessages)
            .values({
                messageId: message.id,
                messageJson: JSON.stringify(message),
                position,
                role: message.role,
                sessionId,
            })
            .onConflictDoUpdate({
                set: {
                    messageId: sql`excluded.message_id`,
                    messageJson: sql`excluded.message_json`,
                    role: sql`excluded.role`,
                },
                setWhere: sql`
                    ${sessionContextMessages.messageId} != excluded.message_id
                    OR ${sessionContextMessages.role} != excluded.role
                    OR ${sessionContextMessages.messageJson} != excluded.message_json
                `,
                target: [sessionContextMessages.sessionId, sessionContextMessages.position],
            })
            .run();
    });
}
