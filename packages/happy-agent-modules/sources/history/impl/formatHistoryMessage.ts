import type { HistoryMessage } from "../HistoryMessage.js";

/** How much of one long piece of text a reader is shown before it is cut. */
export const TEXT_LIMIT = 12_000;
const ARGUMENTS_LIMIT = 1_500;
const DISPLAY_LIMIT = 1_000;
const OUTPUT_LIMIT = 4_000;

/**
 * One message as a reader sees it: a numbered header and a line per block.
 *
 * Nothing here is replayable and it does not pretend to be. Tool arguments and output are cut to
 * a length worth reading, an image is named rather than carried, and hidden reasoning is marked
 * as hidden — the point is to let a reader understand what happened, not to reconstruct it.
 */
export function formatHistoryMessage(
    message: HistoryMessage,
    position: number,
    options: { includeTools?: boolean; textLimit?: number } = {},
): string {
    const includeTools = options.includeTools !== false;
    const textLimit = options.textLimit ?? TEXT_LIMIT;
    const attribution =
        message.provider === undefined
            ? ""
            : ` (${message.provider}${message.model === undefined ? "" : `, ${message.model}`})`;
    // An agent-role message names its specific sender when the sender identified itself.
    const sender = message.senderAgentId === undefined ? "" : ` (${message.senderAgentId})`;
    const lines = [`${position}. ${message.role.toLocaleUpperCase()}${sender}${attribution}`];
    for (const block of message.blocks) {
        if (block.type === "text") {
            lines.push(`Text: ${truncate(block.text, textLimit)}`);
        } else if (block.type === "image") {
            lines.push(`[Image: ${block.mediaType}]`);
        } else if (block.type === "thinking") {
            lines.push(
                block.redacted === true
                    ? "Thinking: [redacted]"
                    : `Thinking: ${truncate(block.thinking, textLimit)}`,
            );
        } else if (block.type === "tool_call_request") {
            lines.push(`Requested tool: ${block.name} ${truncateJson(block.arguments ?? {})}`);
        } else if (block.type === "tool_call") {
            if (!includeTools) continue;
            lines.push(`Tool call: ${block.name} ${truncateJson(block.arguments ?? null)}`);
        } else if (block.type === "tool_result") {
            if (!includeTools) continue;
            const summary =
                block.display === undefined
                    ? ""
                    : `\nSummary: ${truncate(block.display, DISPLAY_LIMIT)}`;
            lines.push(
                `Tool result: ${block.toolName} (${block.isError === true ? "error" : "ok"})${summary}\nOutput: ${truncate(block.output ?? "", OUTPUT_LIMIT)}`,
            );
        } else {
            const tokenChange =
                block.tokensBefore === null
                    ? ""
                    : ` (${String(block.tokensBefore)} → ${block.tokensAfter === null ? "unknown" : String(block.tokensAfter)} tokens)`;
            const reason = block.failureReason === null ? "" : `: ${block.failureReason}`;
            lines.push(`Compaction: ${block.status}${tokenChange}${reason}`);
        }
    }
    return lines.join("\n");
}

/** Tool arguments as bounded text, or a note that they cannot be written down. */
function truncateJson(value: unknown): string {
    try {
        return truncate(JSON.stringify(value) ?? "null", ARGUMENTS_LIMIT);
    } catch {
        return "[unserializable arguments]";
    }
}

/** Cut text to a length, saying how much was cut rather than pretending it ended there. */
export function truncate(value: string, limit: number): string {
    if (value.length <= limit) return value;
    const suffix = `\n...[truncated ${value.length - limit} chars]`;
    if (suffix.length >= limit) return suffix.slice(0, limit);
    return `${value.slice(0, limit - suffix.length)}${suffix}`;
}
