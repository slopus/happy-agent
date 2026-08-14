import { defineAgentTool } from "@slopus/happy-agent-base";

import type { SearchFeature } from "../SearchFeature.js";
import { fetchInputSchema, fetchResultSchema, type FetchInput } from "../Search.js";

/** Common provider-neutral fetch tool over the configured search backend. */
export function webFetchTool(search: SearchFeature, agentId: string) {
    return defineAgentTool({
        name: "web_fetch",
        description:
            "Fetch bounded text from one result URL through the configured search backend.",
        parameters: fetchInputSchema,
        returnType: fetchResultSchema,
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: FetchInput) => await search.fetch(ctx, agentId, input),
        toLLM: (result) => [
            {
                type: "text",
                text: search.formatFetchForModel(result),
            },
        ],
    });
}
