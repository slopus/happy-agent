import { defineAgentTool, type AgentModuleScope } from "@slopus/happy-agent-base";
import { Type } from "@sinclair/typebox";

import type { StoriesModule } from "../StoriesModule.js";
import { ringStoryLines } from "./ringStoryLines.js";

const listStoriesResultSchema = Type.Object(
    { live: Type.Array(Type.String()) },
    { additionalProperties: false },
);

/** The live stories in an agent's ring, for deciding what to supersede or withdraw. */
export function listStoriesTool(stories: StoriesModule, scope: AgentModuleScope) {
    return defineAgentTool({
        name: "list_stories",
        defer: true,
        capabilities: [
            "List the live stories in this task's ring, with whether the person has seen them.",
        ],
        searchKeywords: ["story", "stories", "ring", "list stories"],
        description:
            "List the live stories in this task's ring in the person's sidebar, oldest first: each one's ID, caption, which agent posted it, when, whether the person has seen it, and their reaction. Use it before post_story to know what to supersede, and to find stale stories to withdraw: anything the new work replaced, anything reverted, and anything the person already saw and reacted or replied to.",
        parameters: Type.Object({}, { additionalProperties: false }),
        returnType: listStoriesResultSchema,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx) => ({
            live: ringStoryLines(await stories.ringStories(ctx, scope.agent.id), scope.agent.id),
        }),
        toLLM: (result) => [
            {
                type: "text",
                text:
                    result.live.length === 0
                        ? "No story is live in this task's ring."
                        : [
                              `Live in this task's ring (${String(result.live.length)}):`,
                              ...result.live,
                          ].join("\n"),
            },
        ],
    });
}
