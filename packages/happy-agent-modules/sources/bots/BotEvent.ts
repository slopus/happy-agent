import { Type, type Static } from "@sinclair/typebox";
import type { Context } from "@steve.kite/stdlib";

import { botMembershipSchema, botRecordSchema, botTimestampSchema } from "./Bot.js";

const envelope = {
    eventId: Type.String({ minLength: 1, maxLength: 128 }),
    at: botTimestampSchema,
} as const;

export const botEventSchema = Type.Union([
    Type.Object(
        { ...envelope, type: Type.Literal("bot_created"), bot: botRecordSchema },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...envelope,
            type: Type.Literal("bot_updated"),
            bot: botRecordSchema,
            previousBot: botRecordSchema,
        },
        { additionalProperties: false },
    ),
    /** One person's `hidden` or `unread` on the bot changed; the bot itself did not. */
    Type.Object(
        {
            ...envelope,
            type: Type.Literal("bot_membership_updated"),
            bot: botRecordSchema,
            membership: botMembershipSchema,
        },
        { additionalProperties: false },
    ),
    /** An admin deleted the bot for good; `bot` is its last state. */
    Type.Object(
        { ...envelope, type: Type.Literal("bot_deleted"), bot: botRecordSchema },
        { additionalProperties: false },
    ),
]);

export type BotEvent = Static<typeof botEventSchema>;
export type BotEventListener = (ctx: Context, event: BotEvent) => Promise<void> | void;
export type BotUnsubscribe = () => void;
