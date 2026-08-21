import type OpenAI from "openai";
import type {
    ResponseOutputItem,
    ResponseStreamEvent,
} from "openai/resources/responses/responses.js";
import { ResponsesWS } from "openai/resources/responses/ws";

import type { SessionTool } from "@/core/SessionTool.js";
import {
    createResponsesLiteSseRequest,
    createResponsesLiteWarmupRequest,
    createResponsesLiteWebSocketInferenceRequest,
} from "@/protocol/responsesLite/createResponsesLiteRequest.js";
import type { CodexResponseRequest } from "@/vendors/codex/impl/CodexResponseRequest.js";
import type { CodexTurnState } from "@/vendors/codex/impl/CodexTurnState.js";
import {
    CodexWebSocketClosedBeforeRequestError,
    createCodexWebSocketStream,
} from "@/vendors/codex/impl/createCodexWebSocketStream.js";
import { getCodexIncrementalInput } from "@/vendors/codex/impl/getCodexIncrementalInput.js";
import { setCodexRequestKind } from "@/vendors/codex/impl/setCodexRequestKind.js";
import { toCodexToolDefinitions } from "@/vendors/codex/impl/toCodexToolDefinitions.js";
import { withCodexStreamIdleTimeout } from "@/vendors/codex/impl/codexRetry.js";

/**
 * OpenAI closes Responses websockets after sixty minutes. Rotate a few minutes early so a long
 * session does not discover the limit mid-turn, and always keep an error listener attached so an
 * idle limit rejection cannot become an unhandled process crash.
 */
export const CODEX_WEBSOCKET_MAX_AGE_MS = 55 * 60 * 1000;

interface CodexWebSocketStreamOptions {
    request: CodexResponseRequest;
    signal?: AbortSignal;
    tools: readonly SessionTool[];
}

/**
 * The Codex WebSocket, which is a conversation rather than a request.
 *
 * The socket is warmed once, and every later turn may send only what changed since the response
 * it continues from. That makes the response chain — the last request, its output, and its id —
 * the state that decides whether the next turn can be incremental, so it lives here with the
 * socket it describes. The chain is single-use: building an incremental request consumes it, and
 * anything that interrupts the exchange discards it so the next turn replays in full.
 */
export class CodexWebSocketConnection {
    private socket: ResponsesWS | undefined;
    private openedAtMs = 0;
    private started = false;
    private inferenceStarted = false;
    private needsFullRequest = false;
    private previousRequest: CodexResponseRequest | undefined;
    private previousResponseId: string | undefined;
    private previousResponseItems: readonly ResponseOutputItem[] = [];

    constructor(
        private readonly options: {
            client: () => OpenAI;
            headers: () => Record<string, string>;
            idleTimeoutMs: number;
            turnState: CodexTurnState;
        },
    ) {}

    async *stream(options: CodexWebSocketStreamOptions): AsyncGenerator<ResponseStreamEvent> {
        let preRequestReconnects = 0;
        let yieldedResponseEvent = false;
        for (;;) {
            try {
                for await (const event of this.streamAttempt(options)) {
                    yieldedResponseEvent = true;
                    yield event;
                }
                return;
            } catch (error) {
                // A warmed socket can be dropped while it is idle without its close event winning
                // the race before the next send. When the transport proves that no request frame
                // was sent, one immediate replay on a fresh socket is safe and needs no visible
                // inference retry. Anything ambiguous, initial, or repeated stays on the session's
                // normal rollback and retry path.
                if (
                    !(error instanceof CodexWebSocketClosedBeforeRequestError) ||
                    yieldedResponseEvent ||
                    !this.started ||
                    preRequestReconnects >= 1
                ) {
                    throw error;
                }
                preRequestReconnects += 1;
                this.reset("websocket closed before request");
            }
        }
    }

