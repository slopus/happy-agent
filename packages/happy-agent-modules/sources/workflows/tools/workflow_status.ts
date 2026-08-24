import { Type, type Static } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import { workflowIdSchema, workflowRunSchema } from "../Workflow.js";
import type { WorkflowsModule } from "../WorkflowsModule.js";

const workflowStatusParametersSchema = Type.Object(
    { id: workflowIdSchema },
    { additionalProperties: false },
);

type WorkflowStatusParameters = Static<typeof workflowStatusParametersSchema>;

export function workflowStatusTool(module: WorkflowsModule, agentId: string) {
    return defineAgentTool({
        name: "workflow_status",
        defer: true,
        capabilities: ["Run, inspect, pause, resume, and cancel multi-agent workflows."],
        searchKeywords: ["workflow progress", "running agents", "orchestration status"],
        description:
            "Read one workflow: where it got to, how many agents it has started, what it is doing now, and its latest progress notes.",
        parameters: workflowStatusParametersSchema,
        returnType: Type.Union([workflowRunSchema, Type.Undefined()]),
        durable: true,
        transactional: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, { id }: WorkflowStatusParameters) =>
            await module.status(ctx, agentId, id),
        toLLM: (run) => [
            {
                type: "text",
                text:
                    run === undefined
                        ? "There is no workflow with that ID."
                        : module.formatRunForModel(run),
            },
        ],
    });
}
