import { randomBytes } from "node:crypto";

import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import {
    finishWrites,
    writeBytes,
    type P2pFrameDuplex,
    type P2pFrameReader,
} from "./P2pFrameDuplex.js";
import {
    encodeBase64Url,
    p2pInstanceIdSchema,
    p2pPublicKeySchema,
    verifyP2pSignature,
    type P2pInstanceIdentity,
    type P2pPeerIdentity,
} from "./P2pIdentity.js";
import type { P2pTransportKind } from "./P2pTransport.js";

const HELLO_LIFETIME_MS = 5 * 60 * 1_000;
const MAXIMUM_CLOCK_SKEW_MS = 5 * 60 * 1_000;
const MAXIMUM_HELLO_BYTES = 8 * 1_024;

/**
 * Names the transport-specific value that identifies one end of the live
 * channel: an Iroh endpoint ID, a direct TLS certificate fingerprint, and so
 * on. Every signed hello message carries it alongside the transport kind, so a
 * proof minted for one transport can never be replayed on another.
 */
const channelBindingSchema = Type.String({
    maxLength: 128,
    minLength: 16,
    pattern: "^[A-Za-z0-9_-]+$",
});
const transportSchema = Type.Union([
    Type.Literal("direct"),
    Type.Literal("iroh"),
    Type.Literal("ssh"),
]);
const nonceSchema = Type.String({
    maxLength: 43,
    minLength: 43,
    pattern: "^[A-Za-z0-9_-]+$",
});
const signatureSchema = Type.String({
    maxLength: 86,
    minLength: 86,
    pattern: "^[A-Za-z0-9_-]+$",
});
const announcementSchema = Type.Object(
    {
        channelBinding: channelBindingSchema,
        expiresAt: Type.Integer({ minimum: 0 }),
        instanceId: p2pInstanceIdSchema,
        issuedAt: Type.Integer({ minimum: 0 }),
        nonce: nonceSchema,
        publicKey: p2pPublicKeySchema,
        signature: signatureSchema,
        transport: transportSchema,
        version: Type.Literal(2),
    },
    { additionalProperties: false },
);
type Announcement = Static<typeof announcementSchema>;

const proofSchema = Type.Object(
    {
        expiresAt: Type.Integer({ minimum: 0 }),
        initiatorChannelBinding: channelBindingSchema,
        initiatorNonce: nonceSchema,
        instanceId: p2pInstanceIdSchema,
        issuedAt: Type.Integer({ minimum: 0 }),
        publicKey: p2pPublicKeySchema,
        responderChannelBinding: channelBindingSchema,
        responderNonce: nonceSchema,
        role: Type.Union([Type.Literal("initiator"), Type.Literal("responder")]),
        signature: signatureSchema,
        transport: transportSchema,
        version: Type.Literal(2),
    },
    { additionalProperties: false },
);
export type P2pHelloProof = Static<typeof proofSchema>;

const finishSchema = Type.Object(
    {
        signature: signatureSchema,
        version: Type.Literal(2),
    },
    { additionalProperties: false },
);
export type P2pHelloFinish = Static<typeof finishSchema>;

export interface P2pHelloContext {
    initiatorChannelBinding: string;
    initiatorNonce: string;
    responderChannelBinding: string;
    responderNonce: string;
    transport: P2pTransportKind;
}

interface HelloOptions {
    commitPeer?: (identity: P2pPeerIdentity, channelBinding: string) => Promise<void>;
    identity: P2pInstanceIdentity;
    localChannelBinding: string;
    now?: () => number;
    onContext?: (context: P2pHelloContext) => void;
    randomNonce?: () => string;
    remoteChannelBinding: string;
    transport: P2pTransportKind;
    validatePeer?: (identity: P2pPeerIdentity, channelBinding: string) => Promise<void>;
}

export async function runP2pInitiatorHello(
    duplex: P2pFrameDuplex,
    options: HelloOptions,
): Promise<P2pPeerIdentity> {
    const now = options.now ?? Date.now;
    const initiatorNonce = (options.randomNonce ?? createNonce)();
    await writeJson(
        duplex,
        createAnnouncement(
            options.identity,
            options.transport,
            options.localChannelBinding,
            initiatorNonce,
            now(),
        ),
        announcementSchema,
    );
    const responderProof = await readJson(duplex.recv, proofSchema);
    const context: P2pHelloContext = {
        initiatorChannelBinding: options.localChannelBinding,
        initiatorNonce,
        responderChannelBinding: options.remoteChannelBinding,
        responderNonce: responderProof.responderNonce,
        transport: options.transport,
    };
    const remoteIdentity = verifyP2pHelloProof(responderProof, "responder", context, now());
    await options.validatePeer?.(remoteIdentity, options.remoteChannelBinding);
    await writeJson(
        duplex,
        createP2pHelloProof(options.identity, "initiator", context, now()),
        proofSchema,
    );
    await finishWrites(duplex.send);
    const finish = await readJson(duplex.recv, finishSchema);
    verifyP2pHelloFinish(finish, remoteIdentity, options.identity, context);
    await options.commitPeer?.(remoteIdentity, options.remoteChannelBinding);
    options.onContext?.(context);
    return remoteIdentity;
}

