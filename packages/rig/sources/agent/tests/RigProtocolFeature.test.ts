import type { AgentBasePersistedEvent, AgentFeatureScope } from "@slopus/happy-agent-base";
import { describe, expect, it } from "vitest";

import type { Message } from "../types.js";
import type { ProtocolSession, SessionEvent } from "../../protocol/index.js";
import { createTestRootContext } from "../../testing/createTestRootContext.js";
import { RigProtocolFeature, type RigAgentProtocolSession } from "../RigProtocolFeature.js";

const ctx = createTestRootContext().named("rig-protocol-feature-test");

describe("RigProtocolFeature", () => {
    it("streams Agent Base text and commits the completed assistant message in protocol order", async () => {
        const feature = new RigProtocolFeature();
        const events: SessionEvent[] = [];
        const messages: Message[] = [];
        const snapshot = {
            modelId: "gpt-test",
            modelLocked: false,
            providerId: "codex",
        } as ProtocolSession;
        const session: RigAgentProtocolSession = {
            afterProtocolCommit: async (_ctx, callback) => {
                callback();
            },
            events: {
                append: async (_ctx, event) => {
                    events.push(event);
                    return event;
                },
            },
            id: "session-1",
            projectProtocolEvent: async (_ctx, event) => {
                events.push(event);
                return event;
            },
            projectAgentMessage: async (_ctx, runId, message) => {
                messages.push(message);
                const event = {
                    createdAt: Date.now(),
                    data: { message, runId },
                    id: `message-event-${String(messages.length)}`,
                    sessionId: "session-1",
                    type: "agent_message",
                } satisfies SessionEvent;
                events.push(event);
                return event;
            },
            projectUserMessage: async (_ctx, input) => {
                const event = {
                    createdAt: Date.now(),
                    data: input,
                    id: "submitted-event",
                    sessionId: "session-1",
                    type: "message_submitted",
                } satisfies SessionEvent;
                events.push(event);
                return event;
            },
            publishAgentLiveEvent: (_ctx, event) => {
                events.push(event);
            },
            snapshot: () => snapshot,
        };
        const registration = feature.register("agent-1", {
            delivery: "run",
            displayText: "Hello",
            messageId: "user-1",
            message: {
                blocks: [{ text: "Hello", type: "text" }],
                id: "user-1",
                role: "user",
            },
            modelId: "gpt-test",
            providerId: "codex",
            runId: "run-1",
            session,
            snapshot,
        });

        const accepted = {
            kind: "send",
            message: { content: [{ text: "Hello", type: "text" }], role: "user" },
        } as const;
        await feature.messageAcceptedTransact(ctx, scope("agent-1"), accepted);
        await feature.messageAccepted(ctx, scope("agent-1"), accepted);
        await expect(registration.projected()).resolves.toMatchObject({
            type: "message_submitted",
        });
        await feature.beforeInference(ctx, scope("agent-1"));
        feature.onEvent(ctx, scope("agent-1"), { type: "text_start" });
        feature.onEvent(ctx, scope("agent-1"), { type: "text_delta", delta: "Hello" });
        const completed = {
            type: "text_end",
            block: { type: "text", text: "Hello" },
        } satisfies AgentBasePersistedEvent;
        feature.onEvent(ctx, scope("agent-1"), { type: "text_end" });
        await new Promise<void>((resolve) => setImmediate(resolve));
        feature.onEventTransact(ctx, scope("agent-1"), completed);
        feature.onEvent(ctx, scope("agent-1"), {
            type: "done",
            state: "normal",
            tokens: { input: 4, output: 1 },
        });
        const inference = {
            state: "normal",
            tokens: { input: 4, output: 1 },
        } as const;
        await feature.afterInferenceTransact(ctx, scope("agent-1"), inference);
        await feature.afterInference(ctx, scope("agent-1"), inference);
        await feature.afterAgentSettledTransact(ctx, scope("agent-1"));
        await feature.afterAgentSettled(ctx, scope("agent-1"));

        expect(events.map((event) => event.type)).toEqual([
            "message_submitted",
            "run_started",
            "agent_event",
            "agent_event",
            "agent_event",
            "agent_event",
            "agent_message",
            "run_finished",
        ]);
        expect(
            events
                .filter((event) => event.type === "agent_event")
                .map((event) => event.data.event.type),
        ).toEqual(["inference_iteration_start", "text_start", "text_delta", "text_end"]);
        expect(messages).toEqual([
            expect.objectContaining({
                blocks: [{ text: "Hello", type: "text" }],
                contextTokens: 5,
                providerId: "codex",
                requestedModelId: "gpt-test",
                role: "agent",
            }),
        ]);
        expect(events.at(-1)).toEqual(
            expect.objectContaining({
                data: expect.objectContaining({ runId: "run-1", stopReason: "stop" }),
                type: "run_finished",
            }),
        );
    });

    it("does not publish a terminal event for a rejected submission", async () => {
        const feature = new RigProtocolFeature();
        const events: SessionEvent[] = [];
        const snapshot = {
            modelId: "gpt-test",
            modelLocked: false,
            providerId: "codex",
        } as ProtocolSession;
        const registration = feature.register("agent-1", {
            delivery: "run",
            displayText: "Hello",
            messageId: "user-1",
            message: {
                blocks: [{ text: "Hello", type: "text" }],
                id: "user-1",
                role: "user",
            },
            modelId: "gpt-test",
            providerId: "codex",
            runId: "run-1",
            session: {
                afterProtocolCommit: async (_ctx, callback) => {
                    callback();
                },
                events: {
                    append: async (_ctx, event) => {
                        events.push(event);
                        return event;
                    },
                },
                id: "session-1",
                projectProtocolEvent: async (_ctx, event) => {
                    events.push(event);
                    return event;
                },
                projectAgentMessage: async () => {
                    throw new Error("A rejected run cannot project messages.");
                },
                projectUserMessage: async () => {
                    throw new Error("A rejected run cannot project messages.");
                },
                publishAgentLiveEvent: (_ctx, event) => {
                    events.push(event);
                },
                snapshot: () => snapshot,
            },
            snapshot,
        });

        registration.cancel();
        await feature.afterAgentSettledTransact(ctx, scope("agent-1"));
        await feature.afterAgentSettled(ctx, scope("agent-1"));

        expect(events).toEqual([]);
    });
});

function scope(agentId: string): AgentFeatureScope {
    return {
        agent: {
            id: agentId,
            model: "gpt-test",
            provider: "codex",
        },
    } as AgentFeatureScope;
}
