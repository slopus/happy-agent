import {
    Endpoint,
    EndpointAddr,
    EndpointId,
    EndpointTicket,
    RelayMode,
    SecretKey,
    type Connection,
    type RecvStream,
    type SendStream,
} from "@number0/iroh/index.js";
import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createTestSocketDirectory } from "../testing/createTestSocketDirectory.js";
import { migrateSessionDatabase } from "../persistence/database/migrateSessionDatabase.js";
import {
    openSessionDatabase,
    type OpenSessionDatabase,
} from "../persistence/database/openSessionDatabase.js";
import { IrohNetwork } from "./IrohNetwork.js";
import { createIrohFrameDuplex } from "./P2pFrameDuplex.js";
import { runP2pInitiatorHello, runP2pResponderHello } from "./P2pHelloProtocol.js";
import { createP2pInstanceIdentity, type P2pPeerIdentity } from "./P2pIdentity.js";
import { P2pPeerTrustStore } from "./P2pPeerTrustStore.js";

const ALPN = [...Buffer.from("rig/p2p/5", "utf8")];
const networks: IrohNetwork[] = [];
const directories: string[] = [];
const databases: OpenSessionDatabase[] = [];

afterEach(async () => {
    await Promise.all(networks.splice(0).map((network) => network.close()));
    for (const opened of databases.splice(0)) opened.client.close();
    await Promise.all(
        directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
    );
});

