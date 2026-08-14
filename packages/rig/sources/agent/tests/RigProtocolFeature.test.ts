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
                await callback();
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
            projectAgentConfiguration: async () => snapshot,
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
            id: "user-1",
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
        await feature.onEventTransact(ctx, scope("agent-1"), completed);
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
                    await callback();
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
                projectAgentConfiguration: async () => snapshot,
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

    it("does not resolve a rolled-back submission and projects it once on retry", async () => {
        const feature = new RigProtocolFeature();
        const snapshot = {
            modelId: "gpt-test",
            modelLocked: false,
            providerId: "codex",
        } as ProtocolSession;
        const projected: SessionEvent[] = [];
        const protocolEvents: SessionEvent[] = [];
        let callbacks: Array<() => void | Promise<void>> = [];
        const session: RigAgentProtocolSession = {
            afterProtocolCommit: async (_ctx, callback) => {
                callbacks.push(async () => {
                    await callback();
                    projected.push({} as SessionEvent);
                });
            },
            events: {
                append: async (_ctx, event) => event,
            },
            id: "session-rollback",
            projectAgentMessage: async () => {
                throw new Error("The inference is not expected in this test.");
            },
            projectAgentConfiguration: async () => snapshot,
            projectProtocolEvent: async (_ctx, event) => {
                protocolEvents.push(event);
                return event;
            },
            projectUserMessage: async (_ctx, input) => {
                const event = {
                    createdAt: Date.now(),
                    data: input,
                    id: `submitted-${String(projected.length + 1)}`,
                    sessionId: "session-rollback",
                    type: "message_submitted",
                } satisfies SessionEvent;
                return event;
            },
            publishAgentLiveEvent: () => undefined,
            snapshot: () => snapshot,
        };
        const registration = feature.register("agent-rollback", {
            delivery: "run",
            displayText: "Retry me",
            messageId: "retry-user",
            message: {
                blocks: [{ text: "Retry me", type: "text" }],
                id: "retry-user",
                role: "user",
            },
            modelId: "gpt-test",
            providerId: "codex",
            runId: "retry-run",
            session,
            snapshot,
        });
        const accepted = {
            id: "retry-user",
            kind: "send",
            message: { content: [{ text: "Retry me", type: "text" }], role: "user" },
        } as const;

        await feature.messageAcceptedTransact(ctx, scope("agent-rollback"), accepted);
        callbacks = [];
        runValues.delete("agent-rollback");
        let resolved = false;
        void registration.projected().then(() => {
            resolved = true;
        });
        await Promise.resolve();
        expect(resolved).toBe(false);
        expect(projected).toHaveLength(0);

        await feature.messageAcceptedTransact(ctx, scope("agent-rollback"), accepted);
        const retryCallbacks = callbacks.splice(0);
        for (const callback of retryCallbacks) await callback();
        await feature.messageAccepted(ctx, scope("agent-rollback"), accepted);

        await expect(registration.projected()).resolves.toMatchObject({
            type: "message_submitted",
        });
        expect(projected).toHaveLength(1);

        await feature.afterAgentSettledTransact(ctx, scope("agent-rollback"));
        expect(protocolEvents.map((event) => event.type)).toEqual(["run_finished"]);
        await feature.afterAgentSettled(ctx, scope("agent-rollback"));
        expect(feature.hasPending("agent-rollback")).toBe(true);

        const terminalCallbacks = callbacks.splice(0);
        expect(terminalCallbacks).toHaveLength(1);
        for (const callback of terminalCallbacks) await callback();
        await feature.afterAgentSettled(ctx, scope("agent-rollback"));
        expect(feature.hasPending("agent-rollback")).toBe(false);
    });

    it("uses the final accepted steer candidate for a same-run terminal event", async () => {
        const feature = new RigProtocolFeature();
        const events: SessionEvent[] = [];
        const originalSnapshot = {
            modelId: "gpt-original",
            modelLocked: false,
            providerId: "codex",
        } as ProtocolSession;
        const steerSnapshot = {
            modelId: "claude-final",
            modelLocked: true,
            providerId: "claude",
        } as ProtocolSession;
        const session: RigAgentProtocolSession = {
            afterProtocolCommit: async (_ctx, callback) => {
                await callback();
            },
            events: {
                append: async (_ctx, event) => {
                    events.push(event);
                    return event;
                },
            },
            id: "session-same-run",
            projectAgentMessage: async () => {
                throw new Error("No assistant message expected.");
            },
            projectAgentConfiguration: async () => originalSnapshot,
            projectProtocolEvent: async (_ctx, event) => {
                events.push(event);
                return event;
            },
            projectUserMessage: async (_ctx, input) =>
                ({
                    createdAt: Date.now(),
                    data: input,
                    id: `submitted-${input.message.id}`,
                    sessionId: "session-same-run",
                    type: "message_submitted",
                }) satisfies SessionEvent,
            publishAgentLiveEvent: () => undefined,
            snapshot: () => originalSnapshot,
        };
        const original = feature.register("agent-same-run", {
            delivery: "run",
            displayText: "original",
            messageId: "original-message",
            message: {
                blocks: [{ text: "original", type: "text" }],
                id: "original-message",
                role: "user",
            },
            modelId: "gpt-original",
            providerId: "codex",
            runId: "same-run",
            session,
            snapshot: originalSnapshot,
        });
        const steer = feature.register("agent-same-run", {
            delivery: "steer",
            displayText: "steer",
            messageId: "steer-message",
            message: {
                blocks: [{ text: "steer", type: "text" }],
                id: "steer-message",
                role: "user",
            },
            modelId: "claude-final",
            providerId: "claude",
            runId: "same-run",
            session,
            snapshot: steerSnapshot,
        });

        for (const [messageId, kind] of [
            ["original-message", "send"],
            ["steer-message", "steering"],
        ] as const) {
            const accepted = {
                id: messageId,
                kind,
                message: { content: [{ text: messageId, type: "text" }], role: "user" },
            } as const;
            await feature.messageAcceptedTransact(ctx, scope("agent-same-run"), accepted);
        }
        await expect(original.projected()).resolves.toMatchObject({ type: "message_submitted" });
        await expect(steer.projected()).resolves.toMatchObject({ type: "message_submitted" });

        await feature.afterAgentSettledTransact(ctx, scope("agent-same-run"));
        const terminal = events.find((event) => event.type === "run_finished");
        expect(terminal).toMatchObject({
            data: {
                modelLocked: true,
                providerId: "claude",
                requestedModelId: "claude-final",
                runId: "same-run",
            },
        });
    });
});

const runValues = new Map<string, Map<string, unknown>>();

function scope(agentId: string): AgentFeatureScope {
    const values = runValues.get(agentId) ?? new Map<string, unknown>();
    runValues.set(agentId, values);
    return {
        agent: {
            id: agentId,
            model: "gpt-test",
            provider: "codex",
        },
        runKV: {
            delete: async (_ctx: unknown, key: string) => {
                values.delete(key);
            },
            read: async (_ctx: unknown, key: string) => values.get(key),
            write: async (_ctx: unknown, key: string, value: unknown) => {
                values.set(key, value);
            },
        },
    } as unknown as AgentFeatureScope;
}
