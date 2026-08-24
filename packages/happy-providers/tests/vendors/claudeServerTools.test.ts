import { testContext } from "../testContext.js";

import { describe, expect, it, vi } from "vitest";

import { ClaudeAuthTokenCredential } from "@/vendors/claude/ClaudeAuthTokenCredential.js";
import { ClaudeSession, type ClaudeSdkQuery } from "@/vendors/claude/ClaudeSession.js";
import {
    toClaudeMcpToolDefinition,
    toClaudeSdkOptions,
} from "@/vendors/claude/impl/toClaudeSdkOptions.js";
import type { SessionEvent } from "@/core/SessionEvent.js";
import { collectSessionEvents, textFromSessionEvents } from "../helpers/collectSessionEvents.js";

const web_search = { name: "WebSearch", server: { type: "WebSearch" } } as const;
const tool_search = { name: "ToolSearch", server: { type: "ToolSearch" } } as const;
const read = { name: "Read" };

describe("Claude server tools", () => {
    it("names a server tool as a built-in instead of bridging it over MCP", () => {
        const options = toClaudeSdkOptions({
            context: { instructions: "", messages: [] },
            credential: { name: "claude-code", credential: undefined },
            env: {},
            model: "claude-sonnet-5",
            sessionId: "session",
            systemPrompt: "",
            tools: [read, web_search],
        });

        // Claude Code owns the built-in, so naming it here is what hands it the call.
        expect(options.tools).toEqual(["WebSearch"]);
        // The executor-owned tool keeps its MCP name; the server tool is allowed under its own.
        expect(options.allowedTools).toEqual(["mcp__rig__Read", "WebSearch"]);
    });

    it("keeps every built-in disabled when no tool is a server tool", () => {
        const options = toClaudeSdkOptions({
            context: { instructions: "", messages: [] },
            credential: { name: "claude-code", credential: undefined },
            env: {},
            model: "claude-sonnet-5",
            sessionId: "session",
            systemPrompt: "",
            tools: [read],
        });

        expect(options.tools).toEqual([]);
    });

    it("enables native ToolSearch only when its server descriptor is supplied", () => {
        const deferred = { name: "RareTool", defer: true };
        const fallback = toClaudeSdkOptions({
            context: { instructions: "", messages: [] },
            credential: { name: "claude-code", credential: undefined },
            env: {},
            model: "claude-sonnet-5",
            sessionId: "fallback-session",
            systemPrompt: "",
            tools: [read, deferred],
        });
        expect(fallback.tools).toEqual([]);
        expect(fallback.env?.ENABLE_TOOL_SEARCH).toBeUndefined();
        expect(toClaudeMcpToolDefinition(deferred)._meta).toEqual({
            "anthropic/alwaysLoad": true,
        });

        const options = toClaudeSdkOptions({
            context: { instructions: "", messages: [] },
            credential: { name: "claude-code", credential: undefined },
            env: {},
            model: "claude-sonnet-5",
            sessionId: "session",
            systemPrompt: "",
            tools: [read, deferred, tool_search],
        });

        expect(options.tools).toEqual(["ToolSearch"]);
        expect(options.allowedTools).toContain("ToolSearch");
        expect(options.env?.ENABLE_TOOL_SEARCH).toBe("true");
        expect(toClaudeMcpToolDefinition(read)._meta).toEqual({
            "anthropic/alwaysLoad": true,
        });
        expect(toClaudeMcpToolDefinition(deferred, true)).not.toHaveProperty("_meta");
    });

    it("adds custom search keywords to Claude's searchable MCP description", () => {
        expect(
            toClaudeMcpToolDefinition({
                name: "RareTool",
                description: "A specialized tool.",
                searchKeywords: ["phonograph", "vinyl"],
                defer: true,
            }).description,
        ).toBe("A specialized tool.\n\nSearch keywords: phonograph, vinyl");
    });

    it("reports a built-in Claude Code answers itself without ending the turn for the executor", async () => {
        const credential = await ClaudeAuthTokenCredential.tryLoad({ authToken: "test-token" });
        if (credential === null) throw new Error("Expected test credential.");
        const query = vi.fn<ClaudeSdkQuery>(() => serverToolQuery());
        const session = new ClaudeSession("server-tool-session", {
            instructions: "",
            credential,
            model: "sonnet[1m]",
            query,
            tools: [read, web_search],
        });

        const events = await collectSessionEvents(
            session.run(testContext, {
                context: {
                    instructions: "",
                    messages: [
                        {
                            role: "user",
                            content: [{ type: "text" as const, text: "Search." }],
                        },
                    ],
                },
            }),
        );

        expect(events).toContainEqual({
            type: "toolcall_start",
            callId: "srvtoolu_1",
            name: "WebSearch",
            server: true,
            vendor: { type: "claude_tool_use" },
        });
        expect(events).toContainEqual({
            type: "toolcall_delta",
            callId: "srvtoolu_1",
            delta: '{"query":"Rig"}',
        });
        expect(events).toContainEqual({
            type: "toolcall_end",
            callId: "srvtoolu_1",
            arguments: '{"query":"Rig"}',
        });

        // Rig never executes it and is never asked to answer it, so the call must not become
        // executor work: it is reported as an ordinary call, but every one of them here is the
        // server's own, not one Rig started or must answer.
        expect(
            events.some((event) => event.type === "toolcall_start" && event.server !== true),
        ).toBe(false);
        expect(serverToolCallIds(events).has("srvtoolu_1")).toBe(true);
        expect(
            events
                .filter((event) => event.type === "toolcall_end")
                .every((event) => serverToolCallIds(events).has(event.callId)),
        ).toBe(true);
        // `tool_call` would send the run to the executor to answer a call nothing can answer.
        expect(events.at(-1)).toMatchObject({ type: "done", state: "normal" });
        expect(textFromSessionEvents(events)).toBe("Rig is a coding agent.");
    });

    it("keeps ToolSearch inside the Claude SDK instead of handing it to Rig", async () => {
        const credential = await ClaudeAuthTokenCredential.tryLoad({ authToken: "test-token" });
        if (credential === null) throw new Error("Expected test credential.");
        const query = vi.fn<ClaudeSdkQuery>(() => serverToolQuery("ToolSearch"));
        const session = new ClaudeSession("tool-search-session", {
            instructions: "",
            credential,
            model: "sonnet[1m]",
            query,
            tools: [
                read,
                { name: "RareTool", defer: true },
                {
                    name: "DiscoverTools",
                    namespace: "search",
                    server: { type: "ToolSearch" },
                },
            ],
        });

        const events = await collectSessionEvents(
            session.run(testContext, {
                context: {
                    instructions: "",
                    messages: [
                        {
                            role: "user",
                            content: [{ type: "text" as const, text: "Find a tool." }],
                        },
                    ],
                },
            }),
        );

        expect(events).toContainEqual({
            type: "toolcall_start",
            callId: "srvtoolu_1",
            name: "DiscoverTools",
            namespace: "search",
            server: true,
            vendor: { type: "claude_tool_use", wireName: "ToolSearch" },
        });
        expect(events).toContainEqual({
            type: "toolcall_result_end",
            callId: "srvtoolu_1",
            content: [{ type: "text", text: "matched RareTool" }],
        });
        expect(events.at(-1)).toMatchObject({ type: "done", state: "normal" });
    });
});

