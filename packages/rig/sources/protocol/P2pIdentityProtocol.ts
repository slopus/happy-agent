import { Type, type Static } from "@sinclair/typebox";

export const p2pInstanceIdSchema = Type.String({
    maxLength: 32,
    minLength: 2,
    pattern: "^[a-z][a-z0-9]+$",
});
export const p2pPublicKeySchema = Type.String({
    maxLength: 43,
    minLength: 43,
    pattern: "^[A-Za-z0-9_-]+$",
});
export const p2pPeerIdentitySchema = Type.Object(
    {
        instanceId: p2pInstanceIdSchema,
        publicKey: p2pPublicKeySchema,
    },
    { additionalProperties: false },
);
export type P2pPeerIdentity = Static<typeof p2pPeerIdentitySchema>;