export async function runP2pResponderHello(
    duplex: P2pFrameDuplex,
    options: HelloOptions,
): Promise<P2pPeerIdentity> {
    const now = options.now ?? Date.now;
    const announcement = await readJson(duplex.recv, announcementSchema);
    const announcedIdentity = verifyAnnouncement(
        announcement,
        options.transport,
        options.remoteChannelBinding,
        now(),
    );
    const context: P2pHelloContext = {
        initiatorChannelBinding: options.remoteChannelBinding,
        initiatorNonce: announcement.nonce,
        responderChannelBinding: options.localChannelBinding,
        responderNonce: (options.randomNonce ?? createNonce)(),
        transport: options.transport,
    };
    await writeJson(
        duplex,
        createP2pHelloProof(options.identity, "responder", context, now()),
        proofSchema,
    );
    const initiatorProof = await readJson(duplex.recv, proofSchema);
    const remoteIdentity = verifyP2pHelloProof(initiatorProof, "initiator", context, now());
    if (
        remoteIdentity.instanceId !== announcedIdentity.instanceId ||
        remoteIdentity.publicKey !== announcedIdentity.publicKey
    ) {
        throw new Error("The peer changed its P2P identity during the signed hello.");
    }
    await options.validatePeer?.(remoteIdentity, options.remoteChannelBinding);
    await options.commitPeer?.(remoteIdentity, options.remoteChannelBinding);
    await writeJson(
        duplex,
        createP2pHelloFinish(options.identity, remoteIdentity, context),
        finishSchema,
    );
    await finishWrites(duplex.send);
    options.onContext?.(context);
    return remoteIdentity;
}

export function createP2pHelloProof(
    identity: P2pInstanceIdentity,
    role: P2pHelloProof["role"],
    context: P2pHelloContext,
    issuedAt: number,
): P2pHelloProof {
    const unsigned = {
        expiresAt: issuedAt + HELLO_LIFETIME_MS,
        ...context,
        instanceId: identity.instanceId,
        issuedAt,
        publicKey: identity.publicKey,
        role,
        version: 2 as const,
    };
    return {
        ...unsigned,
        signature: identity.sign(proofMessage(unsigned)),
    };
}

export function verifyP2pHelloProof(
    proof: P2pHelloProof,
    role: P2pHelloProof["role"],
    context: P2pHelloContext,
    now: number,
): P2pPeerIdentity {
    if (!Value.Check(proofSchema, proof)) {
        throw new Error("The peer returned an invalid signed P2P hello.");
    }
    if (
        proof.role !== role ||
        proof.transport !== context.transport ||
        proof.initiatorChannelBinding !== context.initiatorChannelBinding ||
        proof.responderChannelBinding !== context.responderChannelBinding ||
        proof.initiatorNonce !== context.initiatorNonce ||
        proof.responderNonce !== context.responderNonce
    ) {
        throw new Error("The peer's signed P2P hello is bound to another connection.");
    }
    verifyLifetime(proof.issuedAt, proof.expiresAt, now);
    const { signature, ...unsigned } = proof;
    if (!verifyP2pSignature(proofMessage(unsigned), signature, proof.publicKey)) {
        throw new Error("The peer's signed P2P hello could not be verified.");
    }
    return { instanceId: proof.instanceId, publicKey: proof.publicKey };
}

export function createP2pHelloFinish(
    responderIdentity: P2pInstanceIdentity,
    initiatorIdentity: P2pPeerIdentity,
    context: P2pHelloContext,
): P2pHelloFinish {
    return {
        signature: responderIdentity.sign(
            finishMessage(responderIdentity, initiatorIdentity, context),
        ),
        version: 2,
    };
}

export function verifyP2pHelloFinish(
    finish: P2pHelloFinish,
    responderIdentity: P2pPeerIdentity,
    initiatorIdentity: P2pPeerIdentity,
    context: P2pHelloContext,
): void {
    if (!Value.Check(finishSchema, finish)) {
        throw new Error("The peer returned an invalid P2P hello confirmation.");
    }
    if (
        !verifyP2pSignature(
            finishMessage(responderIdentity, initiatorIdentity, context),
            finish.signature,
            responderIdentity.publicKey,
        )
    ) {
        throw new Error("The peer did not confirm the signed P2P hello.");
    }
}

function createAnnouncement(
    identity: P2pInstanceIdentity,
    transport: P2pTransportKind,
    channelBinding: string,
    nonce: string,
    issuedAt: number,
): Announcement {
    const unsigned = {
        channelBinding,
        expiresAt: issuedAt + HELLO_LIFETIME_MS,
        instanceId: identity.instanceId,
        issuedAt,
        nonce,
        publicKey: identity.publicKey,
        transport,
        version: 2 as const,
    };
    return {
        ...unsigned,
        signature: identity.sign(announcementMessage(unsigned)),
    };
}

