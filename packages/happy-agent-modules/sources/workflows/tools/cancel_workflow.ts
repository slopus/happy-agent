import { Type, type Static } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import { workflowIdSchema, workflowRunSchema } from "../Workflow.js";
import type { WorkflowsModule } from "../WorkflowsModule.js";

const cancelWorkflowParametersSchema = Type.Object(
    { id: workflowIdSchema },
    { additionalProperties: false },
);

type CancelWorkflowParameters = Static<typeof cancelWorkflowParametersSchema>;

export function cancelWorkflowTool(module: WorkflowsModule, agentId: string) {
    return defineAgentTool({
        name: "cancel_workflow",
        defer: true,
        capabilities: ["Run, inspect, pause, resume, and cancel multi-agent workflows."],
        searchKeywords: ["stop workflow", "abort orchestration", "cancel running agents"],
        description:
            "Stop one running or paused workflow. The agents it started are stopped too, and everything it already recorded stays readable. A workflow that has already finished is left alone.",
        parameters: cancelWorkflowParametersSchema,
        returnType: workflowRunSchema,
        durable: false,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, { id }: CancelWorkflowParameters) =>
            await module.cancel(ctx, agentId, id),
        toLLM: (run) => [{ type: "text", text: module.formatRunForModel(run) }],
    });
}
