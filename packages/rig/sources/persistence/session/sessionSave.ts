import type { Context } from "@steve.kite/stdlib";

import { inDatabase } from "../database/inDatabase.js";
import { and, eq, gte, sql } from "drizzle-orm";

import type { Message } from "../../agent/types.js";
import { sessionContextMessages, sessionCredentialBindings, sessions } from "../database/schema.js";
import type { PersistedSessionState } from "../../session/InMemorySession.js";
import { inTx } from "../inTx.js";
import { sessionScopeValues } from "./impl/sessionScope.js";

export async function sessionSave(
    ctx: Context,
    state: PersistedSessionState,
    input: {
        contextMessages: readonly Message[];
        now: number;
    },
): Promise<void> {
    await inTx(ctx, "rig.sql.session.session_save", async (ctx) => {
        const tx = ctx.tx;
        const values = {
            ...sessionScopeValues(state.scope),
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
            effort: state.effort ?? null,
            elapsedMs: state.elapsedMs ?? 0,
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
            ownerInstanceId: state.ownerInstanceId,
            profileId: state.profileId ?? null,
            nextTaskId: state.nextTaskId,
            orderKey: state.orderKey,
            parentSessionId: state.agent.parentSessionId ?? null,
            delegatedBySessionId: state.agent.delegatedBySessionId ?? null,
            parentToolCallId: state.agent.parentToolCallId ?? null,
            permissionMode: state.permissionMode,
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
            unsortedSinceMs: state.unsortedSince ?? null,
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
            workspaceQueueWaiting: state.workspaceQueueWaiting === true,
            workspaceTransferJson: JSON.stringify(state.workspaceTransfer ?? { status: "idle" }),
        };
        const {
            createdAtMs: _createdAtMs,
            id: _id,
            ownerInstanceId: _ownerInstanceId,
            profileId: _profileId,
            ...updates
        } = values;
        await tx
            .insert(sessions)
            .values(values)
            .onConflictDoUpdate({ set: updates, target: sessions.id })
            .run();
        const credentialBindingId =
            state.credentialBindingId ?? `${state.ownerInstanceId}:${state.providerId}`;
        await tx
            .insert(sessionCredentialBindings)
            .values({ bindingId: credentialBindingId, sessionId: state.id })
            .onConflictDoUpdate({
                set: { bindingId: credentialBindingId },
                target: sessionCredentialBindings.sessionId,
            })
            .run();
        await replaceContextMessages(ctx, state.id, input.contextMessages);
    });
}

export async function replaceContextMessages(
    ctx: Context,
    sessionId: string,
    messages: readonly Message[],
): Promise<void> {
    return await inDatabase(ctx, "rig.sql.session.replace_context_messages", async (ctx) => {
        const tx = ctx.tx;
        await tx
            .delete(sessionContextMessages)
            .where(
                and(
                    eq(sessionContextMessages.sessionId, sessionId),
                    gte(sessionContextMessages.position, messages.length),
                ),
            )
            .run();
        for (const [position, message] of messages.entries()) {
            await tx
                .insert(sessionContextMessages)
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
        }
    });
}
