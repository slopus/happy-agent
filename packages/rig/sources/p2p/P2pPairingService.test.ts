import * as Iroh from "@number0/iroh/index.js";
import { afterEach, describe, expect, it } from "vitest";

import type { P2pPairingState } from "../protocol/P2pPairingProtocol.js";
import { createIrohFrameDuplex, finishWrites, writeBytes } from "./P2pFrameDuplex.js";
import { createP2pInstanceIdentity } from "./P2pIdentity.js";
import { decodeInvitation, P2pPairingService } from "./P2pPairingService.js";
import type { P2pPeerPairingTrust, P2pTrustedPeer } from "./P2pPeer.js";
import type { P2pPeerTrustStoreContract } from "./P2pPeerTrustStore.js";

const services: P2pPairingService[] = [];

afterEach(async () => {
    await Promise.all(services.splice(0).map((service) => service.close()));
});

describe("P2pPairingService", () => {
    it("shows the same emoji before mutually pinning trust and assigning the first primary", async () => {
        const inviterTrust = recordingTrustStore();
        const joinerTrust = recordingTrustStore();
        let primaryId: string | undefined;
        const inviterIdentity = createP2pInstanceIdentity();
        const joinerIdentity = createP2pInstanceIdentity();
        const inviter = service("Main Rig", inviterIdentity, inviterTrust.store, noPrimaryChange);
        const joiner = service("Build Mac 🛠️", joinerIdentity, joinerTrust.store, async (value) => {
            primaryId ??= value;
        });

        const invitation = await inviter.createInvitation();
        const joined = await joiner.join(invitation.invitation);
        const [inviterState, joinerState] = await Promise.all([
            waitForPhase(inviter, invitation.id, "verifying"),
            waitForPhase(joiner, joined.id, "verifying"),
        ]);

        expect(inviterState.emojis).toEqual(joinerState.emojis);
        expect(inviterState.peer.name).toBe("Build Mac 🛠️");
        expect(joinerState.peer.name).toBe("Main Rig");
        expect(inviterTrust.pins).toHaveLength(0);
        expect(joinerTrust.pins).toHaveLength(0);

        inviter.answer(invitation.id, true);
        joiner.answer(joined.id, true);
        await Promise.all([
            waitForPhase(inviter, invitation.id, "connected"),
            waitForPhase(joiner, joined.id, "connected"),
        ]);

        expect(inviterTrust.pins[0]).toMatchObject({
            instanceId: joinerIdentity.instanceId,
        });
        expect(inviterTrust.connections[0]?.iroh?.ticket).toEqual(expect.any(String));
        expect(joinerTrust.pins[0]).toMatchObject({
            instanceId: inviterIdentity.instanceId,
        });
        expect(joinerTrust.connections[0]?.iroh?.ticket).toEqual(expect.any(String));
        expect(
            Iroh.EndpointTicket.fromString(inviterTrust.connections[0]!.iroh!.ticket!)
                .endpointAddr()
                .id()
                .toString(),
        ).toBe(inviterTrust.connections[0]!.iroh!.endpointId);
        expect(
            Iroh.EndpointTicket.fromString(joinerTrust.connections[0]!.iroh!.ticket!)
                .endpointAddr()
                .id()
                .toString(),
        ).toBe(joinerTrust.connections[0]!.iroh!.endpointId);
        expect(primaryId).toBe(inviterIdentity.instanceId);
    });

    it("does not pin either side when one user rejects the emoji", async () => {
        const inviterTrust = recordingTrustStore();
        const joinerTrust = recordingTrustStore();
        const inviter = service(
            "Main",
            createP2pInstanceIdentity(),
            inviterTrust.store,
            noPrimaryChange,
        );
        const joiner = service(
            "Remote",
            createP2pInstanceIdentity(),
            joinerTrust.store,
            noPrimaryChange,
        );
        const invitation = await inviter.createInvitation();
        const joined = await joiner.join(invitation.invitation);
        await Promise.all([
            waitForPhase(inviter, invitation.id, "verifying"),
            waitForPhase(joiner, joined.id, "verifying"),
        ]);

        inviter.answer(invitation.id, false);
        joiner.answer(joined.id, true);
        await Promise.all([
            waitForPhase(inviter, invitation.id, "rejected"),
            waitForPhase(joiner, joined.id, "rejected"),
        ]);

        expect(inviterTrust.pins).toHaveLength(0);
        expect(joinerTrust.pins).toHaveLength(0);
    });

    it("rejects a signed profile whose stable ticket names another endpoint", async () => {
        const inviterTrust = recordingTrustStore();
        const joinerTrust = recordingTrustStore();
        const inviter = service(
            "Main",
            createP2pInstanceIdentity(),
            inviterTrust.store,
            noPrimaryChange,
        );
        const joiner = service(
            "Remote",
            createP2pInstanceIdentity(),
            joinerTrust.store,
            noPrimaryChange,
            undefined,
            Iroh.SecretKey.generate().public().toString(),
        );

        const invitation = await inviter.createInvitation();
        await joiner.join(invitation.invitation);
        await waitForPhase(inviter, invitation.id, "failed");
        const state = inviter.get(invitation.id);
        expect(state !== undefined && "error" in state ? state.error : undefined).toBe(
            "The peer's stable Iroh address identifies a different endpoint.",
        );
        expect(inviterTrust.pins).toEqual([]);
        expect(joinerTrust.pins).toEqual([]);
    });

    it("keeps accepting after a connection presents the wrong one-time token", async () => {
        const inviter = service(
            "Main",
            createP2pInstanceIdentity(),
            recordingTrustStore().store,
            noPrimaryChange,
        );
        const joiner = service(
            "Remote",
            createP2pInstanceIdentity(),
            recordingTrustStore().store,
            noPrimaryChange,
        );
        const invitation = await inviter.createInvitation();
        await presentWrongToken(invitation.invitation);

        const joined = await joiner.join(invitation.invitation);
        await Promise.all([
            waitForPhase(inviter, invitation.id, "verifying"),
            waitForPhase(joiner, joined.id, "verifying"),
        ]);
        inviter.answer(invitation.id, true);
        joiner.answer(joined.id, true);
        await Promise.all([
            waitForPhase(inviter, invitation.id, "connected"),
            waitForPhase(joiner, joined.id, "connected"),
        ]);
    });

    it("does not activate trust or primary assignment when the peer cannot prepare", async () => {
        const inviterTrust = recordingTrustStore({ failPrepare: true });
        const joinerTrust = recordingTrustStore();
        let primaryId: string | undefined;
        const inviter = service(
            "Main",
            createP2pInstanceIdentity(),
            inviterTrust.store,
            noPrimaryChange,
        );
        const joiner = service(
            "Remote",
            createP2pInstanceIdentity(),
            joinerTrust.store,
            async (value) => {
                primaryId = value;
            },
        );
        const invitation = await inviter.createInvitation();
        const joined = await joiner.join(invitation.invitation);
        await Promise.all([
            waitForPhase(inviter, invitation.id, "verifying"),
            waitForPhase(joiner, joined.id, "verifying"),
        ]);

        inviter.answer(invitation.id, true);
        joiner.answer(joined.id, true);
        await Promise.all([
            waitForPhase(inviter, invitation.id, "failed"),
            waitForPhase(joiner, joined.id, "failed"),
        ]);

        expect(inviterTrust.pins).toHaveLength(0);
        expect(joinerTrust.pins).toHaveLength(0);
        expect(primaryId).toBeUndefined();
    });

    it("does not acknowledge readiness before its durable ready write succeeds", async () => {
        const inviterTrust = recordingTrustStore({ failMarkReady: true });
        const joinerTrust = recordingTrustStore();
        let primaryId: string | undefined;
        const inviter = service(
            "Main",
            createP2pInstanceIdentity(),
            inviterTrust.store,
            noPrimaryChange,
        );
        const joiner = service(
            "Remote",
            createP2pInstanceIdentity(),
            joinerTrust.store,
            async (value) => {
                primaryId = value;
            },
        );
        const invitation = await inviter.createInvitation();
        const joined = await joiner.join(invitation.invitation);
        await Promise.all([
            waitForPhase(inviter, invitation.id, "verifying"),
            waitForPhase(joiner, joined.id, "verifying"),
        ]);

        inviter.answer(invitation.id, true);
        joiner.answer(joined.id, true);
        await Promise.all([
            waitForPhase(inviter, invitation.id, "failed"),
            waitForPhase(joiner, joined.id, "failed"),
        ]);

        expect(inviterTrust.pins).toEqual([]);
        expect(joinerTrust.pins).toEqual([]);
        expect(primaryId).toBeUndefined();
    });

    it("does not activate either peer when one reciprocal ready frame is lost", async () => {
        const inviterTrust = recordingTrustStore();
        const joinerTrust = recordingTrustStore();
        const bothReady = testDeferred();
        const resolveBothReady = (): void => {
            if (inviterTrust.localReadyCount() === 1 && joinerTrust.localReadyCount() === 1) {
                bothReady.resolve();
            }
        };
        inviterTrust.onReady(resolveBothReady);
        joinerTrust.onReady(resolveBothReady);
        const inviter = service(
            "Main",
            createP2pInstanceIdentity(),
            inviterTrust.store,
            noPrimaryChange,
            async () => {
                await bothReady.promise;
                throw new Error("The test dropped the inviter's ready frame.");
            },
        );
        const joiner = service(
            "Remote",
            createP2pInstanceIdentity(),
            joinerTrust.store,
            noPrimaryChange,
        );
        const invitation = await inviter.createInvitation();
        const joined = await joiner.join(invitation.invitation);
        await Promise.all([
            waitForPhase(inviter, invitation.id, "verifying"),
            waitForPhase(joiner, joined.id, "verifying"),
        ]);

        inviter.answer(invitation.id, true);
        joiner.answer(joined.id, true);
        await Promise.all([
            waitForPhase(inviter, invitation.id, "failed"),
            waitForPhase(joiner, joined.id, "failed"),
        ]);

        expect(inviterTrust.localReadyCount()).toBe(0);
        expect(joinerTrust.localReadyCount()).toBe(0);
        expect(inviterTrust.pins).toEqual([]);
        expect(joinerTrust.pins).toEqual([]);
    });
});

