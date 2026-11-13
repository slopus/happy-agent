import type { BotRecord } from "../Bot.js";

/**
 * Tell a task's agent which bot created it and how to report back.
 *
 * The bot is named by its ID alone: its display name can change at any time, and the task's
 * system prompt must not change with it.
 */
export function formatTaskCreatorPrompt(bot: Pick<BotRecord, "id">): string {
    return `This task was created by a bot (bot ID \`${bot.id}\`). Its messages arrive as agent messages. Report progress, results, and blockers to it with send_bot_message.`;
}