    private async *streamAttempt(
        options: CodexWebSocketStreamOptions,
    ): AsyncGenerator<ResponseStreamEvent> {
        const { request, signal, tools } = options;
        const turnState = this.options.turnState;
        const client = this.options.client();
        this.ensureSocket(client);
        if (!this.started) {
            const warmup =
                request.tools === undefined
                    ? createResponsesLiteWarmupRequest(request, toCodexToolDefinitions(tools))
                    : { ...structuredClone(request), input: [], generate: false };
            setCodexRequestKind(warmup, "prewarm");
            for await (const event of this.send(client, warmup, signal)) {
                turnState.observe(event);
                if (event.type === "response.completed")
                    this.previousResponseId = event.response.id;
            }
            this.started = true;
        }
        const fullRequest = request;
        const incrementalInput =
            this.previousRequest === undefined
                ? undefined
                : getCodexIncrementalInput(
                      this.previousRequest,
                      this.previousResponseItems,
                      fullRequest,
                  );
        const canContinue =
            !this.needsFullRequest && (!this.inferenceStarted || incrementalInput !== undefined);
        // Codex builds a separate ResponseCreateWsRequest from its durable request. Keep the same
        // ownership boundary even when a request-shaping helper has no transformations to apply.
        const inferenceRequest = structuredClone(
            canContinue
                ? request.tools === undefined
                    ? createResponsesLiteWebSocketInferenceRequest(request)
                    : request
                : request.tools === undefined
                  ? createResponsesLiteSseRequest(request, toCodexToolDefinitions(tools))
                  : request,
        );
        if (incrementalInput !== undefined) inferenceRequest.input = incrementalInput;
        if (canContinue && this.previousResponseId !== undefined) {
            inferenceRequest.previous_response_id = this.previousResponseId;
        }
        // Match Codex's LastResponse::take() behavior: a response chain is single-use once an
        // incremental request is constructed. Any retry must rebuild complete durable context.
        this.clearResponseChain();
        this.inferenceStarted = true;
        this.needsFullRequest = false;
        const completedItems = new Map<number, ResponseOutputItem>();
        let sawCompletedItem = false;
        let completedItemsAreReusable = true;
        for await (const event of this.send(client, inferenceRequest, signal)) {
            turnState.observe(event);
            if (event.type === "response.output_item.done") {
                sawCompletedItem = true;
                if (
                    !Number.isSafeInteger(event.output_index) ||
                    event.output_index < 0 ||
                    completedItems.has(event.output_index)
                ) {
                    completedItemsAreReusable = false;
                } else {
                    completedItems.set(event.output_index, event.item);
                }
            }
            if (event.type === "response.completed") {
                const responseItems = sawCompletedItem
                    ? completedItemsAreReusable
                        ? orderedResponseItems(completedItems)
                        : undefined
                    : (event.response.output ?? []);
                if (responseItems !== undefined) {
                    const committedRequest = structuredClone(fullRequest);
                    const committedItems = structuredClone(responseItems);
                    this.previousRequest = committedRequest;
                    this.previousResponseItems = committedItems;
                    this.previousResponseId = event.response.id;
                }
            }
            yield event;
        }
    }

    /** Drops the chain while leaving the socket warm, as compaction does. */
    clearResponseChain(): void {
        this.previousRequest = undefined;
        this.previousResponseId = undefined;
        this.previousResponseItems = [];
    }

    /** Abandons the exchange but remembers it was warmed, so the next turn replays in full. */
    reset(reason: string): void {
        this.needsFullRequest = this.started;
        this.close(reason);
        this.clearResponseChain();
        this.inferenceStarted = false;
    }

    /** Forgets everything, for when the credential behind the socket is no longer the same. */
    discard(reason: string): void {
        this.close(reason);
        this.clearResponseChain();
        this.inferenceStarted = false;
        this.started = false;
        this.needsFullRequest = false;
    }

    close(reason: string): void {
        const socket = this.socket;
        this.socket = undefined;
        this.openedAtMs = 0;
        if (socket?.socket.readyState !== undefined && socket.socket.readyState < 2)
            socket.close({ code: 1000, reason });
    }

    private ensureSocket(client: OpenAI): ResponsesWS {
        const now = Date.now();
        if (
            this.socket !== undefined &&
            this.openedAtMs > 0 &&
            now - this.openedAtMs >= CODEX_WEBSOCKET_MAX_AGE_MS
        ) {
            this.reset("websocket max age");
        }
        if (this.socket === undefined) {
            const socket = new ResponsesWS(client, { headers: this.options.headers() });
            // The OpenAI SDK turns unobserved socket errors into Promise.reject(...). Keep one
            // listener for the life of the connection so an idle sixty-minute limit cannot kill
            // the daemon, and drop the dead socket so the next turn opens a fresh one.
            socket.on("error", () => {
                if (this.socket !== socket) return;
                this.abandonDeadSocket();
            });
            this.socket = socket;
            this.openedAtMs = now;
        }
        return this.socket;
    }

    private abandonDeadSocket(): void {
        this.needsFullRequest = this.started;
        this.socket = undefined;
        this.openedAtMs = 0;
        this.clearResponseChain();
        this.inferenceStarted = false;
    }

    private send(
        client: OpenAI,
        request: CodexResponseRequest,
        signal: AbortSignal | undefined,
    ): AsyncIterable<ResponseStreamEvent> {
        const socket = this.socket;
        if (socket === undefined) {
            throw new CodexWebSocketClosedBeforeRequestError();
        }
        const turnState = this.options.turnState.value;
        return withCodexStreamIdleTimeout({
            stream: createCodexWebSocketStream({
                client,
                request,
                socket,
                ...(signal === undefined ? {} : { signal }),
                ...(turnState === undefined ? {} : { turnState }),
            }),
            timeoutMs: this.options.idleTimeoutMs,
            ...(signal === undefined ? {} : { signal }),
            onTimeout: () => this.close("stream idle timeout"),
        });
    }
}

/** Returns one complete response in wire order, or nothing when its indexes are not contiguous. */
function orderedResponseItems(
    items: ReadonlyMap<number, ResponseOutputItem>,
): readonly ResponseOutputItem[] | undefined {
    const ordered = [...items].sort(([left], [right]) => left - right);
    if (ordered.some(([index], position) => index !== position)) return undefined;
    return ordered.map(([, item]) => item);
}
