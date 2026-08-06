import { Type } from "@sinclair/typebox";

import { defineTool } from "../../agent/types.js";
import { networkToolPermission } from "../../runtime/networkToolPermission.js";
import { quoteVisibleExact } from "../../permissions/quoteVisibleExact.js";
import { formatWebSearchOutput } from "../claude/webSearch/formatWebSearchOutput.js";
import type { WebSearchInput, WebSearchOutput } from "../claude/webSearch/types.js";
import { performGeminiWebSearch } from "./performGeminiWebSearch.js";
import { searchCallPresentation, searchResultPresentation } from "./searchPresentation.js";

const searchResultSchema = Type.Object({
    tool_use_id: Type.String({ description: "ID of the web search tool use" }),
    content: Type.Array(
        Type.Object({
            title: Type.String({ description: "The title of the search result" }),
            url: Type.String({ description: "The URL of the search result" }),
        }),
        { description: "Search result links" },
    ),
});

const geminiSearchReturnSchema = Type.Object({
    query: Type.String({ description: "The search query that was executed" }),
    results: Type.Array(Type.Union([searchResultSchema, Type.String()]), {
        description: "Search results and text commentary from Gemini",
    }),
    durationSeconds: Type.Number({ description: "Time taken to complete the search" }),
});

export interface GeminiSearchDependencies {
    search?: (input: WebSearchInput, signal?: AbortSignal) => Promise<WebSearchOutput>;
}

export function createGeminiSearchTool(
    apiKey: string,
    dependencies: GeminiSearchDependencies = {},
) {
    const search =
        dependencies.search ??
        ((input: WebSearchInput, signal?: AbortSignal) =>
            performGeminiWebSearch(input, {
                apiKey,
                ...(signal === undefined ? {} : { signal }),
            }));

    return defineTool({
        name: "gemini_search",
        label: "Gemini search",
        description: `Search the web with Gemini and return current information with source links.

Use this tool for recent or external information. Include relevant source links as markdown hyperlinks in the final response. Domain filtering is supported.`,
        arguments: Type.Object({
            query: Type.String({ minLength: 2, description: "The search query to use" }),
            allowed_domains: Type.Optional(
                Type.Array(Type.String(), {
                    description: "Only include search results from these domains",
                }),
            ),
            blocked_domains: Type.Optional(
                Type.Array(Type.String(), {
                    description: "Never include search results from these domains",
                }),
            ),
        }),
        returnType: geminiSearchReturnSchema,
        ...networkToolPermission,
        describeAutoPermissionAction: ({ query }) =>
            `searching the web with Gemini for ${quoteVisibleExact(query)}. Access: network access outside Rig’s shell sandbox`,
        execute: async ({ query, allowed_domains, blocked_domains }, _context, execution) => {
            if (query.trim().length < 2) {
                throw new Error("Error: Gemini search query must contain at least two characters");
            }
            if (allowed_domains?.length && blocked_domains?.length) {
                throw new Error(
                    "Error: Cannot specify both allowed_domains and blocked_domains in the same request",
                );
            }

            return search(
                {
                    query,
                    ...(allowed_domains !== undefined ? { allowed_domains } : {}),
                    ...(blocked_domains !== undefined ? { blocked_domains } : {}),
                },
                execution.signal,
            );
        },
        toLLM: (result) => [{ type: "text", text: formatWebSearchOutput(result) }],
        // Which backend answered is Rig's business, not the reader's: this shows the same row a
        // Claude or a provider-run search shows.
        toCallPresentation: ({ query }) => searchCallPresentation(query),
        toPresentation: (result, { query }) => searchResultPresentation(result, query),
        toUI: (result) => {
            const searches = result.results.filter((item) => typeof item !== "string").length;
            const duration =
                result.durationSeconds >= 1
                    ? `${Math.round(result.durationSeconds)}s`
                    : `${Math.round(result.durationSeconds * 1000)}ms`;
            return `Completed ${searches} Gemini ${searches === 1 ? "search" : "searches"} in ${duration}`;
        },
        locks: [],
    });
}
