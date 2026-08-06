import { describe, expect, it } from "vitest";

import { ChatStore } from "@/ChatStore.js";
import { describeProviderToolCall } from "@/describeProviderToolCall.js";
import type { ChatElement, ProviderToolCallElement } from "@/ChatElement.js";
import type { AgentLoopEvent, SessionEvent, SessionStreamHello } from "@/protocol.js";

let clock = 0;

function event<TType extends string>(type: TType, data: unknown): SessionEvent {
    clock += 1;
    return {
        createdAt: clock,
        data,
        id: `event-${clock}`,
        sessionId: "session-1",
        type,
    } as SessionEvent;
}

function agentEvent(inner: AgentLoopEvent): SessionEvent {
    return event("agent_event", { event: inner, runId: "run-1" });
}

function hello(): SessionStreamHello {
    return {
        activity: { kind: "idle", label: "Idle", since: 0 },
        resumed: false,
        session: {
            activity: { kind: "idle", label: "Idle", since: 0 },
            archived: false,
            cwd: "/work",
            id: "session-1",
            modelLocked: false,
            modelId: "grok-4.5",
            models: [],
            orderKey: "a0",
            pendingUserInputs: [],
            permissionMode: "auto",
            projectId: "project-1",
            providerId: "grok",
            snapshot: { messages: [] },
            status: "idle",
            tasks: [],
        },
    };
}

function startedStore(): ChatStore {
    const store = new ChatStore("session-1");
    store.apply(event("stream_hello", hello()));
    store.apply(event("run_started", { runId: "run-1" }));
    store.apply(
        agentEvent({ iteration: 0, messageId: "message-1", type: "inference_iteration_start" }),
    );
    return store;
}

function providerCalls(store: ChatStore): ProviderToolCallElement[] {
    return store
        .elements()
        .filter(
            (element: ChatElement): element is ProviderToolCallElement =>
                element.kind === "provider_tool_call",
        );
}

