import { describe, expect, it } from "vitest";

import type { SessionEvent, Usage } from "../../../protocol/index.js";
import { aggregateSessionUsage } from "../aggregateSessionUsage.js";

describe("aggregateSessionUsage", () => {
    it("groups attributed inference usage by provider and display model", () => {
        const result = aggregateSessionUsage(
            [
                inference("event-1", usage(10), {
                    providerId: "codex",
                    requestedModelId: "openai/gpt-5.6",
                    responseModel: "gpt-5.6-2026-07-01",
                }),
                inference("event-2", usage(20), {
                    providerId: "codex",
                    requestedModelId: "openai/gpt-5.6-fast",
                    responseModel: "gpt-5.6-2026-07-01",
                }),
                inference("event-3", usage(7), {
                    providerId: "codex",
                    requestedModelId: "openai/gpt-5.6",
                }),
                inference("event-4", usage(5), {
                    providerId: "claude",
                    requestedModelId: "anthropic/claude-sonnet-4-6",
                }),
            ],
            primary,
        );

        expect(result.groups).toHaveLength(3);
        expect(result.groups[0]).toMatchObject({
            kind: "attributed",
            modelId: "gpt-5.6-2026-07-01",
            providerId: "codex",
            requestedModelId: "openai/gpt-5.6",
            responseModel: "gpt-5.6-2026-07-01",
            usage: {
                cacheRead: 6,
                cacheWrite: 9,
                cost: { input: 90, output: 120, total: 300 },
                input: 30,
                output: 60,
                totalTokens: 300,
            },
        });
        expect(result.groups[1]).toMatchObject({
            modelId: "openai/gpt-5.6",
            providerId: "codex",
            usage: { input: 7 },
        });
        expect(result.groups[2]).toMatchObject({
            modelId: "anthropic/claude-sonnet-4-6",
            providerId: "claude",
            usage: { input: 5 },
        });
        expect(result.currentContext).toEqual({
            approximate: false,
            modelId: "anthropic/claude-sonnet-4-6",
            providerId: "claude",
            requestedModelId: "anthropic/claude-sonnet-4-6",
            totalTokens: 50,
        });
    });

    it("keeps an exact reasoning breakdown only when every grouped response reports it", () => {
        const exactFirst = { ...usage(2), reasoning: 3 };
        const exactSecond = { ...usage(3), reasoning: 4 };
        const exact = aggregateSessionUsage(
            [
                inference("reasoning-1", exactFirst, {
                    providerId: "codex",
                    requestedModelId: "openai/gpt-5.6",
                }),
                inference("reasoning-2", exactSecond, {
                    providerId: "codex",
                    requestedModelId: "openai/gpt-5.6",
                }),
            ],
            primary,
        );
        expect(exact.groups[0]?.usage.reasoning).toBe(7);

        const incomplete = aggregateSessionUsage(
            [
                inference("reasoning-known", exactFirst, {
                    providerId: "codex",
                    requestedModelId: "openai/gpt-5.6",
                }),
                inference("reasoning-unknown", usage(3), {
                    providerId: "codex",
                    requestedModelId: "openai/gpt-5.6",
                }),
            ],
            primary,
        );
        expect(incomplete.groups[0]?.usage.reasoning).toBeUndefined();
    });

    it("only counts usage after the latest session reset", () => {
        expect(
            aggregateSessionUsage(
                [
                    inference("before-reset", usage(10), {
                        providerId: "codex",
                        requestedModelId: "openai/old",
                    }),
                    reset("reset-only", "codex", "openai/gpt-5.6"),
                ],
                primary,
            ).currentContext,
        ).toBeUndefined();

        const result = aggregateSessionUsage(
            [
                inference("before", usage(100), {
                    providerId: "codex",
                    requestedModelId: "openai/old",
                }),
                reset("reset-1", "claude", "anthropic/claude-sonnet-4-6"),
                inference("between", usage(20), {
                    providerId: "claude",
                    requestedModelId: "anthropic/claude-sonnet-4-6",
                }),
                reset("reset-2", "codex", "openai/gpt-5.6"),
                inference("after", usage(3), {
                    providerId: "codex",
                    requestedModelId: "openai/gpt-5.6",
                }),
            ],
            primary,
        );

        expect(result.groups).toHaveLength(1);
        expect(result.groups[0]).toMatchObject({
            modelId: "openai/gpt-5.6",
            providerId: "codex",
            usage: { input: 3, totalTokens: 30 },
        });
    });

    it("preserves consumed usage across rewinds while invalidating current context", () => {
        const events = [
            inference("before-rewind", usage(11), {
                providerId: "codex",
                requestedModelId: "openai/gpt-5.6",
            }),
            rewind("rewind", "codex", "openai/gpt-5.6"),
        ];

        const rewound = aggregateSessionUsage(events, primary);

        expect(rewound.groups[0]).toMatchObject({ usage: { input: 11, totalTokens: 110 } });
        expect(rewound.currentContext).toBeUndefined();

        const refreshed = aggregateSessionUsage(
            [
                ...events,
                inference("after-rewind", usage(4), {
                    providerId: "codex",
                    requestedModelId: "openai/gpt-5.6",
                }),
            ],
            primary,
        );
        expect(refreshed.groups[0]).toMatchObject({ usage: { input: 15, totalTokens: 150 } });
        expect(refreshed.currentContext).toMatchObject({ approximate: false, totalTokens: 40 });
    });

    it("tracks exact inference context and approximate compaction context for the active model", () => {
        const initial = [
            created("created", "codex", "openai/gpt-5.6"),
            inference(
                "codex-inference",
                usage(12),
                {
                    providerId: "codex",
                    requestedModelId: "openai/gpt-5.6",
                    responseModel: "gpt-5.6-2026-07-01",
                },
                73,
            ),
        ];
        expect(aggregateSessionUsage(initial, primary).currentContext).toEqual({
            approximate: false,
            modelId: "gpt-5.6-2026-07-01",
            providerId: "codex",
            requestedModelId: "openai/gpt-5.6",
            responseModel: "gpt-5.6-2026-07-01",
            totalTokens: 73,
        });

        const changed = [
            ...initial,
            modelChanged("changed", "claude", "anthropic/claude-sonnet-4-6"),
        ];
        expect(aggregateSessionUsage(changed, primary).currentContext).toBeUndefined();

        const compactionUsage = compaction("compaction-usage", usage(2), "claude");
        const compacted = [
            ...changed,
            contextCompacted("compacted", 45),
            compactionUsage,
            { ...compactionUsage, id: "compaction-usage-republished" },
        ];
        const compactedUsage = aggregateSessionUsage(compacted, primary);
        expect(compactedUsage.currentContext).toEqual({
            approximate: true,
            modelId: "anthropic/claude-sonnet-4-6",
            providerId: "claude",
            requestedModelId: "anthropic/claude-sonnet-4-6",
            totalTokens: 45,
        });
        expect(compactedUsage.groups.at(-1)).toMatchObject({
            modelId: "anthropic/claude-sonnet-4-6",
            providerId: "claude",
            usage: { input: 2, output: 4, totalTokens: 20 },
        });
        expect(compactedUsage.sessionTokenCount.totalTokens).toBe(140);

        const refreshed = [
            ...compacted,
            inference(
                "claude-inference",
                usage(9),
                {
                    providerId: "claude",
                    requestedModelId: "anthropic/claude-sonnet-4-6",
                    responseModel: "claude-sonnet-4-6-20260301",
                },
                54,
            ),
        ];
        expect(aggregateSessionUsage(refreshed, primary).currentContext).toEqual({
            approximate: false,
            modelId: "claude-sonnet-4-6-20260301",
            providerId: "claude",
            requestedModelId: "anthropic/claude-sonnet-4-6",
            responseModel: "claude-sonnet-4-6-20260301",
            totalTokens: 54,
        });
    });

    it("excludes subagent sessions based on caller-provided session metadata", () => {
        const result = aggregateSessionUsage(
            [
                inference("subagent-inference", usage(10), {
                    providerId: "codex",
                    requestedModelId: "openai/gpt-5.6",
                }),
            ],
            { type: "subagent" },
        );

        expect(result).toEqual({
            groups: [],
            sessionTokenCount: { lastContextTokens: 100, totalTokens: 100 },
        });
    });

    it("attributes a compaction-only incremental usage window from the durable message", () => {
        const result = aggregateSessionUsage(
            [compaction("compaction-only", usage(3), "claude", "claude-sonnet-4-6-20260301")],
            primary,
        );

        expect(result.groups).toMatchObject([
            {
                modelId: "claude-sonnet-4-6-20260301",
                providerId: "claude",
                requestedModelId: "anthropic/claude-sonnet-4-6",
                responseModel: "claude-sonnet-4-6-20260301",
                usage: { input: 3, totalTokens: 30 },
            },
        ]);
    });

    it("uses the same compaction attribution in full and incremental replay", () => {
        const responseModel = "claude-sonnet-4-6-20260301";
        const compacted = compaction("compaction", usage(3), "claude", responseModel);
        const full = aggregateSessionUsage(
            [
                created("created", "claude", "anthropic/claude-sonnet-4-6"),
                inference("inference", usage(5), {
                    providerId: "claude",
                    requestedModelId: "anthropic/claude-sonnet-4-6",
                    responseModel,
                }),
                compacted,
            ],
            primary,
        );
        const incremental = aggregateSessionUsage([compacted], primary);

        expect(full.groups).toHaveLength(1);
        expect(incremental.groups[0]).toMatchObject({
            modelId: full.groups[0]?.modelId,
            providerId: full.groups[0]?.providerId,
            requestedModelId: full.groups[0]?.requestedModelId,
            responseModel: full.groups[0]?.responseModel,
        });
    });

    it("bills permission review usage to the reviewer model without making it the active model", () => {
        const result = aggregateSessionUsage(
            [
                inference("event-1", usage(10), {
                    providerId: "codex",
                    requestedModelId: "openai/gpt-5.6",
                }),
                permissionReview(
                    "event-2",
                    usage(3),
                    "codex",
                    "openai/codex-auto-review",
                    "same-call",
                ),
                permissionReview(
                    "event-3",
                    usage(2),
                    "codex",
                    "openai/codex-auto-review",
                    "same-call",
                ),
            ],
            primary,
        );

        expect(result.groups).toHaveLength(2);
        expect(result.groups[1]).toMatchObject({
            kind: "attributed",
            modelId: "openai/codex-auto-review",
            providerId: "codex",
            usage: { input: 5, totalTokens: 50 },
        });
        // The reviewer's own history is not the conversation's context window.
        expect(result.currentContext).toMatchObject({
            modelId: "openai/gpt-5.6",
            totalTokens: 100,
        });
    });

    it("ignores a permission review that recorded no inference", () => {
        const result = aggregateSessionUsage(
            [
                inference("event-1", usage(10), {
                    providerId: "codex",
                    requestedModelId: "openai/gpt-5.6",
                }),
                {
                    createdAt: 1,
                    data: {
                        event: {
                            action: "running a command",
                            decision: "deny",
                            reason: "No reviewer was available.",
                            risk: "medium",
                            toolCallId: "call-1",
                            type: "permission_review",
                            userAuthorization: "low",
                        },
                        runId: "run-1",
                    },
                    id: "event-2",
                    sessionId: "session-1",
                    type: "agent_event",
                } as SessionEvent,
            ],
            primary,
        );

        expect(result.groups).toHaveLength(1);
    });
});

