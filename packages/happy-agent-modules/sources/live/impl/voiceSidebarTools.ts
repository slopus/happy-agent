import { cuid2Schema, defineAgentTool, type AnyAgentTool } from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";

import type { LiveModule } from "../LiveModule.js";

const resultSchema = Type.Object({ text: Type.String() }, { additionalProperties: false });
const toLLM = (result: Static<typeof resultSchema>) => [
    { type: "text" as const, text: result.text },
];
const emptySchema = Type.Object({}, { additionalProperties: false });
const conversationsSchema = Type.Object(
    {
        ids: Type.Array(cuid2Schema, { minItems: 1, maxItems: 12, uniqueItems: true }),
        turns: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
        replies: Type.Optional(Type.Integer({ minimum: 1, maximum: 3 })),
    },
    { additionalProperties: false },
);

/** Voice's fixed sidebar reads: the person's rows, and what was said in conversations. */
export function voiceSidebarTools(live: LiveModule, ownerId: string): AnyAgentTool[] {
    return [
        defineAgentTool({
            name: "list_sidebar",
            defer: false,
            capabilities: ["Read the rows of the person's sidebar."],
            description:
                "Read the person's sidebar as {rows}, in its order: Happy, the other bots, the person's tasks, then the Surfaces they joined. Each row has its name and, unless it is a Surface, the agent ID of its conversation.",
            parameters: emptySchema,
            returnType: resultSchema,
            durable: true,
            shouldReviewInAutoMode: () => false,
            execute: async (ctx) => ({
                text: JSON.stringify(await live.voiceOutline(ctx, ownerId)),
            }),
            toLLM,
        }),
        defineAgentTool({
            name: "read_conversations",
            defer: false,
            capabilities: ["Read what was said in several conversations on this machine."],
            description:
                "Read up to 12 conversations at once, each a sidebar row's conversation or any other conversation on this machine (its agent ID): its title, whether it is running, and its latest turns (default 4), oldest first. A turn is a message from the person or another agent (such as a subtask's task or report) with the agent's last replies to it (default 1). Tool calls, their output, and reasoning are left out, and long messages are shortened.",
            parameters: conversationsSchema,
            returnType: resultSchema,
            durable: true,
            shouldReviewInAutoMode: () => false,
            execute: async (ctx, input: Static<typeof conversationsSchema>) => ({
                text: await live.readConversations(ctx, ownerId, {
                    ids: input.ids,
                    turns: input.turns ?? 4,
                    replies: input.replies ?? 1,
                }),
            }),
            toLLM,
        }),
    ];
}
