import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it, vi } from "vitest";

import { ClaudeAuthTokenCredential } from "@/vendors/claude/ClaudeAuthTokenCredential.js";
import { ClaudeSession, type ClaudeSdkQuery } from "@/vendors/claude/ClaudeSession.js";
import { testContext } from "./testContext.js";

const context = {
    instructions: "",
    messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "Continue." }] }],
};

describe("Claude context overflow", () => {
    it("explicitly selects Fable 5.1's million-token SDK context", async () => {
        const query = vi.fn<ClaudeSdkQuery>(() => resultQuery("Ready.", false));
        const session = await createSession(query);
        try {
            for await (const _event of session.run(testContext, { context })) {
                // Inspect the actual options passed to the SDK, not a parallel model catalog.
            }
            expect(query.mock.calls[0]?.[0].options?.model).toBe("claude-fable-5-1[1m]");
        } finally {
            session.destroy();
        }
    });

    it.each([
        ["Prompt is too long", "context_overflow"],
        ["prompt is too long: 235171 tokens > 200000 maximum", "context_overflow"],
        ["Input is too long for requested model", "context_overflow"],
        ["Credit balance is too low", "billing_error"],
        ["Claude returned an unsuccessful result.", "unknown"],
    ])("reports %s only as a terminal error", async (message, kind) => {
        const query = vi.fn<ClaudeSdkQuery>(() => resultQuery(message, true));
        const session = await createSession(query);
        try {
            const events = [];
            for await (const event of session.run(testContext, { context })) events.push(event);

            // Completed text is persisted immediately by callers; a later block_reset cannot
            // undo it. SDK result errors must never be emitted as assistant text in the first place.
            expect(events.filter((event) => event.type.startsWith("text_"))).toEqual([]);
            expect(events.filter((event) => event.type === "done")).toEqual([
                expect.objectContaining({ type: "done", state: "error", kind, message }),
            ]);
            expect(query).toHaveBeenCalledOnce();
        } finally {
            session.destroy();
        }
    });

    it("keeps ordinary result-only answers, even when they discuss prompt overflow", async () => {
        const text = "Prompt is too long is the error we should investigate.";
        const session = await createSession(() => resultQuery(text, false));
        try {
            const events = [];
            for await (const event of session.run(testContext, { context })) events.push(event);
            expect(events).toContainEqual({ type: "text_delta", delta: text });
            expect(events.at(-1)).toMatchObject({ type: "done", state: "normal" });
        } finally {
            session.destroy();
        }
    });

    it("classifies an overflow thrown by the SDK without retrying it", async () => {
        const query = vi.fn<ClaudeSdkQuery>(() => {
            throw new Error("prompt is too long: 235171 tokens > 200000 maximum");
        });
        const session = await createSession(query);
        try {
            const events = [];
            for await (const event of session.run(testContext, { context })) events.push(event);
            expect(events.at(-1)).toMatchObject({
                type: "done",
                state: "error",
                kind: "context_overflow",
            });
            expect(query).toHaveBeenCalledOnce();
        } finally {
            session.destroy();
        }
    });
});

async function createSession(query: ClaudeSdkQuery): Promise<ClaudeSession> {
    const credential = await ClaudeAuthTokenCredential.tryLoad({ authToken: "test-only-token" });
    if (credential === null) throw new Error("Expected a test credential.");
    return new ClaudeSession("claude-context-overflow", {
        credential,
        instructions: "",
        model: "anthropic/fable-5-1",
        query,
        tools: [],
    });
}

function resultQuery(text: string, isError: boolean): ReturnType<ClaudeSdkQuery> {
    async function* messages() {
        yield {
            type: "result",
            subtype: "success",
            is_error: isError,
            result: text,
            duration_ms: 1,
            duration_api_ms: 1,
            num_turns: 1,
            stop_reason: "end_turn",
            total_cost_usd: 0,
            usage: {
                input_tokens: 1,
                output_tokens: isError ? 0 : 1,
                output_tokens_details: { thinking_tokens: 0 },
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
                cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
                server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
                service_tier: "standard",
                inference_geo: "not_available",
                iterations: [],
                speed: "standard",
            },
            modelUsage: {},
            permission_denials: [],
            uuid: "00000000-0000-4000-8000-000000000001",
            session_id: "00000000-0000-4000-8000-000000000002",
        } satisfies SDKResultMessage;
    }
    return Object.assign(messages(), { close: () => {} }) as ReturnType<ClaudeSdkQuery>;
}
