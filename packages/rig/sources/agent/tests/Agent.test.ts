import { Type } from "@sinclair/typebox";
import type { HappyTracingEvent } from "happy-plugins";
import { describe, expect, it, vi } from "vitest";

import { createJustBashToolHarness } from "../../testing/createAgentTestHarness.js";
import { validPng32Base64 } from "../../testing/validImageFixtures.js";
import { getImageProcessor } from "../../images/getImageProcessor.js";
import { Agent } from "../Agent.js";
import { AGENTS_MD_SPEC } from "../prompt/agentsMdSpec.js";
import type { AgentLoopEvent } from "../loop.js";
import { defineTool, type CompactionMessage, type Message } from "../types.js";
import {
    defineModel,
    defineProvider,
    type AssistantMessage,
    type Context,
    type InferenceStream,
    type StreamOptions,
    type Usage,
} from "@slopus/rig-execution";
import type { DebugLog } from "../../debug/index.js";
import { createPermissionContext } from "../../permissions/index.js";
import { createTestRootContext } from "../../testing/createTestRootContext.js";

const ctx = createTestRootContext();

describe("Agent", () => {
    it("preserves a custom tool namespace and converts its input before execution", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        let requestCount = 0;
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream() {
                requestCount += 1;
                return streamFor({
                    role: "assistant",
                    content:
                        requestCount === 1
                            ? [
                                  {
                                      type: "toolCall",
                                      id: "custom-call",
                                      kind: "custom",
                                      name: "custom_patch",
                                      namespace: "collaboration",
                                      arguments: { input: "raw patch" },
                                  },
                              ]
                            : [{ type: "text", text: "done" }],
                    api: "test",
                    provider: "codex",
                    model: model.id,
                    usage: zeroUsage(),
                    stopReason: requestCount === 1 ? "toolUse" : "stop",
                    timestamp: requestCount,
                });
            },
        });
        const execute = vi.fn(() => ({ applied: true }));
        const observedEvents: AgentLoopEvent[] = [];
        const traces: { type: string }[] = [];
        const harness = createJustBashToolHarness();
        harness.context.plugins = {
            loadSkills: async () => [],
            trace: (event: HappyTracingEvent) => traces.push(event),
        } as never;
        const tool = defineTool({
            name: "custom_patch",
            label: "Custom patch",
            description: "Applies a custom patch.",
            namespace: {
                name: "collaboration",
                description: "Collaboration tools.",
            },
            executorTool: {
                kind: "custom",
                name: "custom_patch",
                description: "Applies a custom patch.",
            },
            parseExecutorToolArguments: (argumentsValue) => ({
                patch: (argumentsValue as { input: string }).input,
            }),
            arguments: Type.Object({ patch: Type.String() }),
            returnType: Type.Object({ applied: Type.Boolean() }),
            shouldReviewInAutoMode: () => false,
            execute,
            toLLM: () => [{ type: "text", text: "applied" }],
            toUI: () => "Applied.",
            locks: [],
        });
        const agent = new Agent({
            provider,
            modelId: model.id,
            context: harness.context,
            tools: [tool],
            printToConsole: false,
            onEvent: (event) => {
                observedEvents.push(event);
            },
        });

        await agent.send(ctx, "Apply it.");

        expect(execute).toHaveBeenCalledWith(
            { patch: "raw patch" },
            expect.anything(),
            expect.anything(),
        );
        expect(agent.messages[1]).toMatchObject({
            role: "agent",
            blocks: [
                {
                    type: "tool_call",
                    namespace: "collaboration",
                    arguments: { patch: "raw patch" },
                },
            ],
        });
        const streamedMessageIds = new Set(
            observedEvents.flatMap((event) => ("messageId" in event ? [event.messageId] : [])),
        );
        const committedMessageIds = agent.messages.flatMap((message) =>
            message.role === "agent" && message.usage !== undefined ? [message.id] : [],
        );
        expect(streamedMessageIds.size).toBe(2);
        expect(new Set(committedMessageIds)).toEqual(streamedMessageIds);
        expect(traces.map((event) => event.type)).toEqual(
            expect.arrayContaining(["tool_call_started", "tool_call_finished"]),
        );
    });

    it("preserves tool results when optional debug and live observers fail", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        let requestCount = 0;
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream() {
                requestCount += 1;
                return streamFor({
                    role: "assistant",
                    content:
                        requestCount === 1
                            ? [
                                  {
                                      type: "toolCall",
                                      id: "observer-failure-tool",
                                      name: "side-effect",
                                      arguments: {},
                                  },
                              ]
                            : [{ type: "text", text: "completed after observer failures" }],
                    api: "test",
                    provider: "codex",
                    model: model.id,
                    usage: zeroUsage(),
                    stopReason: requestCount === 1 ? "toolUse" : "stop",
                    timestamp: requestCount,
                });
            },
        });
        const execute = vi.fn(() => ({ changed: true }));
        const tool = defineTool({
            name: "side-effect",
            label: "Side effect",
            description: "Changes observable state.",
            arguments: Type.Object({}),
            returnType: Type.Object({ changed: Type.Boolean() }),
            shouldReviewInAutoMode: () => false,
            execute,
            toLLM: (result) => [{ type: "text", text: JSON.stringify(result) }],
            toUI: () => "State changed.",
            locks: [],
        });
        const messages: Message[] = [];
        const agent = new Agent({
            provider,
            modelId: model.id,
            context: createJustBashToolHarness().context,
            tools: [tool],
            printToConsole: false,
            onEvent(event) {
                if (
                    event.type.startsWith("tool_execution_") ||
                    event.type === "background_processes_changed"
                ) {
                    throw new Error("optional observer failed");
                }
            },
            onMessage(message) {
                messages.push(message);
            },
        });
        const debug = {
            directory: "/tmp/rig-failing-debug",
            record: vi.fn(async () => {
                throw new Error("optional debug failed");
            }),
        } as unknown as DebugLog;

        const result = await agent.send(ctx, "Run the side effect.", { debug });

        expect(result.stopReason).toBe("stop");
        expect(execute).toHaveBeenCalledOnce();
        expect(messages).toContainEqual(
            expect.objectContaining({
                role: "agent",
                blocks: [
                    expect.objectContaining({
                        type: "tool_result",
                        toolCallId: expect.any(String),
                        providerToolCallId: "observer-failure-tool",
                        display: "State changed.",
                    }),
                ],
            }),
        );
        expect(result.messages.at(-1)).toMatchObject({
            role: "agent",
            blocks: [{ type: "text", text: "completed after observer failures" }],
        });
    });

    it("propagates a database failure from a tool lifecycle observer", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const databaseError = new Error("database write failed") as Error & { code: string };
        databaseError.code = "SQLITE_IOERR";
        let requestCount = 0;
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream() {
                requestCount += 1;
                return streamFor({
                    role: "assistant",
                    content:
                        requestCount === 1
                            ? [
                                  {
                                      type: "toolCall",
                                      id: "database-observer-tool",
                                      name: "side-effect",
                                      arguments: {},
                                  },
                              ]
                            : [{ type: "text", text: "should not continue" }],
                    api: "test",
                    provider: "codex",
                    model: model.id,
                    usage: zeroUsage(),
                    stopReason: requestCount === 1 ? "toolUse" : "stop",
                    timestamp: requestCount,
                });
            },
        });
        const execute = vi.fn(() => ({ changed: true }));
        const tool = defineTool({
            name: "side-effect",
            label: "Side effect",
            description: "Changes observable state.",
            arguments: Type.Object({}),
            returnType: Type.Object({ changed: Type.Boolean() }),
            shouldReviewInAutoMode: () => false,
            execute,
            toLLM: (result) => [{ type: "text", text: JSON.stringify(result) }],
            toUI: () => "State changed.",
            locks: [],
        });
        const agent = new Agent({
            provider,
            modelId: model.id,
            context: createJustBashToolHarness().context,
            tools: [tool],
            printToConsole: false,
            onEvent(event) {
                if (event.type === "tool_execution_end") throw databaseError;
            },
        });

        await expect(agent.send(ctx, "Run the side effect.")).rejects.toBe(databaseError);

        expect(execute).toHaveBeenCalledOnce();
        expect(requestCount).toBe(1);
    });

    it("propagates a database failure from a provider stream observer", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const databaseError = new Error("database write failed") as Error & { code: string };
        databaseError.code = "SQLITE_BUSY";
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream() {
                return streamFor(stoppedMessage(model.id));
            },
        });
        const traces: HappyTracingEvent[] = [];
        const harness = createJustBashToolHarness();
        harness.context.plugins = {
            loadSkills: async () => [],
            trace: (event: HappyTracingEvent) => traces.push(event),
        } as never;
        const agent = new Agent({
            provider,
            modelId: model.id,
            context: harness.context,
            printToConsole: false,
            onEvent(event) {
                if (event.type === "start") throw databaseError;
            },
        });

        await expect(agent.send(ctx, "Answer once.")).rejects.toBe(databaseError);
        expect(traces.map((event) => event.type)).toEqual([
            "turn_started",
            "inference_request_started",
            "inference_request_finished",
            "turn_finished",
        ]);
    });

    it("propagates a database failure from tool execution", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const databaseError = new Error("database write failed") as Error & { code: string };
        databaseError.code = "SQLITE_FULL";
        let requestCount = 0;
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream() {
                requestCount += 1;
                return streamFor({
                    role: "assistant",
                    content:
                        requestCount === 1
                            ? [
                                  {
                                      type: "toolCall",
                                      id: "database-failure-tool",
                                      name: "persist",
                                      arguments: {},
                                  },
                              ]
                            : [{ type: "text", text: "should not continue" }],
                    api: "test",
                    provider: "codex",
                    model: model.id,
                    usage: zeroUsage(),
                    stopReason: requestCount === 1 ? "toolUse" : "stop",
                    timestamp: requestCount,
                });
            },
        });
        const tool = defineTool({
            name: "persist",
            label: "Persist",
            description: "Persists state.",
            arguments: Type.Object({}),
            returnType: Type.Object({}),
            shouldReviewInAutoMode: () => false,
            execute() {
                throw databaseError;
            },
            toLLM: () => [],
            toUI: () => "unused",
            locks: [],
        });
        const agent = new Agent({
            provider,
            modelId: model.id,
            context: createJustBashToolHarness().context,
            tools: [tool],
            printToConsole: false,
        });

        await expect(agent.send(ctx, "Persist state.")).rejects.toBe(databaseError);

        expect(requestCount).toBe(1);
    });

    it("propagates a database failure from a compaction lifecycle observer", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const databaseError = new Error("database write failed") as Error & { code: string };
        databaseError.code = "SQLITE_FULL";
        const provider = defineProvider({
            id: "codex",
            models: [model],
            compact: async (_ctx, { context }) => completedCompaction(context, "summary"),
            stream() {
                return streamFor(stoppedMessage(model.id));
            },
        });
        const consoleError = vi.fn();
        const agent = new Agent({
            provider,
            modelId: model.id,
            context: createJustBashToolHarness().context,
            console: { error: consoleError, log: vi.fn() },
            messages: [
                { role: "user", id: "user-1", blocks: [{ type: "text", text: "work" }] },
                { role: "agent", id: "agent-1", blocks: [{ type: "text", text: "done" }] },
            ],
            printToConsole: false,
            onEvent(event) {
                if (event.type === "context_compaction_started") throw databaseError;
            },
        });

        await expect(agent.compact(ctx)).rejects.toBe(databaseError);

        expect(consoleError).not.toHaveBeenCalled();
    });

    it("stops background shells before reducing permissions in-process", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream() {
                throw new Error("Inference is not expected.");
            },
        });
        const harness = createJustBashToolHarness();
        harness.context.permissions = createPermissionContext("full_access");
        const killAllSessions = vi.fn(async () => {
            expect(harness.context.permissions?.mode).toBe("full_access");
            return 1;
        });
        harness.context.bash.killAllSessions = killAllSessions;
        const agent = new Agent({
            provider,
            modelId: model.id,
            context: harness.context,
            printToConsole: false,
        });

        await agent.setPermissionMode("workspace_write");

        expect(killAllSessions).toHaveBeenCalledOnce();
        expect(harness.context.permissions?.mode).toBe("workspace_write");
    });

    it("uses the provider image profile independently of its identifier", async () => {
        const model = defineModel({
            id: "anthropic/claude-test",
            name: "Claude Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const contexts: Context[] = [];
        const provider = defineProvider({
            id: "custom-bedrock",
            type: "claude",
            models: [model],
            stream(_ctx, _model, context) {
                contexts.push(context);
                return streamFor({
                    role: "assistant",
                    content: [{ type: "text", text: "done" }],
                    api: "test",
                    provider: "custom-bedrock",
                    model: model.id,
                    usage: zeroUsage(),
                    stopReason: "stop",
                    timestamp: 1,
                });
            },
        });
        const sharp = await getImageProcessor();
        const image = await sharp({
            create: {
                width: 2400,
                height: 1200,
                channels: 3,
                background: { r: 30, g: 60, b: 90 },
            },
        })
            .png()
            .toBuffer();
        const harness = createJustBashToolHarness();
        const agent = new Agent({
            provider,
            modelId: model.id,
            context: harness.context,
            printToConsole: false,
        });

        await agent.send(ctx, [
            {
                type: "image",
                data: image.toString("base64"),
                mediaType: "image/png",
            },
        ]);

        const userMessage = contexts[0]?.messages[0];
        if (userMessage?.role !== "user" || typeof userMessage.content === "string") {
            throw new Error("The provider did not receive the image message.");
        }
        const preparedImage = userMessage.content[0];
        if (preparedImage?.type !== "image") {
            throw new Error("The provider image was omitted.");
        }
        const metadata = await sharp(Buffer.from(preparedImage.data, "base64")).metadata();
        expect(metadata).toMatchObject({ width: 2000, height: 1000 });
    });

    it("uses an updated appended system prompt on later runs", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const contexts: Context[] = [];
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream(_ctx, _model, context) {
                contexts.push(context);
                return streamFor({
                    role: "assistant",
                    content: [{ type: "text", text: "done" }],
                    api: "test",
                    provider: "codex",
                    model: model.id,
                    usage: zeroUsage(),
                    stopReason: "stop",
                    timestamp: 1,
                });
            },
        });
        const agent = new Agent({
            appendSystemPrompt: "Initial API instructions.",
            provider,
            modelId: model.id,
            context: createJustBashToolHarness().context,
            instructions: "Base instructions.",
            printToConsole: false,
        });

        agent.enqueueUserMessage("First run.");
        await agent.run(ctx);
        agent.setAppendSystemPrompt("Updated API instructions.");
        agent.enqueueUserMessage("Second run.");
        await agent.run(ctx);

        expect(contexts[0]?.systemPrompt).toBe(
            `Base instructions.\n\n${AGENTS_MD_SPEC}\n\nYou are in Full access mode. Filesystem, shell, and network access are unrestricted.\n\nInitial API instructions.`,
        );
        expect(contexts[1]?.systemPrompt).toBe(
            `Base instructions.\n\n${AGENTS_MD_SPEC}\n\nYou are in Full access mode. Filesystem, shell, and network access are unrestricted.\n\nUpdated API instructions.`,
        );
    });

    it("applies dynamic plugin prompt replacement and emits turn and inference traces", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const contexts: Context[] = [];
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream(_ctx, _model, context) {
                contexts.push(context);
                return streamFor(stoppedMessage(model.id));
            },
        });
        const harness = createJustBashToolHarness();
        const applySystemPrompt = vi.fn(async (_ctx, { systemPrompt, userPrompt }) => {
            return `${systemPrompt}\n\nPlugin saw: ${userPrompt}`;
        });
        const traces: { type: string }[] = [];
        harness.context.plugins = {
            applySystemPrompt,
            loadSkills: async () => [],
            trace: (event: HappyTracingEvent) => traces.push(event),
        } as never;
        const agent = new Agent({
            context: harness.context,
            instructions: "Base instructions.",
            modelId: model.id,
            printToConsole: false,
            provider,
            traceSessionId: "session-1",
        });

        await agent.send(ctx, "Replace this turn.");

        expect(applySystemPrompt).toHaveBeenCalledWith(ctx, {
            systemPrompt: expect.stringContaining("Base instructions."),
            userPrompt: "Replace this turn.",
        });
        expect(contexts[0]?.systemPrompt).toContain("Plugin saw: Replace this turn.");
        expect(traces.map((event) => event.type)).toEqual([
            "turn_started",
            "inference_request_started",
            "inference_request_finished",
            "turn_finished",
        ]);
    });

    it("queues steering and user messages, runs the loop, and prints messages", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off", "high"],
            defaultThinkingLevel: "off",
        });
        const contexts: Context[] = [];
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream(_ctx, _model, context) {
                contexts.push(context);
                return streamFor({
                    role: "assistant",
                    content: [{ type: "text", text: "agent-done" }],
                    api: "test",
                    provider: "codex",
                    model: "openai/gpt-test",
                    usage: zeroUsage(),
                    stopReason: "stop",
                    timestamp: 1,
                });
            },
        });
        const logs: unknown[][] = [];
        const observedEvents: AgentLoopEvent[] = [];
        const observedMessages: string[] = [];
        const harness = createJustBashToolHarness();
        const agent = new Agent({
            provider,
            modelId: "openai/gpt-test",
            context: harness.context,
            instructions: "Base instructions.",
            idFactory: createDeterministicIds(),
            now: () => 1,
            console: {
                log(...data) {
                    logs.push(data);
                },
            },
            onEvent(event) {
                observedEvents.push(event);
            },
            onMessage(message) {
                observedMessages.push(message.id);
            },
        });

        const steering = agent.addSteering("Keep answers short.");
        const user = agent.enqueueUserMessage("Say done.");
        const queuedIds = agent.queue.map((entry) => entry.id);

        expect(agent.id).toBe("id-1");
        expect(steering.id).toBe("id-2");
        expect(user.id).toBe("id-4");
        expect(queuedIds).toEqual(["id-3", "id-5"]);

        const debug = {
            directory: "/tmp/rig-agent-debug",
            record: async () => undefined,
        } as unknown as DebugLog;
        const result = await agent.run(ctx, { debug });

        expect(result.runId).toBe("id-6");
        expect(result.debugDirectory).toBe("/tmp/rig-agent-debug");
        expect(result.stopReason).toBe("stop");
        expect(agent.status).toBe("idle");
        expect(agent.queue).toEqual([]);
        expect(agent.messages.map((message) => message.id)).toEqual(["id-2", "id-4", "id-7"]);
        // Steering is a positional notice, so it reaches the model in the conversation rather
        // than being folded into the prompt ahead of the turn it belongs to.
        expect(contexts[0]?.systemPrompt).toBe(
            `Base instructions.\n\n${AGENTS_MD_SPEC}\n\nYou are in Full access mode. Filesystem, shell, and network access are unrestricted.`,
        );
        expect(contexts[0]?.messages[0]).toMatchObject({
            role: "system",
            content: "Keep answers short.",
        });
        expect(logs.map((entry) => entry[0])).toEqual([
            "[system:id-2] Keep answers short.",
            "[user:id-4] Say done.",
            "[agent:id-7] agent-done",
        ]);
        expect(observedEvents.map((event) => event.type)).toEqual([
            "inference_iteration_start",
            "start",
            "done",
        ]);
        expect(
            observedEvents.map((event) => ("messageId" in event ? event.messageId : undefined)),
        ).toEqual(["id-7", "id-7", "id-7"]);
        expect(observedMessages).toEqual(["id-7"]);
    });

    it("uses injected default tools and accepts explicit tool configuration", () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream() {
                return streamFor({
                    role: "assistant",
                    content: [],
                    api: "test",
                    provider: "codex",
                    model: "openai/gpt-test",
                    usage: zeroUsage(),
                    stopReason: "stop",
                    timestamp: 1,
                });
            },
        });
        const harness = createJustBashToolHarness();

        const defaultAgent = new Agent({
            provider,
            modelId: "openai/gpt-test",
            context: harness.context,
            toolSelector: () => [],
            printToConsole: false,
        });
        expect(defaultAgent.tools.map((tool) => tool.name)).toEqual([]);

        const noopTool = defineTool({
            name: "noop",
            label: "Noop",
            description: "Does nothing.",
            arguments: Type.Object({}),
            returnType: Type.Object({ ok: Type.Boolean() }),
            shouldReviewInAutoMode: () => false,
            execute: () => ({ ok: true }),
            toLLM: () => [{ type: "text", text: "ok" }],
            toUI: () => "ok",
            locks: [],
        });
        const overrideAgent = new Agent({
            provider,
            modelId: "openai/gpt-test",
            context: harness.context,
            tools: [noopTool],
            toolSelector: () => [],
            printToConsole: false,
        });

        expect(overrideAgent.tools.map((tool) => tool.name)).toEqual(["noop"]);
    });

    it("switches model and reasoning effort", () => {
        const smallModel = defineModel({
            id: "openai/gpt-small",
            name: "GPT Small",
            thinkingLevels: ["low", "medium"],
            defaultThinkingLevel: "low",
        });
        const proModel = defineModel({
            id: "openai/gpt-pro",
            name: "GPT Pro",
            thinkingLevels: ["low", "high"],
            defaultThinkingLevel: "low",
        });
        const provider = defineProvider({
            id: "codex",
            models: [smallModel, proModel],
            stream() {
                return streamFor({
                    role: "assistant",
                    content: [],
                    api: "test",
                    provider: "codex",
                    model: "openai/gpt-pro",
                    usage: zeroUsage(),
                    stopReason: "stop",
                    timestamp: 1,
                });
            },
        });
        const harness = createJustBashToolHarness();
        const agent = new Agent({
            provider,
            modelId: smallModel.id,
            context: harness.context,
            printToConsole: false,
        });

        agent.setModel(proModel.id, "high");

        expect(agent.model.id).toBe(proModel.id);
        expect(agent.snapshot().modelId).toBe(proModel.id);
        expect(agent.snapshot().effort).toBe("high");
    });

    it("sends the selected service tier and preserves it across model changes", async () => {
        const firstModel = defineModel({
            id: "openai/gpt-first",
            name: "GPT First",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const secondModel = defineModel({
            id: "openai/gpt-second",
            name: "GPT Second",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const streamOptions: (StreamOptions | undefined)[] = [];
        let currentTime = new Date(2024, 0, 2, 12).getTime();
        const provider = defineProvider({
            id: "codex",
            models: [firstModel, secondModel],
            serviceTiers: ["fast"],
            stream(_ctx, model, _context, options) {
                streamOptions.push(options);
                return streamFor({
                    role: "assistant",
                    content: [{ type: "text", text: "done" }],
                    api: "test",
                    provider: "codex",
                    model: model.id,
                    usage: zeroUsage(),
                    stopReason: "stop",
                    timestamp: 1,
                });
            },
        });
        const agent = new Agent({
            provider,
            modelId: firstModel.id,
            context: createJustBashToolHarness().context,
            now: () => currentTime,
            serviceTier: "fast",
            printToConsole: false,
        });

        agent.setModel(secondModel.id, undefined);
        await agent.send(ctx, "Use fast inference.");
        currentTime = new Date(2024, 1, 3, 12).getTime();
        await agent.send(ctx, "Keep using fast inference.");

        expect(agent.snapshot().serviceTier).toBe("fast");
        expect(streamOptions).toMatchObject([
            { serviceTier: "fast", startDate: "2024-01-02" },
            { serviceTier: "fast", startDate: "2024-01-02" },
        ]);

        agent.setServiceTier(undefined);
        expect(agent.snapshot().serviceTier).toBeUndefined();
    });

    it("automatically compacts model context while preserving the visible transcript", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
            contextWindow: 40_000,
        });
        const contexts: Context[] = [];
        const emittedCompactions: CompactionMessage[] = [];
        const provider = defineProvider({
            id: "codex",
            models: [model],
            compact: async (_ctx, { context }) =>
                completedCompaction(context, "Earlier work was summarized."),
            stream(_ctx, _model, context) {
                contexts.push(context);
                return streamFor({
                    role: "assistant",
                    content: [{ type: "text", text: "continued" }],
                    api: "test",
                    provider: "codex",
                    model: model.id,
                    usage: zeroUsage(),
                    stopReason: "stop",
                    timestamp: 1,
                });
            },
        });
        const messages: Message[] = [
            {
                role: "user",
                id: "user-old",
                blocks: [{ type: "text", text: "A".repeat(20_000) }],
            },
            {
                role: "agent",
                id: "agent-old",
                blocks: [{ type: "text", text: "B".repeat(20_000) }],
            },
        ];
        const harness = createJustBashToolHarness();
        const agent = new Agent({
            provider,
            modelId: model.id,
            context: harness.context,
            messages,
            idFactory: createDeterministicIds(),
            printToConsole: false,
            onMessage: (message) => {
                if (message.role === "compaction") emittedCompactions.push(message);
            },
        });

        await agent.send(ctx, "Continue from there.");

        expect(contexts).toHaveLength(1);
        expect(contexts[0]?.messages).toMatchObject([
            {
                role: "user",
                content: "Earlier work was summarized.",
            },
        ]);
        expect(agent.snapshot().messages).toMatchObject([
            { id: "user-old" },
            { id: "agent-old" },
            { role: "user" },
            {
                role: "compaction",
                statistics: { after: { exact: true, tokens: 0 } },
            },
            { role: "agent", blocks: [{ type: "text", text: "continued" }] },
        ]);
        expect(agent.snapshot().contextMessages).toHaveLength(2);
        expect(agent.snapshot().contextMessages?.[0]).toMatchObject({
            role: "compaction",
            statistics: { after: { exact: true, tokens: 0 } },
        });
        expect(emittedCompactions).toHaveLength(2);
        expect(emittedCompactions[0]?.usage).toBeDefined();
        expect(emittedCompactions[1]?.usage).toBeUndefined();
    });

    it("ends the run when automatic compaction fails instead of retrying unchanged context", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
            contextWindow: 40_000,
        });
        let compactions = 0;
        let inferences = 0;
        const provider = defineProvider({
            id: "codex",
            models: [model],
            compact: async (_ctx, options) => {
                compactions += 1;
                return {
                    status: "failed",
                    kind: "inference_error",
                    message: "native compaction failed",
                    context: options.context,
                };
            },
            stream() {
                inferences += 1;
                return streamFor({
                    role: "assistant",
                    content: [{ type: "text", text: "should not run" }],
                    api: "test",
                    provider: "codex",
                    model: model.id,
                    usage: zeroUsage(),
                    stopReason: "stop",
                    timestamp: 1,
                });
            },
        });
        const agent = new Agent({
            provider,
            modelId: model.id,
            context: createJustBashToolHarness().context,
            messages: [
                {
                    role: "user",
                    id: "user-old",
                    blocks: [{ type: "text", text: "A".repeat(20_000) }],
                },
                {
                    role: "agent",
                    id: "agent-old",
                    blocks: [{ type: "text", text: "B".repeat(20_000) }],
                },
            ],
            printToConsole: false,
        });

        await expect(agent.send(ctx, "Continue.")).rejects.toThrow("native compaction failed");
        expect(compactions).toBe(1);
        expect(inferences).toBe(0);
    });

    it.each([
        ["reported provider usage", "tool result", 10_000],
        ["the local tool-result estimate", "X".repeat(40_000), 0],
    ])(
        "automatically compacts between tool iterations based on %s",
        async (_trigger, toolResult, reportedTokens) => {
            const model = defineModel({
                id: "openai/gpt-test",
                name: "GPT Test",
                thinkingLevels: ["off"],
                defaultThinkingLevel: "off",
                contextWindow: 40_000,
            });
            const contexts: Context[] = [];
            const echoTool = defineTool({
                name: "echo",
                label: "Echo",
                description: "Returns the supplied value.",
                arguments: Type.Object({ value: Type.String() }),
                returnType: Type.Object({ value: Type.String() }),
                shouldReviewInAutoMode: () => false,
                execute: (args: { value: string }) => args,
                toLLM: (result: { value: string }) => [{ type: "text", text: result.value }],
                toUI: (result: { value: string }) => result.value,
                locks: [],
            });
            const provider = defineProvider({
                id: "codex",
                models: [model],
                compact: async (_ctx, { context }) =>
                    completedCompaction(context, "Earlier work was summarized."),
                stream(_ctx, _model, context) {
                    contexts.push(context);
                    if (contexts.length === 1) {
                        return streamFor({
                            role: "assistant",
                            content: [
                                {
                                    type: "toolCall",
                                    id: "call-echo",
                                    name: "echo",
                                    arguments: { value: toolResult },
                                },
                            ],
                            api: "test",
                            provider: "codex",
                            model: model.id,
                            contextTokens: reportedTokens,
                            usage: usageWithTotalTokens(reportedTokens),
                            stopReason: "toolUse",
                            timestamp: 1,
                        });
                    }
                    return streamFor({
                        role: "assistant",
                        content: [
                            {
                                type: "text",
                                text: "continued",
                            },
                        ],
                        api: "test",
                        provider: "codex",
                        model: model.id,
                        usage: zeroUsage(),
                        stopReason: "stop",
                        timestamp: 2,
                    });
                },
            });
            const messages: Message[] = [
                {
                    role: "user",
                    id: "user-old",
                    blocks: [{ type: "text", text: "Earlier request." }],
                },
                {
                    role: "agent",
                    id: "agent-old",
                    blocks: [{ type: "text", text: "Earlier response." }],
                },
            ];
            const harness = createJustBashToolHarness();
            const agent = new Agent({
                provider,
                modelId: model.id,
                context: harness.context,
                messages,
                tools: [echoTool],
                idFactory: createDeterministicIds(),
                printToConsole: false,
            });

            const result = await agent.send(ctx, "Continue with the tool.");

            expect(result.stopReason).toBe("stop");
            expect(contexts).toHaveLength(2);
            expect(contexts[1]?.messages).toMatchObject([
                {
                    role: "user",
                    content: "Earlier work was summarized.",
                },
            ]);
            expect(agent.snapshot().messages.slice(0, 2)).toEqual(messages);
            expect(agent.snapshot().contextMessages).toHaveLength(2);
        },
    );

    it("compacts and retries when the provider rejects an overlong context", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
            contextWindow: 40_000,
        });
        const contexts: Context[] = [];
        const observedEventTypes: string[] = [];
        const provider = defineProvider({
            id: "codex",
            models: [model],
            compact: async (_ctx, { context }) =>
                completedCompaction(context, "Earlier work was summarized."),
            stream(_ctx, _model, context) {
                contexts.push(context);
                if (contexts.length === 1) {
                    return streamFor({
                        role: "assistant",
                        content: [],
                        api: "test",
                        provider: "codex",
                        model: model.id,
                        usage: zeroUsage(),
                        stopReason: "error",
                        errorMessage:
                            "Codex error: Your input exceeds the context window of this model. Please adjust your input and try again.",
                        timestamp: 1,
                    });
                }
                return streamFor({
                    role: "assistant",
                    content: [
                        {
                            type: "text",
                            text: "recovered",
                        },
                    ],
                    api: "test",
                    provider: "codex",
                    model: model.id,
                    usage: zeroUsage(),
                    stopReason: "stop",
                    timestamp: 2,
                });
            },
        });
        const messages: Message[] = [
            {
                role: "user",
                id: "user-old",
                blocks: [{ type: "text", text: "A".repeat(40) }],
            },
            {
                role: "agent",
                id: "agent-old",
                blocks: [{ type: "text", text: "B".repeat(40) }],
            },
        ];
        const harness = createJustBashToolHarness();
        const agent = new Agent({
            provider,
            modelId: model.id,
            context: harness.context,
            messages,
            idFactory: createDeterministicIds(),
            printToConsole: false,
            onEvent: (event) => {
                observedEventTypes.push(event.type);
            },
        });

        const result = await agent.send(ctx, "Continue after compacting.");

        expect(result.stopReason).toBe("stop");
        expect(contexts).toHaveLength(2);
        expect(contexts[1]?.messages[0]).toMatchObject({
            role: "user",
            content: "Earlier work was summarized.",
        });
        expect(contexts[1]?.messages.at(-1)).toMatchObject({
            role: "user",
            content: [
                {
                    type: "text",
                    text: "Rig inference attempt 1 failed and was retried.",
                },
                {
                    type: "text",
                    text: expect.stringContaining("exceeds the context window"),
                },
            ],
        });
        expect(observedEventTypes).not.toContain("error");
        expect(result.messages).not.toContainEqual(
            expect.objectContaining({ role: "agent", blocks: [] }),
        );
        expect(result.messages).toContainEqual(
            expect.objectContaining({
                outcome: "retried",
                role: "error",
            }),
        );
        expect(result.messages.at(-1)).toMatchObject({
            role: "agent",
            blocks: [{ type: "text", text: "recovered" }],
        });
    });

    it("records a terminal provider error without starting another inference", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        let requestCount = 0;
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream() {
                requestCount += 1;
                return streamFor({
                    role: "assistant",
                    content: requestCount === 1 ? [] : [{ type: "text", text: "recovered" }],
                    api: "test",
                    provider: "codex",
                    model: model.id,
                    usage: zeroUsage(),
                    stopReason: requestCount === 1 ? "error" : "stop",
                    ...(requestCount === 1 ? { errorMessage: "fetch failed" } : {}),
                    timestamp: requestCount,
                });
            },
        });
        const observedEvents: AgentLoopEvent[] = [];
        const harness = createJustBashToolHarness();
        const agent = new Agent({
            provider,
            modelId: model.id,
            context: harness.context,
            printToConsole: false,
            onEvent: (event) => {
                observedEvents.push(event);
            },
        });

        agent.enqueueUserMessage("Continue without manual intervention.");
        const result = await agent.run(ctx);

        expect(result.stopReason).toBe("error");
        expect(requestCount).toBe(1);
        expect(observedEvents).toMatchObject([
            { type: "inference_iteration_start" },
            { type: "start" },
            { type: "error" },
        ]);
        expect(agent.messages).not.toContainEqual(
            expect.objectContaining({ blocks: [{ type: "text", text: "recovered" }] }),
        );
        expect(agent.messages).not.toContainEqual(
            expect.objectContaining({ blocks: [], role: "agent" }),
        );
        expect(agent.messages.at(-1)).toMatchObject({
            blocks: [{ text: "fetch failed", type: "text" }],
            outcome: "failed",
            role: "error",
        });
    });

    it("does not replay an incomplete response after visible content", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        let requestCount = 0;
        const contexts: Context[] = [];
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream(_ctx, _model, context) {
                requestCount += 1;
                contexts.push(context);
                const message: AssistantMessage = {
                    role: "assistant",
                    content: [
                        {
                            type: "text",
                            text: requestCount === 1 ? "partial answer" : " continued answer",
                        },
                    ],
                    api: "test",
                    provider: "codex",
                    model: model.id,
                    usage: zeroUsage(),
                    stopReason: requestCount === 1 ? "error" : "stop",
                    ...(requestCount === 1
                        ? {
                              errorCode: "incomplete_response" as const,
                              errorMessage: "The response ended early.",
                          }
                        : {}),
                    timestamp: requestCount,
                };
                return {
                    async *[Symbol.asyncIterator]() {
                        yield { type: "start" as const, partial: message };
                        yield {
                            type: "text_delta" as const,
                            contentIndex: 0,
                            delta: "partial answer",
                            partial: message,
                        };
                        if (message.stopReason === "error") {
                            yield {
                                type: "error" as const,
                                reason: "error" as const,
                                error: message,
                            };
                        } else {
                            yield { type: "done" as const, reason: "stop" as const, message };
                        }
                    },
                    async result() {
                        return message;
                    },
                };
            },
        });
        const observedEventTypes: string[] = [];
        const harness = createJustBashToolHarness();
        const agent = new Agent({
            provider,
            modelId: model.id,
            context: harness.context,
            printToConsole: false,
            onEvent: (event) => {
                observedEventTypes.push(event.type);
            },
        });

        const result = await agent.send(ctx, "Answer once.");

        expect(result.stopReason).toBe("error");
        expect(requestCount).toBe(1);
        expect(observedEventTypes).not.toContain("retrying");
        expect(result.messages.findLast((message) => message.role === "agent")).toMatchObject({
            role: "agent",
            blocks: [{ type: "text", text: "partial answer" }],
        });
        expect(result.messages.at(-1)).toMatchObject({
            blocks: [{ text: "The response ended early.", type: "text" }],
            outcome: "failed",
            role: "error",
        });
    });

    it("manually compacts into one durable transcript and provider-context message", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off", "low", "high"],
            defaultThinkingLevel: "low",
        });
        const compactionEvents: AgentLoopEvent[] = [];
        const provider = defineProvider({
            id: "codex",
            models: [model],
            serviceTiers: ["fast"],
            compact: async (_ctx, { context }) => completedCompaction(context, "Brief."),
            stream() {
                return streamFor({
                    role: "assistant",
                    content: [{ type: "text", text: "done" }],
                    api: "test",
                    provider: "codex",
                    model: model.id,
                    usage: zeroUsage(),
                    stopReason: "stop",
                    timestamp: 1,
                });
            },
        });
        const harness = createJustBashToolHarness();
        const agent = new Agent({
            provider,
            modelId: model.id,
            context: harness.context,
            effort: "high",
            serviceTier: "fast",
            printToConsole: false,
            onEvent: (event) => {
                if (event.type.startsWith("context_compact")) compactionEvents.push(event);
            },
        });
        await agent.send(ctx, "Do the work.");
        compactionEvents.length = 0;
        const visibleMessages = agent.snapshot().messages;

        const result = await agent.compact(ctx);

        expect(result).toMatchObject({
            compacted: true,
            compactedMessageCount: 2,
            retainedMessageCount: 0,
        });
        expect(agent.snapshot().messages).toEqual([
            ...visibleMessages,
            expect.objectContaining({
                role: "compaction",
                blocks: [],
                replacedMessageIds: visibleMessages.map((message) => message.id),
                statistics: {
                    after: { exact: false, tokens: expect.any(Number) },
                    before: { exact: true, tokens: 0 },
                },
            }),
        ]);
        expect(agent.snapshot().contextMessages).toMatchObject([
            {
                role: "compaction",
                blocks: [],
                replacementMessages: [
                    { role: "user", content: "Brief.", timestamp: expect.any(Number) },
                ],
            },
        ]);
        expect(agent.snapshot().contextMessages?.[0]).not.toBe(agent.snapshot().messages.at(-1));
        expect(compactionEvents.map((event) => event.type)).toEqual([
            "context_compaction_started",
            "context_compacted",
            "context_compaction_finished",
        ]);
        expect(compactionEvents[0]).toMatchObject({
            estimatedTokensBefore: expect.any(Number),
            reason: "manual",
            type: "context_compaction_started",
        });
        expect(compactionEvents[1]).toMatchObject({
            elapsedMs: expect.any(Number),
            reason: "manual",
            type: "context_compacted",
        });
        expect(compactionEvents[2]).toMatchObject({
            elapsedMs: expect.any(Number),
            status: "completed",
            type: "context_compaction_finished",
        });
        expect(compactionEvents[0]).toHaveProperty(
            "compactionId",
            (compactionEvents[2] as { compactionId?: string }).compactionId,
        );
    });

    it("discards steering received during manual compaction", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const normalContexts: Context[] = [];
        let agent: Agent;
        let steeredDuringCompaction = false;
        const provider = defineProvider({
            id: "codex",
            models: [model],
            compact: async (_ctx, { context }) => {
                if (!steeredDuringCompaction) {
                    steeredDuringCompaction = true;
                    void agent.steer("stale compaction steering");
                }
                return completedCompaction(context, "Brief.");
            },
            stream(_ctx, _model, context) {
                normalContexts.push(context);
                return streamFor({
                    role: "assistant",
                    content: [{ type: "text", text: "done" }],
                    api: "test",
                    provider: "codex",
                    model: model.id,
                    usage: zeroUsage(),
                    stopReason: "stop",
                    timestamp: 1,
                });
            },
        });
        const harness = createJustBashToolHarness();
        agent = new Agent({
            provider,
            modelId: model.id,
            context: harness.context,
            printToConsole: false,
        });
        await agent.send(ctx, "Initial turn.");
        await agent.compact(ctx);

        await agent.send(ctx, "Fresh turn.");

        expect(normalContexts).toHaveLength(2);
        expect(JSON.stringify(normalContexts.at(-1))).not.toContain("stale compaction steering");
    });

    it("finishes the compaction lifecycle when summary inference fails", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const provider = defineProvider({
            id: "codex",
            models: [model],
            compact: async (_ctx, { context }) => ({
                status: "failed",
                kind: "inference_error",
                message: "summary failed",
                context,
            }),
            stream() {
                return streamFor({
                    role: "assistant",
                    content: [{ type: "text", text: "done" }],
                    api: "test",
                    provider: "codex",
                    model: model.id,
                    usage: zeroUsage(),
                    stopReason: "stop",
                    timestamp: 1,
                });
            },
        });
        const compactionEvents: AgentLoopEvent[] = [];
        const harness = createJustBashToolHarness();
        const agent = new Agent({
            provider,
            modelId: model.id,
            context: harness.context,
            printToConsole: false,
            onEvent: (event) => {
                if (event.type.startsWith("context_compact")) compactionEvents.push(event);
            },
        });
        await agent.send(ctx, "Do the work.");
        compactionEvents.length = 0;

        await expect(agent.compact(ctx)).rejects.toThrow("summary failed");

        expect(compactionEvents.map((event) => event.type)).toEqual([
            "context_compaction_started",
            "context_compaction_finished",
        ]);
        expect(compactionEvents[1]).toMatchObject({
            errorMessage: "summary failed",
            status: "failed",
            type: "context_compaction_finished",
        });
        expect(compactionEvents[0]).toHaveProperty(
            "compactionId",
            (compactionEvents[1] as { compactionId?: string }).compactionId,
        );
    });

    it("resets transcript and queued messages", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream() {
                return streamFor({
                    role: "assistant",
                    content: [{ type: "text", text: "done" }],
                    api: "test",
                    provider: "codex",
                    model: "openai/gpt-test",
                    usage: zeroUsage(),
                    stopReason: "stop",
                    timestamp: 1,
                });
            },
        });
        const harness = createJustBashToolHarness();
        const agent = new Agent({
            provider,
            modelId: model.id,
            context: harness.context,
            printToConsole: false,
        });

        await agent.send(ctx, "hello");
        agent.enqueueUserMessage("queued");
        expect(agent.snapshot().messages.length).toBeGreaterThan(0);
        expect(agent.snapshot().queue.length).toBe(1);

        await agent.reset();

        expect(agent.status).toBe("idle");
        expect(agent.snapshot().messages).toEqual([]);
        expect(agent.snapshot().queue).toEqual([]);
        expect(agent.snapshot().lastRunId).toBeUndefined();
    });

    it("resets the provider session with the local conversation", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const resetProvider = vi.fn();
        const provider = defineProvider({
            id: "codex",
            models: [model],
            reset: resetProvider,
            stream: () => streamFor(stoppedMessage(model.id)),
        });
        const agent = new Agent({
            provider,
            modelId: model.id,
            context: createJustBashToolHarness().context,
            printToConsole: false,
        });

        await agent.send(ctx, "hello");
        await agent.reset();

        expect(resetProvider).toHaveBeenCalledOnce();
        expect(agent.messages).toEqual([]);
    });

    it("closes the agent-scoped provider", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const closeProvider = vi.fn();
        const provider = defineProvider({
            close: closeProvider,
            id: "codex",
            models: [model],
            stream: () => streamFor(stoppedMessage(model.id)),
        });
        const agent = new Agent({
            provider,
            modelId: model.id,
            context: createJustBashToolHarness().context,
            printToConsole: false,
        });

        await agent.close();

        expect(closeProvider).toHaveBeenCalledOnce();
    });

    it("recovers when the provider rejects a locally valid image tool result", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const contexts: Context[] = [];
        let requestCount = 0;
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream(_ctx, _model, context) {
                contexts.push(context);
                requestCount += 1;
                if (requestCount === 1) {
                    return streamFor({
                        role: "assistant",
                        content: [
                            {
                                type: "toolCall",
                                id: "call-image",
                                name: "image_probe",
                                arguments: {},
                            },
                        ],
                        api: "test",
                        provider: "codex",
                        model: model.id,
                        usage: zeroUsage(),
                        stopReason: "toolUse",
                        timestamp: 1,
                    });
                }
                if (requestCount === 2) {
                    return streamFor({
                        role: "assistant",
                        content: [],
                        api: "test",
                        provider: "codex",
                        model: model.id,
                        usage: zeroUsage(),
                        stopReason: "error",
                        errorCode: "invalid_image_request",
                        errorMessage: `Codex error:
{"type":"error","error":{"type":"invalid_request_error","code":"invalid_value","message":"The image data you provided does not represent a valid image.","param":"input"},"status":400}`,
                        timestamp: 2,
                    });
                }
                return streamFor({
                    role: "assistant",
                    content: [{ type: "text", text: "recovered" }],
                    api: "test",
                    provider: "codex",
                    model: model.id,
                    usage: zeroUsage(),
                    stopReason: "stop",
                    timestamp: 3,
                });
            },
        });
        const observedEventTypes: string[] = [];
        const observedToolResults: Message[] = [];
        const harness = createJustBashToolHarness();
        const imageProbe = defineTool({
            name: "image_probe",
            label: "Image probe",
            description: "Returns an image to exercise provider validation recovery.",
            arguments: Type.Object({}),
            returnType: Type.Object({ data: Type.String() }),
            shouldReviewInAutoMode: () => false,
            execute: () => ({ data: validPng32Base64 }),
            toLLM: ({ data }) => [{ type: "image", mediaType: "image/png", data }],
            toUI: () => "Returned image",
            locks: [],
        });
        const agent = new Agent({
            provider,
            modelId: model.id,
            context: harness.context,
            tools: [imageProbe],
            printToConsole: false,
            onEvent: (event) => {
                observedEventTypes.push(event.type);
            },
            onMessage: (message) => {
                if (
                    message.role === "agent" &&
                    message.blocks.some((block) => block.type === "tool_result")
                ) {
                    observedToolResults.push(message);
                }
            },
        });

        const result = await agent.send(ctx, "Inspect the image.");

        expect(result.stopReason).toBe("stop");
        expect(contexts).toHaveLength(3);
        expect(contexts[1]?.messages.at(-1)).toMatchObject({
            role: "toolResult",
            content: [
                {
                    type: "image",
                    mimeType: "image/png",
                    data: validPng32Base64,
                },
            ],
        });
        expect(
            contexts[2]?.messages.findLast((message) => message.role === "toolResult"),
        ).toMatchObject({
            role: "toolResult",
            content: [{ type: "text", text: "Invalid image" }],
            isError: false,
        });
        expect(contexts[2]?.messages.at(-1)).toMatchObject({
            role: "user",
            content: [
                { type: "text", text: "Rig inference attempt 1 failed and was retried." },
                {
                    type: "text",
                    text: expect.stringContaining(
                        "The image data you provided does not represent a valid image.",
                    ),
                },
            ],
        });
        expect(observedEventTypes).not.toContain("error");
        expect(observedToolResults).toHaveLength(2);
        expect(observedToolResults[1]?.id).toBe(observedToolResults[0]?.id);
        expect(result.messages).toContainEqual(
            expect.objectContaining({
                outcome: "retried",
                role: "error",
            }),
        );
        expect(result.messages.at(-1)).toMatchObject({
            role: "agent",
            blocks: [{ type: "text", text: "recovered" }],
        });
    });

    it("keeps transcript valid after aborting during tool execution", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const contexts: Context[] = [];
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream(_ctx, _model, context) {
                contexts.push(context);
                if (contexts.length === 1) {
                    return streamFor({
                        role: "assistant",
                        content: [
                            {
                                type: "toolCall",
                                id: "call-wait",
                                name: "wait",
                                arguments: { value: "hold" },
                            },
                        ],
                        api: "test",
                        provider: "codex",
                        model: "openai/gpt-test",
                        usage: zeroUsage(),
                        stopReason: "toolUse",
                        timestamp: 1,
                    });
                }

                return streamFor({
                    role: "assistant",
                    content: [{ type: "text", text: "next done" }],
                    api: "test",
                    provider: "codex",
                    model: "openai/gpt-test",
                    usage: zeroUsage(),
                    stopReason: "stop",
                    timestamp: 2,
                });
            },
        });
        const controller = new AbortController();
        const started = deferred<void>();
        const waitTool = defineTool({
            name: "wait",
            label: "Wait",
            description: "Waits until aborted.",
            arguments: Type.Object({ value: Type.String() }),
            returnType: Type.Object({ value: Type.String() }),
            shouldReviewInAutoMode: () => false,
            async execute(args: { value: string }, _context, execution) {
                started.resolve();
                await new Promise<void>((resolve) => {
                    execution.signal?.addEventListener("abort", () => resolve(), {
                        once: true,
                    });
                });
                return args;
            },
            toLLM(result: { value: string }) {
                return [{ type: "text", text: result.value }];
            },
            toUI(result: { value: string }) {
                return `finished ${result.value}`;
            },
            locks: [],
        });
        const harness = createJustBashToolHarness();
        const completedDisplays: string[] = [];
        const agent = new Agent({
            provider,
            modelId: model.id,
            context: harness.context,
            tools: [waitTool],
            printToConsole: false,
            onEvent(event) {
                if (event.type === "tool_execution_end") {
                    completedDisplays.push(event.result.display);
                }
            },
        });

        const abortedRun = agent.send(ctx, "start tool", { signal: controller.signal });
        await started.promise;
        await agent.steer("pending tool direction");
        controller.abort();
        await abortedRun;

        expect(agent.messages.at(-2)).toMatchObject({
            role: "agent",
            blocks: [
                {
                    type: "tool_result",
                    toolCallId: expect.any(String),
                    providerToolCallId: "call-wait",
                    toolName: "wait",
                    rendered: [{ type: "text", text: "Interrupted by user." }],
                    isError: true,
                },
            ],
        });
        expect(agent.messages.at(-1)).toMatchObject({
            role: "user",
            blocks: [{ type: "text", text: "pending tool direction" }],
        });
        expect(completedDisplays).toEqual(["Interrupted by user."]);

        await agent.send(ctx, "next message");

        expect(contexts[1]?.messages).toMatchObject([
            { role: "user" },
            {
                role: "assistant",
                content: [
                    {
                        type: "toolCall",
                        id: expect.any(String),
                        providerToolCallId: "call-wait",
                        name: "wait",
                    },
                ],
            },
            {
                role: "toolResult",
                toolCallId: expect.any(String),
                providerToolCallId: "call-wait",
                toolName: "wait",
                content: [{ type: "text", text: "Interrupted by user." }],
                isError: true,
            },
            { role: "user", content: [{ type: "text", text: "pending tool direction" }] },
            { role: "user" },
        ]);
    });

    it("does not trace a synthetic tool finish when execution never started", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream() {
                return streamFor({
                    role: "assistant",
                    content: [
                        {
                            type: "toolCall",
                            id: "call-never-started",
                            name: "never-started",
                            arguments: {},
                        },
                    ],
                    api: "test",
                    provider: "codex",
                    model: model.id,
                    usage: zeroUsage(),
                    stopReason: "toolUse",
                    timestamp: 1,
                });
            },
        });
        const execute = vi.fn(() => ({}));
        const tool = defineTool({
            name: "never-started",
            label: "Never started",
            description: "Would execute if the turn were not interrupted.",
            arguments: Type.Object({}),
            returnType: Type.Object({}),
            shouldReviewInAutoMode: () => false,
            execute,
            toLLM: () => [],
            toUI: () => "unused",
            locks: [],
        });
        const controller = new AbortController();
        const traces: HappyTracingEvent[] = [];
        const harness = createJustBashToolHarness();
        harness.context.plugins = {
            loadSkills: async () => [],
            trace: (event: HappyTracingEvent) => traces.push(event),
        } as never;
        const agent = new Agent({
            context: harness.context,
            modelId: model.id,
            onEvent(event) {
                if (event.type === "done") controller.abort();
            },
            printToConsole: false,
            provider,
            tools: [tool],
        });

        await expect(
            agent.send(ctx, "Stop before the tool.", { signal: controller.signal }),
        ).resolves.toMatchObject({ stopReason: "aborted" });
        expect(execute).not.toHaveBeenCalled();
        expect(
            traces.filter(
                (event) =>
                    event.type === "tool_call_started" || event.type === "tool_call_finished",
            ),
        ).toEqual([]);
    });

    it("preserves a tool result when aborting after execution completes", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream() {
                return streamFor({
                    role: "assistant",
                    content: [
                        {
                            type: "toolCall",
                            id: "call-complete",
                            name: "complete",
                            arguments: { value: "real result" },
                        },
                    ],
                    api: "test",
                    provider: "codex",
                    model: model.id,
                    usage: zeroUsage(),
                    stopReason: "toolUse",
                    timestamp: 1,
                });
            },
        });
        const completeTool = defineTool({
            name: "complete",
            label: "Complete",
            description: "Completes immediately.",
            arguments: Type.Object({ value: Type.String() }),
            returnType: Type.Object({ value: Type.String() }),
            shouldReviewInAutoMode: () => false,
            execute(args: { value: string }) {
                return args;
            },
            toLLM(result: { value: string }) {
                return [{ type: "text", text: result.value }];
            },
            toUI(result: { value: string }) {
                return `finished ${result.value}`;
            },
            locks: [],
        });
        const controller = new AbortController();
        const harness = createJustBashToolHarness();
        const agent = new Agent({
            provider,
            modelId: model.id,
            context: harness.context,
            tools: [completeTool],
            printToConsole: false,
            onEvent(event) {
                if (event.type === "tool_execution_end") controller.abort();
            },
        });

        const result = await agent.send(ctx, "run the tool", { signal: controller.signal });

        expect(result.stopReason).toBe("aborted");
        expect(result.messages.at(-1)).toMatchObject({
            role: "agent",
            blocks: [
                {
                    type: "tool_result",
                    toolCallId: expect.any(String),
                    providerToolCallId: "call-complete",
                    rendered: [{ type: "text", text: "real result" }],
                    display: "finished real result",
                },
            ],
        });
    });

    it("aborts a steerable tool and continues the same run with scheduled steering", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const contexts: Context[] = [];
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream(_ctx, _model, context) {
                contexts.push(context);
                return streamFor({
                    role: "assistant",
                    content:
                        contexts.length === 1
                            ? [
                                  {
                                      type: "toolCall",
                                      id: "call-steerable-wait",
                                      name: "steerable-wait",
                                      arguments: {},
                                  },
                              ]
                            : [{ type: "text", text: "continued after steering" }],
                    api: "test",
                    provider: "codex",
                    model: model.id,
                    usage: zeroUsage(),
                    stopReason: contexts.length === 1 ? "toolUse" : "stop",
                    timestamp: contexts.length,
                });
            },
        });
        const started = deferred<void>();
        const release = deferred<void>();
        let aborted = false;
        const waitTool = Object.assign(
            defineTool({
                name: "steerable-wait",
                label: "Steerable wait",
                description: "Waits until steering arrives.",
                interruptionMessage: "The wait was interrupted by new user input.",
                arguments: Type.Object({}),
                returnType: Type.Object({}),
                shouldReviewInAutoMode: () => false,
                async execute(_args, _context, execution) {
                    started.resolve();
                    execution.signal?.addEventListener(
                        "abort",
                        () => {
                            aborted = true;
                            release.resolve();
                        },
                        { once: true },
                    );
                    await release.promise;
                    execution.signal?.throwIfAborted();
                    return {};
                },
                toLLM: () => [],
                toUI: () => "Wait completed.",
                locks: [],
            }),
            { steerable: true },
        );
        const agent = new Agent({
            provider,
            modelId: model.id,
            context: createJustBashToolHarness().context,
            tools: [waitTool],
            printToConsole: false,
        });

        const run = agent.send(ctx, "Start the steerable wait.");
        await started.promise;
        await agent.steer("Change direction now.");
        try {
            await vi.waitFor(() => expect(aborted).toBe(true), { timeout: 250 });
        } finally {
            release.resolve();
        }
        const result = await run;

        expect(result.stopReason).toBe("stop");
        expect(contexts).toHaveLength(2);
        expect(contexts[1]?.messages.slice(-2)).toMatchObject([
            {
                role: "toolResult",
                toolName: "steerable-wait",
                isError: true,
                content: [{ type: "text", text: "The wait was interrupted by new user input." }],
            },
            {
                role: "user",
                content: [{ type: "text", text: "Change direction now." }],
            },
        ]);
    });

    it("emits structured tool failure details independently of display wording", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        let requestCount = 0;
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream() {
                requestCount += 1;
                return streamFor({
                    role: "assistant",
                    content:
                        requestCount === 1
                            ? [
                                  {
                                      type: "toolCall",
                                      id: "call-failing",
                                      name: "failing",
                                      arguments: {},
                                  },
                              ]
                            : [{ type: "text", text: "done" }],
                    api: "test",
                    provider: "codex",
                    model: model.id,
                    usage: zeroUsage(),
                    stopReason: requestCount === 1 ? "toolUse" : "stop",
                    timestamp: requestCount,
                });
            },
        });
        const failingTool = defineTool({
            name: "failing",
            label: "Failing",
            description: "Fails with a test error.",
            arguments: Type.Object({}),
            returnType: Type.Object({}),
            shouldReviewInAutoMode: () => false,
            execute() {
                throw new Error("test cause");
            },
            toLLM: () => [],
            toUI: () => "unused",
            locks: [],
        });
        const toolResults: unknown[] = [];
        const harness = createJustBashToolHarness();
        const agent = new Agent({
            provider,
            modelId: model.id,
            context: harness.context,
            tools: [failingTool],
            printToConsole: false,
            onEvent(event) {
                if (event.type === "tool_execution_end") toolResults.push(event.result);
            },
        });

        await agent.send(ctx, "run the failing tool");

        expect(toolResults).toEqual([
            expect.objectContaining({
                display: "Tool 'failing' failed: test cause",
                failure: { kind: "execution_failed", message: "test cause" },
                isError: true,
                toolCallId: expect.any(String),
            }),
        ]);
    });

    it("commits pending steering when inference is aborted", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const controller = new AbortController();
        const started = deferred<void>();
        const contexts: Context[] = [];
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream(_ctx, _model, context, options) {
                contexts.push(context);
                if (contexts.length === 1) {
                    const message: AssistantMessage = {
                        role: "assistant",
                        content: [],
                        api: "test",
                        provider: "codex",
                        model: model.id,
                        usage: zeroUsage(),
                        stopReason: "aborted",
                        timestamp: 1,
                    };
                    return {
                        [Symbol.asyncIterator]() {
                            return {
                                async next() {
                                    started.resolve();
                                    await new Promise<void>((resolve) => {
                                        options?.signal?.addEventListener(
                                            "abort",
                                            () => resolve(),
                                            {
                                                once: true,
                                            },
                                        );
                                    });
                                    throw new Error("aborted");
                                },
                            };
                        },
                        async result() {
                            return message;
                        },
                    };
                }
                return streamFor({
                    role: "assistant",
                    content: [{ type: "text", text: "continued" }],
                    api: "test",
                    provider: "codex",
                    model: model.id,
                    usage: zeroUsage(),
                    stopReason: "stop",
                    timestamp: 2,
                });
            },
        });
        const harness = createJustBashToolHarness();
        const agent = new Agent({
            provider,
            modelId: model.id,
            context: harness.context,
            printToConsole: false,
        });

        const firstRun = agent.send(ctx, "initial", { signal: controller.signal });
        await started.promise;
        await agent.steer("pending direction");
        controller.abort();

        await expect(firstRun).resolves.toMatchObject({ stopReason: "aborted" });
        expect(
            agent.messages.filter(
                (message) =>
                    message.role === "user" &&
                    message.blocks.some(
                        (block) => block.type === "text" && block.text === "pending direction",
                    ),
            ),
        ).toHaveLength(1);

        await agent.send(ctx, "continue");

        const continuedUserText = contexts[1]?.messages.flatMap((message) =>
            message.role === "user" && typeof message.content !== "string"
                ? message.content.flatMap((block) => (block.type === "text" ? [block.text] : []))
                : [],
        );
        expect(continuedUserText?.filter((text) => text === "pending direction")).toHaveLength(1);
        expect(continuedUserText?.filter((text) => text === "continue")).toHaveLength(1);
    });

    it("commits pending steering when inference ends with an error", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const started = deferred<void>();
        const release = deferred<void>();
        const errorMessage: AssistantMessage = {
            role: "assistant",
            content: [],
            api: "test",
            provider: "codex",
            model: model.id,
            usage: zeroUsage(),
            stopReason: "error",
            errorMessage: "Provider rejected the request.",
            timestamp: 1,
        };
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream() {
                return {
                    async *[Symbol.asyncIterator]() {
                        yield { type: "start" as const, partial: errorMessage };
                        started.resolve();
                        await release.promise;
                        yield {
                            type: "error" as const,
                            reason: "error" as const,
                            error: errorMessage,
                        };
                    },
                    async result() {
                        await release.promise;
                        return errorMessage;
                    },
                };
            },
        });
        const harness = createJustBashToolHarness();
        const agent = new Agent({
            provider,
            modelId: model.id,
            context: harness.context,
            printToConsole: false,
        });

        const run = agent.send(ctx, "initial request");
        await started.promise;
        await agent.steer("pending error direction");
        release.resolve();

        await expect(run).resolves.toMatchObject({
            errorMessage: "Provider rejected the request.",
            stopReason: "error",
        });
        expect(agent.messages.at(-1)).toMatchObject({
            role: "user",
            blocks: [{ type: "text", text: "pending error direction" }],
        });
    });

    it("does not allow reset to start an overlapping in-flight run", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const started = deferred<void>();
        const release = deferred<void>();
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream() {
                return streamAfterRelease(started.resolve, release.promise);
            },
        });
        const harness = createJustBashToolHarness();
        const agent = new Agent({
            provider,
            modelId: model.id,
            context: harness.context,
            printToConsole: false,
        });

        const firstRun = agent.send(ctx, "first");
        await started.promise;

        await agent.reset();

        expect(agent.status).toBe("running");
        await expect(agent.send(ctx, "second")).rejects.toThrow("already running");

        release.resolve();
        await firstRun;

        expect(agent.status).toBe("idle");
        expect(agent.messages).toEqual([]);
        expect(agent.queue).toEqual([]);
    });

    it("does not restore a compaction that finishes after reset", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const started = deferred<void>();
        const release = deferred<void>();
        const provider = defineProvider({
            id: "codex",
            models: [model],
            compact: async (_ctx, { context }) => {
                started.resolve();
                await release.promise;
                return completedCompaction(context, "summary");
            },
            stream() {
                return streamAfterRelease(() => {}, Promise.resolve(), "done");
            },
        });
        const harness = createJustBashToolHarness();
        const agent = new Agent({
            provider,
            modelId: model.id,
            context: harness.context,
            messages: [
                { role: "user", id: "user-1", blocks: [{ type: "text", text: "work" }] },
                { role: "agent", id: "agent-1", blocks: [{ type: "text", text: "done" }] },
            ],
            printToConsole: false,
        });

        const compaction = agent.compact(ctx);
        await started.promise;
        await agent.reset();
        release.resolve();
        await compaction;

        expect(agent.snapshot().messages).toEqual([]);
        expect(agent.snapshot().contextMessages).toBeUndefined();
    });
});

