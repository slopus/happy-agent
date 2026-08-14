import { defineAgentTool } from "@slopus/happy-agent-base";

import { workflowIdSchema, workflowRunSchema, type WorkflowId } from "../Workflow.js";
import type { WorkflowsFeature } from "../WorkflowsFeature.js";
import { Type, type Static } from "@sinclair/typebox";

const inputSchema = Type.Object({ id: workflowIdSchema }, { additionalProperties: false });
type Input = Static<typeof inputSchema>;

export function workflowStatusTool(feature: WorkflowsFeature, agentId: string) {
    return defineAgentTool({
        name: "workflow_status",
        description: "Read one workflow run by ID.",
        parameters: inputSchema,
        returnType: Type.Union([workflowRunSchema, Type.Undefined()]),
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: Input) =>
            await feature.status(ctx, agentId, input.id as WorkflowId),
        toLLM: (run) => [
            {
                type: "text",
                text:
                    run === undefined
                        ? "Workflow run was not found."
                        : feature.formatRunForModel(run),
            },
        ],
    });
}
