import { Type, type Static } from "@sinclair/typebox";

// An instance is the installation epoch, a UUID; older records carry the agent identifier
// that stood for the machine before epochs existed.
export const p2pInstanceIdSchema = Type.String({
    maxLength: 64,
    minLength: 2,
    pattern: "^[A-Za-z0-9][A-Za-z0-9-]*$",
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
