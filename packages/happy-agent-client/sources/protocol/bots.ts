/** Bots: persistent single-conversation assistants with a dedicated workspace. */

import { type Static, Type } from "@sinclair/typebox";

import { agentSchema } from "./agents.js";
import {
    computeSchema,
    cuid2Schema,
    mutationIdSchema,
    Nullable,
    resourceVersionSchema,
    timestampSchema,
} from "./common.js";

/** A bot picture. Its bytes are served separately from the bot resource. */
export const botAvatarSchema = Type.Object({
    kind: Type.Literal("image"),
    source: Type.Union([Type.Literal("user"), Type.Literal("generated")]),
    thumbhash: Type.String(),
});
export type BotAvatar = Static<typeof botAvatarSchema>;

/** A human display name: nonblank, bounded, and free of ASCII control characters. */
export const botNameSchema = Type.String({
    maxLength: 256,
    minLength: 1,
    pattern: "^(?=.*\\S)[^\\x00-\\x1f\\x7f]+$",
});
export type BotName = Static<typeof botNameSchema>;

/** The immutable local folder name chosen when a bot is created. */
export const botUsernameSchema = Type.String({
    maxLength: 64,
    minLength: 1,
    pattern: "^[a-z][a-z0-9_]{0,63}$",
});
export type BotUsername = Static<typeof botUsernameSchema>;

/** A bot and its one independently versioned agent. */
export const botSchema = Type.Object({
    /** The bot's one agent, embedded in full for list rendering. */
    agent: agentSchema,
    archivedAt: Nullable(timestampSchema),
    avatar: Nullable(botAvatarSchema),
    /** Mirrors the dedicated workspace's compute. */
    compute: computeSchema,
    createdAt: timestampSchema,
    id: cuid2Schema,
    /** Whether this bot has the `admin_bot` tool role. Older compatible daemons omit it. */
    isAdmin: Type.Optional(Type.Boolean()),
    name: botNameSchema,
    /** An opaque catalog sort key. */
    orderKey: Type.String(),
    status: Type.Union([Type.Literal("active"), Type.Literal("archived")]),
    updatedAt: timestampSchema,
    /** Immutable local snake_case name and folder name. */
    username: botUsernameSchema,
    version: resourceVersionSchema,
    /** The bot's dedicated workspace, distinct from the bot and agent IDs. */
    workspaceId: cuid2Schema,
});
export type Bot = Static<typeof botSchema>;

/** `GET /v0/bots` */
export const botListResponseSchema = Type.Object({ bots: Type.Array(botSchema) });
export type BotListResponse = Static<typeof botListResponseSchema>;

/** Every single-bot JSON route answers with this. */
export const botResponseSchema = Type.Object({ bot: botSchema });
export type BotResponse = Static<typeof botResponseSchema>;

/** `POST /v0/bots` */
export const createBotRequestSchema = Type.Object({
    /** Optional client-supplied ID, which makes creation safely retryable. */
    id: Type.Optional(cuid2Schema),
    /** Grants the new bot the `admin_bot` tool role. Omitted means non-admin. */
    isAdmin: Type.Optional(Type.Boolean()),
    mutationId: Type.Optional(mutationIdSchema),
    name: botNameSchema,
    /** Omitted, the daemon derives a unique username from `name`. */
    username: Type.Optional(botUsernameSchema),
});
export type CreateBotRequest = Static<typeof createBotRequestSchema>;

/** `PATCH /v0/bots/:botId` — the immutable username is deliberately absent. */
export const renameBotRequestSchema = Type.Object({
    mutationId: Type.Optional(mutationIdSchema),
    name: botNameSchema,
    /** Explicitly forbidden even though request objects tolerate future additive fields. */
    username: Type.Optional(Type.Never()),
});
export type RenameBotRequest = Static<typeof renameBotRequestSchema>;

/** `POST /v0/bots/:botId/archive` */
export const archiveBotRequestSchema = Type.Object({
    mutationId: Type.Optional(mutationIdSchema),
});
export type ArchiveBotRequest = Static<typeof archiveBotRequestSchema>;

/** `POST /v0/bots/:botId/unarchive` */
export const unarchiveBotRequestSchema = Type.Object({
    mutationId: Type.Optional(mutationIdSchema),
});
export type UnarchiveBotRequest = Static<typeof unarchiveBotRequestSchema>;

/** `POST /v0/bots/:botId/reorder` */
export const reorderBotRequestSchema = Type.Object({
    /** The bot to place this one after, or `null` to move it first. */
    afterId: Nullable(cuid2Schema),
    mutationId: Type.Optional(mutationIdSchema),
});
export type ReorderBotRequest = Static<typeof reorderBotRequestSchema>;
