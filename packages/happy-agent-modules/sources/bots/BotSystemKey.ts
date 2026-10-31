import { Type, type Static } from "@sinclair/typebox";

export const CHIEF_OF_STAFF_SYSTEM_KEY = "chief_of_staff";

/** The name the built-in bot is seeded with. */
export const CHIEF_OF_STAFF_BOT_NAME = "Chief of Staff";

/** Internal identities for built-in bots. Add future system bots to this union. */
export const botSystemKeySchema = Type.Union([Type.Literal(CHIEF_OF_STAFF_SYSTEM_KEY)]);

export type BotSystemKey = Static<typeof botSystemKeySchema>;
