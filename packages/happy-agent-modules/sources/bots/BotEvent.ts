import { Type, type Static } from "@sinclair/typebox";
import type { Context } from "@steve.kite/stdlib";

import { botRecordSchema, botTimestampSchema } from "./Bot.js";

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
]);

export type BotEvent = Static<typeof botEventSchema>;
export type BotEventListener = (ctx: Context, event: BotEvent) => Promise<void> | void;
export type BotUnsubscribe = () => void;
