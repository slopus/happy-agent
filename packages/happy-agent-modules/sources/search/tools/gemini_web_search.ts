import { defineAgentTool } from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";

import { searchAnswerSchema } from "../Search.js";
import type { SearchModule } from "../SearchModule.js";

const inputSchema = Type.Object(
    {
        query: Type.String({ minLength: 2, maxLength: 20_000 }),
        allowed_domains: Type.Optional(Type.Array(Type.String(), { maxItems: 100 })),
        blocked_domains: Type.Optional(Type.Array(Type.String(), { maxItems: 100 })),
        provider_id: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    },
    { additionalProperties: false },
);

type Input = Static<typeof inputSchema>;

export function geminiWebSearchTool(search: SearchModule, agentId: string) {
    return defineAgentTool({
        name: "gemini_web_search",
        defer: true,
        capabilities: ["Search the web and fetch individual web pages."],
        searchKeywords: ["Gemini web search", "internet current information", "Google search"],
        description:
            "Search the live web through Gemini grounding and return its answer with the sources it cited.",
        parameters: inputSchema,
        returnType: searchAnswerSchema,
        durable: false,
        reloadable: true,
        requiresAutoOrFullAccess: true,
        shouldReviewInAutoMode: () => true,
        describeAutoPermissionAction: ({ query }) =>
            `searching the web through Gemini for "${query}". Access: external provider network`,
        execute: async (ctx, input: Input) =>
            await search.providerSearch(ctx, agentId, {
                provider: "gemini",
                query: input.query,
                ...(input.allowed_domains === undefined
                    ? {}
                    : { allowedDomains: input.allowed_domains }),
                ...(input.blocked_domains === undefined
                    ? {}
                    : { blockedDomains: input.blocked_domains }),
                ...(input.provider_id === undefined ? {} : { providerId: input.provider_id }),
            }),
        toLLM: (answer) => [{ type: "text", text: search.formatSearchAnswerForModel(answer) }],
    });
}
