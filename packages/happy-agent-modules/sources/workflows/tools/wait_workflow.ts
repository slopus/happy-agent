import { Type, type Static } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import { workflowIdSchema, workflowRunSchema } from "../Workflow.js";
import type { WorkflowsModule } from "../WorkflowsModule.js";

const waitWorkflowParametersSchema = Type.Object(
    { id: workflowIdSchema },
    { additionalProperties: false },
);

type WaitWorkflowParameters = Static<typeof waitWorkflowParametersSchema>;

export function waitWorkflowTool(module: WorkflowsModule, agentId: string) {
    return defineAgentTool({
        name: "wait_workflow",
        defer: true,
        capabilities: ["Run, inspect, pause, resume, and cancel multi-agent workflows."],
        searchKeywords: ["wait for workflow", "join orchestration", "workflow completion"],
        description:
            "Wait until a workflow stops. It waits for any duration, so call it once rather than polling workflow_status. Cancelling this call cancels only the wait: the workflow keeps running and can still be read with workflow_status and workflow_logs.",
        parameters: waitWorkflowParametersSchema,
        returnType: workflowRunSchema,
        durable: false,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, { id }: WaitWorkflowParameters) => await module.wait(ctx, agentId, id),
        toLLM: (run) => [{ type: "text", text: module.formatRunForModel(run) }],
    });
}
