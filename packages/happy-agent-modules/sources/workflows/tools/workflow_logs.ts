import { Type, type Static } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import { workflowLogPageSchema, workflowLogQuerySchema } from "../Workflow.js";
import type { WorkflowsModule } from "../WorkflowsModule.js";

/**
 * Providers require an object at the root of a tool's parameters, so the log query variants stay a
 * closed union and travel as one argument.
 */
const workflowLogsToolParametersSchema = Type.Object(
    { input: workflowLogQuerySchema },
    { additionalProperties: false },
);

type WorkflowLogsToolParameters = Static<typeof workflowLogsToolParametersSchema>;

export function workflowLogsTool(module: WorkflowsModule, agentId: string) {
    return defineAgentTool({
        name: "workflow_logs",
        defer: true,
        capabilities: ["Run, inspect, pause, resume, and cancel multi-agent workflows."],
        searchKeywords: ["workflow progress notes", "orchestration logs", "agent pipeline output"],
        description:
            "Read a workflow's progress notes, a page at a time. Ask from=end for the latest notes, and follow the cursor a page reports to read further back.",
        parameters: workflowLogsToolParametersSchema,
        returnType: workflowLogPageSchema,
        durable: true,
        reloadable: true,
        transactional: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, { input }: WorkflowLogsToolParameters) =>
            await module.logs(ctx, agentId, input),
        toLLM: (page) => [{ type: "text", text: module.formatLogsForModel(page) }],
    });
}
