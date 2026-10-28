import { Type, type Static } from "@sinclair/typebox";

export const CHIEF_OF_STAFF_SYSTEM_KEY = "chief_of_staff";

/** The built-in bot's name. Its system key keeps the name it was first seeded under. */
export const HAPPY_BOT_NAME = "Happy";

/** Internal identities for built-in bots. Add future system bots to this union. */
export const botSystemKeySchema = Type.Union([Type.Literal(CHIEF_OF_STAFF_SYSTEM_KEY)]);

export type BotSystemKey = Static<typeof botSystemKeySchema>;
