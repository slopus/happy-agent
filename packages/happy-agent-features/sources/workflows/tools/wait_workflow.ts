import { defineAgentTool } from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";

import { workflowIdSchema, workflowRunSchema } from "../Workflow.js";
import type { WorkflowsFeature } from "../WorkflowsFeature.js";

const inputSchema = Type.Object({ id: workflowIdSchema }, { additionalProperties: false });
type Input = Static<typeof inputSchema>;

export function waitWorkflowTool(feature: WorkflowsFeature, agentId: string) {
    return defineAgentTool({
        name: "wait_workflow",
        description:
            "Wait through the host workflow broker until a run reaches a terminal or unavailable state. The host provides durability and wakeup.",
        parameters: inputSchema,
        returnType: workflowRunSchema,
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: Input) => await feature.wait(ctx, agentId, input.id),
        toLLM: (run) => [{ type: "text", text: feature.formatRunForModel(run) }],
    });
}
