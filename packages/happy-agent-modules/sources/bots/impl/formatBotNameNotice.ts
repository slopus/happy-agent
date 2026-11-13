/**
 * Tell a bot's agent what the bot is called, as a notice in the conversation.
 *
 * A name changes: a new bot names itself seconds into its first turn, and people and bots rename
 * bots. The system prompt must not change with it, so the name travels as a message instead.
 */
export function formatBotNameNotice(name: string): string {
    return [
        "# Bot name",
        `You are the bot named ${JSON.stringify(name)}. Use this name when referring to yourself; it replaces any earlier name.`,
    ].join("\n");
}
