import { Type } from "@sinclair/typebox";

import { defineTool } from "../../types.js";
import { networkToolPermission } from "../../../runtime/networkToolPermission.js";
import { quoteVisibleExact } from "../../../permissions/quoteVisibleExact.js";
import { formatWebSearchOutput } from "../../../tools/claude/webSearch/formatWebSearchOutput.js";
import { performWebSearch } from "../../../tools/claude/webSearch/performWebSearch.js";
import type { WebSearchInput, WebSearchOutput } from "../../../tools/claude/webSearch/types.js";
import type { Model, Provider } from "@slopus/rig-execution";
import { selectClaudeWebToolModel } from "../../../tools/claude/selectClaudeWebToolModel.js";
import {
    searchCallPresentation,
    searchResultPresentation,
} from "../../../tools/webSearch/searchPresentation.js";

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

const claudeWebSearchReturnSchema = Type.Object({
    query: Type.String({ description: "The search query that was executed" }),
    results: Type.Array(Type.Union([searchResultSchema, Type.String()]), {
        description: "Search results and text commentary from the model",
    }),
    durationSeconds: Type.Number({ description: "Time taken to complete the search" }),
});

export interface ClaudeWebSearchDependencies {
    search?: (
        input: WebSearchInput,
        provider: Provider,
        model: Model,
        signal?: AbortSignal,
    ) => Promise<WebSearchOutput>;
}

export function createClaudeWebSearchTool(dependencies: ClaudeWebSearchDependencies = {}) {
    const search = dependencies.search ?? performWebSearch;

    return defineTool({
        name: "WebSearch",
        label: "WebSearch",
        description: createWebSearchDescription(),
        arguments: Type.Object(
            {
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
            },
            { additionalProperties: false },
        ),
        returnType: claudeWebSearchReturnSchema,
        ...networkToolPermission,
        describeAutoPermissionAction: ({ query }) =>
            `searching the web for ${quoteVisibleExact(query)}. Access: network access outside Rig’s shell sandbox`,
        execute: async ({ query, allowed_domains, blocked_domains }, _context, execution) => {
            if (query.trim().length < 2) {
                throw new Error("Error: Web search query must contain at least two characters");
            }
            if (allowed_domains?.length && blocked_domains?.length) {
                throw new Error(
                    "Error: Cannot specify both allowed_domains and blocked_domains in the same request",
                );
            }

            if (execution.provider === undefined || execution.model === undefined) {
                throw new Error("WebSearch requires the active provider and model.");
            }
            return search(
                {
                    query,
                    ...(allowed_domains !== undefined ? { allowed_domains } : {}),
                    ...(blocked_domains !== undefined ? { blocked_domains } : {}),
                },
                execution.provider,
                selectClaudeWebToolModel(execution.provider, execution.model),
                execution.signal,
            );
        },
        toLLM: (result) => [{ type: "text", text: formatWebSearchOutput(result) }],
        // Rig executed this one and Grok's backend executes its own, but a reader is looking at
        // the same act either way, so both reach the interface as the same thing.
        toCallPresentation: ({ query }) => searchCallPresentation(query),
        toPresentation: (result, { query }) => searchResultPresentation(result, query),
        toUI: (result) => {
            const searches = result.results.filter((item) => typeof item !== "string").length;
            const duration =
                result.durationSeconds >= 1
                    ? `${Math.round(result.durationSeconds)}s`
                    : `${Math.round(result.durationSeconds * 1000)}ms`;
            return `Completed ${searches} web ${searches === 1 ? "search" : "searches"} in ${duration}`;
        },
        toSharedCall: ({ query }) => `Searched the web for "${query}".`,
        // Count the result links only; their titles and URLs never leak.
        toSharedResult: (result) => {
            const links = result.results.reduce(
                (sum, item) => sum + (typeof item === "string" ? 0 : item.content.length),
                0,
            );
            return `Found ${links} search result${links === 1 ? "" : "s"}.`;
        },
        sharedOutputDisclosable: true,
        locks: [],
    });
}

export const claudeWebSearchTool = createClaudeWebSearchTool();

function createWebSearchDescription(): string {
    const currentMonthYear = new Intl.DateTimeFormat("en-US", {
        month: "long",
        year: "numeric",
    }).format(new Date());
    return `- Allows Claude to search the web and use the results to inform responses
- Provides up-to-date information for current events and recent data
- Returns search result information with links as markdown hyperlinks
- Use this tool for information beyond Claude's knowledge cutoff
- Searches are performed automatically within a single API call

CRITICAL REQUIREMENT:
  - After answering the user's question, include a "Sources:" section at the end of your response
  - List all relevant URLs from the search results as markdown hyperlinks: [Title](URL)
  - Never omit relevant sources from the response

Usage notes:
  - Domain filtering is supported to include or block specific websites
  - Web search is only available in the US

IMPORTANT - Use the correct year in search queries:
  - The current month is ${currentMonthYear}. Use this year when searching for recent information, documentation, or current events.
  - For example, if the user asks for the latest React docs, search for React documentation with the current year, not last year.`;
}
