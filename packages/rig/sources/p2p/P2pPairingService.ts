import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { createId } from "@paralleldrive/cuid2";
import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Connection, Endpoint, RelayMode } from "@number0/iroh/index.js";

import type { ConfigIrohTransport } from "../config/types.js";
import {
    p2pInvitationPayloadSchema,
    type CreateP2pInvitationResponse,
    type P2pInvitationPayload,
    type P2pPairingPeer,
    type P2pPairingState,
} from "../protocol/P2pPairingProtocol.js";
import { createIrohFrameDuplex, finishWrites, readBytes, writeBytes } from "./P2pFrameDuplex.js";
import {
    runP2pInitiatorHello,
    runP2pResponderHello,
    type P2pHelloContext,
} from "./P2pHelloProtocol.js";
import { loadIrohBindings } from "./loadIrohBindings.js";
import {
    decodeBase64Url,
    encodeBase64Url,
    verifyP2pSignature,
    type P2pInstanceIdentity,
    type P2pPeerIdentity,
} from "./P2pIdentity.js";
import type { P2pPeerTrustStoreContract } from "./P2pPeerTrustStore.js";
import { p2pPairingTransactionIdSchema, type P2pTrustedPeer } from "./P2pPeer.js";
import { telegramEmojiFingerprint } from "./telegramEmojiFingerprint.js";

const PAIRING_ALPN = [...Buffer.from("rig/p2p/pair/2", "utf8")];
const INVITATION_LIFETIME_MS = 5 * 60 * 1_000;
const VERIFICATION_LIFETIME_MS = 5 * 60 * 1_000;
const HANDSHAKE_TIMEOUT_MS = 30_000;
const BOOTSTRAP_TIMEOUT_MS = 5_000;
const CLOSE_TIMEOUT_MS = 5_000;
const MAXIMUM_PAIRINGS = 8;
const MAXIMUM_RETAINED_PAIRINGS = 64;
const MAXIMUM_PAIRING_FRAME_BYTES = 8 * 1_024;
const CLOSE_PAIRING = 0n;

const exact = { additionalProperties: false } as const;
const bootstrapSchema = Type.Object(
    {
        token: Type.String({ maxLength: 43, minLength: 43, pattern: "^[A-Za-z0-9_-]+$" }),
        version: Type.Literal(1),
    },
    exact,
);
const profileSchema = Type.Object(
    {
        instanceId: Type.String({
            maxLength: 32,
            minLength: 2,
            pattern: "^[a-z][a-z0-9]+$",
        }),
        irohEndpointId: Type.String({ pattern: "^[0-9a-f]{64}$" }),
        irohEndpointTicket: Type.String({ maxLength: 4_096, minLength: 1 }),
        name: Type.String({
            maxLength: 128,
            minLength: 1,
            pattern: "^[^\\u0000-\\u001f\\u007f]+$",
        }),
        publicKey: Type.String({
            maxLength: 43,
            minLength: 43,
            pattern: "^[A-Za-z0-9_-]+$",
        }),
        role: Type.Union([Type.Literal("initiator"), Type.Literal("responder")]),
        signature: Type.String({
            maxLength: 86,
            minLength: 86,
            pattern: "^[A-Za-z0-9_-]+$",
        }),
        version: Type.Literal(2),
    },
    exact,
);
type PairingProfile = Static<typeof profileSchema>;
const decisionSchema = Type.Object({ accept: Type.Boolean(), version: Type.Literal(1) }, exact);
type PairingDecision = Static<typeof decisionSchema>;
const readySchema = Type.Object(
    {
        pairingId: p2pPairingTransactionIdSchema,
        ready: Type.Literal(true),
        version: Type.Literal(1),
    },
    exact,
);

interface PairingOperation {
    consumed: boolean;
    decision?: Deferred<boolean>;
    endpoint: Endpoint;
    state: P2pPairingState;
    token: string;
}

