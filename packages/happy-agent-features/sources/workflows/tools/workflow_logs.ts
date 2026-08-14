import { defineAgentTool } from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";

import { workflowIdSchema, workflowLogPageSchema, MAX_WORKFLOW_LOG_LINES } from "../Workflow.js";
import type { WorkflowsFeature } from "../WorkflowsFeature.js";

const inputSchema = Type.Object(
    {
        id: workflowIdSchema,
        cursor: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_WORKFLOW_LOG_LINES })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_WORKFLOW_LOG_LINES })),
    },
    { additionalProperties: false },
);
type Input = Static<typeof inputSchema>;

export function workflowLogsTool(feature: WorkflowsFeature, agentId: string) {
    return defineAgentTool({
        name: "workflow_logs",
        description: "Read a bounded page of workflow logs.",
        parameters: inputSchema,
        returnType: workflowLogPageSchema,
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: Input) => await feature.logs(ctx, agentId, input),
        toLLM: (page) => [
            {
                type: "text",
                text: feature.formatLogsForModel(page),
            },
        ],
    });
}
