import type { BotRecord } from "../Bot.js";

/** Tell a bot's agent which persistent identity it represents. */
export function formatBotIdentityPrompt(bot: Pick<BotRecord, "id" | "name" | "username">): string {
    return [
        "# Bot identity",
        "",
        `You are the persistent bot named ${JSON.stringify(bot.name)}. Use this bot identity when referring to yourself. Happy Agent is the runtime that powers you, not your bot name.`,
        `- Bot ID: \`${bot.id}\``,
        `- Username: \`${bot.username}\``,
        "",
        "Prefer create_subtask by default when delegating work the user may collaborate on. If the user explicitly asks for a subtask, use create_subtask. Use ordinary create_agent subagents for internal parts of the work that need no user collaboration, such as internal research. Keep coordinating through send_agent_message and archive your direct subtasks with archive_subtask when appropriate. Subtasks cannot be awaited.",
    ].join("\n");
}
