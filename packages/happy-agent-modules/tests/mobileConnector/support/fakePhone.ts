import {
    createHash,
    createHmac,
    createPrivateKey,
    createPublicKey,
    diffieHellman,
    generateKeyPairSync,
    hkdfSync,
    randomBytes,
    timingSafeEqual,
    type KeyObject,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

/**
 * A test-only phone written from the "Mobile connector" section of `packages/happy-agent/API.md`,
 * independently of the daemon's `impl/` code. Its emoji table is read out of that document, so the
 * specification, not either implementation, decides the strings. The fixed vectors keep both
 * honest.
 */
const SPEC_PATH = new URL("../../../../happy-agent/API.md", import.meta.url);
const HANDSHAKE = "/v0/mobile-connector/handshake";
const LABEL = "happy-mobile-pair-v1";
const X25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");
const QR_PREFIX = "happy://direct?";

let specTable: readonly string[] | undefined;

/** The 333 emoji exactly as the specification prints them. */
export function specEmojiTable(): readonly string[] {
    if (specTable !== undefined) return specTable;
    const source = readFileSync(SPEC_PATH, "utf8");
    const match = /<!-- emoji-table-begin -->\s*```json\n([\s\S]*?)\n```/u.exec(source);
    if (match?.[1] === undefined) throw new Error("API.md has no emoji table.");
    const parsed: unknown = JSON.parse(match[1]);
    if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) {
        throw new Error("The API.md emoji table is not a string array.");
    }
    specTable = parsed;
    return parsed;
}

/** `stringForEmojiHashOfData(data, count)` as API.md describes it. */
export function specEmoji(data: Buffer, count = 4): readonly string[] {
    const table = specEmojiTable();
    const result: string[] = [];
    for (let index = 0; index < count; index += 1) {
        let value = 0n;
        for (const byte of data.subarray(index * 8, index * 8 + 8)) {
            value = (value << 8n) | BigInt(byte);
        }
        result.push(table[Number((value & ((1n << 63n) - 1n)) % BigInt(table.length))]!);
    }
    return result;
}

export interface PhoneQr {
    readonly v: number;
    readonly a: string;
    readonly p: number;
    readonly t: string;
    readonly n: string;
    readonly e: number;
    readonly u?: string;
}

const qrCommon = { t: Type.String(), n: Type.String(), e: Type.Number() };
const phoneQrSchema = Type.Union([
    Type.Object({ v: Type.Literal(1), a: Type.String(), p: Type.Integer(), ...qrCommon }),
    Type.Object({ v: Type.Literal(2), u: Type.String(), ...qrCommon }),
]);

export function parseQr(text: string): PhoneQr {
    if (!text.startsWith(QR_PREFIX)) throw new Error("Not a direct pairing code.");
    const decoded: unknown = JSON.parse(
        Buffer.from(text.slice(QR_PREFIX.length), "base64url").toString("utf8"),
    );
    if (!Value.Check(phoneQrSchema, decoded)) throw new Error("Unknown pairing code version.");
    if (decoded.v === 1) return decoded;
    const url = new URL(decoded.u);
    if (url.protocol !== "https:" || url.origin !== decoded.u || url.port === "0")
        throw new Error("Invalid public pairing origin.");
    // a/p here name the transcript binding, not extra v2 wire fields.
    return { ...decoded, a: decoded.u, p: Number(url.port || 443) };
}

export interface PhoneKey {
    readonly privateKey: KeyObject;
    readonly publicKey: Buffer;
}

export function phoneKey(scalar?: Buffer): PhoneKey {
    const privateKey =
        scalar === undefined
            ? generateKeyPairSync("x25519").privateKey
            : createPrivateKey({
                  key: Buffer.concat([X25519_PKCS8_PREFIX, scalar]),
                  format: "der",
                  type: "pkcs8",
              });
    const x = createPublicKey(privateKey).export({ format: "jwk" }).x;
    return { privateKey, publicKey: Buffer.from(String(x), "base64url") };
}

