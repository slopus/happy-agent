import { testContext } from "./testContext.js";

import { describe, expect, it } from "vitest";
import { Type } from "@sinclair/typebox";

import type { SessionEvent } from "@/core/SessionEvent.js";
import { assistantMessageFromEvents } from "@/core/SessionAssistantMessageAccumulator.js";
import type { SessionTool } from "@/core/SessionTool.js";
import type { GrokCredential } from "@/vendors/VendorCredential.js";
import { GrokApiKeyCredential } from "@/vendors/grok/GrokApiKeyCredential.js";
import { GrokProvider } from "@/vendors/grok/GrokProvider.js";
import { GrokSessionCredential } from "@/vendors/grok/GrokSessionCredential.js";
import { grok_server_tools } from "@/vendors/grok/tools/index.js";
import { collectSessionEvents, textFromSessionEvents } from "./helpers/collectSessionEvents.js";

const LIVE = process.env.RIG_LIVE_TEST === "1";
const describeLive = LIVE ? describe : describe.skip;

async function resolveGrokCredential(): Promise<GrokCredential | null> {
    return (await GrokSessionCredential.tryLoad()) ?? (await GrokApiKeyCredential.tryLoad());
}

describeLive("GrokProvider live", () => {
    it("streams tool-less inference against Grok 4.6", async () => {
        const credential = await resolveGrokCredential();
        if (credential === null) {
            expect.fail("RIG_LIVE_TEST=1 is set but no grok credentials were found");
        }

        const provider = new GrokProvider({ credential });
        const session = await provider.session(`grok-live-${Date.now()}`, {
            instructions: "You are a concise assistant.",
            tools: [],
        });
        const events = await collectSessionEvents(
            session.run(testContext, {
                context: {
                    instructions: "",
                    messages: [
                        {
                            role: "user",
                            content: [
                                {
                                    type: "text" as const,
                                    text: "Reply with exactly: grok 4.6 live ok",
                                },
                            ],
                        },
                    ],
                },
                effort: "high",
                model: "grok-4.6",
            }),
        );

        const done = events.find((event) => event.type === "done" && event.state === "normal");
        const tokenUsage = events.find((event) => event.type === "token_usage");
        expect(done).toBeDefined();
        expect(tokenUsage).toBeDefined();

        const text = textFromSessionEvents(events);
        expect(text.toLowerCase()).toContain("grok 4.6 live ok");
        if (tokenUsage?.type === "token_usage") {
            expect(tokenUsage.usage.totalTokens).toBeGreaterThan(0);
        }
    }, 120_000);

    it("streams Composer 2.5 without sending a reasoning effort", async () => {
        const credential = await resolveGrokCredential();
        if (credential === null) {
            expect.fail("RIG_LIVE_TEST=1 is set but no grok credentials were found");
        }

        const provider = new GrokProvider({ credential });
        const session = await provider.session(`composer-live-${Date.now()}`, {
            instructions: "You are a concise assistant.",
            tools: [],
        });
        const events = await collectSessionEvents(
            session.run(testContext, {
                context: {
                    instructions: "",
                    messages: [
                        {
                            role: "user",
                            content: [
                                {
                                    type: "text" as const,
                                    text: "Reply with exactly: composer live ok",
                                },
                            ],
                        },
                    ],
                },
                effort: "off",
                model: "grok-composer-2.5-fast",
            }),
        );

        expect(events.at(-1)).toMatchObject({ type: "done", state: "normal" });
        expect(textFromSessionEvents(events).toLowerCase()).toContain("composer live ok");
    }, 120_000);

    it("continues after an encrypted-reasoning tool call", async () => {
        const credential = await resolveGrokCredential();
        if (credential === null) {
            expect.fail("RIG_LIVE_TEST=1 is set but no grok credentials were found");
        }
        const probe = {
            name: "live_probe",
            description: "Returns the supplied value.",
            parameters: Type.Object({
                value: Type.String({ description: "Value to return." }),
            }),
        } as const satisfies SessionTool;
        const provider = new GrokProvider({ credential, model: "grok-4.5" });
        const session = await provider.session(`grok-tool-live-${Date.now()}`, {
            instructions: "Follow the user's tool instructions exactly.",
            tools: [probe],
        });
        const user = {
            role: "user" as const,
            content: [
                {
                    type: "text" as const,
                    text: 'Call live_probe exactly once with value "tool path ok". Do not answer yet.',
                },
            ],
        };
        const first = await collectSessionEvents(
            session.run(testContext, {
                context: { instructions: "", messages: [user] },
                effort: "low",
            }),
        );
        expect(first.at(-1)).toMatchObject({ type: "done", state: "tool_call" });
        const assistant = assistantMessageFromEvents(first);
        if (assistant === undefined) expect.fail("Missing assistant tool-call message.");
        const call = assistant.content.find((block) => block.type === "tool_call");
        if (call?.type !== "tool_call") expect.fail("Missing live_probe tool call.");
        expect(JSON.parse(call.arguments)).toEqual({ value: "tool path ok" });
        expect(
            assistant.content.some(
                (block) => block.type === "reasoning" && block.reasoning !== undefined,
            ),
        ).toBe(true);

        const second = await collectSessionEvents(
            session.run(testContext, {
                context: {
                    instructions: "",
                    messages: [
                        user,
                        assistant,
                        {
                            role: "tool",
                            content: [{ type: "text" as const, text: "tool path ok" }],
                            callId: call.callId,
                            ...(call.vendor === undefined ? {} : { vendor: call.vendor }),
                        },
                        {
                            role: "user",
                            content: [
                                {
                                    type: "text" as const,
                                    text: "Reply with exactly: grok tool continuation ok",
                                },
                            ],
                        },
                    ],
                },
                effort: "low",
            }),
        );
        expect(second.at(-1)).toMatchObject({ type: "done", state: "normal" });
        expect(textFromSessionEvents(second).toLowerCase()).toContain("grok tool continuation ok");
    }, 120_000);

    it("compacts with the Grok 4.5 summary contract", async () => {
        const credential = await resolveGrokCredential();
        if (credential === null) {
            expect.fail("RIG_LIVE_TEST=1 is set but no grok credentials were found");
        }
        const provider = new GrokProvider({ credential, model: "grok-4.5" });
        const session = await provider.session(`grok-compact-live-${Date.now()}`, {
            instructions: "You are a concise coding assistant.",
            tools: [],
        });
        const messages = [
            {
                role: "user" as const,
                content: [
                    {
                        type: "text" as const,
                        text: "Remember that the verification command is pnpm test.",
                    },
                ],
            },
        ];
        await collectSessionEvents(
            session.run(testContext, {
                context: {
                    instructions: "You are a concise coding assistant.",
                    messages,
                },
                effort: "low",
            }),
        );
        const compacted = await session.compact(testContext, {
            context: {
                instructions: "You are a concise coding assistant.",
                messages,
            },
        });
        if (compacted.status !== "completed") {
            expect.fail(`Live compaction failed: ${JSON.stringify(compacted)}`);
        }
        expect(compacted.summary).toContain("pnpm test");
        if (compacted.encryptedReasoning !== undefined) {
            expect(JSON.parse(compacted.encryptedReasoning)).toMatchObject({ type: "reasoning" });
        }
        expect(compacted.preservedMessages).toEqual([
            {
                role: "user",
                content:
                    "<user_query>\nRemember that the verification command is pnpm test.\n" +
                    "</user_query>",
            },
        ]);
        expect(compacted.usage?.totalTokens).toBeGreaterThan(0);
        expect(compacted.context.messages).toHaveLength(2);
        const continuation = compacted.context.messages[1];
        expect(continuation?.role).toBe("user");
        if (continuation?.role !== "user") throw new Error("Expected a user continuation.");
        expect(continuation.content).toContain("This session is being continued");
        expect(continuation.content).toContain("pnpm test");
    }, 120_000);
    it("answers from X search that Grok runs on its own backend", async () => {
        const credential = await resolveGrokCredential();
        if (credential === null) {
            expect.fail("RIG_LIVE_TEST=1 is set but no grok credentials were found");
        }

        const provider = new GrokProvider({ credential });
        const session = await provider.session(`grok-x-search-live-${Date.now()}`, {
            instructions: "You are a concise assistant.",
            tools: grok_server_tools,
        });
        const events = await collectSessionEvents(
            session.run(testContext, {
                context: {
                    instructions: "",
                    messages: [
                        {
                            role: "user",
                            content: [
                                {
                                    type: "text" as const,
                                    text: "<user_query>Search X for recent posts about Claude Code and reply with one post URL.</user_query>",
                                },
                            ],
                        },
                    ],
                },
                model: "grok-4.5",
                effort: "low",
            }),
        );

        const searches = events.filter(
            (
                event,
            ): event is Extract<SessionEvent, { type: "toolcall_start" }> & { server: true } =>
                event.type === "toolcall_start" && event.server === true,
        );
        expect(searches.length).toBeGreaterThan(0);
        expect(searches.every((event) => event.name.startsWith("x_"))).toBe(true);
        // Every call in this run is the server's own; nothing was left for the client to start.
        expect(
            events.filter((event) => event.type === "toolcall_start" && event.server !== true),
        ).toEqual([]);
        expect(events.at(-1)).toMatchObject({ type: "done", state: "normal" });
        expect(textFromSessionEvents(events)).toContain("x.com/");
    }, 180_000);
});