const primary = { type: "primary" } as const;

function permissionReview(
    id: string,
    reviewUsage: Usage,
    providerId: string,
    modelId: string,
    toolCallId = `call-${id}`,
): SessionEvent {
    return {
        createdAt: 1,
        data: {
            event: {
                action: "running a command",
                decision: "allow",
                reason: "Routine.",
                risk: "low",
                toolCallId,
                transcript: {
                    entries: [{ text: "Routine.", type: "text" }],
                    modelId,
                    providerId,
                    usage: reviewUsage,
                },
                type: "permission_review",
                userAuthorization: "high",
            },
            runId: `run-${id}`,
        },
        id,
        sessionId: "session-1",
        type: "agent_event",
    } as SessionEvent;
}

function usage(input: number): Usage {
    return {
        cacheRead: input * 0.2,
        cacheWrite: input * 0.3,
        cost: {
            cacheRead: input,
            cacheWrite: input * 2,
            input: input * 3,
            output: input * 4,
            total: input * 10,
        },
        input,
        output: input * 2,
        totalTokens: input * 10,
    };
}

function inference(
    id: string,
    eventUsage: Usage,
    attribution: { providerId?: string; requestedModelId?: string; responseModel?: string } = {},
    contextTokens = eventUsage.totalTokens,
): SessionEvent {
    return {
        createdAt: 1,
        data: {
            message: {
                blocks: [{ text: "done", type: "text" }],
                id: `message-${id}`,
                role: "agent",
                usage: eventUsage,
                contextTokens,
                ...attribution,
            },
            runId: `run-${id}`,
        },
        id,
        sessionId: "session-1",
        type: "agent_message",
    } as SessionEvent;
}