function lp(value: Buffer): Buffer {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(value.length);
    return Buffer.concat([length, value]);
}

export function commitment(publicKey: Buffer, nonce: Buffer): Buffer {
    return createHash("sha256")
        .update(Buffer.concat([Buffer.from(`${LABEL}/commit`), publicKey, nonce]))
        .digest();
}

export interface PhoneSecrets {
    readonly sharedSecret: Buffer;
    readonly transcriptHash: Buffer;
    readonly emojiKey: Buffer;
    readonly confirmKey: Buffer;
    readonly deviceToken: Buffer;
    readonly emoji: readonly string[];
}

/** Every derived value of API.md's "Derivation", from the phone's point of view. */
export function derive(input: {
    readonly own: PhoneKey;
    readonly daemonPublicKey: Buffer;
    readonly token: Buffer;
    readonly commitment: Buffer;
    readonly phoneNonce: Buffer;
    readonly daemonNonce: Buffer;
    readonly address: string;
    readonly port: number;
}): PhoneSecrets {
    const sharedSecret = diffieHellman({
        privateKey: input.own.privateKey,
        publicKey: createPublicKey({
            key: { kty: "OKP", crv: "X25519", x: input.daemonPublicKey.toString("base64url") },
            format: "jwk",
        }),
    });
    if (sharedSecret.every((byte) => byte === 0)) throw new Error("Low-order daemon key.");
    const port = Buffer.alloc(2);
    port.writeUInt16BE(input.port);
    const transcriptHash = createHash("sha256")
        .update(
            Buffer.concat([
                Buffer.from(LABEL),
                lp(input.token),
                lp(input.commitment),
                lp(input.own.publicKey),
                lp(input.daemonPublicKey),
                lp(input.phoneNonce),
                lp(input.daemonNonce),
                lp(Buffer.from(input.address, "utf8")),
                lp(port),
            ]),
        )
        .digest();
    const expand = (purpose: string) =>
        Buffer.from(hkdfSync("sha256", sharedSecret, transcriptHash, `${LABEL} ${purpose}`, 32));
    const emojiKey = expand("emoji");
    return {
        sharedSecret,
        transcriptHash,
        emojiKey,
        confirmKey: expand("confirm"),
        deviceToken: expand("device-token"),
        emoji: specEmoji(createHash("sha256").update(emojiKey).digest()),
    };
}

export function mac(secrets: PhoneSecrets, role: "mobile" | "daemon"): Buffer {
    return createHmac("sha256", secrets.confirmKey)
        .update(Buffer.concat([Buffer.from(role), secrets.transcriptHash]))
        .digest();
}

export type PhoneStatus =
    | { readonly status: "verifying" }
    | { readonly status: "completed"; readonly deviceId: string; readonly mac: string }
    | { readonly status: "rejected" }
    | { readonly status: "expired" };

export class PhoneRequestError extends Error {
    constructor(
        readonly status: number,
        readonly code: string,
        message: string,
    ) {
        super(message);
    }
}

/**
 * How the phone reaches `server.tailcat:<port>`: one request with a bearer credential. The gym
 * uses real HTTP; module tests call the module the way the API would.
 */
export type PhoneTransport = (request: {
    readonly method: "GET" | "POST";
    readonly path: string;
    readonly credential: string;
    readonly body?: unknown;
}) => Promise<{ readonly status: number; readonly body: unknown }>;

export interface PairedPhone {
    readonly deviceId: string;
    readonly deviceToken: string;
    readonly address: string;
    readonly port: number;
}

/** A phone in the middle of pairing, after it has revealed its key. */
export interface PhonePairing {
    readonly handshakeId: string;
    readonly emoji: readonly string[];
    readonly secrets: PhoneSecrets;
    confirm(): Promise<PairedPhone>;
    reject(): Promise<PhoneStatus>;
}

