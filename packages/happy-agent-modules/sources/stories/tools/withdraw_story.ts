import {
    agentPermissionMode,
    cuid2Schema,
    defineAgentTool,
    type AgentModuleScope,
} from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";

import type { StoriesModule } from "../StoriesModule.js";
import { StoryInputError } from "../StoryErrors.js";
import { ringStoryLines } from "./ringStoryLines.js";

const withdrawStoryToolInputSchema = Type.Object(
    {
        storyIds: Type.Array(cuid2Schema, {
            minItems: 1,
            maxItems: 10,
            description: "Live stories in this task's ring to take out of it.",
        }),
    },
    { additionalProperties: false },
);
type WithdrawStoryToolInput = Static<typeof withdrawStoryToolInputSchema>;

const withdrawStoryResultSchema = Type.Object(
    {
        withdrawn: Type.Array(cuid2Schema),
        alreadyEnded: Type.Array(cuid2Schema),
        live: Type.Array(Type.String()),
    },
    { additionalProperties: false },
);

/** Take stale stories out of an agent's ring. */
export function withdrawStoryTool(stories: StoriesModule, scope: AgentModuleScope) {
    return defineAgentTool({
        name: "withdraw_story",
        defer: true,
        capabilities: [
            "Take stale stories out of this task's ring in the person's sidebar: superseded or reverted work, or something the person already acknowledged.",
        ],
        searchKeywords: ["story", "withdraw story", "remove story", "stale story", "ring"],
        description: [
            "Take stories out of this task's ring in the person's sidebar. Withdraw a story as soon as it went stale: the work it shows was superseded, reverted, or never shipped after all, or the person already acknowledged it by watching it, reacting, or replying about it. An old story left in the ring is noise, so withdraw aggressively; when you are posting a new story anyway, supersede instead.",
            "Any live story in this task's ring may be withdrawn, whichever agent of the task posted it. The story stays in the conversation and the person can still repost it; it only leaves the ring.",
        ].join("\n\n"),
        parameters: withdrawStoryToolInputSchema,
        returnType: withdrawStoryResultSchema,
        durable: true,
        // Only the person sees the ring, and nothing reaches anyone else.
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: WithdrawStoryToolInput) => {
            if (agentPermissionMode(ctx) === "read_only") {
                throw new StoryInputError("Read only mode cannot withdraw a story.");
            }
            const result = await stories.withdraw(ctx, {
                agentId: scope.agent.id,
                storyIds: input.storyIds,
            });
            const withdrawn: string[] = result.withdrawn.slice();
            const alreadyEnded: string[] = result.alreadyEnded.slice();
            return {
                withdrawn,
                alreadyEnded,
                live: ringStoryLines(result.live, scope.agent.id),
            };
        },
        toLLM: (result) => [
            {
                type: "text",
                text: [
                    result.withdrawn.length === 0
                        ? "Withdrew nothing."
                        : `Withdrew ${result.withdrawn.join(", ")}.`,
                    result.alreadyEnded.length === 0
                        ? ""
                        : `Already out of the ring: ${result.alreadyEnded.join(", ")}.`,
                    result.live.length === 0
                        ? "The ring is empty now."
                        : `Live in the ring now (${String(result.live.length)}):`,
                    ...result.live,
                ]
                    .filter((line) => line.length > 0)
                    .join("\n"),
            },
        ],
    });
}
