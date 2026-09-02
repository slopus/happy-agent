import { createId } from "@paralleldrive/cuid2";
import { botNameSchema, botUsernameSchema } from "@slopus/happy-agent-client";
import { Type, type Static } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import { botRecordSchema, type BotRecord } from "../Bot.js";
import type { BotsModule } from "../BotsModule.js";

const createBotToolInputSchema = Type.Object(
    {
        name: botNameSchema,
        username: Type.Optional(botUsernameSchema),
    },
    { additionalProperties: false },
);
type CreateBotToolInput = Static<typeof createBotToolInputSchema>;

/** Create one persistent bot: its identity, its folder, and its one conversation. */
export function createBotTool(bots: BotsModule, actingAgentId: string) {
    return defineAgentTool({
        name: "create_bot",
        defer: true,
        capabilities: ["List, create, and message persistent bots."],
        searchKeywords: ["new bot", "persistent assistant", "continuous chat"],
        description:
            'Create one persistent bot: a standing assistant with its own identity, folder, and one continuous conversation. Give it a human display name such as "Research Assistant". The snake_case username names the bot\'s folder on disk and cannot be changed later; leave it out to have one derived from the name. The bot answers ready for its first message through send_bot_message.',
        parameters: createBotToolInputSchema,
        returnType: botRecordSchema,
        durable: true,
        shouldReviewInAutoMode: () => false,
        // A bot outlives the call that made it, so its identity is minted once and remembered in
        // this invocation's own store. A repeated call after an interruption finds the bot it
        // already created instead of minting a duplicate.
        execute: async (ctx, input: CreateBotToolInput, call) => {
            const actingBot = await bots.forAgent(ctx, actingAgentId);
            if (actingBot !== undefined && !actingBot.isAdmin) {
                throw new Error(formatAdminBotRequired(await bots.list(ctx)));
            }
            return await bots.create(ctx, {
                ...input,
                id: await call.kv.getOrCreate(ctx, "botId", () => createId()),
            });
        },
        toLLM: (bot) => [
            {
                type: "text",
                text: `Bot created: ${bot.name} — id ${bot.id}, username ${bot.username}, folder ${bot.path}. Send it a message with send_bot_message.`,
            },
        ],
    });
}

function formatAdminBotRequired(bots: readonly BotRecord[]): string {
    const admins = bots.filter((bot) => bot.isAdmin);
    if (admins.length === 0) {
        return "Only an admin bot can create other bots. There are no admin bots on this installation.";
    }
    return [
        "Only an admin bot can create other bots. Admin bots on this installation:",
        ...admins.map(
            (bot) =>
                `- ${bot.name}${bot.status === "archived" ? " (archived)" : ""} — id ${bot.id}`,
        ),
    ].join("\n");
}
