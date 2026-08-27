import { cloudKeyValueSchema } from "@slopus/happy-agent-client";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import { createCloudKeyTree, type CloudDerivedKeyPair } from "./CloudKeyTree.js";

const exact = { additionalProperties: false } as const;
const BUNDLE_ASSOCIATED_DATA = new TextEncoder().encode("happy-agent-cloud-keys/v1");
const NONCE_BYTES = 12;
const ROOT_BYTES = 32;

const cloudKeyBundleSchema = Type.Object(
    {
        ciphertext: Type.String({ minLength: 1, maxLength: 2_048, pattern: "^[A-Za-z0-9_-]+$" }),
        nonce: Type.String({ minLength: 16, maxLength: 16, pattern: "^[A-Za-z0-9_-]+$" }),
        version: Type.Literal(1),
    },
    exact,
);

const cloudKeyPayloadSchema = Type.Object(
    { rootSecret: cloudKeyValueSchema, version: Type.Literal(1) },
    exact,
);

export interface CreatedCloudKeyBundle {
    readonly bundle: string;
    readonly identityKey: string;
    readonly rootSecret: string;
}

export class CloudKeyMaterialError extends Error {
    constructor() {
        super("Cloud key material could not be authenticated.");
        this.name = "CloudKeyMaterialError";
    }
}

/** Creates one authenticated encrypted bundle around a fresh account root. */
export async function createCloudKeyBundle(encryptionKey: string): Promise<CreatedCloudKeyBundle> {
    const root = globalThis.crypto.getRandomValues(new Uint8Array(ROOT_BYTES));
    try {
        const rootSecret = encodeKey(root);
        return {
            bundle: await encryptRoot(rootSecret, encryptionKey),
            identityKey: deriveCloudIdentityKey(rootSecret),
            rootSecret,
        };
    } finally {
        root.fill(0);
    }
}

/** Re-encrypts one retained account root without changing its stable identity. */
export async function createCloudKeyBundleFromRoot(
    rootSecret: string,
    encryptionKey: string,
): Promise<CreatedCloudKeyBundle> {
    const root = decodeKey(rootSecret);
    root.fill(0);
    return {
        bundle: await encryptRoot(rootSecret, encryptionKey),
        identityKey: deriveCloudIdentityKey(rootSecret),
        rootSecret,
    };
}

/** Authenticates one remote bundle and returns its canonical root and public identity. */
export async function openCloudKeyBundle(
    bundle: string,
    encryptionKey: string,
): Promise<{ readonly identityKey: string; readonly rootSecret: string }> {
    try {
        const envelope = parseBundle(bundle);
        const keyBytes = decodeKey(encryptionKey);
        const nonce = decodeCanonical(envelope.nonce, NONCE_BYTES);
        const ciphertext = decodeCanonical(envelope.ciphertext);
        let plaintext: Uint8Array | undefined;
        try {
            const key = await globalThis.crypto.subtle.importKey(
                "raw",
                keyBytes,
                "AES-GCM",
                false,
                ["decrypt"],
            );
            plaintext = new Uint8Array(
                await globalThis.crypto.subtle.decrypt(
                    { additionalData: BUNDLE_ASSOCIATED_DATA, iv: nonce, name: "AES-GCM" },
                    key,
                    ciphertext,
                ),
            );
            const payload = parsePayload(
                new TextDecoder("utf-8", { fatal: true }).decode(plaintext),
            );
            decodeKey(payload.rootSecret).fill(0);
            return {
                identityKey: deriveCloudIdentityKey(payload.rootSecret),
                rootSecret: payload.rootSecret,
            };
        } finally {
            keyBytes.fill(0);
            nonce.fill(0);
            ciphertext.fill(0);
            plaintext?.fill(0);
        }
    } catch {
        throw new CloudKeyMaterialError();
    }
}

/** Derives the stable Ed25519 public identity from one canonical account root. */
export function deriveCloudIdentityKey(rootSecret: string): string {
    const root = decodeKey(rootSecret);
    let tree: ReturnType<typeof createCloudKeyTree> | undefined;
    let identity: CloudDerivedKeyPair | undefined;
    try {
        tree = createCloudKeyTree(root);
        identity = tree.deriveEd25519Key(["murmur", "identity"]);
        return encodeKey(identity.public);
    } finally {
        root.fill(0);
        identity?.secret.fill(0);
        identity?.public.fill(0);
        tree?.destroy();
    }
}

async function encryptRoot(rootSecret: string, encryptionKey: string): Promise<string> {
    const keyBytes = decodeKey(encryptionKey);
    const nonce = globalThis.crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
    const plaintext = new TextEncoder().encode(JSON.stringify({ rootSecret, version: 1 }));
    let ciphertext: Uint8Array | undefined;
    try {
        const key = await globalThis.crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, [
            "encrypt",
        ]);
        ciphertext = new Uint8Array(
            await globalThis.crypto.subtle.encrypt(
                { additionalData: BUNDLE_ASSOCIATED_DATA, iv: nonce, name: "AES-GCM" },
                key,
                plaintext,
            ),
        );
        return JSON.stringify({
            ciphertext: encodeBase64Url(ciphertext),
            nonce: encodeBase64Url(nonce),
            version: 1,
        } satisfies Static<typeof cloudKeyBundleSchema>);
    } finally {
        keyBytes.fill(0);
        nonce.fill(0);
        plaintext.fill(0);
        ciphertext?.fill(0);
    }
}

function parseBundle(value: string): Static<typeof cloudKeyBundleSchema> {
    if (value.length === 0 || value.length > 4_096) throw new CloudKeyMaterialError();
    const parsed = JSON.parse(value) as unknown;
    if (!Value.Check(cloudKeyBundleSchema, parsed)) throw new CloudKeyMaterialError();
    return parsed;
}

function parsePayload(value: string): Static<typeof cloudKeyPayloadSchema> {
    const parsed = JSON.parse(value) as unknown;
    if (!Value.Check(cloudKeyPayloadSchema, parsed)) throw new CloudKeyMaterialError();
    return parsed;
}

function decodeKey(value: string): Uint8Array {
    if (!Value.Check(cloudKeyValueSchema, value)) throw new CloudKeyMaterialError();
    return decodeCanonical(value, ROOT_BYTES);
}

function decodeCanonical(value: string, length?: number): Uint8Array {
    const decoded = new Uint8Array(Buffer.from(value, "base64url"));
    if ((length !== undefined && decoded.length !== length) || encodeBase64Url(decoded) !== value) {
        decoded.fill(0);
        throw new CloudKeyMaterialError();
    }
    return decoded;
}

function encodeKey(value: Uint8Array): string {
    if (value.length !== ROOT_BYTES) throw new CloudKeyMaterialError();
    return encodeBase64Url(value);
}

function encodeBase64Url(value: Uint8Array): string {
    return Buffer.from(value).toString("base64url");
}
