import { describe, expect, it } from "vitest";

import type { SessionContext } from "@/core/SessionContext.js";
import { createClaudeSessionReplay } from "@/vendors/claude/impl/createClaudeSessionReplay.js";

describe("Claude session replay reasoning", () => {
    it("replays inline provider-owned results between assistant segments", () => {
        const replay = createClaudeSessionReplay({
            context: context([
                {
                    role: "user",
                    content: [{ type: "text" as const, text: "Find a tool." }],
                },
                {
                    role: "assistant",
                    content: [
                        {
                            type: "tool_call",
                            callId: "base-call",
                            name: "DiscoverTools",
                            namespace: "search",
                            arguments: '{"query":"weather"}',
                            server: true,
                            vendor: { type: "claude_tool_use", wireName: "ToolSearch" },
                        },
                        {
                            type: "tool_result",
                            callId: "base-call",
                            content: [{ type: "text", text: "matched RareTool" }],
                            vendor: {
                                outputBlock: JSON.stringify({
                                    type: "tool_result",
                                    tool_use_id: "provider-call",
                                    content: "matched RareTool",
                                }),
                            },
                        },
                        { type: "text", text: "Found it." },
                    ],
                },
                {
                    role: "user",
                    content: [{ type: "text" as const, text: "Continue." }],
                },
            ]),
            model: "claude-opus-4-8",
            sessionId: "replay-session",
        });
        const entries = replay.entries();

        expect(entries.map((entry) => entry.type)).toEqual([
            "user",
            "assistant",
            "user",
            "assistant",
        ]);
        expect(entries[1]?.message).toMatchObject({
            role: "assistant",
            content: [
                {
                    type: "tool_use",
                    id: "base-call",
                    name: "ToolSearch",
                    input: { query: "weather" },
                },
            ],
        });
        expect(entries[2]?.message).toEqual({
            role: "user",
            content: [
                {
                    type: "tool_result",
                    tool_use_id: "base-call",
                    content: "matched RareTool",
                },
            ],
        });
        expect(entries[3]?.message).toMatchObject({
            role: "assistant",
            content: [{ type: "text", text: "Found it." }],
        });
    });

    it("replays the thinking a turn was signed with", () => {
        const replay = createClaudeSessionReplay({
            context: context([
                {
                    role: "user",
                    content: [{ type: "text" as const, text: "Refactor the parser." }],
                },
                {
                    role: "assistant",
                    content: [
                        {
                            type: "reasoning",
                            text: "The parser entry point is misnamed.",
                            reasoning: "sig-1",
                        },
                        { type: "text", text: "Renamed the entry point." },
                    ],
                },
                {
                    role: "user",
                    content: [{ type: "text" as const, text: "Now update the tests." }],
                },
            ]),
            model: "claude-opus-4-8",
            sessionId: "replay-session",
        });

        const content = assistantContent(replay);

        expect(content[0]).toEqual({
            type: "thinking",
            thinking: "The parser entry point is misnamed.",
            signature: "sig-1",
        });
        expect(content[1]).toEqual({ type: "text", text: "Renamed the entry point." });
    });

    it("keeps every thinking block in the order the turn produced them", () => {
        const replay = createClaudeSessionReplay({
            context: context([
                {
                    role: "user",
                    content: [{ type: "text" as const, text: "Ship it." }],
                },
                {
                    role: "assistant",
                    content: [
                        {
                            type: "reasoning",
                            text: "First consider the failure.",
                            reasoning: "sig-1",
                        },
                        {
                            type: "reasoning",
                            text: "Then confirm the fix.",
                            reasoning: "sig-2",
                        },
                        { type: "text", text: "Done." },
                    ],
                },
                {
                    role: "user",
                    content: [{ type: "text" as const, text: "Thanks." }],
                },
            ]),
            model: "claude-opus-4-8",
            sessionId: "replay-session",
        });

        const content = assistantContent(replay) as Array<{ signature?: string }>;

        expect(content.slice(0, 2).map((block) => block.signature)).toEqual(["sig-1", "sig-2"]);
    });

    it("replays redacted thinking as the opaque block Anthropic returned", () => {
        const replay = createClaudeSessionReplay({
            context: context([
                {
                    role: "user",
                    content: [{ type: "text" as const, text: "Ship it." }],
                },
                {
                    role: "assistant",
                    content: [
                        { type: "reasoning", reasoning: "opaque-payload" },
                        { type: "text", text: "Done." },
                    ],
                },
                {
                    role: "user",
                    content: [{ type: "text" as const, text: "Thanks." }],
                },
            ]),
            model: "claude-opus-4-8",
            sessionId: "replay-session",
        });

        const content = assistantContent(replay);

        expect(content[0]).toEqual({ type: "redacted_thinking", data: "opaque-payload" });
    });

    it("leaves a turn that never reasoned untouched", () => {
        const replay = createClaudeSessionReplay({
            context: context([
                {
                    role: "user",
                    content: [{ type: "text" as const, text: "Ship it." }],
                },
                {
                    role: "assistant",
                    content: [{ type: "text" as const, text: "Done." }],
                },
                {
                    role: "user",
                    content: [{ type: "text" as const, text: "Thanks." }],
                },
            ]),
            model: "claude-opus-4-8",
            sessionId: "replay-session",
        });

        const content = assistantContent(replay);

        expect(content).toEqual([{ type: "text", text: "Done." }]);
    });

    it("does not leave an orphaned parent when an empty assistant turn has no transcript block", () => {
        const replay = createClaudeSessionReplay({
            context: context([
                {
                    role: "user",
                    content: [{ type: "text" as const, text: "First." }],
                },
                {
                    role: "assistant",
                    content: [],
                },
                {
                    role: "user",
                    content: [{ type: "text" as const, text: "Second." }],
                },
                {
                    role: "user",
                    content: [{ type: "text" as const, text: "Third." }],
                },
            ]),
            model: "claude-opus-4-8",
            sessionId: "replay-session",
        });
        const entries = replay.entries();

        expect(entries).toHaveLength(2);
        expect(entries[1]?.parentUuid).toBe(entries[0]?.uuid);
    });

    it("projects unsigned reasoning only at the Claude request boundary", () => {
        const source = context([
            {
                role: "user",
                content: [{ type: "text" as const, text: "Ship it." }],
            },
            {
                role: "assistant",
                content: [
                    { type: "text" as const, text: "Done." },
                    { type: "reasoning", text: "Reasoning from a different provider." },
                ],
            },
            {
                role: "user",
                content: [{ type: "text" as const, text: "Thanks." }],
            },
        ]);
        const original = structuredClone(source);
        const replay = createClaudeSessionReplay({
            context: source,
            model: "claude-opus-4-8",
            sessionId: "replay-session",
        });

        expect(assistantContent(replay)).toEqual([{ type: "text", text: "Done." }]);
        expect(source).toEqual(original);
    });

    it("ignores transcript entries Claude tries to mirror back", async () => {
        const replay = createClaudeSessionReplay({
            context: context([
                {
                    role: "user",
                    content: [{ type: "text" as const, text: "First." }],
                },
                {
                    role: "assistant",
                    content: [{ type: "text" as const, text: "Done." }],
                },
                {
                    role: "user",
                    content: [{ type: "text" as const, text: "Second." }],
                },
            ]),
            model: "claude-opus-4-8",
            sessionId: "replay-session",
        });
        const original = structuredClone(replay.entries());
        const store = replay.options.sessionStore;
        if (store === undefined) throw new Error("Expected a Claude session store.");
        const key = { projectKey: "workspace", sessionId: "replay-session" };

        await store.append(key, [
            {
                type: "assistant",
                uuid: "claude-owned-entry",
                message: { role: "assistant", content: [{ type: "text", text: "Ignore me." }] },
            },
        ]);

        await expect(store.load(key)).resolves.toEqual(original);
        expect(replay.entries()).toEqual(original);
    });
});

function context(messages: SessionContext["messages"]): SessionContext {
    return { instructions: "", messages };
}

function assistantContent(
    replay: ReturnType<typeof createClaudeSessionReplay>,
): readonly unknown[] {
    return replay
        .entries()
        .filter((entry) => entry.type === "assistant")
        .flatMap((entry) => {
            const message = entry.message as { content?: unknown } | undefined;
            return Array.isArray(message?.content) ? message.content : [];
        });
}
