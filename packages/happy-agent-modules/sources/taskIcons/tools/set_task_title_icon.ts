import { defineAgentTool } from "@slopus/happy-agent-base";
import { Type } from "@sinclair/typebox";

import { taskNameSchema, taskIconSlugSchema, taskIdentityChangeSchema } from "../../tasks/index.js";
import type { TaskIconsModule } from "../TaskIconsModule.js";

export function setTaskTitleIconTool(icons: TaskIconsModule, agentId: string) {
    return defineAgentTool({
        name: "set_task_title_icon",
        // Loaded with the task's tools: its instructions ask it to choose its identity early.
        defer: false,
        capabilities: ["Set this task's own title and topic icon."],
        description:
            "Set this task's own short title, topic icon, or both. For an icon, choose a slug from search_task_icons; null clears it. Only this task changes. A person's choice is final for that field and cannot be replaced. Omit a field to keep it.",
        parameters: taskIdentityChangeSchema,
        returnType: Type.Object({
            queued: Type.Literal(true),
            title: Type.Optional(taskNameSchema),
            icon: Type.Optional(
                Type.Union([
                    Type.Object({
                        type: Type.Literal("library"),
                        slug: taskIconSlugSchema,
                        hash: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
                    }),
                    Type.Null(),
                ]),
            ),
        }),
        durable: true,
        transactional: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, change, call) => {
            await icons.setIdentity(ctx, agentId, change, call.id);
            return {
                queued: true as const,
                ...(change.title === undefined ? {} : { title: change.title }),
                ...(change.icon === undefined
                    ? {}
                    : { icon: change.icon === null ? null : icons.icon(change.icon) }),
            };
        },
        toLLM: (identity) => [
            {
                type: "text",
                text: `${JSON.stringify(identity)}\nThe identity change is saved and applies within moments, right after this call is recorded. Continue your task; no confirmation call is needed. A person's later choice remains final.`,
            },
        ],
    });
}
