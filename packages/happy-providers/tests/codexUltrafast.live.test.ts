import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { CodexProvider } from "@/vendors/codex/CodexProvider.js";
import { CodexSessionCredential } from "@/vendors/codex/CodexSessionCredential.js";
import { CodexSseConnection } from "@/vendors/codex/impl/CodexSseConnection.js";
import { CodexWebSocketConnection } from "@/vendors/codex/impl/CodexWebSocketConnection.js";
import { collectSessionEvents, textFromSessionEvents } from "./helpers/collectSessionEvents.js";
import { testContextWith } from "./testContext.js";
import { assertLiveCodexAccount } from "./helpers/assertLiveCodexAccount.js";
import { assistantMessageFromEvents } from "@/core/SessionAssistantMessageAccumulator.js";
import type { SessionMessage } from "@/core/SessionContext.js";

const describeLive = process.env.RIG_LIVE_TEST === "1" ? describe : describe.skip;
const tierResponseSchema = Type.Object({
    model: Type.String(),
    service_tier: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});

describeLive("Astra Ultrafast live", () => {
    it("reads account-advertised speeds without discovering new models", async () => {
        const credential = await CodexSessionCredential.tryLoad();
        if (credential === null) throw new Error("No local Codex login is available.");
        await assertLiveCodexAccount(credential);
        const provider = new CodexProvider({ credential });
        const tiers = await provider.modelServiceTiers(["openai/gpt-6-astra", "openai/gpt-6-sol"]);
        console.log(
            JSON.stringify({ accountVerified: Boolean(process.env.RIG_LIVE_ACCOUNT_EMAIL), tiers }),
        );
        expect(tiers["openai/gpt-6-astra"]).toContain("ultrafast");
        expect(tiers["openai/gpt-6-sol"]).not.toContain("ultrafast");
    }, 20_000);

    beforeAll(async () => {
        if (process.env.RIG_LIVE_REFRESH_ACCOUNT !== "1") return;
        if (!process.env.RIG_LIVE_ACCOUNT_EMAIL?.trim()) {
            throw new Error("Refreshing a live login requires an explicit expected account.");
        }
        const credential = await CodexSessionCredential.tryLoad();
        if (credential === null) throw new Error("No local Codex login is available.");
        await assertLiveCodexAccount(credential);
        const refreshed = await credential.refreshForMaintenance({
            signal: AbortSignal.timeout(35_000),
        });
        if (refreshed === undefined)
            throw new Error("The expected Codex account could not be refreshed.");
        await assertLiveCodexAccount(refreshed);
        console.log(JSON.stringify({ accountVerified: true, credentialMaintenance: "completed" }));
    }, 40_000);

    it("completes a WebSocket tool round trip with Ultrafast requested (reports actual tier separately)", async () => {
        const credential = await CodexSessionCredential.tryLoad();
        if (credential === null) throw new Error("No local Codex login is available.");
        await assertLiveCodexAccount(credential);
        const markerSchema = Type.Object(
            { marker: Type.Literal("ULTRAFAST_TOOL_OK") },
            { additionalProperties: false },
        );
        const session = await new CodexProvider({
            credential,
            model: "gpt-6-astra",
            transport: "websocket",
            inferenceMaxRetries: 0,
        }).session(`ultrafast-tool-${Date.now()}`, {
            instructions: "Call report_marker as requested, then reply with its returned marker.",
            tools: [
                {
                    name: "report_marker",
                    description: "Return the supplied marker.",
                    parameters: markerSchema,
                },
            ],
        });
        const completed: unknown[] = [];
        const original = CodexWebSocketConnection.prototype.stream;
        const observer = vi
            .spyOn(CodexWebSocketConnection.prototype, "stream")
            .mockImplementation(async function* (this: CodexWebSocketConnection, options) {
                expect(options.request.service_tier).toBe("ultrafast");
                for await (const event of original.call(this, options)) {
                    if (event.type === "response.completed") {
                        const response = Value.Parse(tierResponseSchema, event.response);
                        completed.push({
                            model: response.model,
                            serviceTier: response.service_tier ?? null,
                        });
                    }
                    yield event;
                }
            });
        try {
            const instructions =
                "Call report_marker as requested, then reply with its returned marker.";
            const messages: SessionMessage[] = [
                {
                    role: "user",
                    content: [
                        {
                            type: "text",
                            text: "Call report_marker with marker ULTRAFAST_TOOL_OK. After the tool responds, reply exactly ULTRAFAST_TOOL_OK.",
                        },
                    ],
                },
            ];
            const ctx = testContextWith(AbortSignal.timeout(60_000));
            const first = await collectSessionEvents(
                session.run(ctx, {
                    context: { instructions, messages },
                    effort: "low",
                    serviceTier: "ultrafast",
                }),
            );
            expect(first.at(-1)).toMatchObject({ type: "done", state: "tool_call" });
            const assistant = assistantMessageFromEvents(first);
            const tool = assistant?.content.find((block) => block.type === "tool_call");
            if (assistant === undefined || tool === undefined || tool.type !== "tool_call")
                throw new Error("Expected the requested tool call.");
            expect(tool.name).toBe("report_marker");
            const args = Value.Parse(markerSchema, JSON.parse(tool.arguments));
            messages.push(assistant, {
                role: "tool",
                callId: tool.callId,
                content: [{ type: "text", text: args.marker }],
            });
            const final = await collectSessionEvents(
                session.run(ctx, {
                    context: { instructions, messages },
                    effort: "low",
                    serviceTier: "ultrafast",
                }),
            );
            expect(final.at(-1)).toMatchObject({ type: "done", state: "normal" });
            expect(textFromSessionEvents(final)).toContain("ULTRAFAST_TOOL_OK");
            console.log(
                JSON.stringify({
                    accountVerified: Boolean(process.env.RIG_LIVE_ACCOUNT_EMAIL),
                    transport: "websocket",
                    requestedTier: "ultrafast",
                    completed,
                    toolRoundTrip: "passed",
                }),
            );
        } finally {
            await session.destroy();
            observer.mockRestore();
        }
    }, 75_000);

    it.each(["sse", "websocket"] as const)(
        "completes with Ultrafast requested over %s (reports response tier separately)",
        async (transport) => {
            const credential = await CodexSessionCredential.tryLoad();
            if (credential === null) {
                expect.fail("RIG_LIVE_TEST=1 requires a local Codex session credential.");
            }
            await assertLiveCodexAccount(credential);
            const requested: unknown[] = [];
            const completed: unknown[] = [];
            // Observe the real transport without replacing network traffic or publishing raw
            // payloads, credentials, account identifiers, or encrypted reasoning in test output.
            async function* observe(stream: AsyncIterable<ResponseStreamEvent>) {
                for await (const event of stream) {
                    if (event.type === "response.completed") {
                        const response = Value.Parse(tierResponseSchema, event.response);
                        completed.push({
                            model: response.model,
                            serviceTier: response.service_tier ?? null,
                        });
                    }
                    yield event;
                }
            }
            const sse = CodexSseConnection.prototype.stream;
            const websocket = CodexWebSocketConnection.prototype.stream;
            const sseSpy = vi
                .spyOn(CodexSseConnection.prototype, "stream")
                .mockImplementation(async function (this: CodexSseConnection, options) {
                    requested.push(options.request.service_tier);
                    return observe(await sse.call(this, options));
                });
            const websocketSpy = vi
                .spyOn(CodexWebSocketConnection.prototype, "stream")
                .mockImplementation(function (this: CodexWebSocketConnection, options) {
                    requested.push(options.request.service_tier);
                    return observe(websocket.call(this, options));
                });
            const session = await new CodexProvider({
                credential,
                model: "gpt-6-astra",
                transport,
                inferenceMaxRetries: 0,
            }).session(`astra-ultrafast-${transport}-${Date.now()}`, {
                instructions: "Reply concisely.",
                tools: [],
            });
            try {
                const events = await collectSessionEvents(
                    session.run(testContextWith(AbortSignal.timeout(60_000)), {
                        context: {
                            instructions: "Reply concisely.",
                            messages: [
                                {
                                    role: "user",
                                    content: [
                                        { type: "text", text: "Reply exactly: ULTRAFAST_OK" },
                                    ],
                                },
                            ],
                        },
                        effort: "low",
                        serviceTier: "ultrafast",
                    }),
                );
                const last = events.at(-1);
                console.log(
                    JSON.stringify({
                        accountVerified: Boolean(process.env.RIG_LIVE_ACCOUNT_EMAIL),
                        transport,
                        requested,
                        completed,
                        completion: last?.type === "done" ? last.state : "missing",
                    }),
                );
                expect(events.at(-1)).toMatchObject({ type: "done", state: "normal" });
                expect(textFromSessionEvents(events)).toContain("ULTRAFAST_OK");
                expect(requested).toEqual(["ultrafast"]);
                // ChatGPT's server-side routing can report "default" even for an honored
                // speed hint. Response metadata is diagnostic, not proof of served latency.
                expect(completed).toEqual([
                    {
                        model: expect.stringContaining("gpt-6-astra"),
                        serviceTier: expect.anything(),
                    },
                ]);
            } finally {
                await session.destroy();
                sseSpy.mockRestore();
                websocketSpy.mockRestore();
            }
        },
        75_000,
    );
});
