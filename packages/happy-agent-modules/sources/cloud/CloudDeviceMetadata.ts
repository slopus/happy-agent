import { randomBytes } from "node:crypto";
import { arch, hostname, platform, release } from "node:os";

import { gcm } from "@noble/ciphers/aes.js";
import {
    cloudDeviceMetadataSchema,
    type CloudDeviceMetadata,
    type CloudDevicePlatform,
} from "@slopus/happy-agent-client";
import { Value } from "@sinclair/typebox/value";

import type { CloudKeyTree } from "./CloudKeyTree.js";

const DEVICE_METADATA_PATH = ["murmur", "device-metadata"] as const;
const DEVICE_KEY_BYTES = 32;
const FORMAT_VERSION = 1;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const MAX_PLAINTEXT_BYTES = 4 * 1024;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

/** Describe this installation using bounded, display-safe host facts. */
export function createCloudDeviceMetadata(
    installationId: string,
    agentVersion: string,
): CloudDeviceMetadata {
    const metadata = {
        agentVersion: deviceText(agentVersion, "development"),
        architecture: deviceText(arch(), "unknown"),
        installationId,
        name: deviceText(hostname(), "Happy Agent"),
        osVersion: deviceText(release(), "unknown"),
        platform: cloudDevicePlatform(platform()),
    };
    if (!Value.Check(cloudDeviceMetadataSchema, metadata)) {
        throw new Error("The local Cloud device metadata is invalid.");
    }
    return metadata;
}

/** Encrypt owner-local device metadata and bind it to this exact account and device. */
export function encryptCloudDeviceMetadata(
    tree: CloudKeyTree,
    accountKey: Uint8Array,
    deviceKey: Uint8Array,
    metadata: CloudDeviceMetadata,
): Uint8Array {
    assertIdentityKey(accountKey);
    assertIdentityKey(deviceKey);
    if (!Value.Check(cloudDeviceMetadataSchema, metadata)) {
        throw new Error("The Cloud device metadata is invalid.");
    }
    const key = tree.deriveSymmetricKey(DEVICE_METADATA_PATH);
    const nonce = new Uint8Array(randomBytes(NONCE_BYTES));
    const plaintext = textEncoder.encode(JSON.stringify(metadata));
    const aad = deviceMetadataAad(accountKey, deviceKey);
    try {
        if (plaintext.byteLength > MAX_PLAINTEXT_BYTES) {
            throw new Error("The Cloud device metadata is too large.");
        }
        const ciphertext = gcm(key, nonce, aad).encrypt(plaintext);
        const encrypted = new Uint8Array(1 + nonce.byteLength + ciphertext.byteLength);
        encrypted[0] = FORMAT_VERSION;
        encrypted.set(nonce, 1);
        encrypted.set(ciphertext, 1 + nonce.byteLength);
        ciphertext.fill(0);
        return encrypted;
    } finally {
        key.fill(0);
        nonce.fill(0);
        plaintext.fill(0);
        aad.fill(0);
    }
}

/** Decrypt one roster entry, returning null when that opaque entry is not ours or is malformed. */
export function decryptCloudDeviceMetadata(
    tree: CloudKeyTree,
    accountKey: Uint8Array,
    deviceKey: Uint8Array,
    encrypted: Uint8Array,
): CloudDeviceMetadata | null {
    assertIdentityKey(accountKey);
    assertIdentityKey(deviceKey);
    if (encrypted.byteLength < 1 + NONCE_BYTES + TAG_BYTES || encrypted[0] !== FORMAT_VERSION) {
        return null;
    }
    const key = tree.deriveSymmetricKey(DEVICE_METADATA_PATH);
    const nonce = encrypted.slice(1, 1 + NONCE_BYTES);
    const ciphertext = encrypted.slice(1 + NONCE_BYTES);
    const aad = deviceMetadataAad(accountKey, deviceKey);
    let plaintext: Uint8Array | undefined;
    try {
        plaintext = gcm(key, nonce, aad).decrypt(ciphertext);
        if (plaintext.byteLength > MAX_PLAINTEXT_BYTES) return null;
        const parsed = JSON.parse(textDecoder.decode(plaintext)) as unknown;
        return Value.Check(cloudDeviceMetadataSchema, parsed)
            ? structuredClone(parsed as CloudDeviceMetadata)
            : null;
    } catch {
        return null;
    } finally {
        key.fill(0);
        nonce.fill(0);
        ciphertext.fill(0);
        aad.fill(0);
        plaintext?.fill(0);
    }
}

function assertIdentityKey(key: Uint8Array): void {
    if (key.byteLength !== DEVICE_KEY_BYTES) {
        throw new Error("Cloud device metadata requires a 32-byte identity key.");
    }
}

function deviceMetadataAad(accountKey: Uint8Array, deviceKey: Uint8Array): Uint8Array {
    const aad = new Uint8Array(accountKey.byteLength + deviceKey.byteLength);
    aad.set(accountKey);
    aad.set(deviceKey, accountKey.byteLength);
    return aad;
}

function cloudDevicePlatform(value: NodeJS.Platform): CloudDevicePlatform {
    if (value === "darwin") return "macOS";
    if (value === "linux") return "Linux";
    if (value === "win32") return "Windows";
    return "Other";
}

function deviceText(value: string, fallback: string): string {
    const normalized = value
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .trim()
        .slice(0, 256);
    return normalized.length === 0 ? fallback : normalized;
}