describe("IrohNetwork", () => {
    it("connects and keeps pinging when both endpoint identities are allowlisted", async () => {
        const firstKey = SecretKey.generate();
        const secondKey = SecretKey.generate();
        const firstIdentity = createP2pInstanceIdentity();
        const secondIdentity = createP2pInstanceIdentity();
        const [firstEndpoint, secondEndpoint] = await Promise.all([
            Endpoint.bind({ alpns: [ALPN], secretKey: firstKey.toBytes() }, RelayMode.disabled()),
            Endpoint.bind({ alpns: [ALPN], secretKey: secondKey.toBytes() }, RelayMode.disabled()),
        ]);
        const firstId = firstEndpoint.id().toString();
        const secondId = secondEndpoint.id().toString();
        const firstStatusChanged = vi.fn();
        const updateSecondPeerAddress = vi.fn(
            async (_identity: P2pPeerIdentity, _endpointId: string, _ticket: string) => undefined,
        );
        const first = await IrohNetwork.create({
            config: {},
            endpointIds: [secondId],
            endpoint: firstEndpoint,
            identity: firstIdentity,
            handshakeTimeoutMs: 100,
            idleTimeoutMs: 500,
            onStatusChange: firstStatusChanged,
            peerTickets: new Map([
                [secondId, EndpointTicket.fromAddr(secondEndpoint.addr()).toString()],
            ]),
            pingIntervalMs: 150,
            relayMode: RelayMode.disabled(),
            secretKey: firstKey,
        });
        networks.push(first);
        const second = await IrohNetwork.create({
            config: {},
            endpointIds: [firstId],
            endpoint: secondEndpoint,
            identity: secondIdentity,
            handshakeTimeoutMs: 100,
            idleTimeoutMs: 500,
            peerAddresses: new Map([[firstId, firstEndpoint.addr()]]),
            pingIntervalMs: 150,
            relayMode: RelayMode.disabled(),
            secretKey: secondKey,
            updatePeerAddress: updateSecondPeerAddress,
        });
        networks.push(second);

        await vi.waitFor(() => {
            expect(first.status().peers[0]).toMatchObject({
                peerId: secondIdentity.instanceId,
                publicKey: secondIdentity.publicKey,
                status: "connected",
            });
            expect(second.status().peers[0]).toMatchObject({
                peerId: firstIdentity.instanceId,
                publicKey: firstIdentity.publicKey,
                status: "connected",
            });
        });
        const publishedAfterConnect = firstStatusChanged.mock.calls.length;
        const firstPingAt = first.status().peers[0]!.lastSeenAt!;
        await vi.waitFor(() =>
            expect(first.status().peers[0]!.lastSeenAt).toBeGreaterThan(firstPingAt),
        );
        expect(firstStatusChanged).toHaveBeenCalledTimes(publishedAfterConnect);
        await vi.waitFor(() => expect(updateSecondPeerAddress).toHaveBeenCalled());
        const learnedTicket = updateSecondPeerAddress.mock.calls[0]![2];
        expect(EndpointTicket.fromString(learnedTicket).endpointAddr().id().toString()).toBe(
            firstId,
        );
    });

    it("refuses a peer whose authenticated endpoint identity is not allowlisted", async () => {
        const allowedKey = SecretKey.generate();
        const refusedKey = SecretKey.generate();
        const allowedIdentity = createP2pInstanceIdentity();
        const refusedIdentity = createP2pInstanceIdentity();
        const [allowedEndpoint, refusedEndpoint] = await Promise.all([
            Endpoint.bind({ alpns: [ALPN], secretKey: allowedKey.toBytes() }, RelayMode.disabled()),
            Endpoint.bind({ alpns: [ALPN], secretKey: refusedKey.toBytes() }, RelayMode.disabled()),
        ]);
        const allowedId = allowedEndpoint.id().toString();
        const refusedId = refusedEndpoint.id().toString();
        const allowed = await IrohNetwork.create({
            config: {},
            endpointIds: [],
            endpoint: allowedEndpoint,
            identity: allowedIdentity,
            relayMode: RelayMode.disabled(),
            secretKey: allowedKey,
        });
        networks.push(allowed);
        const refused = await IrohNetwork.create({
            config: {},
            endpointIds: [allowedId],
            endpoint: refusedEndpoint,
            identity: refusedIdentity,
            peerAddresses: new Map([[allowedId, allowedEndpoint.addr()]]),
            pingIntervalMs: 10,
            relayMode: RelayMode.disabled(),
            secretKey: refusedKey,
        });
        networks.push(refused);

        await vi.waitFor(() => {
            expect(refused.status().peers[0]).toMatchObject({
                address: allowedId,
                status: "unreachable",
            });
        });
        expect(allowed.status()).toEqual({
            apiExposed: false,
            localAddress: allowedId,
            peers: [],
            state: "ready",
            transport: "iroh",
        });
        expect(refused.localAddress()).toBe(refusedId);
    });

    it("marks a connected peer unreachable when its ping stalls", async () => {
        const clientKey = SecretKey.generate();
        const serverKey = SecretKey.generate();
        const clientIdentity = createP2pInstanceIdentity();
        const [clientEndpoint, serverEndpoint] = await Promise.all([
            Endpoint.bind({ alpns: [ALPN], secretKey: clientKey.toBytes() }, RelayMode.disabled()),
            Endpoint.bind({ alpns: [ALPN], secretKey: serverKey.toBytes() }, RelayMode.disabled()),
        ]);
        const serverId = serverEndpoint.id().toString();
        const serverTask = (async () => {
            const incoming = await serverEndpoint.acceptNext();
            if (incoming === null) return;
            const connection = await (await incoming.accept()).connect();
            await connection.acceptBi();
            await connection.closed();
        })().catch(() => undefined);
        try {
            const client = await IrohNetwork.create({
                config: {},
                endpointIds: [serverId],
                endpoint: clientEndpoint,
                handshakeTimeoutMs: 25,
                identity: clientIdentity,
                peerAddresses: new Map([[serverId, serverEndpoint.addr()]]),
                pingIntervalMs: 10,
                pingTimeoutMs: 25,
                relayMode: RelayMode.disabled(),
                secretKey: clientKey,
            });
            networks.push(client);

            await vi.waitFor(() => {
                expect(client.status().peers[0]).toMatchObject({
                    address: serverId,
                    status: "unreachable",
                });
            });
        } finally {
            await serverEndpoint.close();
            await serverTask;
        }
    });

    it("rejects a transport-authenticated endpoint that presents the wrong stable key", async () => {
        const clientKey = SecretKey.generate();
        const serverKey = SecretKey.generate();
        const pinnedClientIdentity = createP2pInstanceIdentity();
        const impostorIdentity = createP2pInstanceIdentity(pinnedClientIdentity.instanceId);
        const serverIdentity = createP2pInstanceIdentity();
        const [clientEndpoint, serverEndpoint] = await Promise.all([
            Endpoint.bind({ alpns: [ALPN], secretKey: clientKey.toBytes() }, RelayMode.disabled()),
            Endpoint.bind({ alpns: [ALPN], secretKey: serverKey.toBytes() }, RelayMode.disabled()),
        ]);
        const clientId = clientEndpoint.id().toString();
        const serverId = serverEndpoint.id().toString();
        const directory = await createTestSocketDirectory();
        directories.push(directory);
        const trust = openTrustStore();
        await trust.verifyOrPin(pinnedClientIdentity, "iroh", clientId);

        const client = await IrohNetwork.create({
            config: {},
            endpointIds: [serverId],
            endpoint: clientEndpoint,
            identity: impostorIdentity,
            peerAddresses: new Map([[serverId, serverEndpoint.addr()]]),
            pingIntervalMs: 10,
            relayMode: RelayMode.disabled(),
            secretKey: clientKey,
        });
        networks.push(client);
        const server = await IrohNetwork.create({
            config: {},
            endpointIds: [clientId],
            endpoint: serverEndpoint,
            identity: serverIdentity,
            peerAddresses: new Map([[clientId, clientEndpoint.addr()]]),
            pingIntervalMs: 10,
            relayMode: RelayMode.disabled(),
            secretKey: serverKey,
            commitPeer: (identity, endpointId) => trust.verifyOrPin(identity, "iroh", endpointId),
            validatePeer: (identity, endpointId) => trust.validate(identity, "iroh", endpointId),
        });
        networks.push(server);

        await vi.waitFor(() =>
            expect(client.status().peers[0]).toMatchObject({
                address: serverId,
                status: "unreachable",
            }),
        );
        expect(server.status().peers[0]?.peerId).toBeUndefined();
    });

    it("does not pin an initiator peer before the responder confirms the handshake", async () => {
        const clientKey = SecretKey.generate();
        const serverKey = SecretKey.generate();
        const clientIdentity = createP2pInstanceIdentity();
        const serverIdentity = createP2pInstanceIdentity();
        const [clientEndpoint, serverEndpoint] = await Promise.all([
            Endpoint.bind({ alpns: [ALPN], secretKey: clientKey.toBytes() }, RelayMode.disabled()),
            Endpoint.bind({ alpns: [ALPN], secretKey: serverKey.toBytes() }, RelayMode.disabled()),
        ]);
        const clientId = clientEndpoint.id().toString();
        const serverId = serverEndpoint.id().toString();
        const directory = await createTestSocketDirectory();
        directories.push(directory);
        const clientTrust = openTrustStore();
        const serverTask = (async () => {
            const incoming = await serverEndpoint.acceptNext();
            if (incoming === null) return;
            const connection = await (await incoming.accept()).connect();
            const stream = await connection.acceptBi();
            await stream.recv.readExact(1);
            await runP2pResponderHello(createIrohFrameDuplex(stream.recv, stream.send), {
                commitPeer: async () => {
                    throw new Error("The responder refused to commit the peer.");
                },
                identity: serverIdentity,
                localChannelBinding: serverId,
                remoteChannelBinding: clientId,
                transport: "iroh",
            }).catch(() => undefined);
            connection.close(0n, []);
        })();
        const client = await IrohNetwork.create({
            commitPeer: (identity, endpointId) =>
                clientTrust.verifyOrPin(identity, "iroh", endpointId),
            config: {},
            endpointIds: [serverId],
            endpoint: clientEndpoint,
            identity: clientIdentity,
            peerAddresses: new Map([[serverId, serverEndpoint.addr()]]),
            pingIntervalMs: 10,
            relayMode: RelayMode.disabled(),
            secretKey: clientKey,
            validatePeer: (identity, endpointId) =>
                clientTrust.validate(identity, "iroh", endpointId),
        });
        networks.push(client);

        await vi.waitFor(() =>
            expect(client.status().peers[0]).toMatchObject({
                address: serverId,
                status: "unreachable",
            }),
        );
        expect(clientTrust.peerForBinding("iroh", serverId)).toBeUndefined();
        await serverTask;
        await serverEndpoint.close();
    });

    it("forwards an HTTP response stream without blocking peer pings", async () => {
        const clientKey = SecretKey.generate();
        const serverKey = SecretKey.generate();
        const clientIdentity = createP2pInstanceIdentity();
        const serverIdentity = createP2pInstanceIdentity();
        const [clientEndpoint, serverEndpoint] = await Promise.all([
            Endpoint.bind({ alpns: [ALPN], secretKey: clientKey.toBytes() }, RelayMode.disabled()),
            Endpoint.bind({ alpns: [ALPN], secretKey: serverKey.toBytes() }, RelayMode.disabled()),
        ]);
        const clientId = clientEndpoint.id().toString();
        const serverId = serverEndpoint.id().toString();
        let finishStream!: () => void;
        let cancellationObserved = false;
        let responseBodyStarted = false;
        let requestServed = false;
        const streamFinished = new Promise<void>((resolve) => {
            finishStream = resolve;
        });
        const client = await IrohNetwork.create({
            config: {},
            endpointIds: [serverId],
            endpoint: clientEndpoint,
            identity: clientIdentity,
            peerAddresses: new Map([[serverId, serverEndpoint.addr()]]),
            pingIntervalMs: 25,
            relayMode: RelayMode.disabled(),
            secretKey: clientKey,
        });
        networks.push(client);
        const server = await IrohNetwork.create({
            config: {},
            endpointIds: [clientId],
            endpoint: serverEndpoint,
            identity: serverIdentity,
            peerAddresses: new Map([[clientId, clientEndpoint.addr()]]),
            pingIntervalMs: 25,
            relayMode: RelayMode.disabled(),
            secretKey: serverKey,
            serveRequest: async (peerId, request, signal) => {
                requestServed = true;
                expect(peerId).toBe(clientIdentity.instanceId);
                if (request.path === "/cancel") {
                    return {
                        body: (async function* () {
                            yield Buffer.from("started");
                            await new Promise<void>((resolve) => {
                                if (signal.aborted) return resolve();
                                signal.addEventListener("abort", () => resolve(), { once: true });
                            });
                            cancellationObserved = true;
                        })(),
                        headers: { "content-type": "text/event-stream" },
                        status: 200,
                    };
                }
                expect(request).toMatchObject({
                    body: new Uint8Array(Buffer.from("hello")),
                    headers: { "content-type": "text/plain" },
                    method: "POST",
                    path: "/stream?room=one",
                });
                return {
                    body: (async function* () {
                        responseBodyStarted = true;
                        yield Buffer.from("first");
                        await streamFinished;
                        yield Buffer.from("second");
                    })(),
                    headers: { "content-type": "text/event-stream" },
                    status: 201,
                };
            },
        });
        networks.push(server);
        expect(server.status().apiExposed).toBe(true);
        await vi.waitFor(() =>
            expect(client.status().peers[0]).toMatchObject({ status: "connected" }),
        );
        const pingBeforeStream = client.status().peers[0]!.lastSeenAt!;
        const responsePromise = client.fetch(
            serverIdentity.instanceId,
            {
                body: Buffer.from("hello"),
                headers: { "content-type": "text/plain" },
                method: "POST",
                path: "/stream?room=one",
            },
            new AbortController().signal,
        );
        await vi.waitFor(() => expect(requestServed).toBe(true));
        await vi.waitFor(() => expect(responseBodyStarted).toBe(true));
        const response = await responsePromise;
        const chunks = response.body[Symbol.asyncIterator]();

        expect(response.status).toBe(201);
        await expect(chunks.next()).resolves.toMatchObject({
            done: false,
            value: new Uint8Array(Buffer.from("first")),
        });
        await vi.waitFor(() =>
            expect(client.status().peers[0]!.lastSeenAt).toBeGreaterThan(pingBeforeStream),
        );
        finishStream();
        await expect(chunks.next()).resolves.toMatchObject({
            done: false,
            value: new Uint8Array(Buffer.from("second")),
        });
        await expect(chunks.next()).resolves.toEqual({ done: true, value: undefined });

        const cancellation = new AbortController();
        const cancelledResponse = await client.fetch(
            serverIdentity.instanceId,
            { body: new Uint8Array(), headers: {}, method: "GET", path: "/cancel" },
            cancellation.signal,
        );
        const cancelledChunks = cancelledResponse.body[Symbol.asyncIterator]();
        await expect(cancelledChunks.next()).resolves.toMatchObject({
            done: false,
            value: new Uint8Array(Buffer.from("started")),
        });
        cancellation.abort();
        await vi.waitFor(() => expect(cancellationObserved).toBe(true));
    });

    it("keeps retrying after the maximum pending native connections time out", async () => {
        const ownEndpointId = SecretKey.generate().public();
        const peerEndpointId = SecretKey.generate().public();
        const ownId = ownEndpointId.toString();
        const peerId = peerEndpointId.toString();
        let finishAccept!: () => void;
        const accepted = new Promise<null>((resolve) => {
            finishAccept = () => resolve(null);
        });
        const connection = fakePingConnection(peerId, ownId, createP2pInstanceIdentity());
        let connectCount = 0;
        const endpoint = {
            acceptNext: () => accepted,
            close: async () => finishAccept(),
            connect: () => {
                connectCount += 1;
                return connectCount <= 2
                    ? new Promise<Connection>(() => undefined)
                    : Promise.resolve(connection);
            },
            id: () => ownEndpointId,
        } as unknown as Endpoint;
        const network = await IrohNetwork.create({
            bindings: { EndpointAddr, EndpointId, EndpointTicket } as never,
            config: {},
            endpointIds: [peerId],
            connectTimeoutMs: 5,
            endpoint,
            endpointFactory: async () => endpoint,
            peerAddresses: new Map([
                [peerId, new EndpointAddr(peerEndpointId, undefined, ["127.0.0.1:10001"])],
            ]),
            pingIntervalMs: 1_000,
            relayMode: RelayMode.disabled(),
            secretKey: null as never,
        });
        networks.push(network);

        await vi.waitFor(
            () => {
                expect(connectCount).toBe(3);
                expect(network.status().peers[0]).toMatchObject({ status: "connected" });
            },
            { timeout: 1_000 },
        );
    });

    it("retries discovery for a stalled peer without rebuilding a shared healthy endpoint", async () => {
        const ownEndpointId = SecretKey.generate().public();
        const healthyEndpointId = SecretKey.generate().public();
        const stalledEndpointId = SecretKey.generate().public();
        const ownId = ownEndpointId.toString();
        const healthyId = healthyEndpointId.toString();
        const stalledId = stalledEndpointId.toString();
        const healthyAddress = new EndpointAddr(healthyEndpointId, undefined, ["127.0.0.1:10001"]);
        const stalledAddress = new EndpointAddr(
            stalledEndpointId,
            "https://stale-relay.example.com",
            ["10.0.0.5:7777"],
        );
        const healthyConnection = fakePingConnection(healthyId, ownId, createP2pInstanceIdentity());
        const stalledIdentity = createP2pInstanceIdentity();
        const stalledConnection = fakePingConnection(stalledId, ownId, stalledIdentity);
        let finishAccept!: () => void;
        const accepted = new Promise<null>((resolve) => {
            finishAccept = () => resolve(null);
        });
        let stalledConnects = 0;
        let discoveryAddress: EndpointAddr | undefined;
        const endpoint = {
            acceptNext: () => accepted,
            close: async () => finishAccept(),
            connect: (address: EndpointAddr) => {
                if (address.id().toString() === healthyId) {
                    return Promise.resolve(healthyConnection);
                }
                stalledConnects += 1;
                if (stalledConnects <= 2) return new Promise<Connection>(() => undefined);
                if (stalledConnects === 3) {
                    return Promise.reject(new Error("The first discovery probe failed."));
                }
                discoveryAddress = address;
                return Promise.resolve(stalledConnection);
            },
            id: () => ownEndpointId,
        } as unknown as Endpoint;
        const endpointFactory = vi.fn(async () => endpoint);
        const network = await IrohNetwork.create({
            bindings: { EndpointAddr, EndpointId, EndpointTicket } as never,
            closeTimeoutMs: 5,
            config: {},
            connectTimeoutMs: 5,
            endpoint,
            endpointFactory,
            endpointIds: [healthyId, stalledId],
            peerAddresses: new Map([
                [healthyId, healthyAddress],
                [stalledId, stalledAddress],
            ]),
            pingIntervalMs: 1_000,
            relayMode: RelayMode.disabled(),
            secretKey: null as never,
        });
        networks.push(network);

        await vi.waitFor(
            () => {
                expect(network.status().peers).toEqual(
                    expect.arrayContaining([
                        expect.objectContaining({
                            address: healthyId,
                            status: "connected",
                        }),
                        expect.objectContaining({
                            address: stalledId,
                            peerId: stalledIdentity.instanceId,
                            status: "connected",
                        }),
                    ]),
                );
            },
            { timeout: 3_000 },
        );
        expect(stalledConnects).toBe(4);
        expect(discoveryAddress).toBeDefined();
        expect(discoveryAddress!.id().toString()).toBe(stalledId);
        expect(discoveryAddress!.relayUrl()).toBeNull();
        expect(discoveryAddress!.directAddresses()).toEqual([]);
        expect(endpointFactory).not.toHaveBeenCalled();
    });

    it("falls back to discovery after a persisted route fails promptly", async () => {
        const ownEndpointId = SecretKey.generate().public();
        const peerEndpointId = SecretKey.generate().public();
        const ownId = ownEndpointId.toString();
        const peerId = peerEndpointId.toString();
        const peerIdentity = createP2pInstanceIdentity();
        const staleAddress = new EndpointAddr(peerEndpointId, "https://stale-relay.example.com", [
            "10.0.0.5:7777",
        ]);
        let finishAccept!: () => void;
        const accepted = new Promise<null>((resolve) => {
            finishAccept = () => resolve(null);
        });
        let connectCount = 0;
        let discoveryAddress: EndpointAddr | undefined;
        const endpoint = {
            acceptNext: () => accepted,
            close: async () => finishAccept(),
            connect: (address: EndpointAddr) => {
                connectCount += 1;
                if (connectCount <= 2) {
                    return Promise.reject(new Error("The stored route was refused."));
                }
                discoveryAddress = address;
                return Promise.resolve(fakePingConnection(peerId, ownId, peerIdentity));
            },
            id: () => ownEndpointId,
        } as unknown as Endpoint;
        const endpointFactory = vi.fn(async () => endpoint);
        const network = await IrohNetwork.create({
            bindings: { EndpointAddr, EndpointId, EndpointTicket } as never,
            config: {},
            endpoint,
            endpointFactory,
            endpointIds: [peerId],
            peerTickets: new Map([[peerId, EndpointTicket.fromAddr(staleAddress).toString()]]),
            relayMode: RelayMode.disabled(),
            secretKey: null as never,
        });
        networks.push(network);

        await vi.waitFor(() =>
            expect(network.status().peers[0]).toMatchObject({
                peerId: peerIdentity.instanceId,
                status: "connected",
            }),
        );
        expect(connectCount).toBe(3);
        expect(discoveryAddress!.id().toString()).toBe(peerId);
        expect(discoveryAddress!.relayUrl()).toBeNull();
        expect(discoveryAddress!.directAddresses()).toEqual([]);
        expect(endpointFactory).not.toHaveBeenCalled();
    });

    it("rebuilds a wedged endpoint with the same transport identity", async () => {
        const ownEndpointId = SecretKey.generate().public();
        const peerEndpointId = SecretKey.generate().public();
        const ownId = ownEndpointId.toString();
        const peerId = peerEndpointId.toString();
        const peerIdentity = createP2pInstanceIdentity();
        const staleAddress = new EndpointAddr(peerEndpointId, "https://stale-relay.example.com", [
            "10.0.0.5:7777",
        ]);
        const staleTicket = EndpointTicket.fromAddr(staleAddress).toString();
        let closeFirst!: () => void;
        const firstAccepted = new Promise<null>((resolve) => {
            closeFirst = () => resolve(null);
        });
        let staleConnects = 0;
        const first = {
            acceptNext: () => firstAccepted,
            close: async () => closeFirst(),
            connect: () => {
                staleConnects += 1;
                return new Promise<Connection>(() => undefined);
            },
            id: () => ownEndpointId,
        } as unknown as Endpoint;
        let closeSecond!: () => void;
        const secondAccepted = new Promise<null>((resolve) => {
            closeSecond = () => resolve(null);
        });
        let rediscoveredAddress: EndpointAddr | undefined;
        const second = {
            acceptNext: () => secondAccepted,
            close: async () => closeSecond(),
            connect: (address: EndpointAddr) => {
                rediscoveredAddress = address;
                return Promise.resolve(fakePingConnection(peerId, ownId, peerIdentity));
            },
            id: () => ownEndpointId,
        } as unknown as Endpoint;
        const endpointFactory = vi.fn(async () => second);
        const network = await IrohNetwork.create({
            bindings: { EndpointAddr, EndpointId, EndpointTicket } as never,
            config: {},
            connectTimeoutMs: 5,
            endpoint: first,
            endpointFactory,
            endpointIds: [peerId],
            peerTickets: new Map([[peerId, staleTicket]]),
            relayMode: RelayMode.disabled(),
            secretKey: null as never,
        });
        networks.push(network);

        await vi.waitFor(
            () =>
                expect(network.status().peers[0]).toMatchObject({
                    peerId: peerIdentity.instanceId,
                    status: "connected",
                }),
            { timeout: 2_000 },
        );
        expect(staleConnects).toBe(2);
        expect(endpointFactory).toHaveBeenCalledOnce();
        expect(rediscoveredAddress?.id().toString()).toBe(peerId);
        expect(rediscoveredAddress?.relayUrl()).toBeNull();
        expect(rediscoveredAddress?.directAddresses()).toEqual([]);
    });

    it("does not bind a replacement before the old endpoint finishes closing", async () => {
        const ownId = "0".repeat(64);
        const peerId = "1".repeat(64);
        let connectCount = 0;
        const closing = new Promise<void>(() => undefined);
        const close = vi.fn(() => closing);
        const endpoint = {
            acceptNext: () => new Promise<null>(() => undefined),
            close,
            connect: () => {
                connectCount += 1;
                return new Promise<Connection>(() => undefined);
            },
            id: () => ({ toString: () => ownId }),
        } as unknown as Endpoint;
        const endpointFactory = vi.fn(async () => endpoint);
        const network = await IrohNetwork.create({
            bindings: {} as never,
            closeTimeoutMs: 5,
            config: {},
            connectTimeoutMs: 5,
            endpoint,
            endpointFactory,
            endpointIds: [peerId],
            peerAddresses: new Map([[peerId, {} as EndpointAddr]]),
            relayMode: RelayMode.disabled(),
            secretKey: null as never,
        });
        networks.push(network);

        await vi.waitFor(() => expect(close).toHaveBeenCalled());
        expect(endpointFactory).not.toHaveBeenCalled();
    });

    it("does not rebuild while an authenticated incoming connection is active", async () => {
        const ownEndpointId = SecretKey.generate().public();
        const peerEndpointId = SecretKey.generate().public();
        const ownId = ownEndpointId.toString();
        const peerId = peerEndpointId.toString();
        const ownIdentity = createP2pInstanceIdentity();
        const peerIdentity = createP2pInstanceIdentity();
        const hello = duplexPair();
        let rejectServing!: (error: Error) => void;
        const serving = new Promise<never>((_resolve, reject) => {
            rejectServing = reject;
        });
        let markIncomingReady!: () => void;
        const incomingReady = new Promise<void>((resolve) => {
            markIncomingReady = resolve;
        });
        let acceptedStreams = 0;
        const incomingConnection = {
            acceptBi: async () => {
                acceptedStreams += 1;
                if (acceptedStreams === 1) return hello.left;
                markIncomingReady();
                return serving;
            },
            close: () => rejectServing(new Error("The test closed the incoming connection.")),
            remoteId: () => peerEndpointId,
            setMaxConcurrentBiStreams: () => undefined,
        } as unknown as Connection;
        let accepted = false;
        let finishAccept!: () => void;
        const waitingAccept = new Promise<null>((resolve) => {
            finishAccept = () => resolve(null);
        });
        let outgoingConnects = 0;
        const endpoint = {
            acceptNext: async () => {
                if (accepted) return waitingAccept;
                accepted = true;
                return {
                    accept: async () => ({
                        connect: () => Promise.resolve(incomingConnection),
                    }),
                };
            },
            close: async () => finishAccept(),
            connect: () => {
                outgoingConnects += 1;
                return new Promise<Connection>(() => undefined);
            },
            id: () => ownEndpointId,
        } as unknown as Endpoint;
        void (async () => {
            await hello.right.send.writeAll([3]);
            await runP2pInitiatorHello(createIrohFrameDuplex(hello.right.recv, hello.right.send), {
                identity: peerIdentity,
                localChannelBinding: peerId,
                remoteChannelBinding: ownId,
                transport: "iroh",
            });
        })();
        const endpointFactory = vi.fn(async () => endpoint);
        const network = await IrohNetwork.create({
            bindings: { EndpointAddr, EndpointId, EndpointTicket } as never,
            config: {},
            connectTimeoutMs: 5,
            endpoint,
            endpointFactory,
            endpointIds: [peerId],
            identity: ownIdentity,
            peerAddresses: new Map([
                [peerId, new EndpointAddr(peerEndpointId, undefined, ["127.0.0.1:10001"])],
            ]),
            relayMode: RelayMode.disabled(),
            secretKey: null as never,
        });
        networks.push(network);

        await incomingReady;
        await vi.waitFor(() => expect(outgoingConnects).toBe(3));
        expect(endpointFactory).not.toHaveBeenCalled();
    });

    it("does not rebuild while an outgoing request is authenticating", async () => {
        const ownEndpointId = SecretKey.generate().public();
        const peerEndpointId = SecretKey.generate().public();
        const peerId = peerEndpointId.toString();
        const peerIdentity = createP2pInstanceIdentity();
        let finishAccept!: () => void;
        const accepted = new Promise<null>((resolve) => {
            finishAccept = () => resolve(null);
        });
        let endpointClosed = false;
        let connectCount = 0;
        let rejectOpen!: (error: Error) => void;
        const opening = new Promise<never>((_resolve, reject) => {
            rejectOpen = reject;
        });
        const requestConnection = {
            close: () => rejectOpen(new Error("The test closed the outgoing connection.")),
            openBi: () => opening,
            remoteId: () => peerEndpointId,
        } as unknown as Connection;
        const close = vi.fn(async () => finishAccept());
        const endpoint = {
            acceptNext: () => accepted,
            close,
            connect: () => {
                connectCount += 1;
                if (connectCount === 2) return Promise.resolve(requestConnection);
                return new Promise<Connection>(() => undefined);
            },
            id: () => ownEndpointId,
            isClosed: () => endpointClosed,
        } as unknown as Endpoint;
        const endpointFactory = vi.fn(async () => endpoint);
        const network = await IrohNetwork.create({
            bindings: { EndpointAddr, EndpointId, EndpointTicket } as never,
            config: {},
            connectTimeoutMs: 5,
            endpoint,
            endpointFactory,
            endpointIds: [peerId],
            handshakeTimeoutMs: 700,
            knownPeer: () => peerIdentity,
            peerAddresses: new Map([
                [peerId, new EndpointAddr(peerEndpointId, undefined, ["127.0.0.1:10001"])],
            ]),
            relayMode: RelayMode.disabled(),
            secretKey: null as never,
        });
        networks.push(network);

        await vi.waitFor(() => expect(connectCount).toBe(1));
        const cancellation = new AbortController();
        const request = network.fetch(
            peerIdentity.instanceId,
            { body: new Uint8Array(), headers: {}, method: "GET", path: "/health" },
            cancellation.signal,
        );
        await vi.waitFor(() => expect(connectCount).toBe(2));
        endpointClosed = true;
        await new Promise((resolve) => setTimeout(resolve, 400));

        expect(endpointFactory).not.toHaveBeenCalled();
        expect(close).not.toHaveBeenCalled();
        cancellation.abort();
        await expect(request).rejects.toBeDefined();
    });

    it("creates a stable ticket without starting an uncancellable online watcher", async () => {
        const address = new EndpointAddr(
            SecretKey.generate().public(),
            "https://relay.example.com",
            ["127.0.0.1:10001"],
        );
        let finishAccept!: () => void;
        const accepted = new Promise<null>((resolve) => {
            finishAccept = () => resolve(null);
        });
        const online = vi.fn(() => new Promise<void>(() => undefined));
        const endpoint = {
            acceptNext: () => accepted,
            addr: () => address,
            close: async () => finishAccept(),
            id: () => address.id(),
            online,
        } as unknown as Endpoint;
        const network = await IrohNetwork.create({
            addressSupervisionIntervalMs: 1_000,
            bindings: { EndpointTicket } as never,
            config: {},
            endpoint,
            endpointIds: [],
            relayMode: RelayMode.disabled(),
            secretKey: null as never,
        });
        networks.push(network);

        const ticket = EndpointTicket.fromString(await network.endpointTicket()).endpointAddr();
        expect(ticket.id().toString()).toBe(address.id().toString());
        expect(ticket.relayUrl()).toBe("https://relay.example.com/");
        expect(online).not.toHaveBeenCalled();
    });

    it("keeps supervising endpoint addresses after a transient native error", async () => {
        const endpointId = SecretKey.generate().public();
        const address = new EndpointAddr(endpointId, "https://relay.example.com", [
            "127.0.0.1:10001",
        ]);
        let finishAccept!: () => void;
        const accepted = new Promise<null>((resolve) => {
            finishAccept = () => resolve(null);
        });
        const addr = vi
            .fn<() => EndpointAddr>()
            .mockImplementationOnce(() => {
                throw new Error("The network interface is temporarily unavailable.");
            })
            .mockReturnValue(address);
        const endpoint = {
            acceptNext: () => accepted,
            addr,
            close: async () => finishAccept(),
            id: () => endpointId,
        } as unknown as Endpoint;
        const network = await IrohNetwork.create({
            addressSupervisionIntervalMs: 5,
            bindings: { EndpointTicket } as never,
            config: {},
            endpoint,
            endpointIds: [],
            relayMode: RelayMode.disabled(),
            secretKey: null as never,
        });
        networks.push(network);

        await vi.waitFor(() => expect(addr.mock.calls.length).toBeGreaterThanOrEqual(2));
    });

    it("ignores a persisted ticket for a different endpoint identity", async () => {
        const ownEndpointId = SecretKey.generate().public();
        const expectedPeerId = SecretKey.generate().public();
        const wrongPeerId = SecretKey.generate().public();
        const wrongTicket = EndpointTicket.fromAddr(
            new EndpointAddr(wrongPeerId, "https://relay.example.com", ["10.0.0.5:7777"]),
        ).toString();
        let finishAccept!: () => void;
        const accepted = new Promise<null>((resolve) => {
            finishAccept = () => resolve(null);
        });
        let dialedAddress: EndpointAddr | undefined;
        const endpoint = {
            acceptNext: () => accepted,
            close: async () => finishAccept(),
            connect: (address: EndpointAddr) => {
                dialedAddress = address;
                return new Promise<Connection>(() => undefined);
            },
            id: () => ownEndpointId,
        } as unknown as Endpoint;
        const expectedPeer = expectedPeerId.toString();
        const network = await IrohNetwork.create({
            bindings: { EndpointAddr, EndpointId, EndpointTicket } as never,
            config: {},
            connectTimeoutMs: 1_000,
            endpoint,
            endpointIds: [expectedPeer],
            peerTickets: new Map([[expectedPeer, wrongTicket]]),
            relayMode: RelayMode.disabled(),
            secretKey: null as never,
        });
        networks.push(network);

        await vi.waitFor(() => expect(dialedAddress).toBeDefined());
        expect(dialedAddress!.id().toString()).toBe(expectedPeer);
        expect(dialedAddress!.relayUrl()).toBeNull();
        expect(dialedAddress!.directAddresses()).toEqual([]);
    });

    it("bounds a stalled incoming authenticated handshake", async () => {
        const ownId = "0".repeat(64);
        let accepted = false;
        const endpoint = {
            acceptNext: async () => {
                if (accepted) return null;
                accepted = true;
                return {
                    accept: async () => ({
                        connect: () => new Promise<Connection>(() => undefined),
                    }),
                };
            },
            close: async () => undefined,
            id: () => ({ toString: () => ownId }),
        } as unknown as Endpoint;
        const network = await IrohNetwork.create({
            bindings: {} as never,
            config: {},
            endpointIds: [],
            endpoint,
            handshakeTimeoutMs: 5,
            relayMode: RelayMode.disabled(),
            secretKey: null as never,
        });

        await expect(network.close()).resolves.toBeUndefined();
    });

    it("bounds shutdown when the native endpoint does not close", async () => {
        const ownId = "0".repeat(64);
        const endpoint = {
            acceptNext: () => new Promise<null>(() => undefined),
            close: () => new Promise<void>(() => undefined),
            id: () => ({ toString: () => ownId }),
        } as unknown as Endpoint;
        const network = await IrohNetwork.create({
            bindings: {} as never,
            closeTimeoutMs: 5,
            config: {},
            endpointIds: [],
            endpoint,
            relayMode: RelayMode.disabled(),
            secretKey: null as never,
        });

        await expect(network.close()).resolves.toBeUndefined();
    });
});

