import { cuid2Schema } from "@slopus/happy-agent-base";
import { botAvatarSchema, botNameSchema, botUsernameSchema } from "@slopus/happy-agent-client";
import { Type, type Static } from "@sinclair/typebox";

export const botStatusSchema = Type.Union([Type.Literal("active"), Type.Literal("archived")]);
export const botOrderKeySchema = Type.String({
    minLength: 1,
    maxLength: 64,
    pattern: "^[0-9]+$",
});
export const botVersionSchema = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
export const botTimestampSchema = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
export const botPathSchema = Type.String({ minLength: 1, maxLength: 4_096 });

/** Durable state owned by the bot catalog. The agent remains independently owned by Agent Base. */
export const botRecordSchema = Type.Object(
    {
        id: cuid2Schema,
        isAdmin: Type.Boolean(),
        name: botNameSchema,
        username: botUsernameSchema,
        workspaceId: cuid2Schema,
        workspaceVersion: botVersionSchema,
        workspaceUpdatedAt: botTimestampSchema,
        agentId: cuid2Schema,
        path: botPathSchema,
        status: botStatusSchema,
        avatar: Type.Optional(botAvatarSchema),
        orderKey: botOrderKeySchema,
        version: botVersionSchema,
        createdAt: botTimestampSchema,
        updatedAt: botTimestampSchema,
        archivedAt: Type.Optional(botTimestampSchema),
    },
    { additionalProperties: false },
);

export const createBotInputSchema = Type.Object(
    {
        id: Type.Optional(cuid2Schema),
        isAdmin: Type.Optional(Type.Boolean()),
        name: botNameSchema,
        username: Type.Optional(botUsernameSchema),
    },
    { additionalProperties: false },
);

/** The validated image asset this module persists beside public avatar metadata. Always WebP. */
export const botAvatarAssetSchema = Type.Object(
    {
        bytes: Type.Uint8Array({ minByteLength: 1, maxByteLength: 8 * 1024 * 1024 }),
        contentHash: Type.String({
            minLength: 64,
            maxLength: 64,
            pattern: "^[a-f0-9]{64}$",
        }),
        etag: Type.String({ minLength: 66, maxLength: 66, pattern: '^"[a-f0-9]{64}"$' }),
        height: Type.Integer({ minimum: 1, maximum: 16_384 }),
        thumbhash: Type.String({ minLength: 4, maxLength: 128 }),
        width: Type.Integer({ minimum: 1, maximum: 16_384 }),
    },
    { additionalProperties: false },
);

export type BotRecord = Static<typeof botRecordSchema>;
export type BotStatus = Static<typeof botStatusSchema>;
export type CreateBotInput = Static<typeof createBotInputSchema>;
export type BotAvatarAsset = Static<typeof botAvatarAssetSchema>;

export class BotConflictError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "BotConflictError";
    }
}

export class BotNotFoundError extends Error {
    constructor(message = "The bot was not found.") {
        super(message);
        this.name = "BotNotFoundError";
    }
}