// A provider-run search reached every other layer and then vanished: ChatStore had no case for
// `server_toolcall_*` and swallowed it in a bare `default:`, so a connected client showed an
// answer citing X posts with no sign that any search had happened.
describe("provider-run tool calls", () => {
    it("shows an X search a connected client would otherwise never see", () => {
        const store = startedStore();

        store.apply(
            agentEvent({
                callId: "xs_call-1",
                messageId: "message-1",
                name: "x_keyword_search",
                type: "server_toolcall_start",
            }),
        );

        const running = providerCalls(store);
        expect(running).toHaveLength(1);
        expect(running[0]).toMatchObject({
            argumentsComplete: false,
            name: "x_keyword_search",
            presentation: { kind: "search", method: "keyword", target: "x" },
            providerToolCallId: "xs_call-1",
            status: "running",
        });

        store.apply(
            agentEvent({
                arguments: '{"query":"Claude Code","limit":"5"}',
                callId: "xs_call-1",
                messageId: "message-1",
                name: "x_keyword_search",
                type: "server_toolcall_end",
            }),
        );

        const finished = providerCalls(store);
        // The same row settles rather than a second one appearing beside it.
        expect(finished).toHaveLength(1);
        expect(finished[0]).toMatchObject({
            argumentsComplete: true,
            presentation: { kind: "search", method: "keyword", query: "Claude Code", target: "x" },
            status: "completed",
        });
    });

    it("reveals the query while it is still streaming, before the arguments parse", () => {
        const store = startedStore();
        store.apply(
            agentEvent({
                callId: "ws_call-1",
                messageId: "message-1",
                name: "web_search",
                type: "server_toolcall_start",
            }),
        );

        // Deliberately not valid JSON yet: this is what the user stares at while waiting.
        store.apply(
            agentEvent({
                callId: "ws_call-1",
                delta: '{"query":"Node.js current stable version"',
                messageId: "message-1",
                type: "server_toolcall_delta",
            }),
        );

        expect(providerCalls(store)[0]?.presentation).toMatchObject({
            kind: "search",
            query: "Node.js current stable version",
            target: "web",
        });
    });

    it("keeps the sources the provider reported, in its own order and without duplicates", () => {
        const store = startedStore();
        store.apply(
            agentEvent({
                arguments: JSON.stringify({
                    query: "Node.js current stable version",
                    sources: [
                        { type: "url", url: "https://nodejs.org/en" },
                        { type: "url", url: "https://en.wikipedia.org/wiki/Node.js" },
                        { type: "url", url: "https://nodejs.org/en" },
                        { type: "url", url: "not-a-url" },
                    ],
                    type: "search",
                }),
                callId: "ws_call-1",
                messageId: "message-1",
                name: "web_search",
                type: "server_toolcall_end",
            }),
        );

        const presentation = providerCalls(store)[0]?.presentation;
        expect(presentation).toMatchObject({ kind: "search", target: "web" });
        expect(presentation?.kind === "search" ? presentation.sources : []).toEqual([
            { url: "https://nodejs.org/en" },
            { url: "https://en.wikipedia.org/wiki/Node.js" },
        ]);
    });

    // Start and delta are live-only, so a reopened session receives the end on its own.
    it("builds a completed row from the end alone, as a reopened session receives it", () => {
        const store = startedStore();
        store.apply(
            agentEvent({
                arguments: '{"query":"rust async traits"}',
                callId: "ws_call-9",
                messageId: "message-1",
                name: "web_search",
                type: "server_toolcall_end",
            }),
        );

        expect(providerCalls(store)).toMatchObject([
            {
                presentation: { kind: "search", query: "rust async traits", target: "web" },
                status: "completed",
            },
        ]);
    });

    it("names a provider tool it does not recognize instead of dropping it", () => {
        const store = startedStore();
        store.apply(
            agentEvent({
                arguments: "{}",
                callId: "ci_call-1",
                messageId: "message-1",
                name: "code_interpreter",
                type: "server_toolcall_end",
            }),
        );

        expect(providerCalls(store)[0]?.presentation).toEqual({
            kind: "provider_tool",
            label: "Code interpreter",
        });
    });

    it("drops a search abandoned by a restart but keeps one that finished", () => {
        const store = startedStore();
        store.apply(
            agentEvent({
                arguments: '{"query":"kept"}',
                callId: "ws_done",
                messageId: "message-1",
                name: "web_search",
                type: "server_toolcall_end",
            }),
        );
        store.apply(
            agentEvent({
                callId: "ws_running",
                messageId: "message-1",
                name: "web_search",
                type: "server_toolcall_start",
            }),
        );
        expect(providerCalls(store)).toHaveLength(2);

        store.apply(agentEvent({ messageId: "message-1", partial: {}, type: "block_reset" }));

        // The unfinished row would otherwise spin forever; the finished one is durable evidence.
        expect(providerCalls(store)).toMatchObject([
            { providerToolCallId: "ws_done", status: "completed" },
        ]);
    });

    // Stopping the turn stops Rig reading the response. It does not stop the search: that already
    // reached the provider's backend and cannot be recalled, so the row stays and says what is
    // actually known — a search was started and its result never came back.
    it("settles a search still running when the person stopped the turn", () => {
        const store = startedStore();
        store.apply(
            agentEvent({
                arguments: '{"query":"finished"}',
                callId: "ws_done",
                messageId: "message-1",
                name: "web_search",
                type: "server_toolcall_end",
            }),
        );
        store.apply(
            agentEvent({
                callId: "xs_running",
                messageId: "message-1",
                name: "x_keyword_search",
                type: "server_toolcall_start",
            }),
        );
        store.apply(
            agentEvent({
                callId: "xs_running",
                delta: '{"query":"Claude Code"',
                messageId: "message-1",
                type: "server_toolcall_delta",
            }),
        );

        store.apply(event("abort_requested", { runId: "run-1" }));

        expect(providerCalls(store)).toMatchObject([
            { providerToolCallId: "ws_done", status: "completed" },
            // What it was searching for is kept: the partial arguments are all that is known, and
            // an interrupted row with no subject tells the reader nothing.
            {
                argumentsComplete: false,
                presentation: { query: "Claude Code" },
                providerToolCallId: "xs_running",
                status: "interrupted",
            },
        ]);
    });

    // A failed turn is the same shape as a stopped one, and for the same reason: nothing further
    // can arrive for a call the provider was already running.
    it("settles a search still running when the turn failed", () => {
        const store = startedStore();
        store.apply(
            agentEvent({
                callId: "xs_running",
                messageId: "message-1",
                name: "x_keyword_search",
                type: "server_toolcall_start",
            }),
        );

        store.apply(
            event("run_error", {
                errorMessage: "Grok is unavailable.",
                modelLocked: false,
                runId: "run-1",
            }),
        );

        expect(providerCalls(store)).toMatchObject([
            { providerToolCallId: "xs_running", status: "failed" },
        ]);
    });

    // A fresh attach replays no events at all: it receives a transcript window and rebuilds from
    // that alone. A provider-run call is not part of any assistant message, so unless the window
    // carries it, reopening leaves an answer citing sources it has no visible reason to know.
    it("rebuilds both searches from a transcript window, with no events at all", () => {
        const store = new ChatStore("session-1");
        const messages = [
            { blocks: [], content: "What is X saying?", id: "u1", role: "user" },
            { blocks: [], content: "People are praising it.", id: "a1", role: "agent" },
        ];
        const base = hello();
        store.applyHello({
            ...base,
            session: { ...base.session, snapshot: { messages } },
            transcript: {
                complete: true,
                messages,
                providerToolCalls: [
                    {
                        arguments: '{"query":"Claude Code","mode":"Latest"}',
                        callId: "xs_call-1",
                        createdAt: 10,
                        messageId: "a1",
                        name: "x_keyword_search",
                        runId: "run-1",
                        status: "completed",
                    },
                    {
                        arguments: '{"query":"Rig release notes"',
                        callId: "xs_call-2",
                        createdAt: 20,
                        messageId: "a1",
                        name: "x_semantic_search",
                        runId: "run-1",
                        status: "interrupted",
                    },
                ],
                turns: [
                    {
                        endedAt: 100,
                        messageIds: ["u1", "a1"],
                        outcome: "success",
                        runId: "run-1",
                        startedAt: 0,
                    },
                ],
            },
        } as unknown as SessionStreamHello);

        expect(providerCalls(store)).toMatchObject([
            {
                presentation: { query: "Claude Code", target: "x" },
                providerToolCallId: "xs_call-1",
                status: "completed",
            },
            // Its outcome is remembered as unknown rather than quietly promoted to finished.
            {
                presentation: { query: "Rig release notes", target: "x" },
                providerToolCallId: "xs_call-2",
                status: "interrupted",
            },
        ]);
        // They belong to the group of the answer they informed, not to one of their own.
        expect(providerCalls(store).map((call) => call.groupId)).toEqual(["group:a1", "group:a1"]);
    });

    // The next turn must not inherit the last one's unfinished call, or a redelivered event would
    // reopen a row that has already been settled.
    it("does not let a settled search be reopened by a later turn", () => {
        const store = startedStore();
        store.apply(
            agentEvent({
                callId: "xs_running",
                messageId: "message-1",
                name: "x_keyword_search",
                type: "server_toolcall_start",
            }),
        );
        store.apply(event("abort_requested", { runId: "run-1" }));
        store.apply(
            agentEvent({
                callId: "xs_running",
                delta: '{"query":"late"',
                messageId: "message-1",
                type: "server_toolcall_delta",
            }),
        );

        expect(providerCalls(store)).toMatchObject([
            { providerToolCallId: "xs_running", status: "interrupted" },
        ]);
    });
});

/**
 * A hosted search does more than search. OpenAI's `web_search` opens the pages it found, under the
 * same tool name and distinguished only by its arguments — so reading the name alone reported
 * every page it opened as another search, which is work that did not happen.
 *
 * The payloads here are the ones a live `gpt-5.6-sol` turn produced.
 */
describe("a hosted call that opened a page", () => {
    it("says a page was read, not that the web was searched", () => {
        expect(
            describeProviderToolCall(
                "web_search",
                '{"type": "open_page", "url": "https://github.com/webpro-nl/knip"}',
            ),
        ).toEqual({ kind: "page_read", url: "https://github.com/webpro-nl/knip" });
    });

    it("still reads a real search as a search", () => {
        expect(
            describeProviderToolCall(
                "web_search",
                '{"type":"search","query":"Node.js current stable version"}',
            ),
        ).toEqual({
            kind: "search",
            query: "Node.js current stable version",
            sources: [],
            target: "web",
        });
    });

    // Arguments stream in pieces. A call whose type has not landed yet must not flicker into a
    // page read and back; it stays the search it belongs to until the arguments say otherwise.
    it("does not guess from a half-arrived argument string", () => {
        expect(describeProviderToolCall("web_search", '{"type":"open_p').kind).toBe("search");
    });
});
