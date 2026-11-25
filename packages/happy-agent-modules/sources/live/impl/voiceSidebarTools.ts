import { cuid2Schema, defineAgentTool, type AnyAgentTool } from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";

import type { LiveModule } from "../LiveModule.js";

const resultSchema = Type.Object({ text: Type.String() }, { additionalProperties: false });
const toLLM = (result: Static<typeof resultSchema>) => [
    { type: "text" as const, text: result.text },
];
const sidebarSchema = Type.Object(
    {
        query: Type.Optional(Type.String({ maxLength: 256 })),
        cursor: Type.Optional(Type.String({ maxLength: 16 })),
    },
    { additionalProperties: false },
);
const conversationsSchema = Type.Object(
    {
        ids: Type.Array(cuid2Schema, { minItems: 1, maxItems: 12, uniqueItems: true }),
        turns: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
        replies: Type.Optional(Type.Integer({ minimum: 1, maximum: 3 })),
    },
    { additionalProperties: false },
);

/** Voice's fixed sidebar reads: the person's rows, and what was said in conversations. */
export function voiceSidebarTools(
    live: LiveModule,
    ownerId: string,
    agentId: string,
): AnyAgentTool[] {
    return [
        defineAgentTool({
            name: "list_sidebar",
            defer: false,
            capabilities: ["Search the conversations in the person's sidebar."],
            description:
                "Search the person's conversations, all of them, including ones the call's context does not list and ones started during the call: bots, tasks, project and workspace conversations, and their subtasks, in sidebar order. query keeps those whose title, or the project, workspace or conversation path they sit under, contains it as a case-insensitive substring; omit it for all. Returns {rows, total, nextCursor?}, at most 50 rows a page; pass nextCursor as cursor for the next page. Each row has its agent ID, title, kind, parents, the reference voice knows it by, whether it is working or needs the person and what it asks, a failed run's reason, and its last activity.",
            parameters: sidebarSchema,
            returnType: resultSchema,
            durable: true,
            shouldReviewInAutoMode: () => false,
            autoReview: "never",
            execute: async (ctx, input: Static<typeof sidebarSchema>) => ({
                text: await live.voiceSidebar(ctx, ownerId, agentId, input),
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
            autoReview: "never",
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
