import { createTestRootContext } from "../testing/createTestRootContext.js";
import { type TUI } from "@earendil-works/pi-tui";
import { defineModel, defineProvider, type AssistantMessage } from "@slopus/rig-execution";
import { describe, expect, it, vi } from "vitest";

import { Agent } from "../agent/Agent.js";
import { NativeProcessManager } from "../processes/index.js";
import { createJustBashToolHarness } from "../testing/createAgentTestHarness.js";
import { CodingAssistantApp } from "./CodingAssistantApp.js";
import { stripAnsi } from "./testing/stripAnsi.js";

const ANSWER = "The keychain lookup timed out.";

describe("CodingAssistantApp assistant text reconciliation", () => {
    it("keeps one copy when the durable message follows its streamed text", () => {
        const app = createApp();
        streamAnswer(app, "plain");
        applyAnswerMessage(app, "plain-message");
        finishRun(app, "plain-finished");

        expect(answerCount(app)).toBe(1);
    });

    it("keeps one copy when the event stream redelivers the durable message", () => {
        const app = createApp();
        streamAnswer(app, "redelivered");
        applyAnswerMessage(app, "redelivered-message");
        applyAnswerMessage(app, "redelivered-message-again");
        finishRun(app, "redelivered-finished");

        expect(answerCount(app)).toBe(1);
    });

    it("keeps one copy when the durable message arrives after the run finished", () => {
        const app = createApp();
        streamAnswer(app, "late");
        finishRun(app, "late-finished");
        applyAnswerMessage(app, "late-message");

        expect(answerCount(app)).toBe(1);
    });

    it("keeps one copy when the next inference iteration starts first", () => {
        const app = createApp();
        streamAnswer(app, "iterated");
        app.applySessionEvent({
            createdAt: 5,
            data: {
                event: {
                    iteration: 2,
                    messageId: "message-2",
                    type: "inference_iteration_start",
                },
                runId: "run-1",
            },
            id: "iterated-iteration-2",
            sessionId: "session-1",
            type: "agent_event",
        });
        applyAnswerMessage(app, "iterated-message");

        expect(answerCount(app)).toBe(1);
    });

    it("never adopts a streamed entry left behind by an earlier run", () => {
        const app = createApp();
        streamAnswer(app, "stranded");
        finishRun(app, "stranded-finished");
        app.applySessionEvent({
            createdAt: 7,
            data: { runId: "run-2" },
            id: "second-run-started",
            sessionId: "session-1",
            type: "run_started",
        });
        app.applySessionEvent({
            createdAt: 8,
            data: {
                message: {
                    blocks: [{ text: "A different answer.", type: "text" }],
                    id: "message-2",
                    role: "agent",
                },
                runId: "run-2",
            },
            id: "second-run-message",
            sessionId: "session-1",
            type: "agent_message",
        });

        expect(answerCount(app)).toBe(1);
        expect(stripAnsi(app.render(100).join("\n"))).toContain("A different answer.");
    });
});

function createApp(): CodingAssistantApp {
    const model = defineModel({
        defaultThinkingLevel: "off",
        id: "openai/gpt-test",
        name: "GPT Test",
        thinkingLevels: ["off"],
    });
    const provider = defineProvider({
        id: "codex",
        models: [model],
        stream: () => {
            throw new Error("This test never runs inference.");
        },
    });
    const harness = createJustBashToolHarness();
    return new CodingAssistantApp({
        ctx: createTestRootContext().named("app"),
        agent: new Agent({
            context: harness.context,
            modelId: model.id,
            printToConsole: false,
            provider,
        }),
        cwd: harness.context.fs.cwd,
        processManager: new NativeProcessManager(),
        sessionBacked: true,
        tui: fakeTui(),
    });
}

function streamAnswer(app: CodingAssistantApp, prefix: string): void {
    app.applySessionEvent({
        createdAt: 1,
        data: { runId: "run-1" },
        id: `${prefix}-run-started`,
        sessionId: "session-1",
        type: "run_started",
    });
    app.applySessionEvent({
        createdAt: 2,
        data: {
            event: {
                iteration: 1,
                messageId: `${prefix}-message`,
                type: "inference_iteration_start",
            },
            runId: "run-1",
        },
        id: `${prefix}-iteration`,
        sessionId: "session-1",
        type: "agent_event",
    });
    app.applySessionEvent({
        createdAt: 3,
        data: {
            event: {
                contentIndex: 0,
                delta: ANSWER,
                messageId: `${prefix}-message`,
                partial: partialAnswer(ANSWER),
                type: "text_delta",
            },
            runId: "run-1",
        },
        id: `${prefix}-delta`,
        sessionId: "session-1",
        type: "agent_event",
    });
    app.applySessionEvent({
        createdAt: 4,
        data: {
            event: {
                content: ANSWER,
                contentIndex: 0,
                messageId: `${prefix}-message`,
                partial: partialAnswer(ANSWER),
                type: "text_end",
            },
            runId: "run-1",
        },
        id: `${prefix}-text-end`,
        sessionId: "session-1",
        type: "agent_event",
    });
}

function applyAnswerMessage(app: CodingAssistantApp, eventId: string): void {
    app.applySessionEvent({
        createdAt: 5,
        data: {
            message: { blocks: [{ text: ANSWER, type: "text" }], id: "message-1", role: "agent" },
            runId: "run-1",
        },
        id: eventId,
        sessionId: "session-1",
        type: "agent_message",
    });
}

function finishRun(app: CodingAssistantApp, eventId: string): void {
    app.applySessionEvent({
        createdAt: 6,
        data: { modelLocked: false, runId: "run-1", stopReason: "stop" },
        id: eventId,
        sessionId: "session-1",
        type: "run_finished",
    });
}

function partialAnswer(text: string): AssistantMessage {
    return {
        api: "test",
        content: [{ text, type: "text" }],
        model: "openai/gpt-test",
        provider: "codex",
        role: "assistant",
        stopReason: "stop",
        timestamp: 1,
        usage: {
            cacheRead: 0,
            cacheWrite: 0,
            cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
            input: 0,
            output: 0,
            totalTokens: 0,
        },
    };
}

function answerCount(app: CodingAssistantApp): number {
    return stripAnsi(app.render(100).join("\n")).split(ANSWER).length - 1;
}

function fakeTui(): TUI {
    return {
        addChild: vi.fn(),
        requestRender: vi.fn(),
        setFocus: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        terminal: { rows: 20, columns: 80, write: vi.fn() },
    } as unknown as TUI;
}
