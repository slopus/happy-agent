import { defineAgentTool } from "@slopus/happy-agent-base";

import {
    workflowPageQuerySchema,
    workflowPageSchema,
    type WorkflowPageQuery,
} from "../Workflow.js";
import type { WorkflowsFeature } from "../WorkflowsFeature.js";

export function listWorkflowsTool(feature: WorkflowsFeature, agentId: string) {
    return defineAgentTool({
        name: "list_workflows",
        description: "List a bounded page of host-managed workflow runs.",
        parameters: workflowPageQuerySchema,
        returnType: workflowPageSchema,
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, query: WorkflowPageQuery) =>
            await feature.listPage(ctx, agentId, query),
        toLLM: (page) => [
            {
                type: "text",
                text: feature.formatPageForModel(page),
            },
        ],
    });
}
