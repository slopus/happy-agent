import { createTestRootContext } from "../../testing/createTestRootContext.js";

const ctx = createTestRootContext();
import { describe, expect, it } from "vitest";

import { Agent, createNodeAgentContext } from "../../agent/index.js";
import type { CreateCodingAssistantAgentOptions } from "../../runtime/createCodingAssistantAgent.js";
import { createEventIdFactory, type ModelCatalog } from "../../protocol/index.js";
import { NativeProcessManager } from "../../processes/index.js";
import {
    defineModel,
    defineProvider,
    type AssistantMessage,
    type Context,
    type InferenceStream,
    type Usage,
} from "@slopus/rig-execution";
import type { CodingAssistantRuntime } from "../../runtime/CodingAssistantRuntime.js";
import { InMemorySession } from "../InMemorySession.js";

describe("InMemorySession goals", () => {
    it("keeps review commands visible while sending expanded instructions to the model", async () => {
        const model = defineModel({
            defaultThinkingLevel: "medium",
            id: "test/review-model",
            name: "Review model",
            thinkingLevels: ["medium"],
        });
        const contexts: Context[] = [];
        const provider = defineProvider({
            id: "test",
            models: [model],
            stream(_ctx, _model, context) {
                contexts.push(context);
                return streamFor(
                    assistantMessage([{ type: "text", text: "No findings." }], "stop"),
                );
            },
        });
        const catalog: ModelCatalog = {
            defaultModelId: model.id,
            defaultProviderId: provider.id,
            models: [model],
            providers: [{ providerId: provider.id, models: [model] }],
        };
        const session = new InMemorySession(ctx, {
            createEventId: createEventIdFactory(),
            createRuntime: (options) => createTestRuntime(options, provider),
            modelCatalog: catalog,
            request: { cwd: "/tmp/rig-review-test", modelId: model.id, providerId: provider.id },
        });

        const submitted = await session.submit(ctx, { text: "/review focus on concurrency" });
        await expect(session.waitForRun(ctx, submitted.runId)).resolves.toMatchObject({
            status: "completed",
        });

        expect(session.snapshot().snapshot.messages[0]).toMatchObject({
            blocks: [{ text: "/review focus on concurrency", type: "text" }],
            role: "user",
        });
        const reviewContext = contexts.find((context) =>
            JSON.stringify(context.messages).includes("Do not modify files"),
        );
        expect(reviewContext).toBeDefined();
        expect(JSON.stringify(reviewContext?.messages)).toContain(
            "focus especially on: focus on concurrency",
        );
        expect(JSON.stringify(reviewContext?.messages)).not.toContain(
            '"text":"/review focus on concurrency"',
        );
    });

    it("keeps the name a goal gave a chat after the chat is cleared", async () => {
        const model = defineModel({
            defaultThinkingLevel: "medium",
            id: "test/goal-title-model",
            name: "Goal title model",
            thinkingLevels: ["medium"],
        });
        const provider = defineProvider({
            id: "test",
            models: [model],
            stream: () => streamFor(assistantMessage([{ type: "text", text: "Done." }], "stop")),
        });
        const session = new InMemorySession(ctx, {
            createEventId: createEventIdFactory(),
            createRuntime: (options) => createTestRuntime(options, provider),
            modelCatalog: {
                defaultModelId: model.id,
                defaultProviderId: provider.id,
                models: [model],
                providers: [{ providerId: provider.id, models: [model] }],
            },
            request: { cwd: "/tmp/rig-goal-title", modelId: model.id, providerId: provider.id },
        });

        await session.setGoal(ctx, { objective: "Migrate the parser" });
        const named = session.snapshot().title;
        expect(named).toBeDefined();

        // A name a chat has been given is the chat's, and clearing it does not take it back.
        await session.reset(ctx);
        expect(session.snapshot()).toMatchObject({ title: named, titleStatus: "ready" });

        await session.setGoal(ctx, { objective: "Rewrite the scheduler" });
        expect(session.snapshot().title).toBe(named);
    });
});

function createTestRuntime(
    options: CreateCodingAssistantAgentOptions,
    provider: ReturnType<typeof defineProvider>,
): CodingAssistantRuntime {
    const processManager = new NativeProcessManager();
    const context = createNodeAgentContext(createTestRootContext().named("agent"), {
        cwd: options.cwd,
        processManager,
        ...(options.goals !== undefined ? { goals: options.goals } : {}),
    });
    return {
        agent: new Agent({
            context,
            modelId: options.modelId ?? provider.models[0]?.id ?? "",
            printToConsole: false,
            provider,
            tools: [],
        }),
        context,
        cwd: options.cwd,
        processManager,
        executor: provider,
    };
}

function assistantMessage(
    content: AssistantMessage["content"],
    stopReason: AssistantMessage["stopReason"],
): AssistantMessage {
    return {
        api: "test",
        content,
        model: "test/goal-model",
        provider: "test",
        role: "assistant",
        stopReason,
        timestamp: 1,
        usage: zeroUsage(),
    };
}

function streamFor(message: AssistantMessage): InferenceStream {
    return {
        async *[Symbol.asyncIterator]() {
            yield { type: "start" as const, partial: message };
            yield {
                type: "done" as const,
                reason: message.stopReason as "stop" | "toolUse",
                message,
            };
        },
        async result() {
            return message;
        },
    };
}

function zeroUsage(): Usage {
    return {
        cacheRead: 0,
        cacheWrite: 0,
        cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
        input: 0,
        output: 0,
        totalTokens: 0,
    };
}
