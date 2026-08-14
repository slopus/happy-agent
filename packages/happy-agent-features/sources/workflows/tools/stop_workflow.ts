import { defineAgentTool } from "@slopus/happy-agent-base";

import {
    workflowMutationToolInputSchema,
    workflowMutationResultSchema,
    type WorkflowMutationToolInput,
} from "../Workflow.js";
import type { WorkflowsFeature } from "../WorkflowsFeature.js";

export function stopWorkflowTool(feature: WorkflowsFeature, agentId: string) {
    return defineAgentTool({
        name: "stop_workflow",
        description: "Request cancellation of one workflow run.",
        parameters: workflowMutationToolInputSchema,
        returnType: workflowMutationResultSchema,
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: WorkflowMutationToolInput) =>
            await feature.cancelForTool(ctx, agentId, input),
        toLLM: (result) => [{ type: "text", text: feature.formatRunForModel(result.run) }],
    });
}
