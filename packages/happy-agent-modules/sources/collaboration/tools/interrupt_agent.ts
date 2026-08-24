import { Type, type Static } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import type { CollaborationModule } from "../CollaborationModule.js";
import { collaborationAgentIdSchema } from "../CollaborationAgent.js";

const interruptAgentInputSchema = Type.Object(
    {
        targetAgentId: collaborationAgentIdSchema,
    },
    { additionalProperties: false },
);
type InterruptAgentInput = Static<typeof interruptAgentInputSchema>;

/** Immediately abort a collaborator and every descendant without waiting for settlement. */
export function interruptAgentTool(collaboration: CollaborationModule, actingAgentId: string) {
    return defineAgentTool({
        name: "interrupt_agent",
        defer: true,
        capabilities: ["Create, message, and coordinate coding subagents."],
        searchKeywords: ["stop subagent", "abort collaborator", "cancel agent work"],
        description:
            "Immediately abort a collaborator's current turn and every running descendant. Nothing waits for them to settle, and the agents remain available for follow-up work later.",
        parameters: interruptAgentInputSchema,
        returnType: Type.Void(),
        durable: false,
        shouldReviewInAutoMode: () => true,
        describeAutoPermissionAction: ({ targetAgentId }) =>
            `immediately aborting collaborator "${targetAgentId}" and every running descendant without waiting for settlement; the agents remain available for follow-up work`,
        execute: async (ctx, input: InterruptAgentInput) => {
            await collaboration.interruptAgent(ctx, actingAgentId, input.targetAgentId);
        },
        toLLM: () => [
            {
                type: "text",
                text: "Aborted the collaborator and every running descendant immediately. Nothing waits for them to settle, and they remain available for follow-up work.",
            },
        ],
    });
}

export { interruptAgentInputSchema };