function openTrustStore(): P2pPeerTrustStore {
    const opened = openSessionDatabase(":memory:");
    migrateSessionDatabase(opened.database);
    databases.push(opened);
    return P2pPeerTrustStore.fromDatabase(opened.database);
}

function fakePingConnection(
    peerEndpointId: string,
    clientEndpointId: string,
    peerIdentity: ReturnType<typeof createP2pInstanceIdentity>,
): Connection {
    let streamCount = 0;
    return {
        close: () => undefined,
        openBi: async () => {
            streamCount += 1;
            if (streamCount === 1) {
                const pair = duplexPair();
                void (async () => {
                    await pair.right.recv.readExact(1);
                    await runP2pResponderHello(
                        createIrohFrameDuplex(pair.right.recv, pair.right.send),
                        {
                            identity: peerIdentity,
                            localChannelBinding: peerEndpointId,
                            remoteChannelBinding: clientEndpointId,
                            transport: "iroh",
                        },
                    );
                })();
                return pair.left;
            }
            return {
                recv: {
                    readToEnd: async () => [1],
                },
                send: {
                    finish: async () => undefined,
                    writeAll: async () => undefined,
                },
            };
        },
        remoteId: () => ({ toString: () => peerEndpointId }),
    } as unknown as Connection;
}

function duplexPair(): {
    left: { recv: RecvStream; send: SendStream };
    right: { recv: RecvStream; send: SendStream };
} {
    const leftToRight = bytePipe();
    const rightToLeft = bytePipe();
    return {
        left: { recv: rightToLeft.recv, send: leftToRight.send },
        right: { recv: leftToRight.recv, send: rightToLeft.send },
    };
}

function bytePipe(): { recv: RecvStream; send: SendStream } {
    const bytes: number[] = [];
    const waiters: (() => void)[] = [];
    const wake = () => waiters.splice(0).forEach((waiter) => waiter());
    return {
        recv: {
            readExact: async (length: number) => {
                while (bytes.length < length) {
                    await new Promise<void>((resolve) => waiters.push(resolve));
                }
                return bytes.splice(0, length);
            },
        } as unknown as RecvStream,
        send: {
            finish: async () => undefined,
            write: async (chunk: number[]) => {
                bytes.push(...chunk);
                wake();
                return chunk.length;
            },
            writeAll: async (chunk: number[]) => {
                bytes.push(...chunk);
                wake();
            },
        } as unknown as SendStream,
    };
}
