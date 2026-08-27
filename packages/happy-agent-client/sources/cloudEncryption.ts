import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import { cloudKeyValueSchema } from "./protocol/cloud.js";

const exact = { additionalProperties: false } as const;
const encoder = new TextEncoder();
const GENERATED_SECRET_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTVWXYZ";
const GENERATED_SECRET_BASE = BigInt(GENERATED_SECRET_ALPHABET.length);
const GENERATED_SECRET_BODY_CHARACTERS = 26;
const GENERATED_SECRET_PATTERN =
    "^H1-[2-9A-HJ-NP-TV-Z]{5}-[2-9A-HJ-NP-TV-Z]{5}-[2-9A-HJ-NP-TV-Z]{5}-[2-9A-HJ-NP-TV-Z]{5}-[2-9A-HJ-NP-TV-Z]{6}$";
const GENERATED_SECRET_PREFIX = "H1";
const GENERATED_SECRET_VALUE_LIMIT = 1n << 128n;
const KEY_BYTES = 32;
const PBKDF2_ITERATIONS = 650_000;
const KDF_SALT = encoder.encode("happy-agent-cloud-keys/H1");
const passwordInputSchema = Type.String();
const normalizedPasswordSchema = Type.String({ minLength: 1 });

/** The number of cryptographically secure random bytes encoded by an H1 generated secret. */
export const CLOUD_GENERATED_SECRET_SEED_BYTES = 16;

/** A canonical, versioned H1 generated secret. */
export const cloudGeneratedSecretSchema = Type.String({
    minLength: 33,
    maxLength: 33,
    pattern: GENERATED_SECRET_PATTERN,
});
export type CloudGeneratedSecret = Static<typeof cloudGeneratedSecretSchema>;

/** The two derived values accepted by the Cloud key create and restore mutations. */
export const cloudDerivedKeysSchema = Type.Object(
    {
        authHash: cloudKeyValueSchema,
        encryptionKey: cloudKeyValueSchema,
    },
    exact,
);
export type CloudDerivedKeys = Static<typeof cloudDerivedKeysSchema>;

const cloudGeneratedSecretSeedSchema = Type.Uint8Array({
    maxByteLength: CLOUD_GENERATED_SECRET_SEED_BYTES,
    minByteLength: CLOUD_GENERATED_SECRET_SEED_BYTES,
});

/**
 * Removes surrounding Unicode whitespace and applies the NFKD normalization
 * used by 1Password before password key derivation.
 */
export function normalizeCloudPassword(password: string): string {
    if (!Value.Check(passwordInputSchema, password)) {
        throw new TypeError("Password must be a string.");
    }
    const normalized = password.trim().normalize("NFKD");
    if (!Value.Check(normalizedPasswordSchema, normalized)) {
        throw new TypeError("Password must not be empty after trimming.");
    }
    return normalized;
}

/** Encodes a caller-provided 128-bit secure random seed as a canonical H1 generated secret. */
export function stringifyCloudGeneratedSecret(seed: Uint8Array): CloudGeneratedSecret {
    if (!Value.Check(cloudGeneratedSecretSeedSchema, seed)) {
        throw new TypeError(
            `Generated secret seed must contain exactly ${CLOUD_GENERATED_SECRET_SEED_BYTES} bytes.`,
        );
    }

    let value = bytesToInteger(seed);
    let body = "";
    for (let index = 0; index < GENERATED_SECRET_BODY_CHARACTERS; index += 1) {
        body = GENERATED_SECRET_ALPHABET[Number(value % GENERATED_SECRET_BASE)]! + body;
        value /= GENERATED_SECRET_BASE;
    }
    if (value !== 0n) throw new TypeError("Generated secret seed is out of range.");

    const formatted = `${GENERATED_SECRET_PREFIX}-${body.slice(0, 5)}-${body.slice(5, 10)}-${body.slice(10, 15)}-${body.slice(15, 20)}-${body.slice(20)}`;
    if (!Value.Check(cloudGeneratedSecretSchema, formatted)) {
        throw new TypeError("Generated secret could not be encoded.");
    }
    return formatted;
}

/** Decodes one canonical H1 generated secret into a new 128-bit seed buffer. */
export function parseCloudGeneratedSecret(secret: string): Uint8Array<ArrayBuffer> {
    if (!Value.Check(cloudGeneratedSecretSchema, secret)) {
        throw new TypeError("Generated secret is not a canonical H1 secret.");
    }

    const body = secret.slice(GENERATED_SECRET_PREFIX.length + 1).replaceAll("-", "");
    let value = 0n;
    for (const character of body) {
        value =
            value * GENERATED_SECRET_BASE + BigInt(GENERATED_SECRET_ALPHABET.indexOf(character));
    }
    if (value >= GENERATED_SECRET_VALUE_LIMIT) {
        throw new TypeError("Generated secret is outside the H1 value range.");
    }
    return integerToBytes(value, CLOUD_GENERATED_SECRET_SEED_BYTES);
}

