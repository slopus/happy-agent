import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";

import type { SessionEvent } from "@/core/SessionEvent.js";
import type { SessionTool } from "@/core/SessionTool.js";
import { ResponsesProvider } from "@/protocol/responses/ResponsesProvider.js";
import { OPENAI_RESPONSES_CAPABILITIES } from "@/protocol/responses/ResponsesCapabilities.js";
import type { ClaudeCredential, GrokCredential } from "@/vendors/VendorCredential.js";
import { ClaudeApiKeyCredential } from "@/vendors/claude/ClaudeApiKeyCredential.js";
import { ClaudeAuthTokenCredential } from "@/vendors/claude/ClaudeAuthTokenCredential.js";
import { ClaudeCodeCredential } from "@/vendors/claude/ClaudeCodeCredential.js";
import { ClaudeOAuthCredential } from "@/vendors/claude/ClaudeOAuthCredential.js";
import { ClaudeSession } from "@/vendors/claude/ClaudeSession.js";
import { CodexProvider } from "@/vendors/codex/CodexProvider.js";
import { CodexSessionCredential } from "@/vendors/codex/CodexSessionCredential.js";
import { tool_search as codexToolSearch } from "@/vendors/codex/tools/tool_search.js";
import { GrokApiKeyCredential } from "@/vendors/grok/GrokApiKeyCredential.js";
import { GrokProvider } from "@/vendors/grok/GrokProvider.js";
import { GrokSessionCredential } from "@/vendors/grok/GrokSessionCredential.js";
import { collectSessionEvents } from "./helpers/collectSessionEvents.js";
import { testContext } from "./testContext.js";

const LIVE = process.env.RIG_LIVE_TEST === "1";
const deferredForecast = {
    name: "rare_forecast",
    description: "Read the current weather forecast for a city.",
    searchKeywords: ["weather", "meteorology", "temperature"],
    parameters: Type.Object({ city: Type.String() }, { additionalProperties: false }),
    defer: true,
} as const satisfies SessionTool;

async function resolveClaudeCredential(): Promise<ClaudeCredential | null> {
    return (
        (await ClaudeCodeCredential.tryLoad({ env: process.env })) ??
        (await ClaudeOAuthCredential.tryLoad({ env: process.env })) ??
        (await ClaudeAuthTokenCredential.tryLoad({ env: process.env })) ??
        (await ClaudeApiKeyCredential.tryLoad({ env: process.env }))
    );
}

async function resolveGrokCredential(): Promise<GrokCredential | null> {
    return (await GrokSessionCredential.tryLoad()) ?? (await GrokApiKeyCredential.tryLoad());
}

function toolStarts(events: readonly SessionEvent[]) {
    return events.filter(
        (event): event is Extract<SessionEvent, { type: "toolcall_start" }> =>
            event.type === "toolcall_start",
    );
}

