import type {
    BetaContentBlock,
    BetaToolResultBlockParam,
} from "@anthropic-ai/sdk/resources/beta/messages/messages.mjs";

import type { WebSearchHit, WebSearchOutput, WebSearchResult } from "./types.js";

/**
 * What the helper said and what its tools returned, in the order they happened.
 *
 * A tool result belongs to a user message rather than an assistant one, so it is not an assistant
 * content block and the two have to be read together to see a search at all: one half is the call,
 * the other is what it found.
 */
export type WebSearchHelperBlock = BetaContentBlock | BetaToolResultBlockParam;

/**
 * Turns a helper's reply into the search it performed.
 *
 * The helper is reached through the Claude Agent SDK, which runs `WebSearch` itself rather than
 * letting Anthropic's backend run it inside the response. So a search arrives as an ordinary tool
 * call and an ordinary tool result, not as the `server_tool_use` and `web_search_tool_result`
 * blocks the raw Messages API produces. Both are read: the SDK shape is what this transport sends
 * today, and the server shape is what the same helper would send through the other one.
 */
export function makeWebSearchOutput(
    blocks: readonly WebSearchHelperBlock[],
    query: string,
    durationSeconds: number,
): WebSearchOutput {
    const results: Array<WebSearchResult | string> = [];
    let text = "";
    let inText = true;

    const flushText = (): void => {
        if (inText && text.trim().length > 0) results.push(text.trim());
        text = "";
        inText = false;
    };

    for (const block of blocks) {
        if (block.type === "server_tool_use" || isSearchCall(block)) {
            flushText();
            continue;
        }

        if (block.type === "web_search_tool_result") {
            if (!Array.isArray(block.content)) {
                results.push(`Web search error: ${block.content.error_code}`);
            } else {
                results.push({
                    tool_use_id: block.tool_use_id,
                    content: block.content.map((hit) => ({
                        title: hit.title,
                        url: hit.url,
                    })),
                });
            }
            continue;
        }

        const searchResult = searchToolResult(block);
        if (searchResult !== undefined) {
            results.push(searchResult);
            continue;
        }

        if (block.type === "text") {
            if (!inText) {
                text = "";
            }
            inText = true;
            text += block.text;
        }
    }

    if (text.trim().length > 0) {
        results.push(text.trim());
    }
    return { query, results, durationSeconds };
}

/** Whether a search ran, by either shape. Not whether it found anything. */
export function blocksContainSearch(blocks: readonly WebSearchHelperBlock[]): boolean {
    return blocks.some(
        (block) =>
            block.type === "server_tool_use" ||
            block.type === "web_search_tool_result" ||
            isSearchCall(block),
    );
}

function isSearchCall(block: WebSearchHelperBlock): boolean {
    return block.type === "tool_use" && block.name === "WebSearch";
}

/**
 * The pages a `WebSearch` tool result names.
 *
 * The SDK returns them as prose with one embedded JSON array — `Links: [{"title","url"}, …]` — so
 * that array is what is read. Anything else in the result is the helper's own wording about the
 * search rather than the search, and a reader judges a search by where it looked.
 */
function searchToolResult(block: WebSearchHelperBlock): WebSearchResult | undefined {
    if (block.type !== "tool_result") return undefined;
    const content = block.content;
    const text =
        typeof content === "string"
            ? content
            : Array.isArray(content)
              ? content.map((part) => (part.type === "text" ? part.text : "")).join("")
              : "";
    const hits = parseLinks(text);
    if (hits === undefined) return undefined;
    return { tool_use_id: block.tool_use_id, content: hits };
}

function parseLinks(text: string): WebSearchHit[] | undefined {
    const start = text.indexOf("Links: [");
    if (start === -1) return undefined;
    const opening = start + "Links: ".length;
    const closing = findArrayEnd(text, opening);
    if (closing === -1) return undefined;
    try {
        const parsed: unknown = JSON.parse(text.slice(opening, closing + 1));
        if (!Array.isArray(parsed)) return undefined;
        const hits = parsed.flatMap((entry): WebSearchHit[] => {
            if (typeof entry !== "object" || entry === null) return [];
            const { title, url } = entry as { title?: unknown; url?: unknown };
            if (typeof url !== "string") return [];
            return [{ title: typeof title === "string" ? title : url, url }];
        });
        return hits.length === 0 ? undefined : hits;
    } catch {
        return undefined;
    }
}

/**
 * Where the array opened at `opening` closes, or -1 if it never does.
 *
 * The helper writes this list as prose with JSON embedded in it, and the titles inside are page
 * titles: "[PDF] RFC 9000" is an ordinary one. Taking the first `]` as the end cuts the JSON inside
 * a string, and since a failed parse is indistinguishable here from a reply that listed nothing,
 * one bracketed title used to discard every result in the list.
 */
function findArrayEnd(text: string, opening: number): number {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = opening; index < text.length; index += 1) {
        const character = text[index];
        if (inString) {
            if (escaped) escaped = false;
            else if (character === "\\") escaped = true;
            else if (character === '"') inString = false;
            continue;
        }
        if (character === '"') inString = true;
        else if (character === "[" || character === "{") depth += 1;
        else if (character === "]" || character === "}") {
            depth -= 1;
            if (depth === 0) return index;
        }
    }
    return -1;
}
