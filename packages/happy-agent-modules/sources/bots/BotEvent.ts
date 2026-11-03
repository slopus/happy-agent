import { Type, type Static } from "@sinclair/typebox";
import type { Context } from "@steve.kite/stdlib";

import { cuid2Schema } from "@slopus/happy-agent-base";

import { botRecordSchema, botTimestampSchema } from "./Bot.js";

const envelope = {
    eventId: Type.String({ minLength: 1, maxLength: 128 }),
    at: botTimestampSchema,
    stories: Type.Optional(Type.Boolean()),
} as const;

export const botEventSchema = Type.Union([
    Type.Object(
        {
            ...envelope,
            type: Type.Literal("bot_created"),
            bot: botRecordSchema,
            /** The agent whose tool call created the bot; absent when a person or Happy did. */
            creatorAgentId: Type.Optional(cuid2Schema),
        },
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
    /** An admin deleted the bot for good; `bot` is its last state. */
    Type.Object(
        { ...envelope, type: Type.Literal("bot_deleted"), bot: botRecordSchema },
        { additionalProperties: false },
    ),
]);

export type BotEvent = Static<typeof botEventSchema>;
export type BotEventListener = (ctx: Context, event: BotEvent) => Promise<void> | void;
export type BotUnsubscribe = () => void;
