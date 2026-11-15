import { describe, expect, it } from "vitest";
import { acpTranscriptFingerprint } from "@/protocol/acp/impl/acpSessionStore.js";
import { claudeNativeCompactionContext } from "@/vendors/claudeAgent/impl/claudeNativeCompactionContext.js";
import type { ClaudeNativeCompaction } from "@/vendors/claudeAgent/impl/readClaudeNativeCompaction.js";
import { acpReplayPrompt } from "@/protocol/acp/impl/acpPromptFromMessages.js";
import { SessionAssistantMessageAccumulator } from "@/core/SessionAssistantMessageAccumulator.js";

const native = (uuid: string, type: "user" | "assistant", content: unknown) => ({
    uuid,
    type,
    session_id: "session",
    message: { role: type, content },
    parent_tool_use_id: null,
    parent_agent_id: null,
});
const snapshot = (): ClaudeNativeCompaction => ({
    boundaryId: "boundary",
    summaryId: "summary",
    summary: "exact native summary\n",
    preTokens: 700000,
    messages: [
        native("summary", "user", "exact native summary\n"),
        native("assistant", "assistant", [
            {
                type: "thinking",
                thinking: "retained reasoning",
                signature: "signature",
            },
            {
                type: "tool_use",
                id: "call",
                name: "Read",
                input: { file_path: "path" },
            },
        ]),
        native("result", "user", [
            { type: "tool_result", tool_use_id: "call", content: "exact result\n" },
            { type: "text", text: "keep me" },
        ]),
    ],
});

