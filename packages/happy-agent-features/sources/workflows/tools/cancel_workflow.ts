import { defineAgentTool } from "@slopus/happy-agent-base";

import {
    workflowMutationResultSchema,
    workflowMutationToolInputSchema,
    type WorkflowMutationToolInput,
} from "../Workflow.js";
import type { WorkflowsFeature } from "../WorkflowsFeature.js";

export function cancelWorkflowTool(feature: WorkflowsFeature, agentId: string) {
    return defineAgentTool({
        name: "cancel_workflow",
        description:
            "Cancel one queued, running, or paused host-managed workflow. Terminal runs remain unchanged.",
        parameters: workflowMutationToolInputSchema,
        returnType: workflowMutationResultSchema,
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: WorkflowMutationToolInput) =>
            await feature.cancelForTool(ctx, agentId, input),
        toLLM: (result) => [{ type: "text", text: feature.formatRunForModel(result.run) }],
    });
}
