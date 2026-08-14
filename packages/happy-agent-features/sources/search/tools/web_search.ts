import { defineAgentTool } from "@slopus/happy-agent-base";

import type { SearchFeature } from "../SearchFeature.js";
import { searchPageSchema, searchQuerySchema, type SearchQuery } from "../Search.js";

/** Common provider-neutral web search tool. */
export function webSearchTool(search: SearchFeature, agentId: string) {
    return defineAgentTool({
        name: "web_search",
        description:
            "Search the configured web/search backend with a zero-based result offset. Results are bounded; follow nextCursor exactly for more.",
        parameters: searchQuerySchema,
        returnType: searchPageSchema,
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, query: SearchQuery) => await search.search(ctx, agentId, query),
        toLLM: (page) => [
            {
                type: "text",
                text: search.formatSearchForModel(page),
            },
        ],
    });
}
