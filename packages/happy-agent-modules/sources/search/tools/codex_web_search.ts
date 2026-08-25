import { defineAgentTool } from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";

import { searchAnswerSchema } from "../Search.js";
import type { SearchModule } from "../SearchModule.js";

const inputSchema = Type.Object(
    {
        query: Type.String({ minLength: 2, maxLength: 20_000 }),
        domains: Type.Optional(Type.Array(Type.String(), { maxItems: 100 })),
        provider_id: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    },
    { additionalProperties: false },
);

type Input = Static<typeof inputSchema>;

export function codexWebSearchTool(
    search: SearchModule,
    agentId: string,
    currentProviderId: string,
    isPreferred: boolean,
) {
    return defineAgentTool({
        name: "codex_web_search",
        defer: true,
        capabilities: ["Search the web and fetch individual web pages."],
        searchKeywords: ["Codex web search", "internet current information", "OpenAI search"],
        description: isPreferred
            ? "This is the preferred web search for this agent because Codex is its current provider. Omit provider_id to use the current Codex account. Use it when current documentation, releases, or facts need direct sources."
            : "Research the live web through Codex when current documentation, releases, or facts need direct sources.",
        parameters: inputSchema,
        returnType: searchAnswerSchema,
        durable: false,
        reloadable: true,
        requiresAutoOrFullAccess: true,
        shouldReviewInAutoMode: () => true,
        describeAutoPermissionAction: ({ query }) =>
            `searching the web through Codex for "${query}". Access: external provider network`,
        execute: async (ctx, input: Input) =>
            await search.providerSearch(
                ctx,
                agentId,
                {
                    provider: "codex",
                    query: input.query,
                    ...(input.domains === undefined ? {} : { allowedDomains: input.domains }),
                    ...(input.provider_id === undefined ? {} : { providerId: input.provider_id }),
                },
                currentProviderId,
            ),
        toLLM: (answer) => [{ type: "text", text: search.formatSearchAnswerForModel(answer) }],
    });
}
