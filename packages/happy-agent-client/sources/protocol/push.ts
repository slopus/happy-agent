/**
 * Push notifications: a phone's registration of its push capability with a server, and the
 * person's push settings. The routes and shapes are the ones Happy Cloud serves.
 */

import { type Static, Type } from "@sinclair/typebox";

const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/** How long a registration lasts after the `PUT` that made or renewed it. */
export const PUSH_REGISTRATION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

/** How many registrations one person holds at most. */
export const MAX_PUSH_REGISTRATIONS = 20;

/** The lowercase UUID a phone chooses for one server and keeps, so registering again renews. */
export const pushRegistrationIdSchema = Type.String({ pattern: `^${UUID_PATTERN}$` });
export type PushRegistrationId = Static<typeof pushRegistrationIdSchema>;

/**
 * The capability Happy's push relay gives a phone for its native token. Whoever holds it can send
 * to that phone: never log it, show it, or store it outside the registration request.
 */
export const pushTokenSchema = Type.String({ pattern: "^HappyPushToken\\[[A-Za-z0-9]{22}\\]$" });
export type PushToken = Static<typeof pushTokenSchema>;

export const pushPlatformSchema = Type.Union([Type.Literal("ios"), Type.Literal("android")]);
export type PushPlatform = Static<typeof pushPlatformSchema>;

/** The Happy mobile apps a server accepts registrations from. */
export const pushAppIdSchema = Type.Union([
    Type.Literal("com.ex3ndr.happy"),
    Type.Literal("com.slopus.happy.preview"),
    Type.Literal("com.slopus.happy.dev"),
]);
export type PushAppId = Static<typeof pushAppIdSchema>;

/** `PUT /v0/cloud/push/registrations/:id` — registers the phone, or renews its registration. */
export const registerPushRequestSchema = Type.Object(
    {
        token: pushTokenSchema,
        platform: pushPlatformSchema,
        appId: pushAppIdSchema,
        /** 1–64 characters with no control characters. */
        locale: Type.Optional(
            Type.String({
                minLength: 1,
                maxLength: 64,
                pattern: "^[^\\u0000-\\u001f\\u007f-\\u009f]+$",
            }),
        ),
    },
    { additionalProperties: false },
);
export type RegisterPushRequest = Static<typeof registerPushRequestSchema>;

/** A phone's registration as the server reports it; the token is never returned. */
export const pushRegistrationSchema = Type.Object({
    id: pushRegistrationIdSchema,
    /** Minted by every `PUT`; the `If-Match` value that removes exactly this registration. */
    version: Type.String({ pattern: `^${UUID_PATTERN}$` }),
    /** Milliseconds since the Unix epoch, 30 days after the `PUT` that returned it. */
    expiresAt: Type.Integer({ minimum: 0 }),
});
export type PushRegistration = Static<typeof pushRegistrationSchema>;

/** `PUT /v0/cloud/push/registrations/:id` */
export const registerPushResponseSchema = Type.Object({
    registration: pushRegistrationSchema,
});
export type RegisterPushResponse = Static<typeof registerPushResponseSchema>;

/** `GET` and `PUT /v0/cloud/push/settings` — whether the server may notify the caller's phones. */
export const pushSettingsSchema = Type.Object(
    { enabled: Type.Boolean() },
    { additionalProperties: false },
);
export type PushSettings = Static<typeof pushSettingsSchema>;
