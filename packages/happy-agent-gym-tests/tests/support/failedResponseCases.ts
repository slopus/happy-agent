import type { GymInferenceRequest, GymTurn } from "@slopus/happy-agent-gym";
import type { SessionEvent, SessionMessage } from "@slopus/happy-providers";

/**
 * The responses that did not complete normally, shared by the golden fixtures of what Agent Base
 * keeps of each and by the fixtures of what it has published and keeps at every point inside one.
 */
export const MODEL = {
    providerId: "claude",
    id: "anthropic/opus-5-5",
    name: "Opus 5.5",
    effortLevels: ["medium"] as const,
    defaultEffort: "medium" as const,
};
export const TOKENS = { input: 1, output: 1 };
export const READ_ARGUMENTS = '{"file_path":"README.md"}';
export const SEARCH_ARGUMENTS = '{"query":"select:Read"}';

/** The tool policies these cases touch, as Agent Base reads them from the agent's tool array. */
export const POLICIES = {
    Read: { server: false, persistInHistory: true, visibleToUser: true },
    // Claude Code's own tool search, which Base must keep out of history and out of view.
    ToolSearch: { server: true, persistInHistory: false, visibleToUser: false },
};

export interface Case {
    readonly name: string;
    readonly description: string;
    readonly turn: GymTurn;
    /** How the response ends, as Base sees it. */
    readonly stop: "error" | "normal" | "cancelled" | "eof";
    readonly abortAfterText?: string;
}

export const text = (value: string): SessionEvent[] => [
    { type: "text_start" },
    { type: "text_delta", delta: value },
    { type: "text_end" },
];
export const readCall = (callId: string, finished: boolean): SessionEvent[] => [
    { type: "toolcall_start", callId, name: "Read" },
    { type: "toolcall_delta", callId, delta: READ_ARGUMENTS },
    ...(finished
        ? [{ type: "toolcall_end", callId, arguments: READ_ARGUMENTS } as SessionEvent]
        : []),
];
export const searchCall = (callId: string): SessionEvent[] => [
    { type: "toolcall_start", callId, name: "ToolSearch", server: true },
    { type: "toolcall_delta", callId, delta: SEARCH_ARGUMENTS },
    { type: "toolcall_end", callId, arguments: SEARCH_ARGUMENTS },
];
export const failure: SessionEvent = {
    type: "done",
    state: "error",
    kind: "internal_error",
    message: "The provider connection failed.",
};

export const CASES: readonly Case[] = [
    {
        name: "text_partial_then_error",
        description: "A text block that never ends, then a provider error.",
        turn: {
            events: [{ type: "text_start" }, { type: "text_delta", delta: "Half a sen" }, failure],
        },
        stop: "error",
    },
    {
        name: "finished_call_then_error",
        description: "Finished text and a finished client tool call, then a provider error.",
        turn: { events: [...text("Reading it."), ...readCall("toolu_read_error", true), failure] },
        stop: "error",
    },
    {
        name: "server_call_without_result_then_text",
        description: "A provider-run call that exposes no result, then text, ending normally.",
        turn: {
            events: [
                ...searchCall("toolu_search_alone"),
                ...text("Found it."),
                { type: "done", state: "normal", tokens: TOKENS },
            ],
        },
        stop: "normal",
    },
    {
        name: "server_call_with_result",
        description: "A provider-run call with its result, then text, ending normally.",
        turn: {
            events: [
                ...searchCall("toolu_search_paired"),
                { type: "toolcall_result_start", callId: "toolu_search_paired" },
                {
                    type: "toolcall_result_end",
                    callId: "toolu_search_paired",
                    content: [{ type: "text", text: "Read is loaded." }],
                },
                ...text("Found it."),
                { type: "done", state: "normal", tokens: TOKENS },
            ],
        },
        stop: "normal",
    },
    {
        name: "block_reset_mid_call",
        description: "A call reset mid-stream by the provider, replaced by text, ending normally.",
        turn: {
            events: [
                ...text("Let me look."),
                { type: "block_start" },
                ...readCall("toolu_reset", false),
                { type: "block_reset" },
                { type: "block_start" },
                ...text("Never mind."),
                { type: "block_stop" },
                { type: "done", state: "normal", tokens: TOKENS },
            ],
        },
        stop: "normal",
    },
    {
        name: "finished_text_reset_then_retry",
        description: "A finished text block reset by the provider, retried, ending normally.",
        turn: {
            events: [
                { type: "block_start" },
                ...text("First try."),
                { type: "block_reset" },
                { type: "block_start" },
                ...text("Second try."),
                { type: "block_stop" },
                { type: "done", state: "normal", tokens: TOKENS },
            ],
        },
        stop: "normal",
    },
    {
        name: "abort_mid_text_after_reasoning",
        description: "Finished reasoning, then text cut off by an abort.",
        turn: {
            content: [
                { type: "reasoning", text: "Thinking it through." },
                { type: "text", text: "Partial answer that keeps going and going." },
            ],
            textDeltaChunkSize: 4,
            textDeltaDelayMs: 400,
        },
        stop: "cancelled",
        // The third four-character delta, so the abort lands mid-text.
        abortAfterText: "answ",
    },
    {
        name: "stream_end_without_done",
        description: "Finished text and an unfinished call, then the stream ends without done.",
        turn: { events: [...text("Reading it."), ...readCall("toolu_read_eof", false)] },
        stop: "eof",
    },
];

/** Replaces values that differ between runs; provider tool IDs are fixed and kept. */
export function normalize(messages: readonly SessionMessage[], agentId: string): unknown {
    return JSON.parse(JSON.stringify(messages).replaceAll(agentId, "{{agentId}}"));
}

export function stableJson(value: unknown): string {
    const sort = (item: unknown): unknown =>
        Array.isArray(item)
            ? item.map(sort)
            : item !== null && typeof item === "object"
              ? Object.fromEntries(
                    Object.keys(item)
                        .sort()
                        .map((key) => [key, sort((item as Record<string, unknown>)[key])]),
                )
              : item;
    return `${JSON.stringify(sort(value), null, 2)}\n`;
}

/** What Base kept of the response, read from the context of the request that followed it. */
export function keptFromNextRequest(
    first: GymInferenceRequest,
    next: GymInferenceRequest,
    agentId: string,
): Record<string, unknown> {
    const added = next.messages.slice(first.messages.length);
    const followUp = added.findIndex(
        (message) => message.role === "user" || message.role === "system",
    );
    const kept = followUp === -1 ? added : added.slice(0, followUp);
    const finished = kept.filter((message) => message.role === "assistant");
    // Base's raw failure note, kept apart so a port can compare its own wording.
    const note = followUp === -1 ? undefined : added[followUp];
    return {
        finishedMessage: finished.length === 0 ? null : normalize(finished, agentId),
        settlementMessages: normalize(
            kept.filter((message) => message.role === "tool"),
            agentId,
        ),
        keptMessages: normalize(kept, agentId),
        failureNote: note?.role === "system" ? (normalize([note], agentId) as unknown[])[0] : null,
        nextRequestMessages: normalize(next.messages, agentId),
    };
}
