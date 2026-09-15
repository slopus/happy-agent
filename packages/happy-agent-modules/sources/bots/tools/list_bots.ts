import { Type, type Static } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import { botRecordSchema, type BotRecord } from "../Bot.js";
import type { BotsModule } from "../BotsModule.js";

const listBotsInputSchema = Type.Object({
    hasAvatar: Type.Optional(Type.Boolean()),
});
type ListBotsInput = Static<typeof listBotsInputSchema>;

/** List every persistent bot, archived ones included. */
export function listBotsTool(bots: BotsModule) {
    return defineAgentTool({
        name: "list_bots",
        defer: true,
        capabilities: ["List, create, and message persistent bots.", "Find bots without avatars."],
        searchKeywords: ["bot catalog", "persistent assistants", "bot roster", "missing avatars"],
        description:
            "List bots on this installation, including archived bots: persistent single-conversation assistants, each with its own folder. The result includes each bot's ID, display name, username, status, avatar status, and the folder it works in. Omit hasAvatar to list all bots, set it to false to show only bots without an avatar, or true to show only bots with one. Use send_bot_message with a bot's ID to talk to an active one.",
        parameters: listBotsInputSchema,
        returnType: Type.Object({ bots: Type.Array(botRecordSchema) }),
        durable: false,
        reloadable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: ListBotsInput): Promise<{ bots: BotRecord[] }> => ({
            bots: (await bots.list(ctx))
                .filter(
                    (bot) =>
                        input.hasAvatar === undefined ||
                        (bot.avatar !== undefined) === input.hasAvatar,
                )
                .map((bot) => structuredClone(bot) as BotRecord),
        }),
        toLLM: ({ bots: listed }) => [
            {
                type: "text",
                text: listed.length === 0 ? "No bots found." : listed.map(formatBotLine).join("\n"),
            },
        ],
    });
}

function formatBotLine(bot: BotRecord): string {
    const status = bot.status === "archived" ? " (archived)" : "";
    const avatar = bot.avatar === undefined ? "no avatar" : "has avatar";
    return `- ${bot.name}${status} — id ${bot.id}, username ${bot.username}, ${avatar}, folder ${bot.path}`;
}
