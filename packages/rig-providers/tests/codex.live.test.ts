import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";

import { CodexProvider } from "@/vendors/codex/CodexProvider.js";
import { CodexSessionCredential } from "@/vendors/codex/CodexSessionCredential.js";
import type { CodexTransport } from "@/vendors/codex/impl/codexConstants.js";
import { collectSessionEvents, textFromSessionEvents } from "./helpers/collectSessionEvents.js";

const LIVE = process.env.RIG_LIVE_TEST === "1";
const describeLive = LIVE ? describe : describe.skip;
const model = "gpt-5.6-sol";

describeLive("CodexProvider live", () => {
    it.each(["websocket", "sse"] satisfies readonly CodexTransport[])(
        "emits independent tool calls in one response over %s when parallel calls are enabled",
        async (transport) => {
            const credential = await CodexSessionCredential.tryLoad();
            if (credential === null) {
                expect.fail(
                    "RIG_LIVE_TEST=1 is set but no local Codex session credential was found",
                );
            }

            const provider = new CodexProvider({
                credential,
                parallelToolCalls: true,
                transport,
            });
            const session = await provider.session(`codex-parallel-${transport}-${Date.now()}`, {
                instructions:
                    "Call every explicitly requested independent tool in the same response.",
                tools: [
                    {
                        type: "local",
                        name: "read_alpha",
                        description: "Read alpha.",
                        parameters: Type.Object({}, { additionalProperties: false }),
                    },
                    {
                        type: "local",
                        name: "read_beta",
                        description: "Read beta.",
                        parameters: Type.Object({}, { additionalProperties: false }),
                    },
                ],
            });
            try {
                const events = await collectSessionEvents(
                    session.run({
                        context: {
                            messages: [
                                {
                                    role: "user",
                                    content:
                                        "Call read_alpha and read_beta now. They are independent; call both before waiting for either result.",
                                },
                            ],
                        },
                        effort: "low",
                        model,
                    }),
                );

                expect(
                    events
                        .filter((event) => event.type === "toolcall_start")
                        .map((event) => event.name)
                        .sort(),
                ).toEqual(["read_alpha", "read_beta"]);
                expect(events).toContainEqual({ type: "done", state: "tool_call" });
            } finally {
                await session.destroy();
            }
        },
        120_000,
    );

    it.each(["websocket", "sse", "auto"] satisfies readonly CodexTransport[])(
        "streams tool-less inference over %s using the local Codex session",
        async (transport) => {
            const credential = await CodexSessionCredential.tryLoad();
            if (credential === null) {
                expect.fail(
                    "RIG_LIVE_TEST=1 is set but no local Codex session credential was found",
                );
            }

            const provider = new CodexProvider({ credential, transport });
            const session = await provider.session(`codex-${transport}-live-${Date.now()}`, {
                instructions: "You are a concise coding assistant.",
                tools: [],
            });
            try {
                const events = await collectSessionEvents(
                    session.run({
                        context: {
                            messages: [
                                {
                                    role: "user",
                                    content: `Reply with exactly: codex ${transport} live ok`,
                                },
                            ],
                        },
                        model,
                    }),
                );

                expect(events).toContainEqual({ type: "done", state: "normal" });
                expect(events.some((event) => event.type === "token_usage")).toBe(true);
                expect(textFromSessionEvents(events).toLowerCase()).toContain(
                    `codex ${transport} live ok`,
                );
            } finally {
                await session.destroy();
            }
        },
        120_000,
    );

    it.each(["websocket", "sse"] satisfies readonly CodexTransport[])(
        "runs two turns, compacts, and switches within the 5.6 family over %s",
        async (transport) => {
            const credential = await CodexSessionCredential.tryLoad();
            if (credential === null) {
                expect.fail(
                    "RIG_LIVE_TEST=1 is set but no local Codex session credential was found",
                );
            }
            const provider = new CodexProvider({ credential, transport });
            const session = await provider.session(`codex-compact-${transport}-${Date.now()}`, {
                instructions: "You are a concise coding assistant.",
                tools: [],
            });
            try {
                const firstMessages = [
                    { role: "user" as const, content: "Remember the marker ALPHA." },
                ];
                const first = await collectSessionEvents(
                    session.run({
                        context: { messages: firstMessages },
                        effort: "low",
                        model: "gpt-5.6-sol",
                    }),
                );
                const secondMessages = [
                    ...firstMessages,
                    { role: "assistant" as const, content: textFromSessionEvents(first) },
                    { role: "user" as const, content: "Remember the marker BETA." },
                ];
                const second = await collectSessionEvents(
                    session.run({
                        context: { messages: secondMessages },
                        effort: "low",
                        model: "gpt-5.6-sol",
                    }),
                );
                const compacted = await session.compact();
                expect(compacted.status).toBe("completed");
                if (compacted.status !== "completed") return;
                expect(compacted.summary).toBeUndefined();
                expect(compacted.compaction?.role).toBe("compaction");
                expect(compacted.compaction?.encryptedContent?.length).toBeGreaterThan(0);
                expect(compacted.context.messages.at(-1)).toEqual(compacted.compaction);

                const switched = await collectSessionEvents(
                    session.run({
                        context: {
                            messages: [
                                ...compacted.context.messages,
                                {
                                    role: "user",
                                    content: "Reply with exactly: compacted model switch live ok",
                                },
                            ],
                        },
                        effort: "low",
                        model: "gpt-5.6-terra",
                    }),
                );
                expect(textFromSessionEvents(second).length).toBeGreaterThan(0);
                expect(textFromSessionEvents(switched).toLowerCase()).toContain(
                    "compacted model switch live ok",
                );
            } finally {
                await session.destroy();
            }
        },
        240_000,
    );
});
