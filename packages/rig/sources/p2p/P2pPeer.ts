import { Type, type Static } from "@sinclair/typebox";

import { p2pInstanceIdSchema, p2pPublicKeySchema, type P2pPeerIdentity } from "./P2pIdentity.js";

const exact = { additionalProperties: false } as const;

export const p2pDirectPeerSchema = Type.Object(
    {
        address: Type.String({ maxLength: 512, minLength: 1, pattern: "^\\S+$" }),
    },
    exact,
);
export type P2pDirectPeer = Static<typeof p2pDirectPeerSchema>;

export const p2pIrohPeerSchema = Type.Object(
    {
        endpointId: Type.String({ pattern: "^[0-9a-f]{64}$" }),
        ticket: Type.Optional(Type.String({ maxLength: 4_096, minLength: 1 })),
    },
    exact,
);
export type P2pIrohPeer = Static<typeof p2pIrohPeerSchema>;

export const p2pSshPeerSchema = Type.Object(
    {
        agentSocketPath: Type.Optional(Type.String({ minLength: 1 })),
        auth: Type.Union([Type.Literal("agent"), Type.Literal("private_key")]),
        host: Type.String({ maxLength: 512, minLength: 1, pattern: "^\\S+$" }),
        hostKeySha256: Type.String({ pattern: "^SHA256:[A-Za-z0-9+/]{43}$" }),
        passphraseEnvVar: Type.Optional(
            Type.String({
                maxLength: 256,
                minLength: 1,
                pattern: "^[A-Za-z_][A-Za-z0-9_]*$",
            }),
        ),
        port: Type.Integer({ maximum: 65_535, minimum: 1 }),
        privateKeyPath: Type.Optional(Type.String({ minLength: 1 })),
        remoteRig: Type.String({ maxLength: 512, minLength: 1, pattern: "^\\S+$" }),
        username: Type.String({ minLength: 1 }),
    },
    exact,
);
export type P2pSshPeer = Static<typeof p2pSshPeerSchema>;

export const p2pPeerConnectionsSchema = Type.Object(
    {
        direct: Type.Optional(p2pDirectPeerSchema),
        iroh: Type.Optional(p2pIrohPeerSchema),
        ssh: Type.Optional(p2pSshPeerSchema),
    },
    exact,
);
export type P2pPeerConnections = Static<typeof p2pPeerConnectionsSchema>;

export const p2pPeerNameSchema = Type.String({
    maxLength: 128,
    minLength: 1,
    pattern: "^[^\\u0000-\\u001f\\u007f]+$",
});

export const p2pTransportBindingSchema = Type.Object(
    {
        address: Type.String({ maxLength: 512, minLength: 1 }),
        transport: Type.Union([Type.Literal("direct"), Type.Literal("iroh"), Type.Literal("ssh")]),
    },
    exact,
);
export type P2pTransportBinding = Static<typeof p2pTransportBindingSchema>;

export const p2pTrustedPeerSchema = Type.Object(
    {
        bindings: Type.Array(p2pTransportBindingSchema),
        connections: p2pPeerConnectionsSchema,
        instanceId: p2pInstanceIdSchema,
        name: p2pPeerNameSchema,
        publicKey: p2pPublicKeySchema,
    },
    exact,
);
export type P2pTrustedPeer = Static<typeof p2pTrustedPeerSchema>;

export const p2pPairingTransactionIdSchema = Type.String({
    maxLength: 43,
    minLength: 43,
    pattern: "^[A-Za-z0-9_-]+$",
});

export const p2pPeerPairingTrustSchema = Type.Object(
    {
        assignPrimary: Type.Boolean(),
        expiresAt: Type.Integer({ minimum: 0 }),
        pairingId: p2pPairingTransactionIdSchema,
        peer: p2pTrustedPeerSchema,
        state: Type.Union([
            Type.Literal("confirmed"),
            Type.Literal("local_ready"),
            Type.Literal("prepared"),
        ]),
    },
    exact,
);
export type P2pPeerPairingTrust = Static<typeof p2pPeerPairingTrustSchema>;

export function p2pPeerIdentity(peer: P2pTrustedPeer): P2pPeerIdentity {
    return { instanceId: peer.instanceId, publicKey: peer.publicKey };
}
