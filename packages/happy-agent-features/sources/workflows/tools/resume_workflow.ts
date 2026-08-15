import { defineAgentTool } from "@slopus/happy-agent-base";

import {
    workflowMutationToolInputSchema,
    workflowMutationResultSchema,
    type WorkflowMutationToolInput,
} from "../Workflow.js";
import type { WorkflowsFeature } from "../WorkflowsFeature.js";

export function resumeWorkflowTool(feature: WorkflowsFeature, agentId: string) {
    return defineAgentTool({
        name: "resume_workflow",
        description:
            "Resume one paused host-managed workflow run. A running run is an unchanged no-op.",
        parameters: workflowMutationToolInputSchema,
        returnType: workflowMutationResultSchema,
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: WorkflowMutationToolInput) =>
            await feature.resumeForTool(ctx, agentId, input),
        toLLM: (result) => [{ type: "text", text: feature.formatRunForModel(result.run) }],
    });
}
