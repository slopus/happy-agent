import { Type, type Static } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import { workflowIdSchema, workflowRunSchema } from "../Workflow.js";
import type { WorkflowsModule } from "../WorkflowsModule.js";

const resumeWorkflowParametersSchema = Type.Object(
    { id: workflowIdSchema },
    { additionalProperties: false },
);

type ResumeWorkflowParameters = Static<typeof resumeWorkflowParametersSchema>;

export function resumeWorkflowTool(module: WorkflowsModule, agentId: string) {
    return defineAgentTool({
        name: "resume_workflow",
        defer: true,
        capabilities: ["Run, inspect, pause, resume, and cancel multi-agent workflows."],
        searchKeywords: ["continue workflow", "resume paused orchestration", "reuse agent calls"],
        description:
            "Continue a paused workflow from its last checkpoint. Every agent that already answered is reused rather than paid for again. A workflow that is already running is left alone.",
        parameters: resumeWorkflowParametersSchema,
        returnType: workflowRunSchema,
        durable: false,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, { id }: ResumeWorkflowParameters) =>
            await module.resume(ctx, agentId, id),
        toLLM: (run) => [{ type: "text", text: module.formatRunForModel(run) }],
    });
}