export interface CreateP2pPairingServiceOptions {
    /** Test seam for deterministic ready-frame failure coverage. */
    beforeReadyWrite?: (role: "inviter" | "joiner") => Promise<void>;
    bindings?: Awaited<ReturnType<typeof loadIrohBindings>>;
    config: ConfigIrohTransport;
    identity: P2pInstanceIdentity;
    name: () => string;
    onPeerTrusted?: (peer: P2pTrustedPeer) => void;
    peerTrustStore: P2pPeerTrustStoreContract;
    setPrimaryIfUnset: (primaryId: string) => Promise<void>;
    stableIrohEndpointId: string;
    stableIrohEndpointTicket: () => Promise<string> | string;
    /** Test seam for relay-free endpoints. */
    relayMode?: RelayMode;
    /** Production waits for a usable relay before printing the invitation. */
    waitUntilOnline?: boolean;
}

export interface P2pPairingServiceContract {
    answer(id: string, accept: boolean): P2pPairingState;
    createInvitation(): Promise<CreateP2pInvitationResponse>;
    get(id: string): P2pPairingState | undefined;
    join(invitation: string): Promise<{ id: string }>;
}

export class P2pPairingService implements P2pPairingServiceContract {
    readonly #operations = new Map<string, PairingOperation>();
    readonly #options: CreateP2pPairingServiceOptions;
    readonly #tasks = new Set<Promise<void>>();

    constructor(options: CreateP2pPairingServiceOptions) {
        this.#options = options;
    }

    async close(): Promise<void> {
        for (const operation of this.#operations.values()) {
            operation.decision?.reject(new Error("The P2P pairing service stopped."));
        }
        await Promise.allSettled([
            ...[...this.#operations.values()].map((operation) => operation.endpoint.close()),
            withDeadline(
                Promise.allSettled(this.#tasks),
                CLOSE_TIMEOUT_MS,
                "The P2P pairing service did not stop in time.",
            ),
        ]);
    }

    async createInvitation(): Promise<CreateP2pInvitationResponse> {
        this.#reserve();
        const bindings = this.#options.bindings ?? (await loadIrohBindings());
        const endpoint = await bindings.Endpoint.bind(
            { alpns: [PAIRING_ALPN], secretKey: bindings.SecretKey.generate().toBytes() },
            this.#relayMode(bindings),
        );
        try {
            if (this.#options.waitUntilOnline !== false) {
                await withDeadline(
                    endpoint.online(),
                    HANDSHAKE_TIMEOUT_MS,
                    "The temporary P2P invitation endpoint could not reach its relay.",
                );
            }
            const id = createId();
            const token = encodeBase64Url(randomBytes(32));
            const expiresAt = Date.now() + INVITATION_LIFETIME_MS;
            const payload: P2pInvitationPayload = {
                address: bindings.EndpointTicket.fromAddr(endpoint.addr()).toString(),
                expiresAt,
                instanceId: this.#options.identity.instanceId,
                publicKey: this.#options.identity.publicKey,
                token,
                transport: "iroh",
                version: 1,
            };
            const operation: PairingOperation = {
                consumed: false,
                endpoint,
                state: { expiresAt, id, phase: "waiting", role: "inviter" },
                token,
            };
            this.#operations.set(id, operation);
            this.#track(this.#runInviter(operation));
            return { id, invitation: encodeInvitation(payload) };
        } catch (error) {
            await endpoint.close().catch(() => undefined);
            throw error;
        }
    }

    async join(invitation: string): Promise<{ id: string }> {
        this.#reserve();
        const payload = decodeInvitation(invitation);
        if (payload.expiresAt <= Date.now()) {
            throw new Error("This P2P invitation has expired.");
        }
        if (payload.instanceId === this.#options.identity.instanceId) {
            throw new Error("A Rig cannot join its own P2P invitation.");
        }
        const expiresAt = Math.min(payload.expiresAt, Date.now() + INVITATION_LIFETIME_MS);
        const bindings = this.#options.bindings ?? (await loadIrohBindings());
        const endpoint = await bindings.Endpoint.bind(
            { alpns: [PAIRING_ALPN], secretKey: bindings.SecretKey.generate().toBytes() },
            this.#relayMode(bindings),
        );
        const id = createId();
        const operation: PairingOperation = {
            consumed: true,
            endpoint,
            state: {
                expiresAt,
                id,
                phase: "connecting",
                role: "joiner",
            },
            token: payload.token,
        };
        this.#operations.set(id, operation);
        this.#track(this.#runJoiner(operation, payload, bindings));
        return { id };
    }

    get(id: string): P2pPairingState | undefined {
        const operation = this.#operations.get(id);
        if (operation === undefined) return undefined;
        this.#expire(operation);
        return operation.state;
    }

    answer(id: string, accept: boolean): P2pPairingState {
        const operation = this.#operations.get(id);
        if (operation === undefined) throw new Error("That P2P pairing does not exist.");
        this.#expire(operation);
        if (operation.state.phase !== "verifying" || operation.decision === undefined) {
            throw new Error("That P2P pairing is not waiting for emoji verification.");
        }
        operation.decision.resolve(accept);
        return operation.state;
    }

    async #runInviter(operation: PairingOperation): Promise<void> {
        let connection: Connection | undefined;
        try {
            const accepted = await this.#acceptInviter(operation);
            connection = accepted.connection;
            let context: P2pHelloContext | undefined;
            const remoteIdentity = await withPairingDeadline(
                operation,
                runP2pResponderHello(accepted.helloDuplex, {
                    identity: this.#options.identity,
                    localChannelBinding: operation.endpoint.id().toString(),
                    onContext: (value) => {
                        context = value;
                    },
                    remoteChannelBinding: connection.remoteId().toString(),
                    transport: "iroh",
                }),
                "The joining Rig did not finish its signed P2P hello in time.",
            );
            if (context === undefined) throw new Error("The signed P2P hello did not complete.");
            const profileStream = await withPairingDeadline(
                operation,
                connection.acceptBi(),
                "The joining Rig did not start emoji verification in time.",
            );
            await this.#verifyAndCommit(
                operation,
                createIrohFrameDuplex(profileStream.recv, profileStream.send),
                remoteIdentity,
                context,
                "responder",
            );
        } catch (error) {
            this.#fail(operation, error);
        } finally {
            connection?.close(CLOSE_PAIRING, []);
            await operation.endpoint.close().catch(() => undefined);
        }
    }

