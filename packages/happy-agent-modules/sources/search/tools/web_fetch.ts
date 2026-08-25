import { defineAgentTool } from "@slopus/happy-agent-base";

import type { SearchModule } from "../SearchModule.js";
import { fetchInputSchema, fetchResultSchema, type FetchInput } from "../Search.js";

/** Common provider-neutral fetch tool: one public page, returned as bounded readable text. */
export function webFetchTool(search: SearchModule, agentId: string) {
    return defineAgentTool({
        name: "web_fetch",
        defer: true,
        capabilities: ["Search the web and fetch individual web pages."],
        searchKeywords: ["fetch URL", "read web page", "download page text"],
        description: "Fetch one web page and read it as bounded text. HTML comes back as markdown.",
        parameters: fetchInputSchema,
        returnType: fetchResultSchema,
        durable: false,
        reloadable: true,
        requiresAutoOrFullAccess: true,
        shouldReviewInAutoMode: () => true,
        describeAutoPermissionAction: ({ url }) =>
            `fetching "${url}". Access: external network outside the local sandbox`,
        execute: async (ctx, input: FetchInput) => await search.fetch(ctx, agentId, input),
        toLLM: (result) => [
            {
                type: "text",
                text: search.formatFetchForModel(result),
            },
        ],
    });
}
