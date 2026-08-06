import type { ProviderToolCallPresentation, ProviderToolCallSource } from "./ChatElement.js";

/**
 * Describes a call the provider ran on its own backend, from arguments that may still be arriving.
 *
 * The arguments are a JSON string streamed in pieces, so the query is recovered from whatever has
 * landed so far and simply stays absent until enough of it exists. Unlike the terminal's version
 * the query is not truncated here; a client owns its own overflow.
 */
export function describeProviderToolCall(
    name: string,
    argumentsText: string,
): ProviderToolCallPresentation {
    // A hosted search names its sub-action in its own arguments: the backend searches, then opens
    // what it found. Both arrive under one tool name, and only the arguments tell them apart.
    const page = readOpenedPage(argumentsText);
    if (page !== undefined) return { kind: "page_read", url: page };
    const target = readSearchTarget(name);
    if (target === undefined) {
        return { kind: "provider_tool", label: humanizeProviderToolName(name) };
    }
    const query = readQuery(argumentsText);
    return {
        kind: "search",
        sources: readSources(argumentsText),
        target: target.target,
        ...(target.method === undefined ? {} : { method: target.method }),
        ...(query === undefined ? {} : { query }),
    };
}

function readSearchTarget(
    name: string,
): { method?: "keyword" | "semantic"; target: "web" | "x" } | undefined {
    const normalized = name.trim().toLowerCase();
    if (normalized === "web_search" || normalized === "web_search_call") {
        return { target: "web" };
    }
    if (!normalized.startsWith("x_") || !normalized.includes("search")) return undefined;
    if (normalized.includes("keyword")) return { method: "keyword", target: "x" };
    if (normalized.includes("semantic")) return { method: "semantic", target: "x" };
    return { target: "x" };
}

/** Turns `x_keyword_search` into `X keyword search`, so an unknown tool still reads as words. */
export function humanizeProviderToolName(name: string): string {
    const words = name
        .trim()
        .split(/[_\-\s]+/u)
        .filter((word) => word.length > 0);
    if (words.length === 0) return "provider tool";
    return words
        .map((word, index) =>
            word.toLowerCase() === "x" ? "X" : index === 0 ? capitalize(word) : word.toLowerCase(),
        )
        .join(" ");
}

function capitalize(word: string): string {
    return `${word.slice(0, 1).toUpperCase()}${word.slice(1).toLowerCase()}`;
}

function readQuery(argumentsText: string): string | undefined {
    const trimmed = argumentsText.trim();
    if (trimmed.length === 0) return undefined;
    const complete = readCompleteValue(trimmed);
    if (complete !== undefined) {
        return typeof complete.query === "string" ? presentable(complete.query) : undefined;
    }
    const match = /"query"\s*:\s*("(?:[^"\\]|\\.)*")/u.exec(trimmed);
    if (match?.[1] === undefined) return undefined;
    try {
        const query: unknown = JSON.parse(match[1]);
        return typeof query === "string" ? presentable(query) : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Reads the sources the provider says it consulted.
 *
 * Only whole arguments carry them, so a partial stream simply has none yet. Exact duplicates are
 * dropped while first-seen order is kept, because that order is the provider's own ranking.
 */
function readSources(argumentsText: string): readonly ProviderToolCallSource[] {
    const complete = readCompleteValue(argumentsText.trim());
    if (complete === undefined || !Array.isArray(complete.sources)) return [];
    const sources: ProviderToolCallSource[] = [];
    const seen = new Set<string>();
    for (const entry of complete.sources) {
        if (typeof entry !== "object" || entry === null) continue;
        const { title, url } = entry as { title?: unknown; url?: unknown };
        if (typeof url !== "string" || !isWebUrl(url) || seen.has(url)) continue;
        seen.add(url);
        sources.push({
            url,
            ...(typeof title === "string" && title.trim().length > 0
                ? { title: title.trim() }
                : {}),
        });
    }
    return sources;
}

function readCompleteValue(
    argumentsText: string,
): { query?: unknown; sources?: unknown } | undefined {
    if (argumentsText.length === 0) return undefined;
    try {
        const parsed: unknown = JSON.parse(argumentsText);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
            return undefined;
        return parsed as { query?: unknown; sources?: unknown };
    } catch {
        return undefined;
    }
}

function isWebUrl(value: string): boolean {
    try {
        const { protocol } = new URL(value);
        return protocol === "http:" || protocol === "https:";
    } catch {
        return false;
    }
}

function presentable(query: string): string | undefined {
    const singleLine = query.replaceAll(/\s+/gu, " ").trim();
    return singleLine.length === 0 ? undefined : singleLine;
}

/**
 * The page a hosted call opened, if that is what it did.
 *
 * Read from the arguments rather than the tool name, because the name is the same either way.
 * Arguments stream in pieces, so a call still arriving simply reads as the search it belongs to
 * until enough has landed to say otherwise.
 */
function readOpenedPage(argumentsText: string): string | undefined {
    if (!argumentsText.includes("open_page")) return undefined;
    try {
        const parsed: unknown = JSON.parse(argumentsText);
        if (typeof parsed !== "object" || parsed === null) return undefined;
        const { type, url } = parsed as { type?: unknown; url?: unknown };
        if (type !== "open_page" || typeof url !== "string" || url.length === 0) return undefined;
        return url;
    } catch {
        return undefined;
    }
}