describe.skipIf(!LIVE)("Tool search live", () => {
    it("Codex settles client BM25 search as server work and exposes the matched tool", async () => {
        const credential = await CodexSessionCredential.tryLoad();
        if (credential === null) expect.fail("No local Codex session credential was found.");
        const provider = new CodexProvider({ credential, transport: "sse" });
        const session = await provider.session(`codex-tool-search-${Date.now()}`, {
            instructions:
                "Use tool discovery before calling a deferred tool. Follow the user's requested tool call exactly.",
            tools: [deferredForecast, codexToolSearch],
        });
        try {
            const events = await collectSessionEvents(
                session.run(testContext, {
                    context: {
                        instructions: "",
                        messages: [
                            {
                                role: "user",
                                content: [
                                    {
                                        type: "text",
                                        text: "Find the weather tool, then call it exactly once for Reykjavik. Do not answer without calling it.",
                                    },
                                ],
                            },
                        ],
                    },
                    effort: "low",
                    model: "gpt-5.6-sol",
                }),
            );
            expect(toolStarts(events)).toContainEqual(
                expect.objectContaining({ name: "tool_search", server: true }),
            );
            expect(events).toContainEqual(
                expect.objectContaining({ type: "toolcall_result_end", content: [] }),
            );
            expect(toolStarts(events)).toContainEqual(
                expect.objectContaining({ name: "rare_forecast" }),
            );
            expect(events.at(-1)).toMatchObject({ type: "done", state: "tool_call" });
        } finally {
            await session.destroy();
        }
    }, 180_000);

    it("Claude owns ToolSearch and leaves only the matched MCP call for the client", async () => {
        const credential = await resolveClaudeCredential();
        if (credential === null) expect.fail("No Claude credential was found.");
        const session = new ClaudeSession(`claude-tool-search-${Date.now()}`, {
            instructions:
                "Use ToolSearch before calling a deferred tool. Follow the user's requested tool call exactly.",
            credential,
            model: "sonnet[1m]",
            tools: [deferredForecast, { name: "ToolSearch", server: { type: "ToolSearch" } }],
        });
        try {
            const events = await collectSessionEvents(
                session.run(testContext, {
                    context: {
                        instructions: "",
                        messages: [
                            {
                                role: "user",
                                content: [
                                    {
                                        type: "text",
                                        text: "Find the weather tool, then call it exactly once for Reykjavik. Do not answer without calling it.",
                                    },
                                ],
                            },
                        ],
                    },
                }),
            );
            expect(toolStarts(events)).toContainEqual(
                expect.objectContaining({ name: "ToolSearch", server: true }),
            );
            expect(toolStarts(events)).toContainEqual(
                expect.objectContaining({ name: "rare_forecast" }),
            );
            expect(events.at(-1)).toMatchObject({ type: "done", state: "tool_call" });
        } finally {
            session.destroy();
        }
    }, 180_000);

    it("Grok eagerly receives deferred tools and omits unsupported tool search", async () => {
        const credential = await resolveGrokCredential();
        if (credential === null) expect.fail("No Grok credential was found.");
        const provider = new GrokProvider({ credential, model: "grok-4.5" });
        const session = await provider.session(`grok-tool-search-fallback-${Date.now()}`, {
            instructions: "Follow the user's requested tool call exactly.",
            tools: [deferredForecast, { name: "tool_search", server: { type: "tool_search" } }],
        });
        try {
            const events = await collectSessionEvents(
                session.run(testContext, {
                    context: {
                        instructions: "",
                        messages: [
                            {
                                role: "user",
                                content: [
                                    {
                                        type: "text",
                                        text: "Call rare_forecast exactly once for Reykjavik. Do not answer without calling it.",
                                    },
                                ],
                            },
                        ],
                    },
                    effort: "low",
                }),
            );
            expect(toolStarts(events)).not.toContainEqual(
                expect.objectContaining({ name: "tool_search" }),
            );
            expect(toolStarts(events)).toContainEqual(
                expect.objectContaining({ name: "rare_forecast" }),
            );
            expect(events.at(-1)).toMatchObject({ type: "done", state: "tool_call" });
        } finally {
            session.destroy();
        }
    }, 180_000);

    it("generic Responses eagerly sends deferred tools when no search descriptor is supplied", async () => {
        const apiKey = process.env.OPENROUTER_API_KEY;
        if (apiKey === undefined) expect.fail("OPENROUTER_API_KEY is missing.");
        const provider = new ResponsesProvider({
            apiKey,
            endpoint: "https://openrouter.ai/api/v1",
            model: "moonshotai/kimi-k3",
            nativeCompaction: false,
            capabilities: OPENAI_RESPONSES_CAPABILITIES,
            headers: {
                "HTTP-Referer": "https://github.com/slopus/rig",
                "X-OpenRouter-Title": "Rig tool search fallback verification",
            },
        });
        const session = await provider.session(`responses-tool-search-fallback-${Date.now()}`, {
            instructions: "Follow the user's requested tool call exactly.",
            tools: [deferredForecast],
        });
        try {
            const events = await collectSessionEvents(
                session.run(testContext, {
                    context: {
                        instructions: "",
                        messages: [
                            {
                                role: "user",
                                content: [
                                    {
                                        type: "text",
                                        text: "Call rare_forecast exactly once for Reykjavik. Do not answer without calling it.",
                                    },
                                ],
                            },
                        ],
                    },
                    effort: "off",
                }),
            );
            expect(toolStarts(events)).toContainEqual(
                expect.objectContaining({ name: "rare_forecast" }),
            );
            expect(events.at(-1)).toMatchObject({ type: "done", state: "tool_call" });
        } finally {
            await session.destroy();
        }
    }, 180_000);
});
