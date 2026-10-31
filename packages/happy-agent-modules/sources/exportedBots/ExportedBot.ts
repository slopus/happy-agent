import { cuid2Schema } from "@slopus/happy-agent-base";
import { botUsernameSchema } from "@slopus/happy-agent-client";
import { Type, type Static } from "@sinclair/typebox";

/**
 * An identifier a chat service gives a person, a chat, or a message, kept as the service's own
 * string. Telegram's numeric IDs are their decimal form. Nothing interprets it; it is compared
 * exactly.
 */
export const serviceIdSchema = Type.String({
    minLength: 1,
    maxLength: 256,
    pattern: "^[^\\u0000-\\u001f\\u007f-\\u009f]+$",
});

/** A kind of exported bot: `telegram`, built in, or `bridge`, served by a bridge program. */
export const exportedBotKindSchema = Type.String({ pattern: "^[a-z][a-z0-9_]{0,31}$" });

/** The account an export uses on its service, unique within its kind. */
export const exportedBotAccountSchema = Type.String({ minLength: 1, maxLength: 128 });

/** A person's or account's handle on a service, shown as `@username`. */
export const serviceUsernameSchema = Type.String({
    pattern: "^[^\\s\\u0000-\\u001f\\u007f-\\u009f@]{1,64}$",
});

/** The longest held first message; a longer one is cut. */
export const MAX_HELD_MESSAGE_CHARACTERS = 32_000;

/** The most people one export admits. */
export const MAX_EXPORTED_BOT_ALLOWED_USERS = 256;

export const allowedUsersSchema = Type.Array(serviceIdSchema, {
    maxItems: MAX_EXPORTED_BOT_ALLOWED_USERS,
    uniqueItems: true,
});

/**
 * What happens when someone outside the allowlist writes: `ask` holds their first message and
 * asks the Chief of Staff whether to let them in; `ignore` drops it.
 */
export const unknownSendersSchema = Type.Union([Type.Literal("ask"), Type.Literal("ignore")]);
export type UnknownSenders = Static<typeof unknownSendersSchema>;

/**
 * One bot's export of one kind, as the database holds it. `settings` belongs to the kind and is
 * checked against its adapter's schema whenever it is used; it holds credentials, so no tool,
 * log, error, or status ever carries it.
 */
export const exportedBotRecordSchema = Type.Object(
    {
        botId: cuid2Schema,
        kind: exportedBotKindSchema,
        account: exportedBotAccountSchema,
        settings: Type.Unknown(),
        allowedUsers: allowedUsersSchema,
        unknownSenders: unknownSendersSchema,
        enabled: Type.Boolean(),
        createdAt: Type.Integer({ minimum: 0 }),
        updatedAt: Type.Integer({ minimum: 0 }),
    },
    { additionalProperties: false },
);
export type ExportedBotRecord = Static<typeof exportedBotRecordSchema>;

/** The first message of someone waiting to be let in. Their files are never opened. */
export const heldMessageSchema = Type.Object(
    {
        id: serviceIdSchema,
        text: Type.String({ maxLength: MAX_HELD_MESSAGE_CHARACTERS }),
        attachments: Type.Integer({ minimum: 0 }),
    },
    { additionalProperties: false },
);
export type HeldMessage = Static<typeof heldMessageSchema>;

/** Someone outside the allowlist the bot was asked about, or whom it turned away. */
export const exportedBotSenderRecordSchema = Type.Object(
    {
        botId: cuid2Schema,
        kind: exportedBotKindSchema,
        account: exportedBotAccountSchema,
        userId: serviceIdSchema,
        status: Type.Union([Type.Literal("pending"), Type.Literal("denied")]),
        chatId: Type.Optional(serviceIdSchema),
        name: Type.String({ minLength: 1, maxLength: 256 }),
        username: Type.Optional(serviceUsernameSchema),
        /** Present only while the request is pending. */
        message: Type.Optional(heldMessageSchema),
        createdAt: Type.Integer({ minimum: 0 }),
        updatedAt: Type.Integer({ minimum: 0 }),
    },
    { additionalProperties: false },
);
export type ExportedBotSenderRecord = Static<typeof exportedBotSenderRecordSchema>;

/**
 * The durable flag on a conversation subtask: which bot's export it belongs to and the one person
 * and chat it talks to. It lives in the subtask's own agent metadata so every hook can recognize an
 * exported bot's conversation from the agent alone.
 */
export const exportedBotConversationSchema = Type.Object(
    {
        kind: exportedBotKindSchema,
        botId: cuid2Schema,
        userId: serviceIdSchema,
        chatId: serviceIdSchema,
    },
    { additionalProperties: false },
);
export type ExportedBotConversation = Static<typeof exportedBotConversationSchema>;

