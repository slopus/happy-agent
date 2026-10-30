import { Type, type Static } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import type { CollaborationModule } from "../CollaborationModule.js";
import { collaborationAgentIdSchema } from "../CollaborationAgent.js";

const archiveAgentInputSchema = Type.Object(
    {
        targetAgentId: collaborationAgentIdSchema,
    },
    { additionalProperties: false },
);
type ArchiveAgentInput = Static<typeof archiveAgentInputSchema>;

/** Archive a collaborator this agent created, giving its collaborator slot back. */
export function archiveAgentTool(collaboration: CollaborationModule, actingAgentId: string) {
    return defineAgentTool({
        name: "archive_agent",
        defer: true,
        capabilities: ["Create, message, and coordinate coding subagents."],
        searchKeywords: ["archive subagent", "remove collaborator", "free collaborator slot"],
        description:
            "Archive a collaborator you created, for example one that failed because its model or provider no longer works. To retry its work on a working model, switch it with model fields on send_agent_message, or archive it and create a new collaborator. Stops its current work and running descendants, but marks only that collaborator archived. It no longer counts toward the collaborator limit and can no longer receive messages. Conversation history remains, and repeating archival is harmless. Use archive_subtask for subtasks.",
        parameters: archiveAgentInputSchema,
        returnType: Type.Void(),
        durable: true,
        transactional: true,
        shouldReviewInAutoMode: () => true,
        describeAutoPermissionAction: ({ targetAgentId }) =>
            `archiving collaborator "${targetAgentId}" and stopping its current work and running descendants, while preserving its conversation history; it can no longer receive messages`,
        execute: async (ctx, input: ArchiveAgentInput) => {
            await collaboration.archiveAgent(ctx, actingAgentId, input.targetAgentId);
        },
        toLLM: () => [
            {
                type: "text",
                text: "Archived the collaborator. Its place in the collaborator limit is free, its conversation history is preserved, and running descendants were stopped, not archived.",
            },
        ],
    });
}

export { archiveAgentInputSchema };
