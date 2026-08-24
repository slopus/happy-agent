import { Type, type Static } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import { workflowPageQuerySchema, workflowPageSchema } from "../Workflow.js";
import type { WorkflowsModule } from "../WorkflowsModule.js";

/**
 * Providers require an object at the root of a tool's parameters, so the page query variants stay a
 * closed union and travel as one argument.
 */
const listWorkflowsToolParametersSchema = Type.Object(
    { input: workflowPageQuerySchema },
    { additionalProperties: false },
);

type ListWorkflowsToolParameters = Static<typeof listWorkflowsToolParametersSchema>;

export function listWorkflowsTool(module: WorkflowsModule, agentId: string) {
    return defineAgentTool({
        name: "list_workflows",
        defer: true,
        capabilities: ["Run, inspect, pause, resume, and cancel multi-agent workflows."],
        searchKeywords: ["workflow catalog", "workflow runs", "orchestration history"],
        description:
            "List this agent's workflows, a page at a time. Ask from=end for the most recent page, and follow the cursor a page reports to read further.",
        parameters: listWorkflowsToolParametersSchema,
        returnType: workflowPageSchema,
        durable: true,
        transactional: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, { input }: ListWorkflowsToolParameters) =>
            await module.list(ctx, agentId, input),
        toLLM: (page) => [{ type: "text", text: module.formatPageForModel(page) }],
    });
}
