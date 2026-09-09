/**
 * Codex compaction: deciding what a summary must keep, and what the request may lose.
 *
 * Compaction is one behavior with two implementations. The server-side form sends the context back
 * and reads a summary out of the response; the local form builds the summary from the transcript
 * here. Both must fit inside a context window already known to be too small, so the same
 * budgeting, truncation, and message-preservation rules serve them, and they stay together.
 */

import type {
    ResponseCompactionItemParam,
    ResponseStreamEvent,
} from "openai/resources/responses/responses.js";
import type { CodexResponseRequest } from "@/vendors/codex/impl/CodexResponseRequest.js";
import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses.js";
import type { ResponseInputItem } from "openai/resources/responses/responses.js";
import type { SessionUsage } from "@/core/SessionUsage.js";
import type { SessionMessage, SessionUserMessage } from "@/core/SessionContext.js";
import type { SessionTool } from "@/core/SessionTool.js";
import { responseInputItems } from "@/protocol/responses/responseInputItems.js";
import { responseStreamError } from "@/protocol/responses/responseStreamError.js";
import { createResponsesLiteSseRequest } from "@/protocol/responsesLite/createResponsesLiteRequest.js";
import { context_checkpoint_summary_prefix } from "@/vendors/codex/prompts/context_checkpoint_compaction_instructions.js";
import { setCodexRequestKind } from "@/vendors/codex/impl/setCodexRequestKind.js";
import { toCodexToolDefinitions } from "@/vendors/codex/impl/toCodexToolDefinitions.js";
import { toSessionUsage } from "@/protocol/responses/toSessionUsage.js";

export interface CodexCompactionMetadata {
    readonly trigger: "manual";
    readonly reason: "user_requested";
    readonly implementation: "responses" | "responses_compaction_v2";
    readonly phase: "standalone_turn";
    readonly strategy: "memento";
}

const APPROXIMATE_BYTES_PER_TOKEN = 4;
// Codex counts an auto-detail image by its resized model-visible cost, not by the size of the
// base64 transport payload. 7,373 bytes maps to approximately 1,844 tokens under the estimator.
const RESIZED_IMAGE_BYTES_ESTIMATE = 7_373;
const ESTIMATED_IMAGE_PAYLOAD = "A".repeat(RESIZED_IMAGE_BYTES_ESTIMATE);

/** Conservative UTF-8 estimate of the final model-visible request envelope. */
export function estimateCodexContextTokens(envelope: unknown, tokenLimit: number): number {
    const bytes = Buffer.byteLength(JSON.stringify(envelope, modelVisibleImageReplacer));
    return Math.min(tokenLimit, Math.ceil(bytes / APPROXIMATE_BYTES_PER_TOKEN));
}

function modelVisibleImageReplacer(key: string, value: unknown): unknown {
    if (key !== "image_url" || typeof value !== "string") return value;
    const commaIndex = value.indexOf(",");
    if (commaIndex === -1) return value;
    const metadata = value.slice(0, commaIndex);
    if (!metadata.toLowerCase().startsWith("data:image/")) return value;
    if (!metadata.split(";").some((part) => part.toLowerCase() === "base64")) return value;
    return `${value.slice(0, commaIndex + 1)}${ESTIMATED_IMAGE_PAYLOAD}`;
}

/** Mirrors Codex's UTF-8, middle-preserving token-budget truncation. */
export function truncateCodexText(text: string, maxTokens: number): string {
    const source = Buffer.from(text);
    const maxBytes = maxTokens * APPROXIMATE_BYTES_PER_TOKEN;
    if (source.byteLength <= maxBytes) return text;

    const leftBudget = Math.floor(maxBytes / 2);
    const rightBudget = maxBytes - leftBudget;
    const prefix = decodePrefix(source, leftBudget);
    const suffix = decodeSuffix(source, rightBudget);
    const removedBytes = source.byteLength - Buffer.byteLength(prefix) - Buffer.byteLength(suffix);
    const removedTokens = Math.ceil(removedBytes / APPROXIMATE_BYTES_PER_TOKEN);
    return `${prefix}…${removedTokens} tokens truncated…${suffix}`;
}

function decodePrefix(source: Buffer, budget: number): string {
    let end = Math.min(budget, source.byteLength);
    for (;;) {
        try {
            return new TextDecoder("utf-8", { fatal: true }).decode(source.subarray(0, end));
        } catch {
            end -= 1;
        }
    }
}

