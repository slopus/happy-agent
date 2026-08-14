import { Type, type Static } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import type { UsageFeature } from "../UsageFeature.js";
import {
    usageAgentIdSchema,
    usageAggregateQuerySchema,
    usageSummarySchema,
    type UsageSummary,
} from "../Usage.js";

export const getUsageInputSchema = Type.Object(
    {
        aggregate: Type.Optional(Type.Boolean()),
        target: Type.Optional(usageAgentIdSchema),
        cursor: Type.Optional(usageAggregateQuerySchema.properties.cursor),
        maxGroups: Type.Optional(usageAggregateQuerySchema.properties.maxGroups),
    },
    { additionalProperties: false },
);

export type GetUsageInput = Static<typeof getUsageInputSchema>;

/** Read this agent's usage aggregate; cross-agent collection reads stay host-only. */
export function getUsageTool(feature: UsageFeature, agentId: string) {
    return defineAgentTool({
        name: "get_usage",
        description:
            "Read bounded token and timing usage for this agent. Set aggregate to true to request grouped totals.",
        parameters: getUsageInputSchema,
        returnType: usageSummarySchema,
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: GetUsageInput): Promise<UsageSummary> => {
            if (input.target !== undefined && input.target !== agentId) {
                throw new Error("Usage can only be read for the current agent.");
            }
            const query = {
                ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
                ...(input.maxGroups === undefined ? {} : { maxGroups: input.maxGroups }),
            };
            /*
             * Aggregate is intentionally scoped to this agent.  Collection
             * totals remain a host API and cannot become a cross-agent model
             * read by setting a boolean in tool arguments.
             */
            return await feature.read(ctx, agentId, query);
        },
        toLLM: (summary) => [
            {
                type: "text",
                text: feature.formatForModel(summary),
            },
        ],
    });
}