function reset(id: string, providerId: string, modelId: string): SessionEvent {
    return snapshotEvent(id, "session_reset", providerId, modelId);
}

function rewind(id: string, providerId: string, modelId: string): SessionEvent {
    return snapshotEvent(id, "session_rewound", providerId, modelId);
}

function modelChanged(id: string, providerId: string, modelId: string): SessionEvent {
    return snapshotEvent(id, "session_configuration_changed", providerId, modelId);
}

function snapshotEvent(
    id: string,
    type: "session_configuration_changed" | "session_reset" | "session_rewound",
    providerId: string,
    modelId: string,
): SessionEvent {
    return {
        createdAt: 1,
        data: {
            ...(type === "session_rewound" ? { messageId: "message-1" } : {}),
            ...(type === "session_configuration_changed"
                ? { changed: ["model"], modelId, providerId, serviceTier: null }
                : { snapshot: { modelId, providerId } }),
        },
        id,
        sessionId: "session-1",
        type,
    } as SessionEvent;
}

function contextCompacted(id: string, estimatedTokensAfter: number): SessionEvent {
    return {
        createdAt: 1,
        data: {
            event: {
                compactionId: `compaction-${id}`,
                compactedMessageCount: 2,
                elapsedMs: 25,
                estimatedTokensAfter,
                estimatedTokensBefore: 100,
                reason: "threshold",
                type: "context_compacted",
            },
            runId: "run-1",
        },
        id,
        sessionId: "session-1",
        type: "agent_event",
    } as SessionEvent;
}

function compaction(
    id: string,
    compactionUsage: Usage,
    providerId: string,
    responseModel?: string,
): SessionEvent {
    return {
        createdAt: 1,
        data: {
            message: {
                blocks: [{ text: "Compacted.", type: "text" }],
                content: "checkpoint",
                id: `message-${id}`,
                kind: "native",
                providerId,
                requestedModelId: "anthropic/claude-sonnet-4-6",
                ...(responseModel === undefined ? {} : { responseModel }),
                replacedMessageIds: [],
                role: "compaction",
                statistics: {
                    after: { exact: false, tokens: 45 },
                    before: { exact: true, tokens: 120 },
                },
                summary: "Compacted.",
                usage: compactionUsage,
            },
            runId: `run-${id}`,
        },
        id,
        sessionId: "session-1",
        type: "agent_message",
    } as SessionEvent;
}

function created(id: string, providerId: string, modelId: string): SessionEvent {
    return {
        createdAt: 1,
        data: { session: { modelId, providerId } },
        id,
        sessionId: "session-1",
        type: "session_created",
    } as SessionEvent;
}