function verifyAnnouncement(
    announcement: Announcement,
    transport: P2pTransportKind,
    channelBinding: string,
    now: number,
): P2pPeerIdentity {
    if (announcement.transport !== transport || announcement.channelBinding !== channelBinding) {
        throw new Error("The peer signed a different P2P transport channel.");
    }
    verifyLifetime(announcement.issuedAt, announcement.expiresAt, now);
    const { signature, ...unsigned } = announcement;
    if (!verifyP2pSignature(announcementMessage(unsigned), signature, announcement.publicKey)) {
        throw new Error("The peer's P2P identity announcement could not be verified.");
    }
    return {
        instanceId: announcement.instanceId,
        publicKey: announcement.publicKey,
    };
}

function verifyLifetime(issuedAt: number, expiresAt: number, now: number): void {
    if (expiresAt <= issuedAt || expiresAt - issuedAt > HELLO_LIFETIME_MS) {
        throw new Error("The peer's signed P2P hello has an invalid lifetime.");
    }
    if (issuedAt > now + MAXIMUM_CLOCK_SKEW_MS) {
        throw new Error("The peer's clock differs from this machine's by more than five minutes.");
    }
    if (expiresAt < now - MAXIMUM_CLOCK_SKEW_MS) {
        throw new Error(
            "The peer's signed P2P hello has expired, or its clock differs by more than five minutes.",
        );
    }
}

function announcementMessage(announcement: Omit<Announcement, "signature">): Uint8Array {
    return Buffer.from(
        JSON.stringify([
            "rig-p2p-announcement-v2",
            announcement.instanceId,
            announcement.publicKey,
            announcement.transport,
            announcement.channelBinding,
            announcement.issuedAt,
            announcement.expiresAt,
            announcement.nonce,
        ]),
        "utf8",
    );
}

function proofMessage(proof: Omit<P2pHelloProof, "signature">): Uint8Array {
    return Buffer.from(
        JSON.stringify([
            "rig-p2p-proof-v2",
            proof.role,
            proof.instanceId,
            proof.publicKey,
            proof.issuedAt,
            proof.expiresAt,
            proof.transport,
            proof.initiatorChannelBinding,
            proof.responderChannelBinding,
            proof.initiatorNonce,
            proof.responderNonce,
        ]),
        "utf8",
    );
}

function finishMessage(
    responderIdentity: P2pPeerIdentity,
    initiatorIdentity: P2pPeerIdentity,
    context: P2pHelloContext,
): Uint8Array {
    return Buffer.from(
        JSON.stringify([
            "rig-p2p-finish-v2",
            initiatorIdentity.instanceId,
            initiatorIdentity.publicKey,
            responderIdentity.instanceId,
            responderIdentity.publicKey,
            context.transport,
            context.initiatorChannelBinding,
            context.responderChannelBinding,
            context.initiatorNonce,
            context.responderNonce,
        ]),
        "utf8",
    );
}

async function readJson(
    recv: P2pFrameReader,
    schema: typeof announcementSchema,
): Promise<Announcement>;
async function readJson(recv: P2pFrameReader, schema: typeof proofSchema): Promise<P2pHelloProof>;
async function readJson(recv: P2pFrameReader, schema: typeof finishSchema): Promise<P2pHelloFinish>;
async function readJson(
    recv: P2pFrameReader,
    schema: typeof announcementSchema | typeof finishSchema | typeof proofSchema,
): Promise<Announcement | P2pHelloFinish | P2pHelloProof> {
    const length = Buffer.from(await recv.read(4)).readUInt32BE(0);
    if (length === 0 || length > MAXIMUM_HELLO_BYTES) {
        throw new Error("The peer returned an invalid P2P hello frame.");
    }
    const source = Buffer.from(await recv.read(length)).toString("utf8");
    let parsed: unknown;
    try {
        parsed = JSON.parse(source);
    } catch {
        throw new Error("The peer returned malformed P2P hello data.");
    }
    return Value.Decode(schema, parsed) as Announcement | P2pHelloFinish | P2pHelloProof;
}

async function writeJson(
    duplex: P2pFrameDuplex,
    value: Announcement | P2pHelloFinish | P2pHelloProof,
    schema: typeof announcementSchema | typeof finishSchema | typeof proofSchema,
): Promise<void> {
    const encoded = Buffer.from(JSON.stringify(Value.Encode(schema, value)), "utf8");
    if (encoded.byteLength === 0 || encoded.byteLength > MAXIMUM_HELLO_BYTES) {
        throw new Error("The signed P2P hello is too large.");
    }
    const frame = Buffer.allocUnsafe(4 + encoded.byteLength);
    frame.writeUInt32BE(encoded.byteLength, 0);
    encoded.copy(frame, 4);
    await writeBytes(duplex.send, frame);
}

function createNonce(): string {
    return encodeBase64Url(randomBytes(32));
}
