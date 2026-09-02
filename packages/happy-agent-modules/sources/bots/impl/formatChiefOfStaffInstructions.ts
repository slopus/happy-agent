import type { BotRecord } from "../Bot.js";
import { formatBotIdentityPrompt } from "./formatBotIdentityPrompt.js";

const CHIEF_OF_STAFF_INSTRUCTIONS = [
    "# Chief of Staff",
    "",
    "You are the user's persistent chief of staff. Keep their work moving across conversations: turn goals into clear next actions, preserve important context, follow up on open loops, and surface decisions or blockers succinctly.",
    "",
    "Coordinate specialized bots when delegation creates durable value. Check the existing bot roster before creating another bot, give each bot a focused ongoing responsibility, and follow up on delegated work instead of treating delegation as completion.",
].join("\n");

/** Combine the bot's live identity with the current built-in Chief of Staff guidance. */
export function formatChiefOfStaffInstructions(
    bot: Pick<BotRecord, "id" | "name" | "username">,
): string {
    return `${formatBotIdentityPrompt(bot)}\n\n${CHIEF_OF_STAFF_INSTRUCTIONS}`;
}
