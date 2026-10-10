import type { BotRecord } from "../Bot.js";

/** Tell a task's agent which bot created it and how to report back. */
export function formatTaskCreatorPrompt(bot: Pick<BotRecord, "id" | "name">): string {
    return `This task was created by the bot named ${JSON.stringify(bot.name)} (bot ID \`${bot.id}\`). Its messages arrive as agent messages. Report progress, results, and blockers to it with send_bot_message.`;
}
