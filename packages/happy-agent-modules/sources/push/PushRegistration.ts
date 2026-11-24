import { cuid2Schema } from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import { PushToken } from "./PushToken.js";

/** The one person of a standalone installation, who has no team user ID. */
export const STANDALONE_PUSH_OWNER = "standalone";

/** Whose phone: a team user's installation-local ID, or the standalone installation's person. */
export const pushOwnerSchema = Type.Union([cuid2Schema, Type.Literal(STANDALONE_PUSH_OWNER)]);
export type PushOwner = Static<typeof pushOwnerSchema>;

/** How long a registration lasts after the registration that made or renewed it. */
export const PUSH_REGISTRATION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

/** How many registrations one person holds at most. */
export const MAX_PUSH_REGISTRATIONS = 20;

const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/** The lowercase UUID a phone chooses for this server and keeps, so registering again renews. */
export const pushRegistrationIdSchema = Type.String({ pattern: `^${UUID_PATTERN}$` });

/** The UUID minted by every registration; a removal names the exact one it means. */
export const pushRegistrationVersionSchema = Type.String({ pattern: `^${UUID_PATTERN}$` });

const pushRegistrationRequestSchema = Type.Object(
    {
        token: Type.String(),
        platform: Type.Union([Type.Literal("ios"), Type.Literal("android")]),
        appId: Type.Union([
            Type.Literal("com.ex3ndr.happy"),
            Type.Literal("com.slopus.happy.preview"),
            Type.Literal("com.slopus.happy.dev"),
        ]),
        locale: Type.Optional(Type.String({ minLength: 1 })),
    },
    { additionalProperties: false },
);

/** What a phone registers, parsed: the token can no longer be mistaken for ordinary text. */
export type PushRegistrationInput = Omit<
    Static<typeof pushRegistrationRequestSchema>,
    "token" | "locale"
> & {
    readonly token: PushToken;
    readonly locale: string | null;
};

const CONTROL_CHARACTER = /\p{Cc}/u;

/** A phone's registration request as its parsed input, or `undefined` when it is not one. */
export function parsePushRegistrationInput(value: unknown): PushRegistrationInput | undefined {
    if (!Value.Check(pushRegistrationRequestSchema, value)) return undefined;
    const token = PushToken.parse(value.token);
    if (token === undefined) return undefined;
    const locale = value.locale ?? null;
    // Counted in characters rather than UTF-16 units, as Happy Cloud counts them.
    if (locale !== null && ([...locale].length > 64 || CONTROL_CHARACTER.test(locale))) {
        return undefined;
    }
    return { token, platform: value.platform, appId: value.appId, locale };
}

/** A phone's registration as callers see it. It never carries the token. */
export const pushRegistrationSchema = Type.Object({
    id: pushRegistrationIdSchema,
    version: pushRegistrationVersionSchema,
    /** Milliseconds since the Unix epoch; past it the registration receives nothing. */
    expiresAt: Type.Integer({ minimum: 0 }),
});
export type PushRegistration = Static<typeof pushRegistrationSchema>;

/** Whether the server may notify a person's phones. A person who never chose is enabled. */
export const pushSettingsSchema = Type.Object(
    { enabled: Type.Boolean() },
    { additionalProperties: false },
);
export type PushSettings = Static<typeof pushSettingsSchema>;
