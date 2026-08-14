import { defineAgentTool } from "@slopus/happy-agent-base";

import {
    workflowLaunchToolInputSchema,
    workflowRunSchema,
    type WorkflowLaunchToolInput,
} from "../Workflow.js";
import type { WorkflowsFeature } from "../WorkflowsFeature.js";

export function runWorkflowTool(feature: WorkflowsFeature, agentId: string) {
    return defineAgentTool({
        name: "run_workflow",
        description:
            "Start a host-managed workflow. The host owns runtime, processes, filesystem, and permissions.",
        parameters: workflowLaunchToolInputSchema,
        returnType: workflowRunSchema,
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: WorkflowLaunchToolInput) =>
            await feature.launchForTool(ctx, agentId, input),
        toLLM: (run) => [{ type: "text", text: feature.formatRunForModel(run) }],
    });
}
