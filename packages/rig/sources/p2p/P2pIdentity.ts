import { randomBytes } from "node:crypto";

import { createId } from "@paralleldrive/cuid2";
import { ed25519 } from "@noble/curves/ed25519.js";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import {
    NACL_BOX_PUBLIC_KEY_BYTES,
    NACL_NONCE_BYTES,
    nobleBoxOpen,
    nobleBoxSeal,
} from "../crypto/nobleNaCl.js";
import { p2pInstanceIdSchema, type P2pPeerIdentity } from "../protocol/P2pIdentityProtocol.js";
export {
    p2pInstanceIdSchema,
    p2pPeerIdentitySchema,
    p2pPublicKeySchema,
    type P2pPeerIdentity,
} from "../protocol/P2pIdentityProtocol.js";

export const p2pSecretSeedSchema = Type.String({
    maxLength: 43,
    minLength: 43,
    pattern: "^[A-Za-z0-9_-]+$",
});
const P2P_IDENTITY_SEED_BYTES = 32;
const P2P_PUBLIC_KEY_BYTES = 32;
const P2P_SIGNATURE_BYTES = 64;
const ED25519_PKCS8_SEED_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export interface P2pInstanceIdentity extends P2pPeerIdentity {
    decryptFrom(encrypted: P2pEncryptedMessage, senderPublicKey: string): Uint8Array;
    encryptFor(message: Uint8Array, recipientPublicKey: string): P2pEncryptedMessage;
    exportPrivateKeyPkcs8(): Uint8Array;
    sign(message: Uint8Array): string;
}

export interface P2pEncryptedMessage {
    ciphertext: string;
    nonce: string;
}

export function createP2pInstanceIdentity(
    instanceId = createId(),
    secretSeed: Uint8Array = new Uint8Array(randomBytes(P2P_IDENTITY_SEED_BYTES)),
): P2pInstanceIdentity {
    if (!Value.Check(p2pInstanceIdSchema, instanceId)) {
        throw new Error("The stable P2P instance ID must be a cuid2 identity.");
    }
    if (secretSeed.byteLength !== P2P_IDENTITY_SEED_BYTES) {
        throw new Error("The P2P identity seed must contain exactly 32 bytes.");
    }
    const signingPublicKey = ed25519.getPublicKey(secretSeed);
    const encryptionSecretKey = ed25519.utils.toMontgomerySecret(secretSeed);
    return {
        decryptFrom: (encrypted, senderPublicKey) => {
            const nonce = decodeSizedBase64Url(
                encrypted.nonce,
                NACL_NONCE_BYTES,
                "P2P encrypted-message nonce",
            );
            const ciphertext = decodeBase64Url(encrypted.ciphertext);
            const senderEncryptionPublicKey = decodeSizedBase64Url(
                p2pEncryptionPublicKey(senderPublicKey),
                NACL_BOX_PUBLIC_KEY_BYTES,
                "P2P encryption public key",
            );
            const message = nobleBoxOpen(
                ciphertext,
                nonce,
                senderEncryptionPublicKey,
                encryptionSecretKey,
            );
            if (message === undefined) {
                throw new Error("The encrypted P2P message could not be authenticated.");
            }
            return message;
        },
        encryptFor: (message, recipientPublicKey) => {
            const recipientEncryptionPublicKey = decodeSizedBase64Url(
                p2pEncryptionPublicKey(recipientPublicKey),
                NACL_BOX_PUBLIC_KEY_BYTES,
                "P2P encryption public key",
            );
            const nonce = new Uint8Array(randomBytes(NACL_NONCE_BYTES));
            return {
                ciphertext: encodeBase64Url(
                    nobleBoxSeal(message, nonce, recipientEncryptionPublicKey, encryptionSecretKey),
                ),
                nonce: encodeBase64Url(nonce),
            };
        },
        exportPrivateKeyPkcs8: () =>
            new Uint8Array(Buffer.concat([ED25519_PKCS8_SEED_PREFIX, secretSeed])),
        instanceId,
        publicKey: encodeBase64Url(signingPublicKey),
        sign: (message) => encodeBase64Url(ed25519.sign(message, secretSeed)),
    };
}

export function p2pEncryptionPublicKey(publicKey: string): string {
    const signingPublicKey = decodeSizedBase64Url(
        publicKey,
        P2P_PUBLIC_KEY_BYTES,
        "P2P signing public key",
    );
    try {
        return encodeBase64Url(ed25519.utils.toMontgomery(signingPublicKey));
    } catch {
        throw new Error("The P2P signing public key cannot be used for encryption.");
    }
}

export function verifyP2pSignature(
    message: Uint8Array,
    signature: string,
    publicKey: string,
): boolean {
    const signatureBytes = decodeBase64Url(signature);
    const publicKeyBytes = decodeBase64Url(publicKey);
    if (
        signatureBytes.byteLength !== P2P_SIGNATURE_BYTES ||
        publicKeyBytes.byteLength !== P2P_PUBLIC_KEY_BYTES
    ) {
        return false;
    }
    try {
        return ed25519.verify(signatureBytes, message, publicKeyBytes, { zip215: false });
    } catch {
        return false;
    }
}

export function encodeBase64Url(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString("base64url");
}

export function decodeBase64Url(value: string): Uint8Array {
    return new Uint8Array(Buffer.from(value, "base64url"));
}

function decodeSizedBase64Url(value: string, length: number, label: string): Uint8Array {
    const bytes = decodeBase64Url(value);
    if (bytes.byteLength !== length) {
        throw new Error(`The ${label} must contain exactly ${String(length)} bytes.`);
    }
    return bytes;
}
