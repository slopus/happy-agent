import { defineAgentTool, type AgentModuleScope } from "@slopus/happy-agent-base";
import { Type } from "@sinclair/typebox";

import type { StoriesModule } from "../StoriesModule.js";

/** Delete one of this task's or bot's live stories, with every repost of it. */
export function deleteStoryTool(stories: StoriesModule, scope: AgentModuleScope) {
    return defineAgentTool({
        name: "delete_story",
        defer: false,
        capabilities: ["Delete one of this conversation's live stories."],
        description:
            "Delete one of your live stories, and every repost of it, for everyone at once. list_stories gives the ids.",
        parameters: Type.Object({ id: Type.String() }, { additionalProperties: false }),
        returnType: Type.Object({ deleted: Type.Boolean() }),
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, { id }) => ({
            deleted: await stories.deleteOwn(ctx, scope.agent.id, id),
        }),
        toLLM: ({ deleted }) => [
            {
                type: "text",
                text: deleted ? "Deleted the story." : "You have no live story with that id.",
            },
        ],
    });
}
