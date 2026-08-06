import type { SearchSource, SearchToolCallPresentation } from "../../agent/ToolCallPresentation.js";
import type { SearchToolResultPresentation } from "../../agent/ToolResultPresentation.js";
import type { WebSearchOutput } from "../claude/webSearch/types.js";

/**
 * How a search Rig ran itself is shown, in the same words as one the provider ran.
 *
 * Claude's `WebSearch` and `gemini_search` execute differently from Grok's hosted search — they
 * are real tool calls with real results, and that lifecycle is deliberately left alone. What a
 * reader sees should not depend on any of that: a search is a search, and the query and the pages
 * it consulted are the whole of what there is to show.
 */
export function searchCallPresentation(query: string): SearchToolCallPresentation {
    return { query, target: "web", type: "search" };
}

export function searchResultPresentation(
    output: WebSearchOutput,
    query: string,
): SearchToolResultPresentation {
    return {
        query: output.query.trim().length > 0 ? output.query : query,
        sources: searchSources(output),
        target: "web",
        type: "search",
    };
}

/**
 * The pages a search consulted, in the order it reported them and without repeats.
 *
 * A result also carries the model's own commentary as plain strings. That is prose for the model,
 * not a page anyone can follow, so only the structured links become sources. The same first-seen
 * order and deduplication the hosted path uses, because a reader comparing two searches should not
 * be able to tell which of them Rig executed.
 */
function searchSources(output: WebSearchOutput): readonly SearchSource[] {
    const sources: SearchSource[] = [];
    const seen = new Set<string>();
    for (const result of output.results) {
        if (typeof result === "string") continue;
        for (const hit of result.content) {
            const url = hit.url.trim();
            if (url.length === 0 || seen.has(url)) continue;
            seen.add(url);
            const title = hit.title.trim();
            sources.push(title.length === 0 ? { url } : { title, url });
        }
    }
    return sources;
}
