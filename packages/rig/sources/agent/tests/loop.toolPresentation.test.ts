import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";

import { runAgentLoop } from "../loop.js";
import { defineTool } from "../types.js";
import { createJustBashToolHarness } from "../../testing/createAgentTestHarness.js";
import { createTestRootContext } from "../../testing/createTestRootContext.js";
import {
    createInferenceStream,
    defineModel,
    defineProvider,
    type AssistantMessage,
} from "@slopus/rig-execution";

const ctx = createTestRootContext();

describe("agent loop tool presentations", () => {
    it("checkpoints each durable message before publishing it", async () => {
        const model = defineModel({
            defaultThinkingLevel: "off",
            id: "mock/model",
            name: "Mock Model",
            thinkingLevels: ["off"],
        });
        const provider = defineProvider({
            id: "mock",
            models: [model],
            stream() {
                const message = assistantMessage([{ type: "text", text: "done" }], "stop");
                return createInferenceStream(async function* () {
                    yield { partial: message, type: "start" };
                    yield { attempt: 1, reason: "Connection lost", type: "retrying" };
                    yield { message, reason: "stop", type: "done" };
                    return message;
                });
            },
        });
        const harness = createJustBashToolHarness();
        let checkpoint: readonly string[] = [];
        const published: { id: string; checkpoint: readonly string[]; role: string }[] = [];

        await runAgentLoop(ctx, {
            context: harness.context,
            messages: [
                {
                    blocks: [{ text: "Try once.", type: "text" }],
                    id: "user-1",
                    role: "user",
                },
            ],
            modelId: model.id,
            onContextChanged(messages) {
                checkpoint = messages.map((message) => message.id);
            },
            onMessage(message) {
                published.push({ checkpoint: [...checkpoint], id: message.id, role: message.role });
            },
            provider,
            tools: [],
        });

        expect(published.map((message) => message.role)).toEqual(["error", "agent"]);
        for (const message of published) {
            expect(message.checkpoint.at(-1)).toBe(message.id);
        }
    });

    it("publishes a command presentation before execution starts", async () => {
        const model = defineModel({
            id: "mock/model",
            name: "Mock Model",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        let requestCount = 0;
        const provider = defineProvider({
            id: "mock",
            models: [model],
            stream() {
                requestCount += 1;
                const message =
                    requestCount === 1
                        ? assistantMessage(
                              [
                                  {
                                      type: "toolCall",
                                      id: "provider-call-command",
                                      name: "presentation_probe",
                                      arguments: { command: "printf ok" },
                                  },
                              ],
                              "toolUse",
                          )
                        : assistantMessage([{ type: "text", text: "done" }], "stop");
                return createInferenceStream(async function* () {
                    yield { partial: message, type: "start" };
                    yield { message, reason: message.stopReason, type: "done" };
                    return message;
                });
            },
        });
        const harness = createJustBashToolHarness();
        let publishedPresentation: unknown;
        let presentationAtExecution: unknown;
        const startSession = harness.context.bash.startSession.bind(harness.context.bash);
        harness.context.bash.startSession = (options) => {
            presentationAtExecution = publishedPresentation;
            return startSession(options);
        };
        const presentationProbe = defineTool({
            name: "presentation_probe",
            label: "Presentation probe",
            description: "Exercises durable command presentation ordering.",
            arguments: Type.Object({ command: Type.String() }),
            returnType: Type.Object({ ok: Type.Boolean() }),
            shouldReviewInAutoMode: () => false,
            execute: async ({ command }, context) => {
                await context.bash.startSession({ command });
                return { ok: true };
            },
            toCallPresentation: ({ command }) => ({ command, type: "exec_command" }),
            toLLM: () => [{ type: "text", text: "Done." }],
            toUI: () => "Done",
            locks: [],
        });

        await runAgentLoop(ctx, {
            provider,
            modelId: model.id,
            tools: [presentationProbe],
            messages: [
                {
                    role: "user",
                    id: "user-1",
                    blocks: [{ type: "text", text: "Run the command." }],
                },
            ],
            context: harness.context,
            onEvent(event) {
                if (event.type === "tool_execution_start") {
                    publishedPresentation = event.toolCall.presentation;
                }
            },
        });

        expect(presentationAtExecution).toEqual({
            command: "printf ok",
            type: "exec_command",
        });
    });

    it.each([
        ["function", {}, "provider-function-call"],
        ["custom", { input: "*** Begin Patch" }, "provider-custom-call"],
    ] as const)(
        "closes an incomplete %s tool call before a later inference",
        async (kind, argumentsValue, providerToolCallId) => {
            const model = defineModel({
                id: "mock/model",
                name: "Mock Model",
                thinkingLevels: ["off"],
                defaultThinkingLevel: "off",
            });
            const contexts: Parameters<ReturnType<typeof defineProvider>["stream"]>[2][] = [];
            const provider = defineProvider({
                id: "mock",
                models: [model],
                stream(_ctx, _model, context) {
                    contexts.push(context);
                    const message =
                        contexts.length === 1
                            ? assistantMessage(
                                  [
                                      {
                                          type: "toolCall",
                                          id: `rig-${kind}-call`,
                                          providerToolCallId,
                                          kind,
                                          name: "partial_tool",
                                          arguments: argumentsValue,
                                          incomplete: true,
                                      },
                                  ],
                                  "length",
                              )
                            : assistantMessage([{ type: "text", text: "continued" }], "stop");
                    return createInferenceStream(async function* () {
                        yield { partial: message, type: "start" };
                        yield { message, reason: message.stopReason, type: "done" };
                        return message;
                    });
                },
            });
            const harness = createJustBashToolHarness();
            const first = await runAgentLoop(ctx, {
                provider,
                modelId: model.id,
                tools: [],
                messages: [
                    {
                        role: "user",
                        id: "user-1",
                        blocks: [{ type: "text", text: "Start a partial call." }],
                    },
                ],
                context: harness.context,
            });

            expect(first.stopReason).toBe("length");
            expect(first.contextMessages.at(-1)).toMatchObject({
                role: "agent",
                blocks: [
                    {
                        type: "tool_result",
                        toolCallId: expect.any(String),
                        providerToolCallId,
                        isError: true,
                        failure: { kind: "interrupted" },
                    },
                ],
            });

            await runAgentLoop(ctx, {
                provider,
                modelId: model.id,
                tools: [],
                messages: [
                    ...first.messages,
                    {
                        role: "user",
                        id: "user-2",
                        blocks: [{ type: "text", text: "Continue." }],
                    },
                ],
                contextMessages: [
                    ...first.contextMessages,
                    {
                        role: "user",
                        id: "user-2",
                        blocks: [{ type: "text", text: "Continue." }],
                    },
                ],
                context: harness.context,
            });

            expect(contexts[1]?.messages).toContainEqual(
                expect.objectContaining({
                    role: "toolResult",
                    providerToolCallId,
                    isError: true,
                }),
            );
        },
    );
});

function assistantMessage(
    content: AssistantMessage["content"],
    stopReason: "length" | "stop" | "toolUse",
): Omit<AssistantMessage, "stopReason"> & {
    stopReason: "length" | "stop" | "toolUse";
} {
    return {
        api: "mock",
        content,
        model: "mock/model",
        provider: "mock",
        role: "assistant",
        stopReason,
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
