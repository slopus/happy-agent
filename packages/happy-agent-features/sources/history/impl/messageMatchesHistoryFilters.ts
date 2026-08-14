import type { HistoryMessage, HistoryRole } from "../HistoryMessage.js";

/** Whether a message survives the role and text filters a reader asked for. */
export function messageMatchesHistoryFilters(
    message: HistoryMessage,
    options: { query?: string | undefined; roles?: readonly HistoryRole[] | undefined },
): boolean {
    if (options.roles !== undefined && !options.roles.includes(message.role)) return false;
    const query =
        options.query === undefined ? undefined : foldHistorySearchText(options.query.trim());
    if (query === undefined || query.length === 0) return true;
    // Search reads the whole stored message, not the bounded rendering a reader is shown, so a
    // hit inside truncated tool output is still findable.
    return historyMessageSearchParts(message).some((part) =>
        foldHistorySearchText(part).includes(query),
    );
}

/**
 * The one case-folding rule shared by every history adapter.
 *
 * SQLite's built-in case folding is ASCII-only. SQL adapters that cannot execute this Unicode
 * operation use a bounded host-side filter with this exact function instead.
 */
export function foldHistorySearchText(value: string): string {
    return value.toLocaleLowerCase("en-US");
}

/** Every piece of a message that counts as text a search may match. */
export function historyMessageSearchParts(message: HistoryMessage): readonly string[] {
    const parts: string[] = [];
    for (const block of message.blocks) {
        if (block.type === "text") parts.push(block.text);
        else if (block.type === "image") parts.push(block.mediaType);
        else if (block.type === "thinking") parts.push(block.thinking);
        else if (block.type === "tool_call") parts.push(block.name, stringify(block.arguments));
        else parts.push(block.toolName, block.display ?? "", block.output);
    }
    return parts;
}

/** Tool arguments as text, or nothing when they cannot be written down. */
function stringify(value: unknown): string {
    try {
        return JSON.stringify(value) ?? "";
    } catch {
        return "";
    }
}