export const exportedBotConversationMetadataSchema = Type.Object({
    exportedBot: exportedBotConversationSchema,
});

/** The routing row that sends one person's messages to the subtask holding their conversation. */
export const exportedBotConversationRecordSchema = Type.Object(
    {
        botId: cuid2Schema,
        kind: exportedBotKindSchema,
        account: exportedBotAccountSchema,
        userId: serviceIdSchema,
        chatId: serviceIdSchema,
        agentId: cuid2Schema,
        /** The person's current display name, which they may change at any time. */
        name: Type.String({ minLength: 1, maxLength: 256 }),
        username: Type.Optional(serviceUsernameSchema),
        createdAt: Type.Integer({ minimum: 0 }),
        updatedAt: Type.Integer({ minimum: 0 }),
    },
    { additionalProperties: false },
);
export type ExportedBotConversationRecord = Static<typeof exportedBotConversationRecordSchema>;

/** The longest reply one settled run sends; anything beyond it stays readable in Happy. */
export const MAX_EXPORTED_BOT_REPLY_CHARACTERS = 32_000;

/** The most files one reply carries. */
export const MAX_EXPORTED_BOT_REPLY_ATTACHMENTS = 10;

export const exportedBotReplyAttachmentSchema = Type.Object(
    {
        path: Type.String({ minLength: 1, maxLength: 4_096 }),
        mimeType: Type.String({ minLength: 1, maxLength: 255 }),
        name: Type.String({ minLength: 1, maxLength: 255 }),
        size: Type.Integer({ minimum: 0 }),
        image: Type.Boolean(),
    },
    { additionalProperties: false },
);

/** One reply owed to a person's chat, recorded in the transaction that settles the run. */
export const exportedBotReplySchema = Type.Object(
    {
        kind: exportedBotKindSchema,
        botId: cuid2Schema,
        agentId: cuid2Schema,
        userId: serviceIdSchema,
        chatId: serviceIdSchema,
        text: Type.Optional(
            Type.String({ minLength: 1, maxLength: MAX_EXPORTED_BOT_REPLY_CHARACTERS + 200 }),
        ),
        attachments: Type.Optional(
            Type.Array(exportedBotReplyAttachmentSchema, {
                minItems: 1,
                maxItems: MAX_EXPORTED_BOT_REPLY_ATTACHMENTS,
            }),
        ),
    },
    { additionalProperties: false },
);
export type ExportedBotReplyCall = Static<typeof exportedBotReplySchema>;

export const EXPORTED_BOT_REPLY_FUNCTION = "exportedBots.reply";

export const exportedBotStateSchema = Type.Union([
    /** Saved but switched off. */
    Type.Literal("disabled"),
    /** Its bot is archived or gone. */
    Type.Literal("waiting_for_bot"),
    Type.Literal("connecting"),
    /** Ready, but the program that serves it has not connected. */
    Type.Literal("waiting_for_bridge"),
    Type.Literal("connected"),
    Type.Literal("failed"),
]);
export type ExportedBotState = Static<typeof exportedBotStateSchema>;

/** Someone outside the allowlist who wrote to the bot. Their messages are never kept. */
export const ignoredSenderSchema = Type.Object(
    {
        userId: serviceIdSchema,
        username: Type.Optional(serviceUsernameSchema),
        at: Type.Integer({ minimum: 0 }),
    },
    { additionalProperties: false },
);
export type IgnoredSender = Static<typeof ignoredSenderSchema>;

/** Someone waiting to be let in, or turned away, as status shows them. */
export const exportedBotSenderStatusSchema = Type.Object(
    {
        userId: serviceIdSchema,
        name: Type.String({ minLength: 1, maxLength: 256 }),
        username: Type.Optional(serviceUsernameSchema),
        at: Type.Integer({ minimum: 0 }),
    },
    { additionalProperties: false },
);

