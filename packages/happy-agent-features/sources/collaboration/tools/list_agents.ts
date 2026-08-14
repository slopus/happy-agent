import { defineAgentTool } from "@slopus/happy-agent-base";

import type { CollaborationFeature } from "../CollaborationFeature.js";
import {
    collaborationAgentPageQuerySchema,
    collaborationAgentPageSchema,
    type CollaborationAgentPageQuery,
} from "../CollaborationAgent.js";

/** List a bounded page from the host-owned collaboration roster. */
export function listAgentsTool(
    collaboration: CollaborationFeature,
    actingAgentId: string,
    _maxOutputCharacters = 8_000,
) {
    return defineAgentTool({
        name: "list_agents",
        description:
            "List collaborators in the durable roster. Follow nextCursor to inspect later pages.",
        parameters: collaborationAgentPageQuerySchema,
        returnType: collaborationAgentPageSchema,
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, query: CollaborationAgentPageQuery) =>
            await collaboration.listAgents(ctx, actingAgentId, query),
        toLLM: (page) => [
            {
                type: "text",
                text: collaboration.formatAgentPageForModel(page),
            },
        ],
    });
}