function decodeSuffix(source: Buffer, budget: number): string {
    let start = Math.max(0, source.byteLength - budget);
    for (;;) {
        try {
            return new TextDecoder("utf-8", { fatal: true }).decode(source.subarray(start));
        } catch {
            start += 1;
        }
    }
}

export function createCodexCompactionRequest(
    request: ResponseCreateParamsStreaming,
    metadata: CodexCompactionMetadata,
): CodexResponseRequest {
    const compaction: CodexResponseRequest = structuredClone(request);
    setCodexRequestKind(compaction, "compaction", metadata);
    compaction.input = [...responseInputItems(compaction.input), { type: "compaction_trigger" }];
    return compaction;
}

const TRUNCATED_TOOL_OUTPUT = "Output exceeded the available model context and was truncated";

/** Fits a compaction request to the hard model window without mutating durable context. */
export function fitCodexCompactionRequest(
    request: CodexResponseRequest,
    tools: readonly SessionTool[],
    contextWindow: number,
): CodexResponseRequest {
    const fitted: CodexResponseRequest = structuredClone(request);
    let input = Array.isArray(fitted.input) ? [...fitted.input] : [];
    fitted.input = input;

    for (let index = input.length - 1; index >= 0; index -= 1) {
        if (estimate(fitted, tools, contextWindow) < contextWindow) break;
        const item = input[index];
        if (item === undefined) continue;
        if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
            input[index] = { ...item, output: TRUNCATED_TOOL_OUTPUT };
        } else if (item.type === "tool_search_output") {
            input[index] = { ...item, tools: [] };
        }
    }

    while (estimate(fitted, tools, contextWindow) >= contextWindow) {
        const lastUser = input.findLast((item) => "role" in item && item.role === "user");
        const removableIndex = input.findIndex((item) => {
            if (item === lastUser) return false;
            return (
                (!("role" in item) || item.role !== "developer") &&
                item.type !== "compaction_trigger"
            );
        });
        if (removableIndex === -1) break;
        const removed = input[removableIndex];
        const callId =
            removed !== undefined && "call_id" in removed && typeof removed.call_id === "string"
                ? removed.call_id
                : undefined;
        input = input.filter(
            (item, index) =>
                index !== removableIndex &&
                (callId === undefined || !("call_id" in item) || item.call_id !== callId),
        );
        fitted.input = input;
    }

    while (estimate(fitted, tools, contextWindow) >= contextWindow) {
        const item = input.findLast(
            (candidate) => "role" in candidate && candidate.role === "user",
        );
        if (item === undefined) break;
        const text = messageText(item);
        if (text === undefined || Buffer.byteLength(text) === 0) break;
        const estimateTokens = estimate(fitted, tools, Number.MAX_SAFE_INTEGER);
        const textTokens = Math.ceil(Buffer.byteLength(text) / 4);
        const targetTokens = Math.max(0, textTokens - (estimateTokens - contextWindow) - 256);
        if (targetTokens >= textTokens) break;
        replaceMessageText(item, truncateCodexText(text, targetTokens));
        if (estimate(fitted, tools, Number.MAX_SAFE_INTEGER) >= estimateTokens) break;
    }

    return fitted;
}

function estimate(
    request: CodexResponseRequest,
    tools: readonly SessionTool[],
    limit: number,
): number {
    return estimateCodexContextTokens(
        request.tools === undefined
            ? createResponsesLiteSseRequest(request, toCodexToolDefinitions(tools))
            : request,
        limit,
    );
}

function messageText(item: ResponseInputItem): string | undefined {
    if (!("content" in item)) return undefined;
    if (typeof item.content === "string") return item.content;
    if (!Array.isArray(item.content)) return undefined;
    const content = findTextContent(item.content);
    return content?.text;
}

function replaceMessageText(item: ResponseInputItem, text: string): void {
    if (!("content" in item)) return;
    if (typeof item.content === "string") {
        item.content = text;
        return;
    }
    if (!Array.isArray(item.content)) return;
    const content = findTextContent(item.content);
    if (content !== undefined) content.text = text;
}

function findTextContent(values: readonly unknown[]): { text: string } | undefined {
    for (const value of values) {
        if (hasText(value)) return value;
    }
    return undefined;
}

function hasText(value: unknown): value is { text: string } {
    return (
        typeof value === "object" &&
        value !== null &&
        "text" in value &&
        typeof value.text === "string"
    );
}