/** Call ids of every `toolcall_start` the provider marked `server: true`. */
function serverToolCallIds(events: readonly SessionEvent[]): Set<string> {
    return new Set(
        events.flatMap((event) =>
            event.type === "toolcall_start" && event.server === true ? [event.callId] : [],
        ),
    );
}

/**
 * The SDK stream a host sees when Claude Code runs a built-in itself: the `tool_use` block
 * arrives like any other, the CLI answers it out of band, and the same query keeps generating.
 */
function serverToolQuery(name = "WebSearch"): ReturnType<ClaudeSdkQuery> {
    async function* messages() {
        yield streamEvent({
            type: "content_block_start",
            index: 0,
            content_block: { type: "tool_use", id: "srvtoolu_1", name, input: {} },
        });
        yield streamEvent({
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: '{"query":"Rig"}' },
        });
        yield streamEvent({ type: "content_block_stop", index: 0 });
        yield {
            type: "user",
            message: {
                role: "user",
                content: [
                    {
                        type: "tool_result",
                        tool_use_id: "srvtoolu_1",
                        content: "matched RareTool",
                    },
                ],
            },
            parent_tool_use_id: null,
            uuid: "server-tool-result",
            session_id: "server-tool-session",
        };
        // Claude Code can continue after a built-in in a new Anthropic message. Content indexes
        // restart for that message, so the text block may reuse the completed tool's index.
        yield streamEvent({
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
        });
        yield streamEvent({
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "Rig is a coding agent." },
        });
        yield streamEvent({ type: "content_block_stop", index: 0 });
        yield {
            type: "result",
            subtype: "success",
            duration_ms: 1,
            duration_api_ms: 1,
            is_error: false,
            num_turns: 1,
            result: "Rig is a coding agent.",
            stop_reason: "end_turn",
            session_id: "session-id",
            total_cost_usd: 0,
            usage: {
                input_tokens: 10,
                output_tokens: 2,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
            },
            modelUsage: {},
            permission_denials: [],
            uuid: "result-id",
        };
    }
    return Object.assign(messages(), {
        close: () => {},
    }) as unknown as ReturnType<ClaudeSdkQuery>;
}

function streamEvent(event: Record<string, unknown>) {
    return {
        type: "stream_event" as const,
        event,
        parent_tool_use_id: null,
        uuid: "server-tool-event",
        session_id: "server-tool-session",
    };
}