function createDeterministicIds(): () => string {
    let next = 0;
    return () => `id-${++next}`;
}

function completedCompaction(context: Context, content: string) {
    return {
        status: "completed" as const,
        context: {
            ...context,
            messages: [{ role: "user" as const, content, timestamp: 1 }],
        },
        usage: zeroUsage(),
    };
}

function streamFor(message: AssistantMessage): InferenceStream {
    return {
        async *[Symbol.asyncIterator]() {
            yield {
                type: "start" as const,
                partial: message,
            };
            if (message.stopReason === "error" || message.stopReason === "aborted") {
                yield {
                    type: "error" as const,
                    reason: message.stopReason,
                    error: message,
                };
                return;
            }
            yield {
                type: "done" as const,
                reason: message.stopReason,
                message,
            };
        },
        async result() {
            return message;
        },
    };
}

function stoppedMessage(model: string): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text: "Done." }],
        api: "test",
        provider: "codex",
        model,
        usage: zeroUsage(),
        stopReason: "stop",
        timestamp: 1,
    };
}

function deferred<T>(): {
    promise: Promise<T>;
    resolve: (value: T | PromiseLike<T>) => void;
} {
    let resolve: (value: T | PromiseLike<T>) => void = () => {};
    const promise = new Promise<T>((innerResolve) => {
        resolve = innerResolve;
    });
    return { promise, resolve };
}

function streamAfterRelease(
    started: () => void,
    release: Promise<void>,
    text = "done",
): InferenceStream {
    const message: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text }],
        api: "test",
        provider: "codex",
        model: "openai/gpt-test",
        usage: zeroUsage(),
        stopReason: "stop",
        timestamp: 1,
    };

    return {
        async *[Symbol.asyncIterator]() {
            yield { type: "start" as const, partial: message };
            started();
            await release;
            yield { type: "done" as const, reason: "stop" as const, message };
        },
        async result() {
            await release;
            return message;
        },
    };
}

function zeroUsage(): Usage {
    return {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
        },
    };
}

function usageWithTotalTokens(totalTokens: number): Usage {
    return {
        ...zeroUsage(),
        input: totalTokens,
        totalTokens,
    };
}
