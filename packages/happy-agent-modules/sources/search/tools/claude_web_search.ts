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

export function claudeWebSearchTool(
    search: SearchModule,
    agentId: string,
    currentProviderId: string,
    isPreferred: boolean,
) {
    return defineAgentTool({
        name: "claude_web_search",
        defer: true,
        capabilities: ["Search the web and fetch individual web pages."],
        searchKeywords: ["Claude web search", "internet current information", "Anthropic search"],
        description: isPreferred
            ? "This is the preferred web search for this agent because Claude is its current provider. Omit provider_id to use the current Claude account. Use it for recent facts and documentation, and cite returned sources."
            : "Search the current web through Claude. Use it for recent facts and documentation, and cite returned sources.",
        parameters: inputSchema,
        returnType: searchAnswerSchema,
        durable: false,
        requiresAutoOrFullAccess: true,
        shouldReviewInAutoMode: () => true,
        describeAutoPermissionAction: ({ query }) =>
            `searching the web through Claude for "${query}". Access: external provider network`,
        execute: async (ctx, input: Input) =>
            await search.providerSearch(
                ctx,
                agentId,
                {
                    provider: "claude",
                    query: input.query,
                    ...(input.allowed_domains === undefined
                        ? {}
                        : { allowedDomains: input.allowed_domains }),
                    ...(input.blocked_domains === undefined
                        ? {}
                        : { blockedDomains: input.blocked_domains }),
                    ...(input.provider_id === undefined ? {} : { providerId: input.provider_id }),
                },
                currentProviderId,
            ),
        toLLM: (answer) => [{ type: "text", text: search.formatSearchAnswerForModel(answer) }],
    });
}