/**
 * Combines the generated and password factors into independent Cloud bundle
 * encryption and authentication values.
 */
export async function deriveCloudKeys(
    generatedSecret: CloudGeneratedSecret,
    password: string,
): Promise<CloudDerivedKeys> {
    const normalizedPassword = normalizeCloudPassword(password);
    const seed = parseCloudGeneratedSecret(generatedSecret);
    const passwordBytes = encoder.encode(normalizedPassword);
    let encryptionKey: Uint8Array<ArrayBuffer> | undefined;
    let authHash: Uint8Array<ArrayBuffer> | undefined;
    try {
        encryptionKey = await deriveCombinedKey(seed, passwordBytes, "encryption");
        authHash = await deriveCombinedKey(seed, passwordBytes, "authentication");
        return {
            authHash: encodeBase64Url(authHash),
            encryptionKey: encodeBase64Url(encryptionKey),
        };
    } finally {
        encryptionKey?.fill(0);
        authHash?.fill(0);
        seed.fill(0);
        passwordBytes.fill(0);
    }
}

async function deriveCombinedKey(
    seed: Uint8Array<ArrayBuffer>,
    password: Uint8Array<ArrayBuffer>,
    purpose: "authentication" | "encryption",
): Promise<Uint8Array<ArrayBuffer>> {
    const passwordSalt = await deriveHkdf(seed, `password-salt/${purpose}`);
    let generatedPart: Uint8Array<ArrayBuffer> | undefined;
    let passwordPart: Uint8Array<ArrayBuffer> | undefined;
    try {
        generatedPart = await deriveHkdf(seed, `generated-factor/${purpose}`);
        passwordPart = await derivePbkdf2(password, passwordSalt);
        const combined = new Uint8Array(KEY_BYTES);
        for (let index = 0; index < combined.length; index += 1) {
            combined[index] = passwordPart[index]! ^ generatedPart[index]!;
        }
        return combined;
    } finally {
        passwordSalt.fill(0);
        generatedPart?.fill(0);
        passwordPart?.fill(0);
    }
}

async function deriveHkdf(
    seed: Uint8Array<ArrayBuffer>,
    info: string,
): Promise<Uint8Array<ArrayBuffer>> {
    const key = await globalThis.crypto.subtle.importKey("raw", seed, "HKDF", false, [
        "deriveBits",
    ]);
    return new Uint8Array(
        await globalThis.crypto.subtle.deriveBits(
            {
                hash: "SHA-256",
                info: encoder.encode(`happy-agent-cloud-keys/H1/${info}`),
                name: "HKDF",
                salt: KDF_SALT,
            },
            key,
            KEY_BYTES * 8,
        ),
    );
}

async function derivePbkdf2(
    password: Uint8Array<ArrayBuffer>,
    salt: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
    const key = await globalThis.crypto.subtle.importKey("raw", password, "PBKDF2", false, [
        "deriveBits",
    ]);
    return new Uint8Array(
        await globalThis.crypto.subtle.deriveBits(
            {
                hash: "SHA-256",
                iterations: PBKDF2_ITERATIONS,
                name: "PBKDF2",
                salt,
            },
            key,
            KEY_BYTES * 8,
        ),
    );
}

function bytesToInteger(bytes: Uint8Array): bigint {
    let value = 0n;
    for (const byte of bytes) value = (value << 8n) | BigInt(byte);
    return value;
}

function integerToBytes(value: bigint, length: number): Uint8Array<ArrayBuffer> {
    const bytes = new Uint8Array(length);
    for (let index = bytes.length - 1; index >= 0; index -= 1) {
        bytes[index] = Number(value & 0xffn);
        value >>= 8n;
    }
    return bytes;
}

function encodeBase64Url(bytes: Uint8Array): string {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let encoded = "";
    let bits = 0;
    let buffer = 0;
    for (const byte of bytes) {
        buffer = (buffer << 8) | byte;
        bits += 8;
        while (bits >= 6) {
            bits -= 6;
            encoded += alphabet[(buffer >>> bits) & 0x3f]!;
        }
    }
    if (bits > 0) encoded += alphabet[(buffer << (6 - bits)) & 0x3f]!;
    return encoded;
}
