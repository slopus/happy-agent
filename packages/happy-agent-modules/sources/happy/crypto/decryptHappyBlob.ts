import { createHmac, randomBytes as nodeRandomBytes } from "node:crypto";

import type { HappyEncryptionVariant } from "../HappyCredentials.js";
import {
    NACL_NONCE_BYTES,
    NACL_SECRETBOX_OVERHEAD_BYTES,
    nobleSecretBoxOpen,
    nobleSecretBoxSeal,
} from "./nobleNaCl.js";

type RandomBytes = (size: number) => Uint8Array;

const defaultRandomBytes: RandomBytes = (size) => new Uint8Array(nodeRandomBytes(size));

/**
 * Encrypts a binary Happy blob.
 *
 * Binary uploads use the same nonce-prefixed secretbox format as attachments. The
 * derived key keeps the blob format separate from JSON payloads while still
 * following the account's legacy/data-key encryption branch.
 */
export function encryptHappyBlob(options: {
    bytes: Uint8Array;
    encryptionKey: Uint8Array;
    encryptionVariant: HappyEncryptionVariant;
    randomBytes?: RandomBytes;
}): Uint8Array {
    const nonce = (options.randomBytes ?? defaultRandomBytes)(NACL_NONCE_BYTES);
    return concatenate(
        nonce,
        nobleSecretBoxSeal(
            options.bytes,
            nonce,
            deriveBlobKey(options.encryptionKey, options.encryptionVariant),
        ),
    );
}

/**
 * Decrypts an attachment Happy stored as a blob.
 *
 * Blobs are always secretbox, under a key derived from the account or session
 * key rather than the key itself.
 */
export function decryptHappyBlob(options: {
    bundle: Uint8Array;
    encryptionKey: Uint8Array;
    encryptionVariant: HappyEncryptionVariant;
}): Uint8Array | undefined {
    const { bundle, encryptionKey, encryptionVariant } = options;
    if (bundle.length < NACL_NONCE_BYTES + NACL_SECRETBOX_OVERHEAD_BYTES) {
        return undefined;
    }
    return nobleSecretBoxOpen(
        bundle.slice(NACL_NONCE_BYTES),
        bundle.slice(0, NACL_NONCE_BYTES),
        deriveBlobKey(encryptionKey, encryptionVariant),
    );
}

function deriveBlobKey(
    encryptionKey: Uint8Array,
    encryptionVariant: HappyEncryptionVariant,
): Uint8Array {
    const root = createHmac("sha512", new TextEncoder().encode("Happy Blobs Master Seed"))
        .update(encryptionKey)
        .digest();
    const path = encryptionVariant === "dataKey" ? "session" : "master";
    return new Uint8Array(
        createHmac("sha512", root.subarray(32))
            .update(new Uint8Array([0, ...new TextEncoder().encode(path)]))
            .digest()
            .subarray(0, 32),
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
