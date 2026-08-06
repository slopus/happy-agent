import { hsalsa, secretbox } from "@noble/ciphers/salsa.js";
import { u8, u32 } from "@noble/ciphers/utils.js";
import { x25519 } from "@noble/curves/ed25519.js";

export const NACL_BOX_PUBLIC_KEY_BYTES = 32;
export const NACL_BOX_SECRET_KEY_BYTES = 32;
export const NACL_NONCE_BYTES = 24;
export const NACL_SECRETBOX_OVERHEAD_BYTES = 16;

export interface NobleBoxKeyPair {
    publicKey: Uint8Array;
    secretKey: Uint8Array;
}

const SIGMA = u32(new TextEncoder().encode("expand 32-byte k"));
const ZERO_HSALSA_INPUT = new Uint32Array(4);

export function nobleBoxKeyPairFromSecretKey(secretKey: Uint8Array): NobleBoxKeyPair {
    assertLength(secretKey, NACL_BOX_SECRET_KEY_BYTES, "X25519 secret key");
    const ownedSecretKey = secretKey.slice();
    return {
        publicKey: x25519.getPublicKey(ownedSecretKey),
        secretKey: ownedSecretKey,
    };
}

export function nobleSecretBoxSeal(
    plaintext: Uint8Array,
    nonce: Uint8Array,
    key: Uint8Array,
): Uint8Array {
    return secretbox(key, nonce).seal(plaintext);
}

export function nobleSecretBoxOpen(
    ciphertext: Uint8Array,
    nonce: Uint8Array,
    key: Uint8Array,
): Uint8Array | undefined {
    try {
        return secretbox(key, nonce).open(ciphertext);
    } catch {
        return undefined;
    }
}

export function nobleBoxSeal(
    plaintext: Uint8Array,
    nonce: Uint8Array,
    recipientPublicKey: Uint8Array,
    senderSecretKey: Uint8Array,
): Uint8Array {
    return nobleSecretBoxSeal(
        plaintext,
        nonce,
        deriveNaclBoxKey(recipientPublicKey, senderSecretKey),
    );
}

export function nobleBoxOpen(
    ciphertext: Uint8Array,
    nonce: Uint8Array,
    senderPublicKey: Uint8Array,
    recipientSecretKey: Uint8Array,
): Uint8Array | undefined {
    try {
        return nobleSecretBoxOpen(
            ciphertext,
            nonce,
            deriveNaclBoxKey(senderPublicKey, recipientSecretKey),
        );
    } catch {
        return undefined;
    }
}

function deriveNaclBoxKey(publicKey: Uint8Array, secretKey: Uint8Array): Uint8Array {
    assertLength(publicKey, NACL_BOX_PUBLIC_KEY_BYTES, "X25519 public key");
    assertLength(secretKey, NACL_BOX_SECRET_KEY_BYTES, "X25519 secret key");
    const sharedSecret = x25519.getSharedSecret(secretKey, publicKey);
    const output = new Uint32Array(8);
    hsalsa(SIGMA, u32(sharedSecret), ZERO_HSALSA_INPUT, output);
    return u8(output).slice();
}

function assertLength(value: Uint8Array, length: number, label: string): void {
    if (value.byteLength !== length) {
        throw new Error(`The ${label} must contain exactly ${String(length)} bytes.`);
    }
}