describe("native ACP compaction", () => {
    it("preserves native summary, signed reasoning and settled tool tail without inventing another summary", () => {
        const source = snapshot();
        const checkpoint = claudeNativeCompactionContext(source);
        expect(checkpoint.compaction.content).toBe(source.summary);
        expect(checkpoint.compaction.vendor.messages).toEqual(source.messages);
        expect(checkpoint.preservedMessages).toMatchObject([
            {
                role: "assistant",
                content: [
                    {
                        type: "reasoning",
                        text: "retained reasoning",
                        reasoning: "signature",
                    },
                    {
                        type: "tool_call",
                        callId: "call",
                        name: "Read",
                        arguments: '{"file_path":"path"}',
                        server: true,
                    },
                ],
            },
            {
                role: "tool",
                callId: "call",
                content: [{ type: "text", text: "exact result\n" }],
            },
            { role: "user", content: [{ type: "text", text: "keep me" }] },
        ]);
        expect(source).toEqual(snapshot());
    });
    it("keeps a native preserved prefix before its summary", () => {
        const source = snapshot();
        const prefix = native("prefix", "user", "keep before summary");
        const checkpoint = claudeNativeCompactionContext({
            ...source,
            messages: [prefix, ...source.messages],
        });
        expect(checkpoint.messages[0]).toEqual({
            role: "user",
            content: [{ type: "text", text: "keep before summary" }],
        });
        expect(checkpoint.messages[1]).toEqual(checkpoint.compaction);
        expect(checkpoint.messages.slice(2)).toEqual(checkpoint.preservedMessages.slice(1));
    });

    it("refuses a malformed native block rather than silently dropping it", () => {
        const source = snapshot();
        expect(() =>
            claudeNativeCompactionContext({
                ...source,
                messages: [...source.messages, native("unsupported", "user", [{ source: {} }])],
            }),
        ).toThrow("cannot be replayed faithfully");
    });
    it("retains ToolSearch references, native search results and document citations in opaque state and portable handoff", () => {
        const source = snapshot();
        const reference = {
            type: "tool_reference",
            tool_name: "mcp__happy__search_tools",
        };
        const document = {
            type: "document",
            title: "Guide",
            source: {
                type: "text",
                media_type: "text/plain",
                data: "Important source text",
            },
        };
        const search = {
            type: "search_result",
            title: "Reference",
            source: "https://example.com/reference",
            content: [{ type: "text", text: "Verified detail" }],
        };
        const result = {
            type: "tool_result",
            tool_use_id: "mixed-call",
            content: [reference, document, search],
        };
        const serverResult = {
            type: "tool_search_tool_result",
            tool_use_id: "search-call",
            content: [reference],
        };
        const messages = [
            ...source.messages,
            native("search-call", "assistant", [
                {
                    type: "server_tool_use",
                    id: "search-call",
                    name: "tool_search_tool_regex",
                    input: { pattern: "tools" },
                },
                serverResult,
                {
                    type: "tool_use",
                    id: "mixed-call",
                    name: "Read",
                    input: { file_path: "Guide.pdf" },
                },
            ]),
            native("mixed-result", "user", [result]),
        ];
        const converted = claudeNativeCompactionContext({ ...source, messages });
        expect(converted.compaction.vendor.messages).toEqual(messages);
        const toolMessage = converted.preservedMessages.at(-1);
        expect(toolMessage).toMatchObject({
            role: "tool",
            callId: "mixed-call",
            vendor: { native: result },
        });
        const replay = JSON.stringify(acpReplayPrompt("", converted.messages, [], false));
        for (const text of [
            "mcp__happy__search_tools",
            "Important source text",
            "https://example.com/reference",
            "Verified detail",
        ])
            expect(replay).toContain(text);
        expect(converted.preservedMessages.at(-2)).toMatchObject({
            role: "assistant",
            content: [
                { type: "tool_call", callId: "search-call" },
                {
                    type: "tool_result",
                    callId: "search-call",
                    vendor: { native: serverResult },
                },
                { type: "tool_call", callId: "mixed-call" },
            ],
        });
    });
    it("keeps binary documents opaque without inflating their base64 into replay text", () => {
        const source = snapshot();
        const data = "SECRETBINARY".repeat(100_000);
        const document = {
            type: "document",
            title: "Attachment.pdf",
            source: { type: "base64", media_type: "application/pdf", data },
        };
        const messages = [...source.messages, native("document", "user", [document])];
        const converted = claudeNativeCompactionContext({ ...source, messages });
        expect(converted.compaction.vendor.messages).toEqual(messages);
        const replay = JSON.stringify(acpReplayPrompt("", converted.messages, [], false));
        expect(replay).toContain("Attachment.pdf");
        expect(replay).toContain("Binary attachment retained in native checkpoint");
        expect(replay).not.toContain("SECRETBINARY");
        expect(replay.length).toBeLessThan(5000);
    });
    it("different summaries and opaque checkpoints cannot resume the same old account prefix", () => {
        const a = {
            role: "compaction" as const,
            content: "summary A",
            encryptedContent: null,
            vendor: { checkpoint: "a" },
        };
        const b = { ...a, content: "summary B" };
        const c = { ...a, vendor: { checkpoint: "c" } };
        expect(acpTranscriptFingerprint([a])).not.toBe(acpTranscriptFingerprint([b]));
        expect(acpTranscriptFingerprint([a])).not.toBe(acpTranscriptFingerprint([c]));
        expect(acpTranscriptFingerprint([a])).toBe(acpTranscriptFingerprint([structuredClone(a)]));
        const d = { ...a, vendor: { first: "a", second: "b" } };
        const e = { ...a, vendor: { second: "b", first: "a" } };
        expect(acpTranscriptFingerprint([d])).toBe(acpTranscriptFingerprint([e]));
    });
    it("an accumulator appends only response blocks after the adopted native checkpoint", () => {
        const acc = new SessionAssistantMessageAccumulator();
        acc.add({ type: "block_start" });
        for (const text of ["old", "new"]) {
            if (text === "new")
                acc.add({
                    type: "context_compacted",
                    checkpointId: "boundary",
                    result: {
                        status: "completed",
                        context: { instructions: "", messages: [] },
                        preservedMessages: [],
                        usage: {
                            input: 0,
                            output: 0,
                            totalTokens: 0,
                            cacheRead: 0,
                            cacheWrite: 0,
                        },
                    },
                });
            acc.add({ type: "text_start" });
            acc.add({ type: "text_delta", delta: text });
            acc.add({ type: "text_end" });
        }
        acc.add({ type: "block_stop" });
        expect(acc.message()?.content).toEqual([{ type: "text", text: "new" }]);
    });
});
