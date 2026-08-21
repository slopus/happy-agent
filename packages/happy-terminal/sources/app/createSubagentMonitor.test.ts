import { describe, expect, it, vi } from "vitest";

import type { SessionEvent, SubagentSummary } from "../protocol/index.js";
import { createSubagentMonitor } from "./createSubagentMonitor.js";
import { stripAnsi } from "./testing/stripAnsi.js";

describe("createSubagentMonitor", () => {
    it("shows each subagent's model and latest context size in a navigable list", () => {
        const monitor = createSubagentMonitor({
            getHeight: () => 16,
            getSubagents: () => [
                subagent("agent-1", "Inspect caching", "openai/gpt-5.6", 1_250),
                subagent("agent-2", "Check rendering", "anthropic/claude-sonnet-4-6", 800),
            ],
            modelName: (modelId) =>
                modelId === "openai/gpt-5.6" ? "GPT-5.6" : "Claude Sonnet 4.6",
            onCancel: vi.fn(),
            watchSubagent: vi.fn(async () => undefined),
        });

        expect(render(monitor)).toContain(
            "→ Running · Inspect caching · GPT-5.6 · 1.3k context tokens",
        );
        monitor.handleInput?.("\x1b[B");
        expect(render(monitor)).toContain(
            "→ Running · Check rendering · Claude Sonnet 4.6 · 800 context tokens",
        );
    });

    it("opens a live child event stream and only renders log rows that fit the viewport", async () => {
        let publish: ((event: SessionEvent) => void) | undefined;
        const watchSubagent = vi.fn(
            async (
                _agentId: string,
                _signal: AbortSignal,
                onEvent: (event: SessionEvent) => void,
            ) => {
                publish = onEvent;
            },
        );
        const monitor = createSubagentMonitor({
            getHeight: () => 12,
            getSubagents: () => [subagent("agent-1", "Inspect streaming", "openai/gpt-5.6", 1_250)],
            modelName: () => "GPT-5.6",
            onCancel: vi.fn(),
            watchSubagent,
        });

        monitor.handleInput?.("\r");
        await vi.waitFor(() => expect(watchSubagent).toHaveBeenCalledOnce());
        for (let index = 1; index <= 10; index += 1) {
            publish?.(agentMessage(`message-${index}`, `STREAM_LOG_${index}`));
        }

        const tailed = monitor.render(80).map(stripAnsi);
        expect(tailed.length).toBeLessThanOrEqual(12);
        expect(tailed.join("\n")).toContain("STREAM_LOG_10");
        expect(tailed.join("\n")).not.toContain("STREAM_LOG_1\n");

        monitor.handleInput?.("\x1b[A");
        expect(render(monitor)).toContain("STREAM_LOG_6");
        expect(render(monitor)).not.toContain("STREAM_LOG_10");
    });

    it("reconciles a durable inference failure with its terminal boundary", async () => {
        let publish: ((event: SessionEvent) => void) | undefined;
        const monitor = createSubagentMonitor({
            getHeight: () => 12,
            getSubagents: () => [subagent("agent-1", "Inspect failures", "openai/gpt-5.6", 0)],
            modelName: () => "GPT-5.6",
            onCancel: vi.fn(),
            watchSubagent: vi.fn(
                async (
                    _agentId: string,
                    _signal: AbortSignal,
                    onEvent: (event: SessionEvent) => void,
                ) => {
                    publish = onEvent;
                },
            ),
        });
        monitor.handleInput?.("\r");
        await vi.waitFor(() => expect(publish).toBeDefined());
        publish?.({
            createdAt: 1,
            data: {
                message: {
                    blocks: [{ text: "Provider unavailable.", type: "text" }],
                    id: "failure-1",
                    outcome: "failed",
                    role: "error",
                },
                runId: "run-1",
            },
            id: "failure-message",
            sessionId: "agent-1",
            type: "agent_message",
        });
        publish?.({
            createdAt: 2,
            data: {
                errorMessage: "Provider unavailable.",
                modelLocked: false,
                runId: "run-1",
            },
            id: "run-error",
            sessionId: "agent-1",
            type: "run_error",
        });

        expect(render(monitor).match(/Provider unavailable\./gu)).toHaveLength(1);
    });
});

function render(component: ReturnType<typeof createSubagentMonitor>): string {
    return stripAnsi(component.render(100).join("\n"));
}

function subagent(
    id: string,
    description: string,
    modelId: string,
    totalTokens: number,
): SubagentSummary {
    return {
        agentId: id,
        createdAt: 1,
        depth: 1,
        description,
        id,
        modelId,
        parentSessionId: "parent",
        status: "running",
        totalTokens,
        updatedAt: 1,
    };
}

function agentMessage(id: string, text: string): SessionEvent {
    return {
        createdAt: 1,
        data: {
            message: {
                blocks: [{ text, type: "text" }],
                id,
                role: "agent",
                usage: {
                    cacheRead: 900,
                    cacheWrite: 0,
                    cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
                    input: 1_000,
                    output: 250,
                    totalTokens: 1_250,
                },
            },
            runId: "run-1",
        },
        id: `event-${id}`,
        sessionId: "agent-1",
        type: "agent_message",
    };
}
