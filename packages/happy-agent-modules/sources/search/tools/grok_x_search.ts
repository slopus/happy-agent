import { defineAgentTool } from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";

import { searchAnswerSchema } from "../Search.js";
import type { SearchModule } from "../SearchModule.js";

const inputSchema = Type.Object(
    {
        query: Type.String({ minLength: 2, maxLength: 20_000 }),
        latest: Type.Optional(Type.Boolean()),
        provider_id: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    },
    { additionalProperties: false },
);

type Input = Static<typeof inputSchema>;

export function grokXSearchTool(search: SearchModule, agentId: string, currentProviderId: string) {
    return defineAgentTool({
        name: "grok_x_search",
        description:
            "Search posts and discussion on X through Grok for reactions, opinion, and breaking conversation.",
        parameters: inputSchema,
        returnType: searchAnswerSchema,
        durable: false,
        requiresAutoOrFullAccess: true,
        shouldReviewInAutoMode: () => true,
        describeAutoPermissionAction: ({ query }) =>
            `searching X through Grok for "${query}". Access: external provider network`,
        execute: async (ctx, input: Input) =>
            await search.providerSearch(
                ctx,
                agentId,
                {
                    provider: "grok-x",
                    query: input.query,
                    ...(input.latest === undefined ? {} : { latest: input.latest }),
                    ...(input.provider_id === undefined ? {} : { providerId: input.provider_id }),
                },
                currentProviderId,
            ),
        toLLM: (answer) => [{ type: "text", text: search.formatSearchAnswerForModel(answer) }],
    });
}
