import { createCipheriv, createDecipheriv, randomBytes as nodeRandomBytes } from "node:crypto";

import {
    NACL_BOX_PUBLIC_KEY_BYTES,
    NACL_BOX_SECRET_KEY_BYTES,
    NACL_NONCE_BYTES,
    NACL_SECRETBOX_OVERHEAD_BYTES,
    nobleBoxKeyPairFromSecretKey,
    nobleBoxOpen,
    nobleBoxSeal,
    nobleSecretBoxOpen,
    nobleSecretBoxSeal,
} from "../crypto/nobleNaCl.js";
import type { HappyEncryptionVariant } from "./types.js";

type RandomBytes = (size: number) => Uint8Array;

export function encryptHappyPayload(
    key: Uint8Array,
    variant: HappyEncryptionVariant,
    value: unknown,
    randomBytes: RandomBytes = (size) => new Uint8Array(nodeRandomBytes(size)),
): Uint8Array {
    const plaintext = new TextEncoder().encode(JSON.stringify(value));
    if (variant === "legacy") {
        const nonce = randomBytes(NACL_NONCE_BYTES);
        const ciphertext = nobleSecretBoxSeal(plaintext, nonce, key);
        return concatenate(nonce, ciphertext);
    }
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return concatenate(new Uint8Array([0]), nonce, ciphertext, cipher.getAuthTag());
}

export function decryptHappyPayload(
    key: Uint8Array,
    variant: HappyEncryptionVariant,
    bundle: Uint8Array,
): unknown | undefined {
    try {
        let plaintext: Uint8Array | undefined;
        if (variant === "legacy") {
            if (bundle.length < NACL_NONCE_BYTES + NACL_SECRETBOX_OVERHEAD_BYTES) {
                return undefined;
            }
            plaintext = nobleSecretBoxOpen(
                bundle.slice(NACL_NONCE_BYTES),
                bundle.slice(0, NACL_NONCE_BYTES),
                key,
            );
        } else {
            if (bundle[0] !== 0 || bundle.length < 29) return undefined;
            const decipher = createDecipheriv("aes-256-gcm", key, bundle.slice(1, 13));
            decipher.setAuthTag(bundle.slice(-16));
            plaintext = new Uint8Array(
                Buffer.concat([decipher.update(bundle.slice(13, -16)), decipher.final()]),
            );
        }
        if (plaintext === undefined) return undefined;
        return JSON.parse(new TextDecoder().decode(plaintext)) as unknown;
    } catch {
        return undefined;
    }
}

export function wrapHappyDataKey(
    dataKey: Uint8Array,
    recipientPublicKey: Uint8Array,
    randomBytes: RandomBytes = (size) => new Uint8Array(nodeRandomBytes(size)),
): Uint8Array {
    const ephemeral = nobleBoxKeyPairFromSecretKey(randomBytes(NACL_BOX_SECRET_KEY_BYTES));
    const nonce = randomBytes(NACL_NONCE_BYTES);
    const encrypted = nobleBoxSeal(dataKey, nonce, recipientPublicKey, ephemeral.secretKey);
    return concatenate(new Uint8Array([0]), ephemeral.publicKey, nonce, encrypted);
}

export function decryptHappyAuthBundle(
    bundle: Uint8Array,
    recipientSecretKey: Uint8Array,
): Uint8Array | undefined {
    if (bundle.length < NACL_BOX_PUBLIC_KEY_BYTES + NACL_NONCE_BYTES) return undefined;
    return nobleBoxOpen(
        bundle.slice(NACL_BOX_PUBLIC_KEY_BYTES + NACL_NONCE_BYTES),
        bundle.slice(NACL_BOX_PUBLIC_KEY_BYTES, NACL_BOX_PUBLIC_KEY_BYTES + NACL_NONCE_BYTES),
        bundle.slice(0, NACL_BOX_PUBLIC_KEY_BYTES),
        recipientSecretKey,
    );
}

function concatenate(...parts: readonly Uint8Array[]): Uint8Array {
    const output = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
    let offset = 0;
    for (const part of parts) {
        output.set(part, offset);
        offset += part.length;
    }
    return output;
}
