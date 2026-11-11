import { Type, type Static } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";

import type { CollaborationCreator } from "../CollaborationAgent.js";
import type { CollaborationModule } from "../CollaborationModule.js";

const agentOptionsInputSchema = Type.Object(
    {
        usage: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
);
type AgentOptionsInput = Static<typeof agentOptionsInputSchema>;

const agentOptionsResultSchema = Type.Object(
    { text: Type.String() },
    { additionalProperties: false },
);

/**
 * List what this agent can create sub-agents and subtasks with now. Reading them makes them what
 * the agent knows, so later notices carry only what changed since.
 */
export function agentOptionsTool(
    collaboration: CollaborationModule,
    creator: CollaborationCreator,
    markKnown: (ctx: Context, text: string) => Promise<void>,
) {
    return defineAgentTool({
        name: "agent_options",
        defer: true,
        capabilities: ["Create, message, and coordinate coding subagents."],
        searchKeywords: ["list models", "subagent models", "harnesses", "providers", "quota"],
        description:
            "The current models you can start agents and subtasks on, by harness and provider. usage: true adds the quota each account reports.",
        parameters: agentOptionsInputSchema,
        returnType: agentOptionsResultSchema,
        durable: false,
        shouldReviewInAutoMode: () => false,
        autoReview: "never",
        execute: async (ctx, input: AgentOptionsInput) => {
            const text = collaboration.agentOptionsText(creator);
            await markKnown(ctx, text);
            return {
                text:
                    input.usage === true
                        ? `${text}\n\nUsage:\n${await collaboration.agentOptionsUsage(creator)}`
                        : text,
            };
        },
        toLLM: ({ text }) => [{ type: "text", text }],
    });
}
