import { botNameSchema } from "@slopus/happy-agent-client";
import { Type, type Static } from "@sinclair/typebox";
import { cuid2Schema, defineAgentTool } from "@slopus/happy-agent-base";

import { BotNotFoundError, botRecordSchema } from "../Bot.js";
import type { BotsModule } from "../BotsModule.js";
import { formatOtherBotRefusal } from "../impl/formatOtherBotRefusal.js";

const setBotNameInputSchema = Type.Object(
    {
        name: botNameSchema,
        botId: Type.Optional(cuid2Schema),
    },
    { additionalProperties: false },
);
type SetBotNameInput = Static<typeof setBotNameInputSchema>;

/** Let a bot rename itself, or an admin rename any bot. */
export function setBotNameTool(bots: BotsModule, botAgentId: string) {
    return defineAgentTool({
        name: "set_bot_name",
        defer: true,
        capabilities: ["Rename bots; admin bots can rename any bot."],
        searchKeywords: ["rename bot", "bot name", "change my name", "admin bot rename"],
        description:
            "Change a bot's display name, which is also the title of its conversation. Omit botId, or pass your own bot ID, to rename yourself. Only active admin bots may supply another bot's ID, including an archived bot's; find IDs with list_bots. The username and folder never change. A renamed bot is no longer named automatically from its first message.",
        parameters: setBotNameInputSchema,
        returnType: botRecordSchema,
        durable: true,
        shouldReviewInAutoMode: () => false,
        autoReview: "never",
        execute: async (ctx, input: SetBotNameInput) => {
            const bot = await bots.forAgent(ctx, botAgentId);
            if (bot === undefined) throw new Error("Only a bot can rename itself.");
            if (bot.status === "archived") {
                throw new Error("An archived bot cannot rename bots.");
            }
            if (input.botId !== undefined && input.botId !== bot.id) {
                if (!bot.isAdmin) {
                    throw new Error(
                        formatOtherBotRefusal(
                            "rename another bot",
                            "rename yourself",
                            await bots.list(ctx),
                        ),
                    );
                }
                if ((await bots.get(ctx, input.botId)) === undefined) {
                    throw new BotNotFoundError(
                        `There is no bot with ID ${input.botId}. Find bot IDs with list_bots.`,
                    );
                }
            }
            return await bots.renameForAgent(ctx, botAgentId, input.name, input.botId);
        },
        toLLM: (bot) => [
            {
                type: "text",
                text: `The bot is now named ${JSON.stringify(bot.name)} (id ${bot.id}, username ${bot.username}).`,
            },
        ],
    });
}
