import { defineAgentTool, type AgentModuleScope } from "@slopus/happy-agent-base";
import { Type } from "@sinclair/typebox";

import type { StoriesModule } from "../StoriesModule.js";

/** This task's live stories and reposts of them, with seen counts and replies. */
export function listStoriesTool(stories: StoriesModule, scope: AgentModuleScope) {
    return defineAgentTool({
        name: "list_stories",
        defer: true,
        capabilities: [],
        searchKeywords: ["list stories", "live stories", "story replies", "who saw"],
        description:
            "List your live stories and people's reposts of them (repostOf names yours; userId is the reposter), each with how many people saw it, how many replied, and the latest 50 replies. A reply also reaches you as the person's message quoting the story.",
        parameters: Type.Object({}, { additionalProperties: false }),
        returnType: Type.Unknown(),
        shouldReviewInAutoMode: () => false,
        autoReview: "never",
        execute: async (ctx) => {
            return await stories.ofAgent(ctx, scope.agent.id);
        },
        toLLM: (result) => [{ type: "text", text: JSON.stringify(result) }],
    });
}
