import { describe, expect, it, vi } from "vitest";

import type { P2pTransportStatus } from "../protocol/P2pProtocol.js";
import type { P2pTransport } from "./P2pTransport.js";
import { P2pNetwork } from "./P2pNetwork.js";
import { createP2pInstanceIdentity, type P2pPeerIdentity } from "./P2pIdentity.js";
import type { P2pTrustedPeer } from "./P2pPeer.js";
import type { P2pPeerTrustStoreContract } from "./P2pPeerTrustStore.js";

const disabledConfig = {
    direct: {},
    enableDirect: false,
    enableIroh: false,
    enableSsh: false,
    exposeApi: false,
    iroh: {},
    name: "Test Rig",
    role: "primary",
} as const;
const identity = createP2pInstanceIdentity("alocalinstance00000000001");
const peerId = "aremoteinstance0000000001";
const peerTrustStore: P2pPeerTrustStoreContract = {
    preparePairing: async () => {
        throw new Error("Pairing is not used by this test.");
    },
    peerForBinding: () => undefined,
    peers: () => [],
    readyPairings: () => [],
    validate: async () => undefined,
    verifyOrPin: async () => undefined,
};

describe("P2pNetwork", () => {
    it("starts with no transports when all transports are disabled", async () => {
        const network = await P2pNetwork.create({
            config: disabledConfig,
            identity,
            irohSecretKeyPath: "unused",
            peerTrustStore,
        });

        expect(network.status()).toMatchObject({
            instanceId: identity.instanceId,
            name: "Test Rig",
            publicKey: identity.publicKey,
            transports: [],
        });

        network.setName("Renamed Rig");
        expect(network.status().name).toBe("Renamed Rig");
        await network.close();
    });

    it("contains malformed saved trust without taking down the daemon", async () => {
        const unavailable = vi.fn();
        const createIrohTransport = vi.fn();
        const network = await P2pNetwork.create({
            config: { ...disabledConfig, enableIroh: true },
            createIrohTransport,
            identity,
            irohSecretKeyPath: "unused",
            onTransportUnavailable: unavailable,
            peerTrustStore: {
                ...peerTrustStore,
                peers: () => {
                    throw new Error("The saved P2P peer trust is invalid.");
                },
            },
        });

        expect(createIrohTransport).not.toHaveBeenCalled();
        expect(unavailable).toHaveBeenCalledWith("iroh", expect.any(Error));
        expect(network.status().transports).toEqual([
            expect.objectContaining({ state: "unavailable", transport: "iroh" }),
        ]);
        await network.close();
    });

    it("contains one transport failure without failing the P2P service", async () => {
        const unavailable = vi.fn();
        const network = await P2pNetwork.create({
            config: { ...disabledConfig, enableIroh: true },
            createIrohTransport: async () => {
                throw new Error("binding unavailable");
            },
            identity,
            irohSecretKeyPath: "unused",
            onTransportUnavailable: unavailable,
            peerTrustStore,
        });

        expect(network.status()).toEqual({
            instanceId: identity.instanceId,
            name: "Test Rig",
            publicKey: identity.publicKey,
            transports: [
                {
                    error: "binding unavailable",
                    state: "unavailable",
                    transport: "iroh",
                },
            ],
        });
        expect(unavailable).toHaveBeenCalledOnce();
        await network.close();
    });

    it("aggregates transport status changes and closes enabled transports", async () => {
        const changed = vi.fn();
        const close = vi.fn(async () => undefined);
        let publish!: (status: P2pTransportStatus) => void;
        const initial: Extract<P2pTransportStatus, { state: "ready" }> = {
            apiExposed: false,
            localAddress: "local",
            peers: [],
            state: "ready",
            transport: "iroh",
        };
        const transport: P2pTransport = {
            close,
            kind: "iroh",
            status: () => initial,
        };
        const network = await P2pNetwork.create({
            config: { ...disabledConfig, enableIroh: true },
            createIrohTransport: async (onStatusChange) => {
                publish = onStatusChange;
                return transport;
            },
            identity,
            irohSecretKeyPath: "unused",
            onStatusChange: changed,
            peerTrustStore,
        });

        publish({
            ...initial,
            peers: [{ address: "remote-address", peerId, status: "connected" }],
        });
        expect(network.status().transports[0]).toMatchObject({
            peers: [{ address: "remote-address", peerId, status: "connected" }],
        });
        network.setName("Renamed Rig");
        publish(initial);
        expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ name: "Renamed Rig" }));
        await network.close();
        expect(close).toHaveBeenCalledOnce();
        expect(changed).toHaveBeenCalled();
    });

    it("validates newly persisted Iroh trust without recreating the network", async () => {
        const endpointId = "a".repeat(64);
        const remoteIdentity = createP2pInstanceIdentity(peerId);
        let persistedPeer: P2pTrustedPeer | undefined;
        let validateIrohPeer!: (identity: P2pPeerIdentity, endpointId: string) => Promise<void>;
        const validate = vi.fn(async () => undefined);
        const initial: Extract<P2pTransportStatus, { state: "ready"; transport: "iroh" }> = {
            apiExposed: false,
            localAddress: "local",
            peers: [],
            state: "ready",
            transport: "iroh",
        };
        const network = await P2pNetwork.create({
            config: { ...disabledConfig, enableIroh: true },
            createIrohTransport: async (_onStatusChange, authenticate) => {
                validateIrohPeer = authenticate;
                return {
                    close: async () => undefined,
                    kind: "iroh",
                    status: () => initial,
                };
            },
            identity,
            irohSecretKeyPath: "unused",
            peerTrustStore: {
                ...peerTrustStore,
                peerForBinding: (_transport, address) =>
                    persistedPeer?.bindings.some((binding) => binding.address === address) === true
                        ? remoteIdentity
                        : undefined,
                peers: () => (persistedPeer === undefined ? [] : [persistedPeer]),
                validate,
            },
        });

        await expect(validateIrohPeer(remoteIdentity, endpointId)).rejects.toThrow(
            "does not match its trusted peer record",
        );
        persistedPeer = {
            bindings: [{ address: endpointId, transport: "iroh" }],
            connections: { iroh: { endpointId } },
            instanceId: remoteIdentity.instanceId,
            name: "Remote Rig",
            publicKey: remoteIdentity.publicKey,
        };
        network.addTrustedPeer(persistedPeer);

        await expect(validateIrohPeer(remoteIdentity, endpointId)).resolves.toBeUndefined();
        expect(validate).toHaveBeenCalledWith(remoteIdentity, "iroh", endpointId);
        await network.close();
    });

    it("routes one stable peer through the best available transport", async () => {
        const response = {
            body: (async function* () {
                yield Buffer.from("direct");
            })(),
            headers: {},
            status: 200,
        };
        const directFetch = vi.fn(async () => response);
        const sshFetch = vi.fn(async () => response);
        const peer = {
            address: "peer-address",
            peerId,
            publicKey: createP2pInstanceIdentity(peerId).publicKey,
            status: "connected" as const,
        };
        const network = await P2pNetwork.create({
            config: {
                ...disabledConfig,
                enableDirect: true,
                enableSsh: true,
            },
            createDirectTransport: async () => ({
                close: async () => undefined,
                fetch: directFetch,
                kind: "direct",
                status: () => ({
                    apiExposed: false,
                    peers: [peer],
                    state: "ready",
                    transport: "direct",
                }),
            }),
            createSshTransport: async () => ({
                close: async () => undefined,
                fetch: sshFetch,
                kind: "ssh",
                status: () => ({
                    direction: "outbound",
                    peers: [{ ...peer, status: "connecting" }],
                    state: "ready",
                    transport: "ssh",
                }),
            }),
            identity,
            irohSecretKeyPath: "unused",
            peerTrustStore,
        });

        const selected = await network.fetch(
            peerId,
            { body: Buffer.alloc(0), headers: {}, method: "GET", path: "/health" },
            new AbortController().signal,
        );

        expect(selected.transport).toBe("direct");
        expect(directFetch).toHaveBeenCalledOnce();
        expect(sshFetch).not.toHaveBeenCalled();
        await network.close();
    });
});
