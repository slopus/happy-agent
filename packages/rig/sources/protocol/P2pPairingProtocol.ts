import { Type, type Static } from "@sinclair/typebox";

import { p2pInstanceIdSchema, p2pPublicKeySchema } from "./P2pIdentityProtocol.js";

const exact = { additionalProperties: false } as const;

export const p2pInvitationPayloadSchema = Type.Object(
    {
        address: Type.String({ maxLength: 4_096, minLength: 1 }),
        expiresAt: Type.Integer({ minimum: 0 }),
        instanceId: p2pInstanceIdSchema,
        publicKey: p2pPublicKeySchema,
        token: Type.String({
            maxLength: 43,
            minLength: 43,
            pattern: "^[A-Za-z0-9_-]+$",
        }),
        transport: Type.Literal("iroh"),
        version: Type.Literal(1),
    },
    exact,
);
export type P2pInvitationPayload = Static<typeof p2pInvitationPayloadSchema>;

export const createP2pInvitationResponseSchema = Type.Object(
    {
        id: p2pInstanceIdSchema,
        invitation: Type.String({ maxLength: 8_192, minLength: 1 }),
    },
    exact,
);
export type CreateP2pInvitationResponse = Static<typeof createP2pInvitationResponseSchema>;

export const joinP2pInvitationRequestSchema = Type.Object(
    { invitation: Type.String({ maxLength: 8_192, minLength: 1 }) },
    exact,
);
export type JoinP2pInvitationRequest = Static<typeof joinP2pInvitationRequestSchema>;

export const joinP2pInvitationResponseSchema = Type.Object({ id: p2pInstanceIdSchema }, exact);
export type JoinP2pInvitationResponse = Static<typeof joinP2pInvitationResponseSchema>;

export const answerP2pVerificationRequestSchema = Type.Object({ accept: Type.Boolean() }, exact);
export type AnswerP2pVerificationRequest = Static<typeof answerP2pVerificationRequestSchema>;

export const p2pPairingPeerSchema = Type.Object(
    {
        instanceId: p2pInstanceIdSchema,
        name: Type.String({
            maxLength: 128,
            minLength: 1,
            pattern: "^[^\\u0000-\\u001f\\u007f]+$",
        }),
        publicKey: p2pPublicKeySchema,
    },
    exact,
);
export type P2pPairingPeer = Static<typeof p2pPairingPeerSchema>;

const p2pPairingBase = {
    expiresAt: Type.Integer({ minimum: 0 }),
    id: p2pInstanceIdSchema,
    role: Type.Union([Type.Literal("inviter"), Type.Literal("joiner")]),
};

export const p2pPairingStateSchema = Type.Union([
    Type.Object(
        {
            ...p2pPairingBase,
            phase: Type.Union([Type.Literal("connecting"), Type.Literal("waiting")]),
        },
        exact,
    ),
    Type.Object(
        {
            ...p2pPairingBase,
            emojis: Type.Tuple([Type.String(), Type.String(), Type.String(), Type.String()]),
            peer: p2pPairingPeerSchema,
            phase: Type.Literal("verifying"),
        },
        exact,
    ),
    Type.Object(
        {
            ...p2pPairingBase,
            peer: p2pPairingPeerSchema,
            phase: Type.Literal("connected"),
        },
        exact,
    ),
    Type.Object(
        {
            ...p2pPairingBase,
            error: Type.Optional(Type.String({ maxLength: 1_024, minLength: 1 })),
            phase: Type.Union([
                Type.Literal("expired"),
                Type.Literal("failed"),
                Type.Literal("rejected"),
            ]),
        },
        exact,
    ),
]);
export type P2pPairingState = Static<typeof p2pPairingStateSchema>;