/** Remote compaction keeps far more of the transcript than the local fallback can afford. */
const PRESERVED_TOKEN_LIMIT = 64_000;

export function preserveCodexCompactionMessages(
    messages: readonly SessionMessage[],
): SessionUserMessage[] {
    const candidates = messages.filter(
        (message): message is SessionUserMessage => message.role === "user",
    );
    const preserved: SessionUserMessage[] = [];
    let remainingTokens = PRESERVED_TOKEN_LIMIT;
    for (const message of candidates.toReversed()) {
        if (remainingTokens === 0) break;
        const text = sessionUserText(message);
        const tokens = Math.ceil(Buffer.byteLength(text) / APPROXIMATE_BYTES_PER_TOKEN);
        if (tokens <= remainingTokens) {
            preserved.unshift(structuredClone(message));
            remainingTokens -= tokens;
            continue;
        }
        preserved.unshift({
            ...structuredClone(message),
            content: [{ type: "text", text: truncateCodexText(text, remainingTokens) }],
        });
        break;
    }
    return preserved;
}

const LOCAL_PRESERVED_TOKEN_LIMIT = 20_000;

/** Applies Codex's local-compaction policy used for providers without remote compaction. */
export function preserveCodexLocalCompactionMessages(
    messages: readonly SessionMessage[],
): SessionUserMessage[] {
    const candidates = messages.filter(
        (message): message is SessionUserMessage =>
            message.role === "user" &&
            !sessionUserText(message).startsWith(`${context_checkpoint_summary_prefix}\n`),
    );
    const preserved: SessionUserMessage[] = [];
    let remainingTokens = LOCAL_PRESERVED_TOKEN_LIMIT;
    for (const message of candidates.toReversed()) {
        if (remainingTokens === 0) break;
        const text = sessionUserText(message);
        const tokens = Math.ceil(Buffer.byteLength(text) / APPROXIMATE_BYTES_PER_TOKEN);
        if (tokens <= remainingTokens) {
            preserved.unshift(structuredClone(message));
            remainingTokens -= tokens;
            continue;
        }
        preserved.unshift({
            ...structuredClone(message),
            content: [{ type: "text", text: truncateCodexText(text, remainingTokens) }],
        });
        break;
    }
    return preserved;
}

function sessionUserText(message: SessionUserMessage): string {
    return message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
}

export interface CollectedCodexCompaction {
    readonly item: ResponseCompactionItemParam;
    readonly usage: SessionUsage;
}

export async function collectCodexCompaction(
    stream: AsyncIterable<ResponseStreamEvent>,
    options: { signal?: AbortSignal; onOutputStarted?: () => void },
): Promise<CollectedCodexCompaction> {
    let item: ResponseCompactionItemParam | undefined;
    for await (const event of stream) {
        if (options.signal?.aborted) throw options.signal.reason;
        if (event.type === "response.output_item.added") {
            options.onOutputStarted?.();
            continue;
        }
        if (event.type === "response.output_item.done" && event.item.type === "compaction") {
            if (item !== undefined)
                throw new Error("Compaction returned more than one compaction item.");
            item = {
                type: "compaction",
                encrypted_content: event.item.encrypted_content,
            };
            continue;
        }
        if (event.type === "response.incomplete") {
            const reason = event.response.incomplete_details?.reason ?? "unknown";
            throw new Error(`Incomplete compaction response returned, reason: ${reason}`);
        }
        if (event.type === "response.failed") {
            throw responseStreamError(event, "Codex failed to compact the conversation.");
        }
        if (event.type === "error") {
            throw responseStreamError(event, "Codex failed to compact the conversation.");
        }
        if (event.type !== "response.completed") continue;
        const completedItems = event.response.output.filter(
            (output): output is typeof output & { type: "compaction" } =>
                output.type === "compaction",
        );
        if (completedItems.length > 1)
            throw new Error("Compaction returned more than one compaction item.");
        const completedItem = completedItems[0];
        const resolved =
            item ??
            (completedItem === undefined
                ? undefined
                : {
                      type: "compaction" as const,
                      encrypted_content: completedItem.encrypted_content,
                  });
        if (resolved === undefined)
            throw new Error("Compaction response did not contain a compaction item.");
        return {
            item: resolved,
            usage: toSessionUsage(event.response.usage),
        };
    }
    throw new Error("Compaction response stream closed before completion.");
}