function service(
    name: string,
    identity: ReturnType<typeof createP2pInstanceIdentity>,
    peerTrustStore: P2pPeerTrustStoreContract,
    setPrimaryIfUnset: (primaryId: string) => Promise<void>,
    beforeReadyWrite?: () => Promise<void>,
    ticketEndpointId?: string,
): P2pPairingService {
    const stableIrohEndpointId = Iroh.SecretKey.generate().public().toString();
    const stableIrohEndpointTicket = Iroh.EndpointTicket.fromAddr(
        new Iroh.EndpointAddr(
            Iroh.EndpointId.fromString(ticketEndpointId ?? stableIrohEndpointId),
            "https://relay.example.com",
            ["127.0.0.1:7777"],
        ),
    ).toString();
    const created = new P2pPairingService({
        ...(beforeReadyWrite === undefined ? {} : { beforeReadyWrite }),
        bindings: Iroh,
        config: {},
        identity,
        name: () => name,
        peerTrustStore,
        relayMode: Iroh.RelayMode.disabled(),
        setPrimaryIfUnset,
        stableIrohEndpointId,
        stableIrohEndpointTicket: () => stableIrohEndpointTicket,
        waitUntilOnline: false,
    });
    services.push(created);
    return created;
}

function recordingTrustStore(options: { failMarkReady?: boolean; failPrepare?: boolean } = {}): {
    connections: P2pTrustedPeer["connections"][];
    onReady(listener: () => void): void;
    pins: { instanceId: string; publicKey: string }[];
    localReadyCount(): number;
    store: P2pPeerTrustStoreContract;
} {
    const pins: { instanceId: string; publicKey: string }[] = [];
    const connectionsSeen: P2pTrustedPeer["connections"][] = [];
    const prepared = new Map<string, P2pPeerPairingTrust>();
    const readyListeners = new Set<() => void>();
    return {
        connections: connectionsSeen,
        onReady: (listener) => {
            readyListeners.add(listener);
        },
        pins,
        localReadyCount: () =>
            [...prepared.values()].filter(
                (pairing) => pairing.state === "local_ready" || pairing.state === "confirmed",
            ).length,
        store: {
            preparePairing: async (
                pairingId,
                identity,
                transport,
                address,
                connections,
                name,
                assignPrimary,
                expiresAt,
            ) => {
                if (options.failPrepare === true) {
                    throw new Error("The test peer refused its trust transaction.");
                }
                const peer: P2pTrustedPeer = {
                    bindings: [{ address, transport }],
                    connections,
                    instanceId: identity.instanceId,
                    name,
                    publicKey: identity.publicKey,
                };
                const pairing: P2pPeerPairingTrust = {
                    assignPrimary,
                    expiresAt,
                    pairingId,
                    peer,
                    state: "prepared",
                };
                prepared.set(pairingId, pairing);
                return {
                    pairing,
                    activate: async () => {
                        if (pairing.state !== "confirmed") {
                            throw new Error("The test pairing is not ready.");
                        }
                        if (!pins.some((pin) => pin.instanceId === identity.instanceId)) {
                            pins.push({
                                instanceId: identity.instanceId,
                                publicKey: identity.publicKey,
                            });
                        }
                        connectionsSeen.push(connections);
                        return peer;
                    },
                    abort: async () => {
                        if (pairing.state === "prepared" || pairing.state === "local_ready") {
                            prepared.delete(pairingId);
                        }
                    },
                    complete: async () => {
                        prepared.delete(pairingId);
                    },
                    markConfirmed: async () => {
                        if (pairing.state !== "local_ready") {
                            throw new Error("The test pairing is not locally ready.");
                        }
                        pairing.state = "confirmed";
                    },
                    markLocallyReady: async () => {
                        if (options.failMarkReady === true) {
                            throw new Error("The test peer could not persist readiness.");
                        }
                        pairing.state = "local_ready";
                        for (const listener of readyListeners) listener();
                    },
                };
            },
            peerForBinding: () => undefined,
            peers: () => [],
            readyPairings: () => [],
            validate: async () => undefined,
            verifyOrPin: async () => undefined,
        },
    };
}

