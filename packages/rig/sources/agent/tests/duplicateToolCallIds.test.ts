import { Type } from "@sinclair/typebox";
import { describe, expect, it, vi } from "vitest";

import { runAgentLoop } from "../loop.js";
import { defineTool } from "../types.js";
import { createJustBashToolHarness } from "../../testing/createAgentTestHarness.js";
import { createTestRootContext } from "../../testing/createTestRootContext.js";
import {
    defineModel,
    defineProvider,
    type AssistantMessage,
    type ProviderAssistantMessageEvent,
    type Context,
    type InferenceStream,
} from "@slopus/rig-execution";

const ctx = createTestRootContext();

describe("provider tool call identifiers", () => {
    it("assigns unique Rig IDs while replaying a repeated provider ID", async () => {
        const model = defineModel({
            id: "mock/model",
            name: "Mock Model",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const contexts: Context[] = [];
        let iteration = 0;
        const provider = defineProvider({
            id: "mock",
            models: [model],
            stream(_ctx, _model, context) {
                contexts.push(context);
                iteration += 1;
                return streamFor(
                    iteration <= 2
                        ? message([
                              {
                                  type: "toolCall",
                                  id: "reused-provider-id",
                                  name: "machine-action",
                                  arguments: { value: `action-${String(iteration)}` },
                              },
                          ])
                        : message([], "stop"),
                );
            },
        });
        const execute = vi.fn((args: { value: string }) => args);
        const tool = defineTool({
            name: "machine-action",
            label: "Machine action",
            description: "Changes the machine.",
            arguments: Type.Object({ value: Type.String() }),
            returnType: Type.Object({ value: Type.String() }),
            shouldReviewInAutoMode: () => false,
            execute,
            toLLM: (result: { value: string }) => [{ type: "text", text: result.value }],
            toUI: (result: { value: string }) => result.value,
            locks: [],
        });
        let nextId = 0;
        const harness = createJustBashToolHarness();

        const result = await runAgentLoop(ctx, {
            provider,
            modelId: model.id,
            tools: [tool],
            messages: [
                {
                    role: "user",
                    id: "user-1",
                    blocks: [{ type: "text", text: "Run both actions." }],
                },
            ],
            context: harness.context,
            idFactory: () => `rig-id-${String(++nextId)}`,
        });

        expect(result.stopReason).toBe("stop");
        expect(execute).toHaveBeenCalledTimes(2);
        const toolCalls = result.messages
            .flatMap((entry) => (entry.role === "agent" ? entry.blocks : []))
            .filter((block) => block.type === "tool_call");
        expect(toolCalls).toHaveLength(2);
        expect(toolCalls.map((call) => call.id)).toHaveLength(
            new Set(toolCalls.map((call) => call.id)).size,
        );
        expect(toolCalls.map((call) => call.providerToolCallId)).toEqual([
            "reused-provider-id",
            "reused-provider-id",
        ]);

        const secondRequest = contexts[1]!;
        const firstRigId = toolCalls[0]!.id;
        expect(secondRequest.messages.at(-2)).toMatchObject({
            role: "assistant",
            content: [
                {
                    type: "toolCall",
                    id: firstRigId,
                    providerToolCallId: "reused-provider-id",
                },
            ],
        });
        expect(secondRequest.messages.at(-1)).toMatchObject({
            role: "toolResult",
            toolCallId: firstRigId,
            providerToolCallId: "reused-provider-id",
        });
    });
});

function message(
    content: AssistantMessage["content"],
    stopReason: AssistantMessage["stopReason"] = "toolUse",
): AssistantMessage {
    return {
        role: "assistant",
        content,
        api: "mock",
        provider: "mock",
        model: "mock/model",
        usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason,
        timestamp: 0,
    };
}

function streamFor(message: AssistantMessage): InferenceStream {
    return {
        async *[Symbol.asyncIterator](): AsyncIterator<ProviderAssistantMessageEvent> {
            yield { type: "start", partial: message };
            yield {
                type: "done",
                reason: message.stopReason === "stop" ? "stop" : "toolUse",
                message,
            };
        },
        result: async () => message,
    };
}
