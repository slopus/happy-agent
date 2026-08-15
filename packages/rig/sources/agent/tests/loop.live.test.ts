import { Type } from "@sinclair/typebox";
import { describe, expect, it, vi } from "vitest";

import { runAgentLoop } from "../loop.js";
import { defineTool } from "../types.js";
import { createJustBashToolHarness } from "../../testing/createAgentTestHarness.js";
import { createTestRootContext } from "../../testing/createTestRootContext.js";
import {
    defineModel,
    defineProvider,
    type AssistantContent,
    type AssistantMessage,
    type ProviderAssistantMessageEvent,
    type Context,
    type InferenceStream,
    type StopReason,
    type StreamOptions,
    type Usage,
} from "@slopus/rig-execution";

const ctx = createTestRootContext();

describe("agent loop live", () => {
    it("executes mock tools and feeds rendered tool answers back to the model", async () => {
        const model = defineModel({
            id: "mock/model",
            name: "Mock Model",
            thinkingLevels: ["off", "high"],
            defaultThinkingLevel: "off",
        });
        const contexts: Context[] = [];
        const streamOptions: StreamOptions[] = [];

        const provider = defineProvider({
            id: "mock",
            models: [model],
            stream(_ctx, _model, context, options) {
                contexts.push(context);
                if (options !== undefined) {
                    streamOptions.push(options);
                }

                if (contexts.length === 1) {
                    return streamFor(
                        assistantMessage(
                            [
                                {
                                    type: "toolCall",
                                    id: "call-add",
                                    name: "add",
                                    arguments: { left: 2, right: 5 },
                                },
                                {
                                    type: "toolCall",
                                    id: "call-shout",
                                    name: "shout",
                                    arguments: { value: "dublin" },
                                },
                            ],
                            "toolUse",
                        ),
                    );
                }

                return streamFor(
                    assistantMessage(
                        [
                            {
                                type: "text",
                                text: "done",
                            },
                        ],
                        "stop",
                    ),
                );
            },
        });

        const addExecute = vi.fn((args: { left: number; right: number }) => ({
            total: args.left + args.right,
        }));
        const addToLLM = vi.fn((result: { total: number }) => [
            {
                type: "text" as const,
                text: `total=${result.total}`,
            },
        ]);
        const addToUI = vi.fn((result: { total: number }) => `added ${result.total}`);
        const addTool = defineTool({
            name: "add",
            label: "Add",
            description: "Adds two numbers.",
            arguments: Type.Object({
                left: Type.Number(),
                right: Type.Number(),
            }),
            returnType: Type.Object({
                total: Type.Number(),
            }),
            shouldReviewInAutoMode: () => false,
            execute: addExecute,
            toLLM: addToLLM,
            toUI: addToUI,
            locks: [],
        });

        const shoutExecute = vi.fn((args: { value: string }) => ({
            shouted: args.value.toUpperCase(),
        }));
        const shoutToLLM = vi.fn((result: { shouted: string }) => [
            {
                type: "text" as const,
                text: result.shouted,
            },
        ]);
        const shoutToUI = vi.fn((result: { shouted: string }) => `shouted ${result.shouted}`);
        const shoutTool = defineTool({
            name: "shout",
            label: "Shout",
            description: "Uppercases text.",
            arguments: Type.Object({
                value: Type.String(),
            }),
            returnType: Type.Object({
                shouted: Type.String(),
            }),
            shouldReviewInAutoMode: () => false,
            execute: shoutExecute,
            toLLM: shoutToLLM,
            toUI: shoutToUI,
            locks: [],
        });

        let nextId = 0;
        let timestamp = 1_000;
        const harness = createJustBashToolHarness();
        const result = await runAgentLoop(ctx, {
            provider,
            modelId: "mock/model",
            effort: "high",
            tools: [addTool, shoutTool],
            instructions: "Use tools when needed.",
            messages: [
                {
                    role: "user",
                    id: "user-1",
                    blocks: [
                        {
                            type: "text",
                            text: "Add 2 and 5, then shout dublin.",
                        },
                    ],
                },
            ],
            idFactory: () => `generated-${++nextId}`,
            now: () => timestamp++,
            context: harness.context,
        });

        expect(result.stopReason).toBe("stop");
        expect(contexts).toHaveLength(2);
        expect(streamOptions).toHaveLength(2);
        expect(streamOptions[0]?.thinking).toBe("high");

        expect(contexts[0]?.systemPrompt).toContain("Use tools when needed.");
        expect(contexts[0]?.systemPrompt).toContain("You are in Full access mode.");
        expect(contexts[0]?.tools?.map((tool) => tool.name)).toEqual(["add", "shout"]);

        expect(addExecute).toHaveBeenCalledExactlyOnceWith(
            {
                left: 2,
                right: 5,
            },
            expect.objectContaining({
                fs: expect.objectContaining({ cwd: "/workspace" }),
                bash: expect.objectContaining({ cwd: "/workspace" }),
            }),
            expect.objectContaining({
                onProgress: expect.any(Function),
                onStatus: expect.any(Function),
                toolCallId: "call-add",
            }),
        );
        expect(addToLLM).toHaveBeenCalledExactlyOnceWith({ total: 7 });
        expect(addToUI).toHaveBeenCalledExactlyOnceWith(
            { total: 7 },
            {
                left: 2,
                right: 5,
            },
        );
        expect(shoutExecute).toHaveBeenCalledExactlyOnceWith(
            { value: "dublin" },
            expect.objectContaining({
                fs: expect.objectContaining({ cwd: "/workspace" }),
                bash: expect.objectContaining({ cwd: "/workspace" }),
            }),
            expect.objectContaining({
                onProgress: expect.any(Function),
                onStatus: expect.any(Function),
                toolCallId: "call-shout",
            }),
        );
        expect(shoutToLLM).toHaveBeenCalledExactlyOnceWith({
            shouted: "DUBLIN",
        });
        expect(shoutToUI).toHaveBeenCalledExactlyOnceWith(
            {
                shouted: "DUBLIN",
            },
            { value: "dublin" },
        );

        expect(contexts[1]?.messages).toHaveLength(4);
        expect(contexts[1]?.messages[2]).toMatchObject({
            role: "toolResult",
            toolCallId: "call-add",
            toolName: "add",
            content: [{ type: "text", text: "total=7" }],
            isError: false,
        });
        expect(contexts[1]?.messages[3]).toMatchObject({
            role: "toolResult",
            toolCallId: "call-shout",
            toolName: "shout",
            content: [{ type: "text", text: "DUBLIN" }],
            isError: false,
        });

        expect(result.messages).toHaveLength(4);
        expect(result.messages[2]).toMatchObject({
            role: "agent",
            blocks: [
                {
                    type: "tool_result",
                    toolCallId: "call-add",
                    toolName: "add",
                    rendered: [{ type: "text", text: "total=7" }],
                    display: "added 7",
                },
                {
                    type: "tool_result",
                    toolCallId: "call-shout",
                    toolName: "shout",
                    rendered: [{ type: "text", text: "DUBLIN" }],
                    display: "shouted DUBLIN",
                },
            ],
        });
    });

    it("bounds individual and batched tool results on the wire before the next inference", async () => {
        const model = defineModel({
            id: "mock/model",
            name: "Mock Model",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const contexts: Context[] = [];
        const provider = defineProvider({
            id: "mock",
            models: [model],
            stream(_ctx, _model, context) {
                contexts.push(context);
                return streamFor(
                    contexts.length === 1
                        ? assistantMessage(
                              Array.from({ length: 5 }, (_, index) => ({
                                  type: "toolCall" as const,
                                  id: `call-large-${String(index)}`,
                                  name: "large_result",
                                  arguments: {},
                              })),
                              "toolUse",
                          )
                        : assistantMessage([{ type: "text", text: "done" }], "stop"),
                );
            },
        });
        const largeResultTool = defineTool({
            name: "large_result",
            label: "Large result",
            description: "Returns a deliberately oversized result.",
            arguments: Type.Object({}),
            returnType: Type.Object({ text: Type.String() }),
            shouldReviewInAutoMode: () => false,
            execute: () => ({ text: `begin-${"x".repeat(100_000)}-end` }),
            toLLM: (result) => [{ type: "text", text: result.text }],
            toUI: () => "Returned a large result",
            locks: [],
        });
        const harness = createJustBashToolHarness();

        await runAgentLoop(ctx, {
            provider,
            modelId: model.id,
            tools: [largeResultTool],
            messages: [
                {
                    role: "user",
                    id: "user-1",
                    blocks: [{ type: "text", text: "Return a large tool result." }],
                },
            ],
            context: harness.context,
        });

        const toolResults =
            contexts[1]?.messages.filter((message) => message.role === "toolResult") ?? [];
        const wireTexts = toolResults.map((message) =>
            message.content
                .filter((content) => content.type === "text")
                .map((content) => content.text)
                .join(""),
        );
        expect(toolResults.map((message) => message.toolCallId)).toEqual(
            Array.from({ length: 5 }, (_, index) => `call-large-${String(index)}`),
        );
        expect(
            wireTexts.reduce((total, wireText) => total + Buffer.byteLength(wireText), 0),
        ).toBeLessThanOrEqual(200 * 1024);
        for (const wireText of wireTexts) {
            expect(Buffer.byteLength(wireText)).toBeLessThanOrEqual(50 * 1024);
            expect(wireText).toContain("begin-");
            expect(wireText).not.toContain("-end");
            expect(wireText).toContain("Tool result truncated");
        }
    });

    it("executes provider tool calls in parallel and preserves result order", async () => {
        const model = defineModel({
            id: "mock/model",
            name: "Mock Model",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const contexts: Context[] = [];

        const provider = defineProvider({
            id: "mock",
            models: [model],
            stream(_ctx, _model, context) {
                contexts.push(context);

                if (contexts.length === 1) {
                    return streamFor(
                        assistantMessage(
                            [
                                {
                                    type: "toolCall",
                                    id: "call-slow",
                                    name: "slow",
                                    arguments: { value: "slow" },
                                },
                                {
                                    type: "toolCall",
                                    id: "call-fast",
                                    name: "fast",
                                    arguments: { value: "fast" },
                                },
                            ],
                            "toolUse",
                        ),
                    );
                }

                return streamFor(assistantMessage([{ type: "text", text: "done" }], "stop"));
            },
        });

        const events: string[] = [];
        const slowTool = defineTool({
            name: "slow",
            label: "Slow",
            description: "Returns slowly.",
            arguments: Type.Object({ value: Type.String() }),
            returnType: Type.Object({ value: Type.String() }),
            shouldReviewInAutoMode: () => false,
            async execute(args: { value: string }) {
                events.push("slow-start");
                await delay(40);
                events.push("slow-end");
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
        const fastTool = defineTool({
            name: "fast",
            label: "Fast",
            description: "Returns quickly.",
            arguments: Type.Object({ value: Type.String() }),
            returnType: Type.Object({ value: Type.String() }),
            shouldReviewInAutoMode: () => false,
            async execute(args: { value: string }) {
                events.push("fast-start");
                await delay(1);
                events.push("fast-end");
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
        const executionEvents: string[] = [];
        const result = await runAgentLoop(ctx, {
            provider,
            modelId: "mock/model",
            tools: [slowTool, fastTool],
            messages: [
                {
                    role: "user",
                    id: "user-1",
                    blocks: [{ type: "text", text: "Run both tools." }],
                },
            ],
            context: harness.context,
            onEvent(event) {
                if (event.type === "tool_execution_start") {
                    executionEvents.push(`start:${event.toolCall.id}`);
                }
                if (event.type === "tool_execution_end") {
                    executionEvents.push(`end:${event.result.toolCallId}`);
                }
            },
        });

        expect(result.stopReason).toBe("stop");
        expect(events.indexOf("fast-start")).toBeGreaterThan(events.indexOf("slow-start"));
        expect(events.indexOf("fast-start")).toBeLessThan(events.indexOf("slow-end"));
        expect(executionEvents).toEqual([
            "start:call-slow",
            "start:call-fast",
            "end:call-fast",
            "end:call-slow",
        ]);
        expect(contexts[1]?.messages.slice(2)).toMatchObject([
            {
                role: "toolResult",
                toolCallId: "call-slow",
                toolName: "slow",
                content: [{ type: "text", text: "slow" }],
            },
            {
                role: "toolResult",
                toolCallId: "call-fast",
                toolName: "fast",
                content: [{ type: "text", text: "fast" }],
            },
        ]);
        expect(result.messages[2]).toMatchObject({
            role: "agent",
            blocks: [
                {
                    type: "tool_result",
                    toolCallId: "call-slow",
                    toolName: "slow",
                    rendered: [{ type: "text", text: "slow" }],
                    display: "finished slow",
                },
                {
                    type: "tool_result",
                    toolCallId: "call-fast",
                    toolName: "fast",
                    rendered: [{ type: "text", text: "fast" }],
                    display: "finished fast",
                },
            ],
        });
    });

    it("executes an identical tool mutation only once within one provider message", async () => {
        const model = defineModel({
            id: "mock/model",
            name: "Mock Model",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const contexts: Context[] = [];
        const provider = defineProvider({
            id: "mock",
            models: [model],
            stream(_ctx, _model, context) {
                contexts.push(context);
                return contexts.length === 1
                    ? streamFor(
                          assistantMessage(
                              [
                                  {
                                      type: "toolCall",
                                      id: "call-first",
                                      name: "send",
                                      arguments: { message: "One delivery.", target: "agent-1" },
                                  },
                                  {
                                      type: "toolCall",
                                      id: "call-duplicate",
                                      name: "send",
                                      arguments: { target: "agent-1", message: "One delivery." },
                                  },
                              ],
                              "toolUse",
                          ),
                      )
                    : streamFor(assistantMessage([{ type: "text", text: "done" }], "stop"));
            },
        });
        const execute = vi.fn((args: { message: string; target: string }) => args);
        const sendTool = defineTool({
            name: "send",
            label: "Send",
            description: "Sends one externally visible message.",
            arguments: Type.Object({ message: Type.String(), target: Type.String() }),
            returnType: Type.Object({ message: Type.String(), target: Type.String() }),
            shouldReviewInAutoMode: () => false,
            execute,
            toLLM: () => [{ type: "text", text: "sent" }],
            toUI: () => "sent",
            locks: [],
        });
        const harness = createJustBashToolHarness();

        await runAgentLoop(ctx, {
            provider,
            modelId: model.id,
            tools: [sendTool],
            messages: [
                {
                    role: "user",
                    id: "user-1",
                    blocks: [{ type: "text", text: "Send this once." }],
                },
            ],
            context: harness.context,
        });

        expect(execute).toHaveBeenCalledTimes(1);
        const resultIds =
            contexts[1]?.messages
                .filter((message) => message.role === "toolResult")
                .map((message) => message.toolCallId) ?? [];
        expect(resultIds).toHaveLength(2);
        expect(new Set(resultIds).size).toBe(2);
    });

    it("serializes provider tool calls that share a declared lock", async () => {
        const model = defineModel({
            id: "mock/model",
            name: "Mock Model",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        let inferenceCount = 0;
        const provider = defineProvider({
            id: "mock",
            models: [model],
            stream() {
                inferenceCount++;
                return inferenceCount === 1
                    ? streamFor(
                          assistantMessage(
                              [
                                  {
                                      type: "toolCall",
                                      id: "call-first",
                                      name: "locked",
                                      arguments: { key: "shared", value: "first" },
                                  },
                                  {
                                      type: "toolCall",
                                      id: "call-second",
                                      name: "locked",
                                      arguments: { key: "shared", value: "second" },
                                  },
                              ],
                              "toolUse",
                          ),
                      )
                    : streamFor(assistantMessage([{ type: "text", text: "done" }], "stop"));
            },
        });
        const events: string[] = [];
        const lockedTool = defineTool({
            name: "locked",
            label: "Locked",
            description: "Runs under an argument-derived lock.",
            arguments: Type.Object({ key: Type.String(), value: Type.String() }),
            returnType: Type.Object({ value: Type.String() }),
            shouldReviewInAutoMode: () => false,
            async execute(args: { key: string; value: string }) {
                events.push(`${args.value}-start`);
                await delay(args.value === "first" ? 40 : 1);
                events.push(`${args.value}-end`);
                return { value: args.value };
            },
            toLLM: (result: { value: string }) => [{ type: "text", text: result.value }],
            toUI: (result: { value: string }) => result.value,
            locks: [(args) => args.key],
        });

        const harness = createJustBashToolHarness();
        await runAgentLoop(ctx, {
            provider,
            modelId: "mock/model",
            tools: [lockedTool],
            messages: [
                {
                    role: "user",
                    id: "user-1",
                    blocks: [{ type: "text", text: "Run both locked calls." }],
                },
            ],
            context: harness.context,
        });

        expect(events).toEqual(["first-start", "first-end", "second-start", "second-end"]);
    });

    it("propagates an optional tool result failure predicate", async () => {
        const model = defineModel({
            id: "mock/model",
            name: "Mock Model",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const contexts: Context[] = [];
        const provider = defineProvider({
            id: "mock",
            models: [model],
            stream(_ctx, _model, context) {
                contexts.push(context);
                return contexts.length === 1
                    ? streamFor(
                          assistantMessage(
                              [
                                  {
                                      type: "toolCall",
                                      id: "call-failed-result",
                                      name: "checked-action",
                                      arguments: {},
                                  },
                              ],
                              "toolUse",
                          ),
                      )
                    : streamFor(assistantMessage([{ type: "text", text: "done" }], "stop"));
            },
        });
        const checkedTool = defineTool({
            name: "checked-action",
            label: "Checked action",
            description: "Returns a result whose status is determined after execution.",
            arguments: Type.Object({}),
            returnType: Type.Object({ failed: Type.Boolean() }),
            shouldReviewInAutoMode: () => false,
            execute: () => ({ failed: true }),
            isError: (result) => result.failed,
            toLLM: (result) => [{ type: "text", text: `failed=${String(result.failed)}` }],
            toUI: () => "The checked action failed.",
            locks: [],
        });
        const executionResults: Array<{ isError?: boolean }> = [];
        const harness = createJustBashToolHarness();
        const result = await runAgentLoop(ctx, {
            provider,
            modelId: model.id,
            tools: [checkedTool],
            messages: [
                {
                    role: "user",
                    id: "user-1",
                    blocks: [{ type: "text", text: "Run the checked action." }],
                },
            ],
            context: harness.context,
            onEvent(event) {
                if (event.type === "tool_execution_end") executionResults.push(event.result);
            },
        });

        expect(executionResults).toEqual([expect.objectContaining({ isError: true })]);
        expect(contexts[1]?.messages.at(-1)).toMatchObject({
            content: [{ type: "text", text: "failed=true" }],
            isError: true,
            role: "toolResult",
            toolCallId: "call-failed-result",
            toolName: "checked-action",
        });
        expect(result.messages[2]).toMatchObject({
            blocks: [
                {
                    display: "The checked action failed.",
                    isError: true,
                    toolCallId: "call-failed-result",
                    toolName: "checked-action",
                    type: "tool_result",
                },
            ],
            role: "agent",
        });
    });

    it("passes the abort signal to active tool calls and omits results after abort", async () => {
        const model = defineModel({
            id: "mock/model",
            name: "Mock Model",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const provider = defineProvider({
            id: "mock",
            models: [model],
            stream() {
                return streamFor(
                    assistantMessage(
                        [
                            {
                                type: "toolCall",
                                id: "call-wait",
                                name: "wait",
                                arguments: { value: "hold" },
                            },
                        ],
                        "toolUse",
                    ),
                );
            },
        });

        const controller = new AbortController();
        const started = deferred<void>();
        const observedSignals: boolean[] = [];
        const waitTool = defineTool({
            name: "wait",
            label: "Wait",
            description: "Waits until the run is aborted.",
            interruptionMessage: "The custom wait was interrupted.",
            arguments: Type.Object({ value: Type.String() }),
            returnType: Type.Object({ value: Type.String() }),
            shouldReviewInAutoMode: () => false,
            async execute(args: { value: string }, _context, execution) {
                observedSignals.push(execution.signal === controller.signal);
                started.resolve();
                if (execution.signal === undefined) {
                    throw new Error("Missing abort signal.");
                }

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
        const resultPromise = runAgentLoop(ctx, {
            provider,
            modelId: "mock/model",
            tools: [waitTool],
            messages: [
                {
                    role: "user",
                    id: "user-1",
                    blocks: [{ type: "text", text: "Run a waiting tool." }],
                },
            ],
            context: harness.context,
            signal: controller.signal,
        });

        await started.promise;
        controller.abort();

        const result = await resultPromise;
        expect(observedSignals).toEqual([true]);
        expect(result.stopReason).toBe("aborted");
        expect(result.messages).toHaveLength(3);
        expect(result.messages[2]).toMatchObject({
            role: "agent",
            blocks: [
                {
                    type: "tool_result",
                    toolCallId: "call-wait",
                    toolName: "wait",
                    rendered: [{ type: "text", text: "The custom wait was interrupted." }],
                    display: "The custom wait was interrupted.",
                    isError: true,
                },
            ],
        });
    });

    it("finishes an aborted run without waiting for provider stream cleanup", async () => {
        const model = defineModel({
            id: "mock/model",
            name: "Mock Model",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const started = deferred<void>();
        const never = new Promise<never>(() => {});
        const provider = defineProvider({
            id: "mock",
            models: [model],
            stream() {
                return {
                    [Symbol.asyncIterator]() {
                        return {
                            next() {
                                started.resolve();
                                return never;
                            },
                        };
                    },
                    result() {
                        return never;
                    },
                };
            },
        });
        const controller = new AbortController();
        const harness = createJustBashToolHarness();
        const resultPromise = runAgentLoop(ctx, {
            provider,
            modelId: model.id,
            tools: [],
            messages: [
                {
                    role: "user",
                    id: "user-1",
                    blocks: [{ type: "text", text: "Wait forever." }],
                },
            ],
            context: harness.context,
            signal: controller.signal,
        });

        await started.promise;
        controller.abort();

        await expect(settlesBeforeNextTurn(resultPromise)).resolves.toMatchObject({
            stopReason: "aborted",
        });
    });

    it("publishes every interrupted tool result before finishing without waiting for cleanup", async () => {
        const model = defineModel({
            id: "mock/model",
            name: "Mock Model",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const provider = defineProvider({
            id: "mock",
            models: [model],
            stream() {
                return streamFor(
                    assistantMessage(
                        ["first", "second"].map((name) => ({
                            type: "toolCall" as const,
                            id: `call-${name}`,
                            name,
                            arguments: {},
                        })),
                        "toolUse",
                    ),
                );
            },
        });
        const started = deferred<void>();
        let startedCount = 0;
        const never = new Promise<never>(() => {});
        const createWaitingTool = (name: string) =>
            defineTool({
                name,
                label: name,
                description: `Run ${name}.`,
                interruptionMessage: `${name} was stopped.`,
                arguments: Type.Object({}),
                returnType: Type.Object({}),
                shouldReviewInAutoMode: () => false,
                execute() {
                    startedCount += 1;
                    if (startedCount === 2) started.resolve();
                    return never;
                },
                toLLM: () => [],
                toUI: () => name,
                locks: [],
            });
        const controller = new AbortController();
        const completedToolIds: string[] = [];
        const harness = createJustBashToolHarness();
        const resultPromise = runAgentLoop(ctx, {
            provider,
            modelId: model.id,
            tools: [createWaitingTool("first"), createWaitingTool("second")],
            messages: [
                {
                    role: "user",
                    id: "user-1",
                    blocks: [{ type: "text", text: "Run both tools." }],
                },
            ],
            context: harness.context,
            signal: controller.signal,
            onEvent(event) {
                if (event.type === "tool_execution_end") {
                    completedToolIds.push(event.result.toolCallId);
                }
            },
        });

        await started.promise;
        controller.abort();

        const result = await settlesBeforeNextTurn(resultPromise);
        expect(result.stopReason).toBe("aborted");
        expect(completedToolIds).toEqual(["call-first", "call-second"]);
        expect(result.messages.at(-1)).toMatchObject({
            role: "agent",
            blocks: [
                {
                    display: "first was stopped.",
                    failure: { kind: "interrupted" },
                    toolCallId: "call-first",
                },
                {
                    display: "second was stopped.",
                    failure: { kind: "interrupted" },
                    toolCallId: "call-second",
                },
            ],
        });
    });
});

async function settlesBeforeNextTurn<T>(promise: Promise<T>): Promise<T> {
    return Promise.race([
        promise,
        new Promise<never>((_, reject) => {
            setImmediate(() => reject(new Error("The aborted operation outlived its turn.")));
        }),
    ]);
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
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

function streamFor(message: AssistantMessage): InferenceStream {
    const doneReason = toDoneReason(message.stopReason);

    return {
        async *[Symbol.asyncIterator](): AsyncIterator<ProviderAssistantMessageEvent> {
            yield {
                type: "start",
                partial: message,
            };
            yield {
                type: "done",
                reason: doneReason,
                message,
            };
        },
        result: async () => message,
    };
}

function assistantMessage(
    content: readonly AssistantContent[],
    stopReason: StopReason,
): AssistantMessage {
    return {
        role: "assistant",
        content,
        api: "mock",
        provider: "mock",
        model: "mock/model",
        usage: zeroUsage(),
        stopReason,
        timestamp: 0,
    };
}

function toDoneReason(reason: StopReason): Extract<StopReason, "stop" | "length" | "toolUse"> {
    if (reason === "stop" || reason === "length" || reason === "toolUse") {
        return reason;
    }

    throw new Error(`Cannot create done event for stop reason '${reason}'`);
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
