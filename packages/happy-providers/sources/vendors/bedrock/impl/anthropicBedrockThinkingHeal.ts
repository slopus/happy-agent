import { createHash } from "node:crypto";

import { APIError } from "@anthropic-ai/sdk/error";
import type {
    BetaContentBlockParam,
    BetaMessageParam,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";

import type { AnthropicRequest } from "@/protocol/anthropic/createAnthropicRequest.js";
import { resolveAnthropicBedrockErrorStatus } from "@/vendors/bedrock/impl/anthropicBedrockRetry.js";

/** The response header that names the first thinking block that failed the prefix check. */
const MISMATCH_HEADER = "anthropic-thinking-prefix-mismatch";
const MAX_MISMATCH_HEADER_LENGTH = 2048;
const BLOCK_PATH = /^messages\.(\d{1,6})\.content\.(\d{1,6})$/;
const BLOCK_PATH_IN_MESSAGE = /(?<![\w.])messages\.(\d{1,6})\.content\.(\d{1,6})(?!\d)/;

/** What an assistant message holds once thinking was all it had. Claude Code sends the same. */
const REMOVED_THINKING_PLACEHOLDER = "[Thinking removed]";

/** Where the API says the first failing thinking block is, in its own numbering. */
export interface AnthropicThinkingMismatchPosition {
    readonly message: number;
    readonly content: number;
}

/**
 * Recognizes the rejection of replayed thinking whose prefix changed: the system prompt, the
 * tools, or an earlier message is no longer what it was when the block was produced. Sending the
 * same request again cannot work. The two phrases are the ones Claude Code heals on; the rest of
 * the message is documented as free to change.
 */
export function isAnthropicThinkingPrefixMismatch(error: unknown): boolean {
    if (resolveAnthropicBedrockErrorStatus(error) !== 400) return false;
    const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
    return (
        message.includes("bound to a different conversation") ||
        message.includes("not created in this conversation")
    );
}

/**
 * The first failing block the rejection names: from the mismatch header when the endpoint sends
 * one, and otherwise from the `messages.N.content.M` path that opens the error message.
 */
export function anthropicThinkingMismatchPosition(
    error: unknown,
): AnthropicThinkingMismatchPosition | undefined {
    const named = headerBlockPath(error) ?? BLOCK_PATH_IN_MESSAGE.exec(errorMessage(error));
    if (named === null || named === undefined) return undefined;
    return { message: Number(named[1]), content: Number(named[2]) };
}

function headerBlockPath(error: unknown): RegExpExecArray | undefined {
    if (!(error instanceof APIError)) return undefined;
    let header: string | null | undefined;
    try {
        header = error.headers?.get(MISMATCH_HEADER);
    } catch {
        return undefined;
    }
    if (typeof header !== "string" || header.length === 0) return undefined;
    if (header.length > MAX_MISMATCH_HEADER_LENGTH) return undefined;
    // `key=value` pairs separated by `;`; the first `block` wins.
    for (const pair of header.split(";")) {
        const separator = pair.indexOf("=");
        if (separator <= 0 || pair.slice(0, separator).trim() !== "block") continue;
        return BLOCK_PATH.exec(pair.slice(separator + 1).trim()) ?? undefined;
    }
    return undefined;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * The thinking a request must leave out to get past the rejection, as block identities.
 *
 * The API's documented repair is to remove the named block and every thinking block after it,
 * because each later one fails for the same reason. The position is trusted only when it lands on
 * a thinking block of this request: the API counts two adjacent messages of one role as one, so
 * its position can be lower than ours, and a position that names anything else is not a place to
 * cut. Without a usable position every thinking block goes.
 */
export function anthropicThinkingToRemove(
    request: AnthropicRequest,
    position: AnthropicThinkingMismatchPosition | undefined,
): readonly string[] {
    const named =
        position === undefined
            ? undefined
            : contentOf(request.messages[position.message])?.[position.content];
    const from =
        position !== undefined && named !== undefined && thinkingIdentity(named) !== undefined
            ? position
            : undefined;
    return request.messages.flatMap((message, messageIndex) => {
        if (from !== undefined && messageIndex < from.message) return [];
        return (contentOf(message) ?? []).flatMap((block, blockIndex) => {
            if (from !== undefined && messageIndex === from.message && blockIndex < from.content)
                return [];
            const identity = thinkingIdentity(block);
            return identity === undefined ? [] : [identity];
        });
    });
}

/**
 * The request without the given thinking blocks. Only this request's copy changes: the caller's
 * history still holds every block. An assistant message that held nothing else keeps a short
 * text, since the API refuses an empty one.
 */
export function withoutAnthropicThinking(
    request: AnthropicRequest,
    removed: ReadonlySet<string>,
): AnthropicRequest {
    if (removed.size === 0) return request;
    let changed = false;
    const messages = request.messages.map((message): BetaMessageParam => {
        const content = contentOf(message);
        if (content === undefined) return message;
        const kept = content.filter((block) => {
            const identity = thinkingIdentity(block);
            return identity === undefined || !removed.has(identity);
        });
        if (kept.length === content.length) return message;
        changed = true;
        return {
            ...message,
            content:
                kept.length === 0 ? [{ type: "text", text: REMOVED_THINKING_PLACEHOLDER }] : kept,
        };
    });
    return changed ? { ...request, messages } : request;
}

function contentOf(message: BetaMessageParam | undefined): BetaContentBlockParam[] | undefined {
    if (message === undefined || message.role !== "assistant") return undefined;
    return Array.isArray(message.content) ? message.content : undefined;
}

/**
 * A stable name for one thinking block, or `undefined` for any other block. The signature is what
 * makes a block that block, and it can be long, so its digest is kept instead.
 */
function thinkingIdentity(block: BetaContentBlockParam): string | undefined {
    const signed =
        block.type === "thinking"
            ? block.signature
            : block.type === "redacted_thinking"
              ? block.data
              : undefined;
    if (signed === undefined) return undefined;
    return createHash("sha256").update(`${block.type}\n${signed}`, "utf8").digest("hex");
}
