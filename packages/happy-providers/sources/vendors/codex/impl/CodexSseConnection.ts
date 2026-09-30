import type OpenAI from "openai";
import type {
    ResponseCreateParamsStreaming,
    ResponseStreamEvent,
} from "openai/resources/responses/responses.js";

import type { SessionTool } from "@/core/SessionTool.js";
import { createResponsesLiteSseRequest } from "@/protocol/responsesLite/createResponsesLiteRequest.js";
import type { CodexResponseRequest } from "@/vendors/codex/impl/CodexResponseRequest.js";
import type { CodexTurnState } from "@/vendors/codex/impl/CodexTurnState.js";
import { createCodexBedrockRequest } from "@/vendors/codex/impl/createCodexBedrockRequest.js";
import { createCodexRequestHeaders } from "@/vendors/codex/impl/createCodexRequestHeaders.js";
import { isCodexV2Model } from "@/vendors/codex/impl/isCodexV2Model.js";
import { toCodexToolDefinitions } from "@/vendors/codex/impl/toCodexToolDefinitions.js";
import { withCodexStreamIdleTimeout } from "@/vendors/codex/impl/codexRetry.js";
import { createCodexRoutingHint } from "./createCodexRoutingHint.js";

/**
 * One Codex request over server-sent events.
 *
 * SSE carries no state between turns: every request replays the whole context and the response
 * ends the exchange. So this holds nothing of its own and simply performs a request, adopting the
 * turn token if this is the first response to carry one.
 */
export class CodexSseConnection {
    constructor(
        private readonly options: {
            bedrock: () => boolean;
            codexBackend: () => boolean;
            client: () => OpenAI;
            idleTimeoutMs: number;
            turnState: CodexTurnState;
            windowId: () => string;
        },
    ) {}

    async stream(options: {
        model: string;
        request: CodexResponseRequest;
        signal?: AbortSignal;
        tools: readonly SessionTool[];
    }): Promise<AsyncGenerator<ResponseStreamEvent>> {
        const { signal } = options;
        const turnState = this.options.turnState;
        const request =
            options.request.tools === undefined
                ? createResponsesLiteSseRequest(
                      options.request,
                      toCodexToolDefinitions(options.tools),
                  )
                : options.request;
        const turnMetadata = request.client_metadata?.["x-codex-turn-metadata"];
        const { data: stream, response } = await this.options
            .client()
            .responses.create(
                // The SDK enum predates Codex's native "ultrafast" tier; serialization is unchanged.
                (this.options.bedrock()
                    ? createCodexBedrockRequest(request)
                    : request) as ResponseCreateParamsStreaming,
                {
                    headers: {
                        ...createCodexRequestHeaders(
                            options.model,
                            turnState.value,
                            this.options.windowId(),
                            typeof turnMetadata === "string" ? turnMetadata : undefined,
                            isCodexV2Model(options.model) && request.tools === undefined,
                        ),
                        ...(this.options.codexBackend()
                            ? { "x-codex-routing-hint": createCodexRoutingHint(request) }
                            : {}),
                    },
                    ...(signal === undefined ? {} : { signal }),
                },
            )
            .withResponse();
        turnState.observeHeaders(response.headers);
        return observeTurnState(
            withCodexStreamIdleTimeout({
                stream,
                timeoutMs: this.options.idleTimeoutMs,
                ...(signal === undefined ? {} : { signal }),
            }),
            turnState,
        );
    }
}

async function* observeTurnState(
    stream: AsyncIterable<ResponseStreamEvent>,
    turnState: CodexTurnState,
): AsyncGenerator<ResponseStreamEvent> {
    for await (const event of stream) {
        turnState.observe(event);
        yield event;
    }
}