/** What an admin bot sees about one export. Credentials are never part of it. */
export const exportedBotStatusSchema = Type.Object(
    {
        kind: exportedBotKindSchema,
        /** The service as people know it, such as "Telegram". */
        service: Type.String({ minLength: 1, maxLength: 64 }),
        botId: cuid2Schema,
        bot: Type.Optional(botUsernameSchema),
        state: exportedBotStateSchema,
        /** The export's own account on the service, such as its Telegram bot's username. */
        serviceUsername: Type.Optional(serviceUsernameSchema),
        /** Where people open a chat with that account. */
        link: Type.Optional(Type.String({ maxLength: 256 })),
        allowedUsers: allowedUsersSchema,
        unknownSenders: unknownSendersSchema,
        error: Type.Optional(Type.String({ maxLength: 1_000 })),
        ignoredSenders: Type.Array(ignoredSenderSchema),
        /** People waiting for the bot's owner to let them in, oldest first. */
        accessRequests: Type.Array(exportedBotSenderStatusSchema),
        /** People turned away, newest first, at most a few. */
        deniedUsers: Type.Array(exportedBotSenderStatusSchema),
        conversations: Type.Array(
            Type.Object(
                {
                    userId: serviceIdSchema,
                    agentId: cuid2Schema,
                    name: Type.String({ minLength: 1, maxLength: 256 }),
                },
                { additionalProperties: false },
            ),
        ),
    },
    { additionalProperties: false },
);
export type ExportedBotStatus = Static<typeof exportedBotStatusSchema>;

export const exportedBotStatusListSchema = Type.Object(
    {
        exportedBots: Type.Array(exportedBotStatusSchema),
        /** The one bot the list was narrowed to, when it was. */
        botId: Type.Optional(cuid2Schema),
    },
    { additionalProperties: false },
);
export type ExportedBotStatusList = Static<typeof exportedBotStatusListSchema>;

/**
 * The Happy bot a change is for, as a cuid2. Every tool that changes an export names it; none
 * assumes the caller.
 */
export const happyBotIdSchema = Type.String({
    minLength: 2,
    maxLength: 32,
    pattern: "^[a-z][a-z0-9]*$",
    description: "The ID of the Happy bot that is exported, from list_bots.",
});

/**
 * An allowlist as a setup tool takes it. Telegram's numeric IDs may arrive as numbers; they are
 * kept as their decimal strings.
 */
export const allowedUsersInputSchema = Type.Array(
    Type.Union([Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }), serviceIdSchema]),
    { maxItems: MAX_EXPORTED_BOT_ALLOWED_USERS },
);

export const removeExportedBotInputSchema = Type.Object(
    {
        kind: Type.String({
            minLength: 1,
            maxLength: 32,
            description: 'The kind of export to remove, "telegram" or "bridge"',
        }),
        botId: happyBotIdSchema,
    },
    { additionalProperties: false },
);
export type RemoveExportedBotInput = Static<typeof removeExportedBotInputSchema>;

/** What became of a removal: whether there was an export to remove, and what it was called. */
export const removedExportedBotSchema = Type.Object(
    {
        botId: cuid2Schema,
        kind: exportedBotKindSchema,
        removed: Type.Boolean(),
        service: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    },
    { additionalProperties: false },
);
export type RemovedExportedBot = Static<typeof removedExportedBotSchema>;

/** Let one person talk to an exported bot, or turn them away. */
export const exportedBotUserInputSchema = Type.Object(
    {
        kind: Type.String({
            minLength: 1,
            maxLength: 32,
            description: 'The kind of export, "telegram" or "bridge"',
        }),
        userId: Type.Union([
            Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
            Type.String({ minLength: 1, maxLength: 256 }),
        ]),
        botId: happyBotIdSchema,
    },
    { additionalProperties: false },
);
export type ExportedBotUserInput = Static<typeof exportedBotUserInputSchema>;

export const approvedExportedBotUserSchema = Type.Object(
    {
        botId: cuid2Schema,
        /** The bot's name, so a result about another bot's export says which. */
        bot: Type.String({ minLength: 1, maxLength: 256 }),
        kind: exportedBotKindSchema,
        service: Type.String({ minLength: 1, maxLength: 64 }),
        userId: serviceIdSchema,
        name: Type.String({ minLength: 1, maxLength: 256 }),
        /** Whether the message they were waiting with went to their conversation. */
        delivered: Type.Boolean(),
        agentId: Type.Optional(cuid2Schema),
        /** The guest user who now speaks for this person in Happy. */
        guestUserId: cuid2Schema,
    },
    { additionalProperties: false },
);
export type ApprovedExportedBotUser = Static<typeof approvedExportedBotUserSchema>;

export const deniedExportedBotUserSchema = Type.Object(
    {
        botId: cuid2Schema,
        bot: Type.String({ minLength: 1, maxLength: 256 }),
        kind: exportedBotKindSchema,
        service: Type.String({ minLength: 1, maxLength: 64 }),
        userId: serviceIdSchema,
        /** Whether they were on the allowlist until now. */
        wasAllowed: Type.Boolean(),
        /** Whether a held first message was thrown away. */
        discarded: Type.Boolean(),
    },
    { additionalProperties: false },
);
export type DeniedExportedBotUser = Static<typeof deniedExportedBotUserSchema>;