/** Drive start and reveal over `transport`. */
export async function startPhonePairing(
    qrText: string,
    transport: PhoneTransport,
    device: { readonly name: string; readonly platform: string } = {
        name: "Test iPhone",
        platform: "ios",
    },
): Promise<PhonePairing> {
    const qr = parseQr(qrText);
    if (qr.v !== 1 && qr.v !== 2) throw new Error("Unknown pairing code version.");
    const own = phoneKey();
    const phoneNonce = randomBytes(32);
    const committed = commitment(own.publicKey, phoneNonce);
    const started = await phoneRequest<{
        handshakeId: string;
        publicKey: string;
        nonce: string;
    }>(transport, "POST", HANDSHAKE, qr.t, {
        commitment: committed.toString("base64url"),
        device,
    });
    const handshakeId = started.handshakeId;
    const secrets = derive({
        own,
        daemonPublicKey: Buffer.from(started.publicKey, "base64url"),
        token: Buffer.from(qr.t, "base64url"),
        commitment: committed,
        phoneNonce,
        daemonNonce: Buffer.from(started.nonce, "base64url"),
        address: qr.a,
        port: qr.p,
    });
    const revealed = await phoneRequest<PhoneStatus>(
        transport,
        "POST",
        `${HANDSHAKE}/reveal`,
        handshakeId,
        { publicKey: own.publicKey.toString("base64url"), nonce: phoneNonce.toString("base64url") },
    );
    if (revealed.status !== "verifying") throw new Error(`Reveal answered ${revealed.status}.`);
    return {
        handshakeId,
        emoji: secrets.emoji,
        secrets,
        confirm: async () => {
            let status = await phoneRequest<PhoneStatus>(
                transport,
                "POST",
                `${HANDSHAKE}/confirm`,
                handshakeId,
                { mac: mac(secrets, "mobile").toString("base64url") },
            );
            while (status.status === "verifying") {
                status = await phoneRequest<PhoneStatus>(
                    transport,
                    "GET",
                    `${HANDSHAKE}?wait=25`,
                    handshakeId,
                ).catch((error: unknown) => {
                    // A handshake the daemon no longer knows reads as expired.
                    if (error instanceof PhoneRequestError && error.status === 401) {
                        return { status: "expired" } as const;
                    }
                    throw error;
                });
            }
            if (status.status !== "completed") {
                throw new PhoneRequestError(200, status.status, `Pairing ended: ${status.status}.`);
            }
            const proof = Buffer.from(status.mac, "base64url");
            const expected = mac(secrets, "daemon");
            if (proof.length !== 32 || !timingSafeEqual(proof, expected)) {
                throw new PhoneRequestError(200, "verification_failed", "Bad daemon MAC.");
            }
            return {
                deviceId: status.deviceId,
                deviceToken: secrets.deviceToken.toString("base64url"),
                address: qr.a,
                port: qr.p,
            };
        },
        reject: async () =>
            await phoneRequest<PhoneStatus>(transport, "POST", `${HANDSHAKE}/reject`, handshakeId),
    };
}

/** One request; anything but `200` throws with the error body's code. */
export async function phoneRequest<Body>(
    transport: PhoneTransport,
    method: "GET" | "POST",
    path: string,
    credential: string,
    body?: unknown,
): Promise<Body> {
    const response = await transport({
        method,
        path,
        credential,
        ...(body === undefined ? {} : { body }),
    });
    if (response.status !== 200) {
        const payload = response.body as { error?: string; code?: string } | null;
        throw new PhoneRequestError(
            response.status,
            payload?.code ?? "unknown",
            payload?.error ?? `HTTP ${String(response.status)}`,
        );
    }
    return response.body as Body;
}

/** The phone's HTTP, against `baseUrl` standing in for `server.tailcat:<port>`. */
export function httpPhoneTransport(baseUrl: string): PhoneTransport {
    return async ({ method, path, credential, body }) => {
        const response = await fetch(`${baseUrl}${path}`, {
            method,
            headers: {
                authorization: `Bearer ${credential}`,
                ...(body === undefined ? {} : { "content-type": "application/json" }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        return { status: response.status, body: await response.json().catch(() => null) };
    };
}
