import { describe, expect, it } from "vitest";
import type { SessionMessage } from "@/core/SessionContext.js";
import { createClaudeSessionReplay } from "@/vendors/claude/impl/createClaudeSessionReplay.js";
import { claudeNativeCompactionContext } from "@/vendors/claudeAgent/impl/claudeNativeCompactionContext.js";

function checkpoint() {
    const message = (
        uuid: string,
        type: "user" | "assistant",
        content: unknown,
        metadata: Record<string, unknown> = {},
    ) => ({
        ...metadata,
        uuid,
        type,
        session_id: "old-session",
        message: { role: type, content },
        parent_tool_use_id: null,
        parent_agent_id: null,
    });
    return claudeNativeCompactionContext({
        boundaryId: "boundary",
        summaryId: "summary",
        summary: "keep the decisions and permissions",
        preTokens: 1_111_757,
        messages: [
            message("prefix", "user", "Keep this prefix exactly"),
            message("summary", "user", "keep the decisions and permissions"),
            message("call", "assistant", [
                { type: "thinking", thinking: "reasoning", signature: "signed" },
                { type: "tool_use", id: "call-id", name: "Read", input: { file_path: "work" } },
            ]),
            message(
                "result",
                "user",
                [
                    {
                        type: "tool_result",
                        tool_use_id: "call-id",
                        content: [
                            { type: "tool_reference", tool_name: "native_tool" },
                            {
                                type: "document",
                                source: {
                                    type: "base64",
                                    media_type: "application/pdf",
                                    data: "OPAQUE",
                                },
                            },
                        ],
                    },
                ],
                { sourceToolAssistantUUID: "call", isMeta: true },
            ),
            message("answer", "assistant", [{ type: "text", text: "retained answer" }]),
        ],
    });
}

function replay(messages: readonly SessionMessage[]) {
    return createClaudeSessionReplay({
        context: {
            instructions: "",
            messages: [
                ...messages,
                { role: "user", content: [{ type: "text", text: "Continue" }] },
            ],
        },
        model: "claude-sonnet-5",
        sessionId: "11111111-1111-4111-8111-111111111111",
    })
        .entries()
        .filter((entry) => entry.type === "user" || entry.type === "assistant");
}

describe("Claude checkpoint replay", () => {
    it("restores the exact native payload once, including reasoning and binary/tool references", () => {
        const source = checkpoint();
        const before = structuredClone(source.messages);
        const rows = replay(source.messages);
        expect(rows.map((row) => row.message)).toEqual(
            source.compaction.vendor.messages.map((row: any) => row.message),
        );
        expect(source.messages).toEqual(before);
        expect(new Set(rows.map((row) => row.uuid)).size).toBe(rows.length);
        const result = rows.find((row) => row.uuid === "result");
        expect(result?.sourceToolAssistantUUID).toBe("call");
        expect(rows.some((row) => row.uuid === result?.sourceToolAssistantUUID)).toBe(true);
        expect(result?.isMeta).toBe(true);
    });

    it("preserves post-checkpoint output merged into the last retained assistant message", () => {
        const source = checkpoint();
        const messages = [...structuredClone(source.messages)];
        const last = messages.at(-1)!;
        if (last.role !== "assistant") throw new Error("fixture");
        messages[messages.length - 1] = {
            ...last,
            content: [...last.content, { type: "text", text: "post-checkpoint work" }],
        };
        const rows = replay(messages);
        expect(rows.at(-1)?.message).toMatchObject({
            content: [{ type: "text", text: "post-checkpoint work" }],
        });
        expect(JSON.stringify(rows)).toContain("OPAQUE");
        expect(JSON.stringify(rows)).not.toContain("[Native tool_reference]");
    });

    it("refuses an inconsistent checkpoint projection rather than dropping work", () => {
        const source = checkpoint();
        const messages = [...structuredClone(source.messages)];
        messages.splice(0, 1);
        expect(() => replay(messages)).toThrow("checkpoint");
    });

    it("replays producer-owned native tools and results without expanding their presentation envelopes", () => {
        const call = {
            type: "mcp_tool_use",
            id: "new-call",
            name: "lookup",
            server_name: "docs",
            input: { query: "state" },
        };
        const result = {
            type: "tool_result",
            tool_use_id: "new-call",
            content: [{ type: "tool_reference", tool_name: "lookup" }],
        };
        const rows = replay([
            { role: "user", content: [{ type: "text", text: "Inspect" }] },
            {
                role: "assistant",
                content: [
                    {
                        type: "tool_call",
                        callId: call.id,
                        name: "lookup",
                        arguments: JSON.stringify(call.input),
                        vendor: { type: "claude_tool_use", native: call },
                    },
                ],
            },
            {
                role: "tool",
                callId: call.id,
                content: [{ type: "text", text: "presentation only" }],
                vendor: { type: "claude_native_tool_result", native: result },
            },
        ]);
        expect(rows[1]?.message).toMatchObject({ content: [call] });
        expect(rows[2]?.message).toMatchObject({ content: [result] });
        expect(JSON.stringify(rows)).not.toContain("presentation only");
    });
});
