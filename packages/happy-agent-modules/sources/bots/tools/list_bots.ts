import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import { botRecordSchema, type BotRecord } from "../Bot.js";
import type { BotsModule } from "../BotsModule.js";

/** List every persistent bot, archived ones included. */
export function listBotsTool(bots: BotsModule) {
    return defineAgentTool({
        name: "list_bots",
        defer: true,
        capabilities: ["List, create, and message persistent bots."],
        searchKeywords: ["bot catalog", "persistent assistants", "bot roster"],
        description:
            "List every bot on this installation: persistent single-conversation assistants, each with its own folder. The result includes each bot's ID, display name, username, status, and the folder it works in. Use send_bot_message with a bot's ID to talk to an active one.",
        parameters: Type.Object({}),
        returnType: Type.Object({ bots: Type.Array(botRecordSchema) }),
        durable: false,
        reloadable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx): Promise<{ bots: BotRecord[] }> => ({
            bots: (await bots.list(ctx)).map((bot) => structuredClone(bot) as BotRecord),
        }),
        toLLM: ({ bots: listed }) => [
            {
                type: "text",
                text:
                    listed.length === 0
                        ? "There are no bots yet."
                        : listed.map(formatBotLine).join("\n"),
            },
        ],
    });
}

function formatBotLine(bot: BotRecord): string {
    const status = bot.status === "archived" ? " (archived)" : "";
    return `- ${bot.name}${status} — id ${bot.id}, username ${bot.username}, folder ${bot.path}`;
}
