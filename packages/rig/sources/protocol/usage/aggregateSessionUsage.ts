import type { SessionEvent } from "../index.js";
import { addUsage } from "./addUsage.js";
import {
    type AttributedSessionUsageGroup,
    type SessionContextUsage,
    type SessionUsageGroup,
    type SessionUsageMetadata,
    type SessionUsageSummary,
} from "./types.js";
import { zeroUsage } from "./zeroUsage.js";
import { aggregateSessionTokenCount } from "./aggregateSessionTokenCount.js";

interface ActiveModel {
    modelId: string;
    providerId: string;
    requestedModelId: string;
    responseModel?: string;
}

export function aggregateSessionUsage(
    events: readonly SessionEvent[],
    metadata: SessionUsageMetadata,
): SessionUsageSummary {
    const sessionTokenCount = aggregateSessionTokenCount(events);
    if (metadata.type === "subagent") {
        return { groups: [], sessionTokenCount };
    }

    let groups: SessionUsageGroup[] = [];
    let attributedGroupIndexes = new Map<string, number>();
    let countedUsageIds = new Set<string>();
    let activeModel: ActiveModel | undefined;
    let currentContext: SessionContextUsage | undefined;

    for (const event of events) {
        if (event.type === "session_reset") {
            groups = [];
            attributedGroupIndexes = new Map();
            countedUsageIds = new Set();
            activeModel = {
                modelId: event.data.snapshot.modelId,
                providerId: event.data.snapshot.providerId,
                requestedModelId: event.data.snapshot.modelId,
            };
            currentContext = undefined;
            continue;
        }

        if (event.type === "session_created") {
            activeModel = {
                modelId: event.data.session.modelId,
                providerId: event.data.session.providerId,
                requestedModelId: event.data.session.modelId,
            };
            continue;
        }

        if (event.type === "session_rewound") {
            activeModel = {
                modelId: event.data.snapshot.modelId,
                providerId: event.data.snapshot.providerId,
                requestedModelId: event.data.snapshot.modelId,
            };
            currentContext = undefined;
            continue;
        }

        if (
            event.type === "session_configuration_changed" &&
            // Reasoning and fast mode changes keep the same model and the same context, so
            // only an actual model change restarts attribution.
            event.data.changed.includes("model")
        ) {
            activeModel = {
                modelId: event.data.modelId,
                providerId: event.data.providerId,
                requestedModelId: event.data.modelId,
            };
            currentContext = undefined;
            continue;
        }

        if (
            event.type === "agent_event" &&
            event.data.event.type === "permission_review" &&
            event.data.event.transcript !== undefined
        ) {
            const usageId = `permission_review:${event.id}`;
            if (countedUsageIds.has(usageId)) continue;
            countedUsageIds.add(usageId);
            // The reviewer spends the user's tokens on its own model, so it is billed under that
            // model. It never becomes the active model, because it is not what the conversation
            // is running on and its history is not the context window the user is watching.
            const transcript = event.data.event.transcript;
            const groupKey = JSON.stringify([
                transcript.providerId,
                transcript.modelId,
                "permission_review",
            ]);
            let groupIndex = attributedGroupIndexes.get(groupKey);
            if (groupIndex === undefined) {
                groupIndex = groups.length;
                attributedGroupIndexes.set(groupKey, groupIndex);
                groups.push({
                    kind: "attributed",
                    modelId: transcript.modelId,
                    providerId: transcript.providerId,
                    requestedModelId: transcript.modelId,
                    role: "permission_review",
                    usage: zeroUsage(),
                });
            }
            const reviewerGroup = groups[groupIndex] as AttributedSessionUsageGroup;
            groups[groupIndex] = {
                ...reviewerGroup,
                usage: addUsage(reviewerGroup.usage, transcript.usage),
            };
            continue;
        }

        if (
            event.type === "agent_event" &&
            event.data.event.type === "context_compacted" &&
            activeModel !== undefined
        ) {
            currentContext = {
                ...activeModel,
                approximate: true,
                totalTokens: event.data.event.estimatedTokensAfter,
            };
            continue;
        }

        if (event.type !== "agent_message") continue;
        const message = event.data.message;
        if (message.role === "compaction" && message.usage !== undefined) {
            const usageId = `message:${message.id}`;
            if (countedUsageIds.has(usageId)) continue;
            countedUsageIds.add(usageId);
            const compactionModel =
                message.requestedModelId === undefined
                    ? activeModel
                    : {
                          modelId: message.responseModel ?? message.requestedModelId,
                          providerId: message.providerId,
                          requestedModelId: message.requestedModelId,
                          ...(message.responseModel === undefined
                              ? {}
                              : { responseModel: message.responseModel }),
                      };
            if (compactionModel === undefined) continue;
            const groupKey = JSON.stringify([message.providerId, compactionModel.modelId]);
            let groupIndex = attributedGroupIndexes.get(groupKey);
            if (groupIndex === undefined) {
                groupIndex = groups.length;
                attributedGroupIndexes.set(groupKey, groupIndex);
                groups.push({
                    kind: "attributed",
                    ...compactionModel,
                    providerId: message.providerId,
                    usage: zeroUsage(),
                });
            }
            const group = groups[groupIndex] as AttributedSessionUsageGroup;
            groups[groupIndex] = { ...group, usage: addUsage(group.usage, message.usage) };
            continue;
        }
        if (message.role !== "agent" || message.usage === undefined) continue;
        const usageId = `message:${message.id}`;
        const usageAlreadyCounted = countedUsageIds.has(usageId);
        countedUsageIds.add(usageId);

        const hasCompleteAttribution =
            message.providerId !== undefined &&
            message.providerId.trim().length > 0 &&
            message.requestedModelId !== undefined &&
            message.requestedModelId.trim().length > 0;
        if (!hasCompleteAttribution) {
            throw new Error("Persisted inference usage is missing provider or model attribution.");
        }

        const providerId = message.providerId as string;
        const requestedModelId = message.requestedModelId as string;
        const modelId = message.responseModel ?? requestedModelId;
        const groupKey = JSON.stringify([providerId, modelId]);
        let groupIndex = attributedGroupIndexes.get(groupKey);
        if (groupIndex === undefined) {
            const group: AttributedSessionUsageGroup = {
                kind: "attributed",
                modelId,
                providerId,
                requestedModelId,
                ...(message.responseModel === undefined
                    ? {}
                    : { responseModel: message.responseModel }),
                usage: zeroUsage(),
            };
            groupIndex = groups.length;
            attributedGroupIndexes.set(groupKey, groupIndex);
            groups.push(group);
        }
        if (!usageAlreadyCounted) {
            const group = groups[groupIndex] as AttributedSessionUsageGroup;
            groups[groupIndex] = { ...group, usage: addUsage(group.usage, message.usage) };
        }
        activeModel = {
            modelId,
            providerId,
            requestedModelId,
            ...(message.responseModel === undefined
                ? {}
                : { responseModel: message.responseModel }),
        };
        if (message.contextTokens !== undefined) {
            currentContext = {
                ...activeModel,
                approximate: false,
                totalTokens: message.contextTokens,
            };
        }
    }

    return {
        ...(currentContext === undefined ? {} : { currentContext }),
        groups,
        sessionTokenCount,
    };
}
