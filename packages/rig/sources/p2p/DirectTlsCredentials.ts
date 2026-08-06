import { createHash, createPrivateKey, type KeyObject, X509Certificate } from "node:crypto";

import type { P2pInstanceIdentity } from "./P2pIdentity.js";
import { decodeBase64Url, encodeBase64Url } from "./P2pIdentity.js";

const CERTIFICATE_LIFETIME_MS = 10 * 365 * 24 * 60 * 60 * 1_000;
const CERTIFICATE_CLOCK_SKEW_MS = 5 * 60 * 1_000;
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const ED25519_ALGORITHM = derSequence(derOid([1, 3, 101, 112]));

export interface DirectTlsCredentials {
    certificate: string;
    privateKey: string;
}

export async function createDirectTlsCredentials(
    identity: P2pInstanceIdentity,
    now = Date.now(),
): Promise<DirectTlsCredentials> {
    const certificate = createSelfSignedCertificate(identity, now);
    return {
        certificate: pem("CERTIFICATE", certificate),
        privateKey: exportPrivateKeyPem(
            createPrivateKey({
                format: "der",
                key: Buffer.from(identity.exportPrivateKeyPkcs8()),
                type: "pkcs8",
            }),
        ),
    };
}

function createSelfSignedCertificate(identity: P2pInstanceIdentity, now: number): Uint8Array {
    const name = derSequence(
        derSet(
            derSequence(
                derOid([2, 5, 4, 3]),
                derValue(0x0c, Buffer.from(identity.instanceId, "utf8")),
            ),
        ),
    );
    const serial = createHash("sha256")
        .update(identity.instanceId)
        .update(String(now))
        .digest()
        .subarray(0, 16);
    serial[0] = serial[0]! & 0x7f;
    if (serial.every((value) => value === 0)) serial[serial.byteLength - 1] = 1;
    const publicKey = decodeBase64Url(identity.publicKey);
    const tbs = derSequence(
        derValue(0xa0, derInteger(Uint8Array.of(2))),
        derInteger(serial),
        ED25519_ALGORITHM,
        name,
        derSequence(
            derTime(new Date(now - CERTIFICATE_CLOCK_SKEW_MS)),
            derTime(new Date(now + CERTIFICATE_LIFETIME_MS)),
        ),
        name,
        derSequence(ED25519_ALGORITHM, derBitString(publicKey)),
    );
    return derSequence(tbs, ED25519_ALGORITHM, derBitString(decodeBase64Url(identity.sign(tbs))));
}

export function directTlsCertificatePublicKey(certificate: X509Certificate): string {
    const spki = Buffer.from(
        certificate.publicKey.export({
            format: "der",
            type: "spki",
        }),
    );
    if (
        spki.byteLength !== ED25519_SPKI_PREFIX.byteLength + 32 ||
        !spki.subarray(0, ED25519_SPKI_PREFIX.byteLength).equals(ED25519_SPKI_PREFIX)
    ) {
        throw new Error("The direct P2P peer certificate does not use an Ed25519 identity key.");
    }
    return encodeBase64Url(spki.subarray(ED25519_SPKI_PREFIX.byteLength));
}

export function verifyDirectTlsCertificate(certificate: X509Certificate, now = Date.now()): string {
    if (certificate.raw.byteLength === 0 || !certificate.verify(certificate.publicKey)) {
        throw new Error("The direct P2P peer certificate is not self-signed.");
    }
    const validFrom = Date.parse(certificate.validFrom);
    const validTo = Date.parse(certificate.validTo);
    if (
        !Number.isFinite(validFrom) ||
        !Number.isFinite(validTo) ||
        validFrom > now + CERTIFICATE_CLOCK_SKEW_MS ||
        validTo < now - CERTIFICATE_CLOCK_SKEW_MS
    ) {
        throw new Error("The direct P2P peer certificate is not currently valid.");
    }
    return directTlsCertificatePublicKey(certificate);
}

function exportPrivateKeyPem(key: KeyObject): string {
    const exported = key.export({ format: "pem", type: "pkcs8" });
    return typeof exported === "string" ? exported : exported.toString("utf8");
}

function derSequence(...values: readonly Uint8Array[]): Uint8Array {
    return derValue(0x30, Buffer.concat(values));
}

function derSet(...values: readonly Uint8Array[]): Uint8Array {
    return derValue(0x31, Buffer.concat(values));
}

function derInteger(value: Uint8Array): Uint8Array {
    let offset = 0;
    while (
        offset + 1 < value.byteLength &&
        value[offset] === 0 &&
        (value[offset + 1] ?? 0) < 0x80
    ) {
        offset += 1;
    }
    value = value.subarray(offset);
    const positive =
        (value[0] ?? 0) >= 0x80 ? Buffer.concat([Buffer.from([0]), Buffer.from(value)]) : value;
    return derValue(0x02, positive);
}

function derBitString(value: Uint8Array): Uint8Array {
    return derValue(0x03, Buffer.concat([Buffer.from([0]), Buffer.from(value)]));
}

function derTime(value: Date): Uint8Array {
    const year = value.getUTCFullYear();
    if (year < 1950 || year > 9999) {
        throw new Error("The direct P2P certificate date is outside the supported range.");
    }
    const two = (number: number) => String(number).padStart(2, "0");
    const suffix = `${two(value.getUTCMonth() + 1)}${two(value.getUTCDate())}${two(value.getUTCHours())}${two(value.getUTCMinutes())}${two(value.getUTCSeconds())}Z`;
    return year <= 2049
        ? derValue(0x17, Buffer.from(`${two(year % 100)}${suffix}`, "ascii"))
        : derValue(0x18, Buffer.from(`${String(year).padStart(4, "0")}${suffix}`, "ascii"));
}

function derOid(parts: readonly number[]): Uint8Array {
    if (parts.length < 2 || parts[0] === undefined || parts[1] === undefined) {
        throw new Error("The direct P2P certificate contains an invalid object identifier.");
    }
    const bytes = [parts[0] * 40 + parts[1]];
    for (const part of parts.slice(2)) {
        const encoded = [part & 0x7f];
        for (let value = Math.floor(part / 128); value > 0; value = Math.floor(value / 128)) {
            encoded.unshift((value & 0x7f) | 0x80);
        }
        bytes.push(...encoded);
    }
    return derValue(0x06, Uint8Array.from(bytes));
}

function derValue(tag: number, value: Uint8Array): Uint8Array {
    return Buffer.concat([Buffer.from([tag]), derLength(value.byteLength), Buffer.from(value)]);
}

function derLength(length: number): Uint8Array {
    if (length < 0x80) return Uint8Array.of(length);
    const bytes: number[] = [];
    for (let value = length; value > 0; value = Math.floor(value / 256)) {
        bytes.unshift(value & 0xff);
    }
    return Uint8Array.from([0x80 | bytes.length, ...bytes]);
}

function pem(label: string, value: Uint8Array): string {
    const body =
        Buffer.from(value)
            .toString("base64")
            .match(/.{1,64}/gu)
            ?.join("\n") ?? "";
    return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}