    async #acceptInviter(operation: PairingOperation): Promise<{
        connection: Connection;
        helloDuplex: ReturnType<typeof createIrohFrameDuplex>;
    }> {
        while (Date.now() < operation.state.expiresAt && !operation.consumed) {
            let connection: Connection | undefined;
            try {
                const incoming = await withOperationExpiry(
                    operation,
                    operation.endpoint.acceptNext(),
                    "The P2P invitation expired before another Rig joined.",
                );
                if (incoming === null) throw new PairingEndpointClosedError();
                const connecting = (await incoming.accept()).connect();
                try {
                    connection = await withDeadline(
                        connecting,
                        Math.min(BOOTSTRAP_TIMEOUT_MS, operation.state.expiresAt - Date.now()),
                        "The joining Rig did not finish its Iroh handshake in time.",
                    );
                } catch (error) {
                    void connecting.then(
                        (late) => late.close(CLOSE_PAIRING, []),
                        () => undefined,
                    );
                    throw error;
                }
                const helloStream = await withDeadline(
                    connection.acceptBi(),
                    Math.min(BOOTSTRAP_TIMEOUT_MS, operation.state.expiresAt - Date.now()),
                    "The joining Rig did not present its invitation token in time.",
                );
                const helloDuplex = createIrohFrameDuplex(helloStream.recv, helloStream.send);
                const bootstrap = await withDeadline(
                    readJson(helloDuplex.recv, bootstrapSchema),
                    Math.min(BOOTSTRAP_TIMEOUT_MS, operation.state.expiresAt - Date.now()),
                    "The joining Rig did not present its invitation token in time.",
                );
                if (!equalToken(bootstrap.token, operation.token)) {
                    connection.close(CLOSE_PAIRING, []);
                    continue;
                }
                operation.consumed = true;
                return { connection, helloDuplex };
            } catch (error) {
                connection?.close(CLOSE_PAIRING, []);
                if (error instanceof PairingEndpointClosedError) throw error;
                if (Date.now() >= operation.state.expiresAt) throw error;
            }
        }
        throw new Error("The P2P invitation expired before another Rig joined.");
    }

    async #runJoiner(
        operation: PairingOperation,
        invitation: P2pInvitationPayload,
        bindings: Awaited<ReturnType<typeof loadIrohBindings>>,
    ): Promise<void> {
        let connection: Connection | undefined;
        try {
            const ticket = bindings.EndpointTicket.fromString(invitation.address);
            connection = await withPairingDeadline(
                operation,
                operation.endpoint.connect(ticket.endpointAddr(), PAIRING_ALPN),
                "Rig could not connect to the temporary P2P invitation endpoint.",
            );
            const helloStream = await withPairingDeadline(
                operation,
                connection.openBi(),
                "Rig could not open the temporary P2P invitation stream.",
            );
            const helloDuplex = createIrohFrameDuplex(helloStream.recv, helloStream.send);
            await withPairingDeadline(
                operation,
                writeJson(helloDuplex.send, { token: invitation.token, version: 1 }),
                "Rig could not send the P2P invitation token in time.",
            );
            let context: P2pHelloContext | undefined;
            const remoteIdentity = await withPairingDeadline(
                operation,
                runP2pInitiatorHello(helloDuplex, {
                    identity: this.#options.identity,
                    localChannelBinding: operation.endpoint.id().toString(),
                    onContext: (value) => {
                        context = value;
                    },
                    remoteChannelBinding: connection.remoteId().toString(),
                    transport: "iroh",
                    validatePeer: async (identity) => {
                        if (
                            identity.instanceId !== invitation.instanceId ||
                            identity.publicKey !== invitation.publicKey
                        ) {
                            throw new Error(
                                "The P2P invitation was answered by a different Rig identity.",
                            );
                        }
                    },
                }),
                "The inviting Rig did not finish its signed P2P hello in time.",
            );
            if (context === undefined) throw new Error("The signed P2P hello did not complete.");
            const profileStream = await withPairingDeadline(
                operation,
                connection.openBi(),
                "Rig could not open the P2P verification stream.",
            );
            await this.#verifyAndCommit(
                operation,
                createIrohFrameDuplex(profileStream.recv, profileStream.send),
                remoteIdentity,
                context,
                "initiator",
            );
        } catch (error) {
            this.#fail(operation, error);
        } finally {
            connection?.close(CLOSE_PAIRING, []);
            await operation.endpoint.close().catch(() => undefined);
        }
    }

    async #verifyAndCommit(
        operation: PairingOperation,
        duplex: ReturnType<typeof createIrohFrameDuplex>,
        remoteIdentity: P2pPeerIdentity,
        context: P2pHelloContext,
        role: PairingProfile["role"],
    ): Promise<void> {
        const stableIrohEndpointTicket = await withPairingDeadline(
            operation,
            Promise.resolve(this.#options.stableIrohEndpointTicket()),
            "The stable Iroh endpoint did not obtain a usable relay address in time.",
        );
        const localProfile = createProfile(
            this.#options.identity,
            this.#options.name(),
            this.#options.stableIrohEndpointId,
            stableIrohEndpointTicket,
            role,
            context,
            operation.token,
        );
        const remoteProfile =
            role === "initiator"
                ? await (async () => {
                      await withPairingDeadline(
                          operation,
                          writeJson(duplex.send, localProfile),
                          "The P2P profile could not be sent in time.",
                      );
                      return withPairingDeadline(
                          operation,
                          readJson(duplex.recv, profileSchema),
                          "The peer did not send its P2P profile in time.",
                      );
                  })()
                : await (async () => {
                      const profile = await withPairingDeadline(
                          operation,
                          readJson(duplex.recv, profileSchema),
                          "The peer did not send its P2P profile in time.",
                      );
                      await withPairingDeadline(
                          operation,
                          writeJson(duplex.send, localProfile),
                          "The P2P profile could not be sent in time.",
                      );
                      return profile;
                  })();
        verifyProfile(remoteProfile, remoteIdentity, oppositeRole(role), context, operation.token);
        const bindings = this.#options.bindings ?? (await loadIrohBindings());
        const remoteAddress = bindings.EndpointTicket.fromString(
            remoteProfile.irohEndpointTicket,
        ).endpointAddr();
        if (remoteAddress.id().toString() !== remoteProfile.irohEndpointId) {
            throw new Error("The peer's stable Iroh address identifies a different endpoint.");
        }
        await this.#options.peerTrustStore.validate(
            remoteIdentity,
            "iroh",
            remoteProfile.irohEndpointId,
        );
        const peer: P2pPairingPeer = {
            instanceId: remoteIdentity.instanceId,
            name: remoteProfile.name,
            publicKey: remoteIdentity.publicKey,
        };
        const initiator = role === "initiator" ? localProfile : remoteProfile;
        const responder = role === "responder" ? localProfile : remoteProfile;
        const verificationToken = operation.token;
        operation.token = "";
        operation.decision = deferred<boolean>();
        const verificationDigest = verificationHash(
            initiator,
            responder,
            context,
            verificationToken,
        );
        const pairingId = encodeBase64Url(verificationDigest);
        operation.state = {
            emojis: telegramEmojiFingerprint(verificationDigest),
            expiresAt: Date.now() + VERIFICATION_LIFETIME_MS,
            id: operation.state.id,
            peer,
            phase: "verifying",
            role: operation.state.role,
        };
        const accept = await withDeadline(
            operation.decision.promise,
            operation.state.expiresAt - Date.now(),
            "The P2P verification expired before it was confirmed.",
        );
        await withPairingDeadline(
            operation,
            writeJson(duplex.send, { accept, version: 1 } satisfies PairingDecision),
            "The P2P verification answer could not be sent in time.",
        );
        const remoteDecision = await withOperationExpiry(
            operation,
            readJson(duplex.recv, decisionSchema),
            "The peer did not answer P2P verification in time.",
        );
        if (!accept || !remoteDecision.accept) {
            await finishWrites(duplex.send);
            operation.state = {
                expiresAt: operation.state.expiresAt,
                id: operation.state.id,
                phase: "rejected",
                role: operation.state.role,
            };
            return;
        }
        const prepared = await this.#options.peerTrustStore.preparePairing(
            pairingId,
            remoteIdentity,
            "iroh",
            remoteProfile.irohEndpointId,
            {
                iroh: {
                    endpointId: remoteProfile.irohEndpointId,
                    ticket: remoteProfile.irohEndpointTicket,
                },
            },
            remoteProfile.name,
            operation.state.role === "joiner",
            operation.state.expiresAt,
        );
        let confirmed = false;
        try {
            await prepared.markLocallyReady();
            await this.#options.beforeReadyWrite?.(operation.state.role);
            await withPairingDeadline(
                operation,
                writeJson(duplex.send, { pairingId, ready: true, version: 1 }),
                "The P2P pairing readiness could not be sent in time.",
            );
            const remoteReady = await withPairingDeadline(
                operation,
                readJson(duplex.recv, readySchema),
                "The peer did not confirm its P2P pairing readiness in time.",
            );
            if (remoteReady.pairingId !== pairingId) {
                throw new Error("The peer confirmed a different P2P pairing transaction.");
            }
            await prepared.markConfirmed();
            confirmed = true;
        } finally {
            if (!confirmed) await prepared.abort();
        }
        const trustedPeer = await prepared.activate();
        if (prepared.pairing.assignPrimary) {
            await this.#options.setPrimaryIfUnset(remoteIdentity.instanceId);
        }
        await prepared.complete();
        try {
            this.#options.onPeerTrusted?.(trustedPeer);
        } catch {
            // Status refresh cannot invalidate a mutually committed pairing.
        }
        await finishWrites(duplex.send).catch(() => undefined);
        operation.state = {
            expiresAt: operation.state.expiresAt,
            id: operation.state.id,
            peer,
            phase: "connected",
            role: operation.state.role,
        };
    }

    #expire(operation: PairingOperation): void {
        if (
            Date.now() >= operation.state.expiresAt &&
            operation.state.phase !== "connected" &&
            operation.state.phase !== "failed" &&
            operation.state.phase !== "rejected"
        ) {
            operation.decision?.reject(new Error("The P2P pairing expired."));
            operation.state = {
                expiresAt: operation.state.expiresAt,
                id: operation.state.id,
                phase: "expired",
                role: operation.state.role,
            };
            void operation.endpoint.close().catch(() => undefined);
        }
    }

    #fail(operation: PairingOperation, error: unknown): void {
        if (operation.state.phase === "connected" || operation.state.phase === "rejected") return;
        operation.state = {
            error: error instanceof Error ? error.message : "P2P pairing failed.",
            expiresAt: operation.state.expiresAt,
            id: operation.state.id,
            phase: Date.now() >= operation.state.expiresAt ? "expired" : "failed",
            role: operation.state.role,
        };
    }

    #relayMode(bindings: Awaited<ReturnType<typeof loadIrohBindings>>) {
        return (
            this.#options.relayMode ??
            (this.#options.config.relayUrl === undefined
                ? bindings.RelayMode.defaultMode()
                : bindings.RelayMode.customFromUrls([this.#options.config.relayUrl]))
        );
    }

    #reserve(): void {
        for (const operation of this.#operations.values()) this.#expire(operation);
        while (this.#operations.size >= MAXIMUM_RETAINED_PAIRINGS) {
            const completed = [...this.#operations].find(([, operation]) =>
                isTerminalPairingPhase(operation.state.phase),
            );
            if (completed === undefined) break;
            this.#operations.delete(completed[0]);
        }
        const active = [...this.#operations.values()].filter(
            (operation) =>
                operation.state.phase === "connecting" ||
                operation.state.phase === "waiting" ||
                operation.state.phase === "verifying",
        ).length;
        if (active >= MAXIMUM_PAIRINGS) {
            throw new Error("Too many P2P invitations or joins are already active.");
        }
    }

    #track(task: Promise<void>): void {
        this.#tasks.add(task);
        void task.finally(() => this.#tasks.delete(task));
    }
}

function isTerminalPairingPhase(phase: P2pPairingState["phase"]): boolean {
    return (
        phase === "connected" || phase === "expired" || phase === "failed" || phase === "rejected"
    );
}

function withPairingDeadline<T>(
    operation: PairingOperation,
    promise: Promise<T>,
    message: string,
): Promise<T> {
    return withDeadline(
        promise,
        Math.min(HANDSHAKE_TIMEOUT_MS, operation.state.expiresAt - Date.now()),
        message,
    );
}

function withOperationExpiry<T>(
    operation: PairingOperation,
    promise: Promise<T>,
    message: string,
): Promise<T> {
    return withDeadline(promise, operation.state.expiresAt - Date.now(), message);
}

export function encodeInvitation(payload: P2pInvitationPayload): string {
    return `rig://join/${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}`;
}

export function decodeInvitation(invitation: string): P2pInvitationPayload {
    let url: URL;
    try {
        url = new URL(invitation);
    } catch {
        throw new Error("The P2P invitation is not a valid rig://join link.");
    }
    if (url.protocol !== "rig:" || url.hostname !== "join" || url.pathname.length < 2) {
        throw new Error("The P2P invitation is not a valid rig://join link.");
    }
    try {
        const decoded: unknown = JSON.parse(
            Buffer.from(url.pathname.slice(1), "base64url").toString("utf8"),
        );
        return Value.Decode(p2pInvitationPayloadSchema, decoded);
    } catch {
        throw new Error("The P2P invitation payload is invalid.");
    }
}

function createProfile(
    identity: P2pInstanceIdentity,
    name: string,
    irohEndpointId: string,
    irohEndpointTicket: string,
    role: PairingProfile["role"],
    context: P2pHelloContext,
    token: string,
): PairingProfile {
    const unsigned = {
        instanceId: identity.instanceId,
        irohEndpointId,
        irohEndpointTicket,
        name,
        publicKey: identity.publicKey,
        role,
        version: 2 as const,
    };
    return {
        ...unsigned,
        signature: identity.sign(profileMessage(unsigned, context, token)),
    };
}

function verifyProfile(
    profile: PairingProfile,
    identity: P2pPeerIdentity,
    role: PairingProfile["role"],
    context: P2pHelloContext,
    token: string,
): void {
    if (
        profile.role !== role ||
        profile.instanceId !== identity.instanceId ||
        profile.publicKey !== identity.publicKey
    ) {
        throw new Error("The peer changed identity during P2P verification.");
    }
    const { signature, ...unsigned } = profile;
    if (
        !verifyP2pSignature(profileMessage(unsigned, context, token), signature, profile.publicKey)
    ) {
        throw new Error("The peer's P2P connection profile could not be verified.");
    }
}

function profileMessage(
    profile: Omit<PairingProfile, "signature">,
    context: P2pHelloContext,
    token: string,
): Uint8Array {
    return Buffer.from(
        JSON.stringify([
            "rig-p2p-profile-v2",
            token,
            profile.role,
            profile.instanceId,
            profile.publicKey,
            profile.name,
            profile.irohEndpointId,
            profile.irohEndpointTicket,
            context.transport,
            context.initiatorChannelBinding,
            context.responderChannelBinding,
            context.initiatorNonce,
            context.responderNonce,
        ]),
        "utf8",
    );
}

function verificationHash(
    initiator: PairingProfile,
    responder: PairingProfile,
    context: P2pHelloContext,
    token: string,
): Uint8Array {
    return new Uint8Array(
        createHash("sha256")
            .update(
                JSON.stringify([
                    "rig-p2p-verification-v2",
                    token,
                    initiator.instanceId,
                    initiator.publicKey,
                    initiator.irohEndpointId,
                    initiator.irohEndpointTicket,
                    responder.instanceId,
                    responder.publicKey,
                    responder.irohEndpointId,
                    responder.irohEndpointTicket,
                    context.transport,
                    context.initiatorChannelBinding,
                    context.responderChannelBinding,
                    context.initiatorNonce,
                    context.responderNonce,
                ]),
            )
            .digest(),
    );
}

async function readJson<Schema extends TSchema>(
    reader: Parameters<typeof readBytes>[0],
    schema: Schema,
): Promise<Static<Schema>> {
    const length = Buffer.from(await readBytes(reader, 4)).readUInt32BE(0);
    if (length === 0 || length > MAXIMUM_PAIRING_FRAME_BYTES) {
        throw new Error("The P2P pairing frame is too large.");
    }
    try {
        return Value.Decode(
            schema,
            JSON.parse(Buffer.from(await readBytes(reader, length)).toString()),
        );
    } catch {
        throw new Error("The peer sent an invalid P2P pairing frame.");
    }
}

async function writeJson(writer: Parameters<typeof writeBytes>[0], value: unknown): Promise<void> {
    const payload = Buffer.from(JSON.stringify(value), "utf8");
    if (payload.byteLength === 0 || payload.byteLength > MAXIMUM_PAIRING_FRAME_BYTES) {
        throw new Error("The P2P pairing frame is too large.");
    }
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(payload.byteLength, 0);
    await writeBytes(writer, length);
    await writeBytes(writer, payload);
}

function oppositeRole(role: PairingProfile["role"]): PairingProfile["role"] {
    return role === "initiator" ? "responder" : "initiator";
}

function equalToken(left: string, right: string): boolean {
    const leftBytes = decodeBase64Url(left);
    const rightBytes = decodeBase64Url(right);
    return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((promiseResolve, promiseReject) => {
        resolve = promiseResolve;
        reject = promiseReject;
    });
    return { promise, reject, resolve };
}

interface Deferred<T> {
    promise: Promise<T>;
    reject(error: unknown): void;
    resolve(value: T): void;
}

class PairingEndpointClosedError extends Error {
    constructor() {
        super("The temporary invitation endpoint closed.");
        this.name = "PairingEndpointClosedError";
    }
}

function withDeadline<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    if (timeoutMs <= 0) return Promise.reject(new Error(message));
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        timer.unref();
        promise.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (error: unknown) => {
                clearTimeout(timer);
                reject(error);
            },
        );
    });
}
