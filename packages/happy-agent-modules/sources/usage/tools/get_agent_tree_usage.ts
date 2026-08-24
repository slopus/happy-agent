import { Type, type Static } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import { usageAgentTreeSchema, type UsageAgentTree } from "../Usage.js";
import type { UsageModule } from "../UsageModule.js";

export const getAgentTreeUsageInputSchema = Type.Object({}, { additionalProperties: false });

export type GetAgentTreeUsageInput = Static<typeof getAgentTreeUsageInputSchema>;

/** Read exact bounded lifetime usage for the current agent's authorized subtree. */
export function getAgentTreeUsageTool(module: UsageModule, agentId: string) {
    return defineAgentTool({
        name: "get_agent_tree_usage",
        defer: true,
        capabilities: ["Inspect agent token and timing usage."],
        searchKeywords: ["agent tree tokens", "subagent usage", "lifetime token total"],
        description:
            "Report exact lifetime token usage for this agent and every recursively linked descendant, including hidden and delegated agents. Access requires host authorization; completed agents remain in the bounded snapshot.",
        parameters: getAgentTreeUsageInputSchema,
        returnType: usageAgentTreeSchema,
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (_ctx, _input: GetAgentTreeUsageInput): Promise<UsageAgentTree> =>
            await module.readAgentTreeUsage(_ctx, agentId),
        toLLM: (tree) => [
            {
                type: "text",
                text: module.formatAgentTreeUsageForModel(tree),
            },
        ],
    });
}
