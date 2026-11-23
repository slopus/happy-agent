import { Type, type Static } from "@sinclair/typebox";

const idSchema = Type.String({ maxLength: 128, minLength: 1, pattern: "^[A-Za-z0-9_-]+$" });
const errorSchema = Type.String({ maxLength: 8_192, minLength: 1 });

/** Whether the outbound relay socket is up. `off` means the owner has not made it reachable. */
export const accountLinkRelayStateSchema = Type.Union([
    Type.Literal("off"),
    Type.Literal("connecting"),
    Type.Literal("attached"),
]);

/**
 * The link's whole lifecycle. A daemon is unavailable (not configured, or a team server), not
 * linked, waiting for a person to approve a code, or linked to exactly one account.
 */
export const accountLinkStatusSchema = Type.Union([
    Type.Object(
        { reason: errorSchema, state: Type.Literal("unavailable") },
        { additionalProperties: false },
    ),
    Type.Object(
        { error: Type.Optional(errorSchema), state: Type.Literal("unlinked") },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            expiresAt: Type.Integer({ minimum: 0 }),
            state: Type.Literal("linking"),
            userCode: Type.String({ maxLength: 64, minLength: 1 }),
            verificationUrl: Type.String({ maxLength: 4_096, minLength: 1 }),
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            accountId: idSchema,
            endpointId: idSchema,
            error: Type.Optional(errorSchema),
            reachable: Type.Boolean(),
            relay: accountLinkRelayStateSchema,
            state: Type.Literal("linked"),
        },
        { additionalProperties: false },
    ),
]);

/** What survives a restart: who owns this machine, its credential, and the owner's choice. */
export const accountLinkCredentialsSchema = Type.Object(
    {
        accountId: idSchema,
        accountsUrl: Type.String({ maxLength: 2_048, minLength: 1 }),
        endpointId: idSchema,
        linkedAt: Type.Integer({ minimum: 0 }),
        reachable: Type.Boolean(),
        refreshToken: Type.String({ maxLength: 16_384, minLength: 1 }),
    },
    { additionalProperties: false },
);

export type AccountLinkRelayState = Static<typeof accountLinkRelayStateSchema>;
export type AccountLinkStatus = Static<typeof accountLinkStatusSchema>;
export type AccountLinkCredentials = Static<typeof accountLinkCredentialsSchema>;
