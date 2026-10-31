import { defineAgentTool, type AgentModuleScope } from "@slopus/happy-agent-base";
import { Type } from "@sinclair/typebox";

import type { BotsModule } from "../../bots/index.js";
import type { TasksModule } from "../../tasks/index.js";
import type { StoriesModule } from "../StoriesModule.js";

const nobody = { agentId: null, userId: null };

/** Read this agent's own card as every member sees it now: who set each part, and its stories. */
export function getCardTool(
    stories: StoriesModule,
    tasks: TasksModule,
    bots: BotsModule,
    scope: AgentModuleScope,
) {
    const agentId = scope.agent.id;
    return defineAgentTool({
        name: "get_card",
        defer: false,
        capabilities: [
            "Read this conversation's own card in the sidebar: title, icon, status, stories.",
        ],
        description:
            "Read your own card in the person's sidebar as it is now: its title and icon and who set them, your status line, your stories (live first, then those that ended in the last 7 days, with who took one down and who saw it), and the choices about what shows under it. A person may have renamed it or taken a story down since you last looked.",
        parameters: Type.Object({}, { additionalProperties: false }),
        returnType: Type.Unknown(),
        shouldReviewInAutoMode: () => false,
        execute: async (ctx) => {
            const task = await tasks.forAgent(ctx, agentId);
            const bot = task === undefined ? await bots.forAgent(ctx, agentId) : undefined;
            const person = { agentId: null, userId: task?.ownerUserId ?? null };
            const children = task === undefined ? [] : await tasks.children(ctx, task.id);
            return {
                title: {
                    text: task?.name ?? bot?.name ?? "",
                    by: task?.nameAgentChosen === true ? { agentId, userId: null } : nobody,
                },
                icon:
                    task?.icon === undefined
                        ? null
                        : {
                              slug: task.icon,
                              by: task.iconConfigured === true ? person : { agentId, userId: null },
                          },
                status: await stories.statusOf(ctx, agentId),
                stories: (await stories.list(ctx, { agentId })).map((story) => ({
                    id: story.artifactId,
                    audience: story.audience,
                    caption: story.caption,
                    media: story.media,
                    postedAt: story.postedAt,
                    expiresAt: story.expiresAt,
                    state: story.state,
                    takenDownBy: story.takenDownBy,
                    seenBy: story.seenBy,
                    replies: story.replies,
                })),
                children: children.map(({ ref, visibility, by }) => ({ ref, visibility, by })),
            };
        },
        toLLM: (card) => [{ type: "text", text: JSON.stringify(card) }],
    });
}
