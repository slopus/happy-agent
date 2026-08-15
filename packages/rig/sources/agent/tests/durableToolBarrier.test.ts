import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";

import { runAgentLoop } from "../loop.js";
import { defineTool } from "../types.js";
import { createJustBashToolHarness } from "../../testing/createAgentTestHarness.js";
import { createTestRootContext } from "../../testing/createTestRootContext.js";
import {
    defineModel,
    defineProvider,
    type AssistantMessage,
    type ProviderAssistantMessageEvent,
    type InferenceStream,
} from "@slopus/rig-execution";

const ctx = createTestRootContext();

describe("durable tool execution barriers", () => {
    it("finishes immediate calls before publishing durable calls from the same batch", async () => {
        const order: string[] = [];
        let inferenceCount = 0;
        const model = defineModel({
            defaultThinkingLevel: "off",
            id: "mock/model",
            name: "Mock",
            thinkingLevels: ["off"],
        });
        const provider = defineProvider({
            id: "mock",
            models: [model],
            stream() {
                inferenceCount += 1;
                return streamFor(
                    inferenceCount === 1
                        ? message([
                              {
                                  arguments: {},
                                  id: "durable-first",
                                  name: "external",
                                  type: "toolCall",
                              },
                              {
                                  arguments: {},
                                  id: "immediate-second",
                                  name: "local",
                                  type: "toolCall",
                              },
                          ])
                        : message([{ text: "done", type: "text" }], "stop"),
                );
            },
        });
        const local = defineTool({
            arguments: Type.Object({}),
            description: "Local action",
            execute: () => {
                order.push("local");
                return "local-result";
            },
            label: "Local",
            locks: [],
            name: "local",
            returnType: Type.String(),
            shouldReviewInAutoMode: () => false,
            toLLM: (result) => [{ text: result, type: "text" }],
            toUI: () => "Local completed",
        });
        const external = defineTool({
            arguments: Type.Object({}),
            description: "Durable action",
            execution: "durable",
            execute: () => {
                order.push("durable");
                return "external-result";
            },
            label: "External",
            locks: [],
            name: "external",
            returnType: Type.String(),
            shouldReviewInAutoMode: () => false,
            toLLM: (result) => [{ text: result, type: "text" }],
            toUI: () => "External completed",
        });
        const harness = createJustBashToolHarness();

        const result = await runAgentLoop(ctx, {
            context: harness.context,
            messages: [{ blocks: [{ text: "Run both", type: "text" }], id: "user", role: "user" }],
            modelId: model.id,
            provider,
            tools: [local, external],
        });

        expect(order).toEqual(["local", "durable"]);
        expect(result.messages.slice(2, 4).map((entry) => entry.role)).toEqual(["agent", "agent"]);
        expect(result.messages[2]).toMatchObject({
            blocks: [
                {
                    providerToolCallId: "immediate-second",
                    toolCallId: expect.any(String),
                    type: "tool_result",
                },
            ],
        });
        expect(result.messages[3]).toMatchObject({
            blocks: [
                {
                    providerToolCallId: "durable-first",
                    toolCallId: expect.any(String),
                    type: "tool_result",
                },
            ],
        });
    });
});

function message(
    content: AssistantMessage["content"],
    stopReason: AssistantMessage["stopReason"] = "toolUse",
): AssistantMessage {
    return {
        api: "mock",
        content,
        model: "mock/model",
        provider: "mock",
        role: "assistant",
        stopReason,
        timestamp: 0,
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

function streamFor(message: AssistantMessage): InferenceStream {
    return {
        async *[Symbol.asyncIterator](): AsyncIterator<ProviderAssistantMessageEvent> {
            yield { partial: message, type: "start" };
            if (message.stopReason === "toolUse" || message.stopReason === "stop") {
                yield { message, reason: message.stopReason, type: "done" };
            }
        },
        result: async () => message,
    };
}