function testDeferred(): { promise: Promise<void>; resolve(): void } {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

function noPrimaryChange(): Promise<void> {
    return Promise.resolve();
}

async function presentWrongToken(invitation: string): Promise<void> {
    const payload = decodeInvitation(invitation);
    const endpoint = await Iroh.Endpoint.bind(
        {
            alpns: [[...Buffer.from("rig/p2p/pair/2", "utf8")]],
            secretKey: Iroh.SecretKey.generate().toBytes(),
        },
        Iroh.RelayMode.disabled(),
    );
    const ticket = Iroh.EndpointTicket.fromString(payload.address);
    const connection = await endpoint.connect(ticket.endpointAddr(), [
        ...Buffer.from("rig/p2p/pair/2", "utf8"),
    ]);
    try {
        const stream = await connection.openBi();
        const duplex = createIrohFrameDuplex(stream.recv, stream.send);
        const body = Buffer.from(JSON.stringify({ token: "A".repeat(43), version: 1 }), "utf8");
        const length = Buffer.alloc(4);
        length.writeUInt32BE(body.byteLength);
        await writeBytes(duplex.send, length);
        await writeBytes(duplex.send, body);
        await finishWrites(duplex.send);
    } finally {
        connection.close(0n, []);
        await endpoint.close();
    }
}

async function waitForPhase<Phase extends P2pPairingState["phase"]>(
    service: P2pPairingService,
    id: string,
    phase: Phase,
): Promise<Extract<P2pPairingState, { phase: Phase }>> {
    const deadline = Date.now() + 10_000;
    for (;;) {
        const state = service.get(id);
        if (state?.phase === phase) {
            return state as Extract<P2pPairingState, { phase: Phase }>;
        }
        if (state?.phase === "failed" || state?.phase === "expired") {
            throw new Error(state.error ?? `Pairing ${state.phase}.`);
        }
        if (Date.now() >= deadline) throw new Error(`Pairing did not reach ${phase}.`);
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}
