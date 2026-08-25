import { Type, type Static } from "@sinclair/typebox";
import { agentId as contextAgentId, defineAgentTool } from "@slopus/happy-agent-base";

import type { UsageModule } from "../UsageModule.js";
import {
    usageAgentIdSchema,
    usageAggregateQuerySchema,
    usageSummarySchema,
    type UsageSummary,
} from "../Usage.js";

export const getAgentUsageInputSchema = Type.Object(
    {
        aggregate: Type.Optional(Type.Boolean()),
        cursor: Type.Optional(usageAggregateQuerySchema.properties.cursor),
        maxGroups: Type.Optional(usageAggregateQuerySchema.properties.maxGroups),
    },
    { additionalProperties: false },
);

export const getUsageInputSchema = Type.Object(
    {
        ...getAgentUsageInputSchema.properties,
        target: Type.Optional(usageAgentIdSchema),
    },
    { additionalProperties: false },
);

export type GetAgentUsageInput = Static<typeof getAgentUsageInputSchema>;
export type GetUsageInput = Static<typeof getUsageInputSchema>;

/**
 * Read one agent's usage aggregate, or the whole collection when constructed
 * without an agent ID and called from a host-neutral context.
 */
export function getUsageTool(module: UsageModule): ReturnType<typeof getHostUsageTool>;
export function getUsageTool(
    module: UsageModule,
    agentId: string,
): ReturnType<typeof getAgentUsageTool>;
export function getUsageTool(module: UsageModule, agentId?: string) {
    if (agentId === undefined) return getHostUsageTool(module);
    return getAgentUsageTool(module, agentId);
}

function getAgentUsageTool(module: UsageModule, agentId: string) {
    return defineAgentTool({
        name: "get_usage",
        defer: true,
        capabilities: ["Inspect agent token and timing usage."],
        searchKeywords: ["token usage", "timing", "model consumption", "usage breakdown"],
        description:
            "Read this agent's bounded token and timing usage. Set aggregate=true to group the totals, and follow a returned cursor to continue.",
        parameters: getAgentUsageInputSchema,
        returnType: usageSummarySchema,
        durable: true,
        reloadable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: GetAgentUsageInput): Promise<UsageSummary> => {
            const owner = contextAgentId(ctx);
            if (owner !== undefined && agentId !== owner) {
                throw new Error("Usage can only be read for the current agent.");
            }
            if ("target" in input) {
                throw new Error("Usage can only be read for the current agent.");
            }
            const query = {
                ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
                ...(input.maxGroups === undefined ? {} : { maxGroups: input.maxGroups }),
            };
            /*
             * A host-neutral caller may use the existing `aggregate` flag
             * even when a tool was created from an agent scope.  Agent
             * contexts still remain self-scoped through UsageModule's access
             * boundary.
             */
            if (owner === undefined && input.aggregate === true) {
                return await module.aggregate(ctx, query);
            }
            return await module.read(ctx, agentId, query);
        },
        toLLM: (summary) => [
            {
                type: "text",
                text: module.formatForModel(summary),
            },
        ],
    });
}

function getHostUsageTool(module: UsageModule) {
    return defineAgentTool({
        name: "get_usage",
        defer: true,
        capabilities: ["Inspect agent token and timing usage."],
        searchKeywords: ["token usage", "timing", "model consumption", "usage breakdown"],
        description:
            "Read bounded token and timing usage for one target or the whole collection from a host-neutral context.",
        parameters: getUsageInputSchema,
        returnType: usageSummarySchema,
        durable: true,
        reloadable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: GetUsageInput): Promise<UsageSummary> => {
            const owner = contextAgentId(ctx);
            const query = {
                ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
                ...(input.maxGroups === undefined ? {} : { maxGroups: input.maxGroups }),
            };
            if (owner !== undefined) {
                if (input.target !== undefined && input.target !== owner) {
                    throw new Error("Usage can only be read for the current agent.");
                }
                return await module.read(ctx, owner, query);
            }
            return await module.aggregate(ctx, {
                ...(input.target === undefined ? {} : { agentId: input.target }),
                ...query,
            });
        },
        toLLM: (summary) => [
            {
                type: "text",
                text: module.formatForModel(summary),
            },
        ],
    });
}
