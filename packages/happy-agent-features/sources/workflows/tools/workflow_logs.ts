import { defineAgentTool } from "@slopus/happy-agent-base";
import {
    workflowLogPageSchema,
    workflowLogQuerySchema,
    type WorkflowLogQuery,
} from "../Workflow.js";
import type { WorkflowsFeature } from "../WorkflowsFeature.js";

export function workflowLogsTool(feature: WorkflowsFeature, agentId: string) {
    return defineAgentTool({
        name: "workflow_logs",
        description:
            "Read a bounded page of workflow logs. Use from=end for the latest page and prev/next cursors to traverse both directions.",
        parameters: workflowLogQuerySchema,
        returnType: workflowLogPageSchema,
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: WorkflowLogQuery) => await feature.logs(ctx, agentId, input),
        toLLM: (page) => [
            {
                type: "text",
                text: feature.formatLogsForModel(page),
            },
        ],
    });
}
