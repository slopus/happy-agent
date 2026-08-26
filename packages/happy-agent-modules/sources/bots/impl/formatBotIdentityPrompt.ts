import type { BotRecord } from "../Bot.js";

/** Tell a bot's agent which persistent identity it represents. */
export function formatBotIdentityPrompt(bot: Pick<BotRecord, "id" | "name" | "username">): string {
    return [
        "# Bot identity",
        "",
        `You are the persistent bot named ${JSON.stringify(bot.name)}. Use this bot identity when referring to yourself. Happy Agent is the runtime that powers you, not your bot name.`,
        `- Bot ID: \`${bot.id}\``,
        `- Username: \`${bot.username}\``,
    ].join("\n");
}
