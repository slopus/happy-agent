import { describe, expect, it } from "vitest";

import { createInferenceStream } from "@slopus/rig-execution";
import {
    defineModel,
    defineProvider,
    type AssistantMessage,
    type StreamOptions,
} from "@slopus/rig-execution";
import { generateSessionMetadata, parseSessionMetadata } from "../generateSessionMetadata.js";

describe("parseSessionMetadata", () => {
    it("accepts only the strict bounded title and recap object", () => {
        expect(
            parseSessionMetadata(
                '{"title":"Delayed session metadata","recap":"The user added delayed metadata. The implementation is complete."}',
            ),
        ).toEqual({
            recap: "The user added delayed metadata. The implementation is complete.",
            title: "Delayed session metadata",
        });

        expect(() => parseSessionMetadata("```json\n{}\n```")).toThrow("invalid JSON");
        expect(() => parseSessionMetadata('{"title":"One","recap":"Valid recap."}')).toThrow(
            "2 to 6 words",
        );
        expect(() =>
            parseSessionMetadata('{"title":"Valid title","recap":"One. Two. Three."}'),
        ).toThrow("at most 2 sentences");
        expect(() =>
            parseSessionMetadata('{"title":"Valid title","recap":"Valid recap.","extra":"no"}'),
        ).toThrow("only string title and recap");
    });

    it("forwards the stored session start date to metadata inference", async () => {
        const model = defineModel({
            defaultThinkingLevel: "off",
            id: "openai/gpt-5.4",
            name: "Metadata model",
            thinkingLevels: ["off"],
        });
        let observedOptions: StreamOptions | undefined;
        const message: AssistantMessage = {
            api: "test",
            content: [
                {
                    text: '{"title":"Stable session date","recap":"The stored session date was forwarded."}',
                    type: "text",
                },
            ],
            model: model.id,
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
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream(_model, _context, options) {
                observedOptions = options;
                return createInferenceStream(async function* () {
                    yield { message, reason: "stop", type: "done" };
                    return message;
                });
            },
        });

        await generateSessionMetadata({
            modelId: model.id,
            provider,
            sessionId: "session-1",
            startDate: "2024-01-02",
            transcript: "User: Keep the date stable.",
        });

        expect(observedOptions).toMatchObject({
            sessionId: "session-1:title",
            startDate: "2024-01-02",
            structuredOutput: {
                name: "session_metadata",
                schema: {
                    additionalProperties: false,
                    properties: {
                        recap: { type: "string" },
                        title: { type: "string" },
                    },
                    required: ["title", "recap"],
                    type: "object",
                },
            },
        });
    });

    it("names the session with a cheap model from the session model's own family", async () => {
        // Bedrock serves both families, and reaching across them to name a chat asks the session's
        // Claude provider for a GPT model, which it cannot serve.
        const models = [
            defineModel({
                defaultThinkingLevel: "off",
                id: "openai/gpt-5.6-sol",
                name: "Sol",
                thinkingLevels: ["off"],
            }),
            defineModel({
                defaultThinkingLevel: "off",
                id: "anthropic/sonnet-5",
                name: "Sonnet",
                thinkingLevels: ["off"],
            }),
            defineModel({
                defaultThinkingLevel: "off",
                id: "anthropic/fable-5",
                name: "Fable",
                thinkingLevels: ["off"],
            }),
        ];
        const observed: string[] = [];
        const provider = defineProvider({
            id: "bedrock",
            models,
            stream(model) {
                observed.push(model.id);
                const message: AssistantMessage = {
                    api: "test",
                    content: [
                        {
                            text: '{"title":"Metadata stays in family","recap":"The title model matched the session family."}',
                            type: "text",
                        },
                    ],
                    model: model.id,
                    provider: "bedrock",
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
                return createInferenceStream(async function* () {
                    yield { message, reason: "stop", type: "done" };
                    return message;
                });
            },
        });

        await generateSessionMetadata({
            modelId: "anthropic/fable-5",
            provider,
            sessionId: "session-1",
            transcript: "User: Name this chat.",
        });

        expect(observed).toEqual(["anthropic/sonnet-5"]);
    });

    it("closes its isolated provider even when inference fails synchronously", async () => {
        const model = defineModel({
            defaultThinkingLevel: "off",
            id: "openai/gpt-5.6-sol",
            name: "Sol",
            thinkingLevels: ["off"],
        });
        let isolatedCloseCount = 0;
        let mainStreamCount = 0;
        const isolated = defineProvider({
            close() {
                isolatedCloseCount += 1;
            },
            id: "codex",
            models: [model],
            stream() {
                throw new Error("metadata inference failed");
            },
        });
        const provider = {
            ...defineProvider({
                id: "codex",
                models: [model],
                stream() {
                    mainStreamCount += 1;
                    throw new Error("main provider must not run metadata");
                },
            }),
            isolate(label: string) {
                expect(label).toBe("title");
                return isolated;
            },
        };

        await expect(
            generateSessionMetadata({
                modelId: model.id,
                provider,
                sessionId: "session-1",
                transcript: "User: Name this chat.",
            }),
        ).rejects.toThrow("metadata inference failed");

        expect(mainStreamCount).toBe(0);
        expect(isolatedCloseCount).toBe(1);
    });

    it("settles cancellation even when an isolated provider ignores its abort signal", async () => {
        const model = defineModel({
            defaultThinkingLevel: "off",
            id: "openai/gpt-5.6-sol",
            name: "Sol",
            thinkingLevels: ["off"],
        });
        let isolatedCloseCount = 0;
        let isolatedForceCloseCount = 0;
        const isolatedBase = defineProvider({
            close() {
                isolatedCloseCount += 1;
            },
            id: "codex",
            models: [model],
            stream() {
                return createInferenceStream(async function* () {
                    await new Promise<void>(() => {});
                    throw new Error("unreachable");
                });
            },
        });
        const isolated = {
            ...isolatedBase,
            forceClose() {
                isolatedForceCloseCount += 1;
                return Promise.reject(new Error("Expected teardown failure."));
            },
        };
        const provider = {
            ...isolated,
            isolate: () => isolated,
        };
        const controller = new AbortController();
        const metadata = generateSessionMetadata({
            modelId: model.id,
            provider,
            sessionId: "session-1",
            signal: controller.signal,
            transcript: "User: Do not hang after cancellation.",
        });

        controller.abort();

        await expect(metadata).rejects.toThrow("cancelled");
        await Promise.resolve();
        expect(isolatedForceCloseCount).toBe(1);
        expect(isolatedCloseCount).toBe(0);
    });
});
