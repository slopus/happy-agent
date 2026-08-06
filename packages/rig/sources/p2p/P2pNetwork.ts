import type { Duplex } from "node:stream";

import type { ConfigP2p } from "../config/types.js";
import type { P2pStatus, P2pTransportStatus } from "../protocol/P2pProtocol.js";
import { DirectTlsNetwork } from "./DirectTlsNetwork.js";
import { IrohNetwork } from "./IrohNetwork.js";
import { loadOrCreateIrohSecretKey } from "./loadOrCreateIrohSecretKey.js";
import { loadOrCreateP2pIdentity } from "./loadOrCreateP2pIdentity.js";
import type { P2pPeerTrustStoreContract } from "./P2pPeerTrustStore.js";
import type { P2pInstanceIdentity, P2pPeerIdentity } from "./P2pIdentity.js";
import type { P2pTrustedPeer } from "./P2pPeer.js";
import type { P2pHttpRequest, P2pHttpResponse, ServeP2pHttpRequest } from "./P2pHttp.js";
import type { P2pTransport, P2pTransportKind } from "./P2pTransport.js";
import type { P2pTunnelConnection, P2pTunnelRequestHead, ServeP2pTunnel } from "./P2pTunnel.js";
import { SshBridgeResponder } from "./SshBridgeResponder.js";
import { SshTransport } from "./SshTransport.js";

export interface CreateP2pNetworkOptions {
    config: ConfigP2p;
    /** Test seam. Production creates the direct mutual-TLS transport. */
    createDirectTransport?: (
        onStatusChange: (status: P2pTransportStatus) => void,
    ) => Promise<P2pTransport>;
    /** Test seam. Production creates the native Iroh transport. */
    createIrohTransport?: (
        onStatusChange: (status: P2pTransportStatus) => void,
        validatePeer: (identity: P2pPeerIdentity, endpointId: string) => Promise<void>,
    ) => Promise<P2pTransport>;
    /** Test seam. Production creates the outbound SSH transport. */
    createSshTransport?: (
        onStatusChange: (status: P2pTransportStatus) => void,
    ) => Promise<P2pTransport>;
    irohSecretKeyPath: string;
    identity?: P2pInstanceIdentity;
    identityPath?: string;
    onStatusChange?: (status: P2pStatus) => void;
    onTransportUnavailable?: (transport: P2pTransportKind, error: unknown) => void;
    peerTrustStore: P2pPeerTrustStoreContract;
    serveRequest?: ServeP2pHttpRequest;
    serveTunnel?: ServeP2pTunnel;
}

export class P2pNetwork {
    readonly #statuses: Map<P2pTransportKind, P2pTransportStatus>;
    readonly #transports: readonly P2pTransport[];
    readonly #identity: P2pInstanceIdentity | undefined;
    #name: string;
    readonly #sshBridgeResponder: SshBridgeResponder | undefined;

    private constructor(
        transports: readonly P2pTransport[],
        statuses: Map<P2pTransportKind, P2pTransportStatus>,
        identity: P2pInstanceIdentity | undefined,
        name: string,
        sshBridgeResponder?: SshBridgeResponder,
    ) {
        this.#transports = transports;
        this.#statuses = statuses;
        this.#identity = identity;
        this.#name = name;
        this.#sshBridgeResponder = sshBridgeResponder;
    }

    static async create(options: CreateP2pNetworkOptions): Promise<P2pNetwork> {
        const statuses = new Map<P2pTransportKind, P2pTransportStatus>();
        const transports: P2pTransport[] = [];
        let identity: P2pInstanceIdentity | undefined;
        let network: P2pNetwork | undefined;
        const publish = (): void => {
            try {
                options.onStatusChange?.(
                    network?.status() ?? createStatus(statuses, identity, options.config.name),
                );
            } catch {
                // Optional status delivery must not break a transport.
            }
        };

        try {
            identity =
                options.identity ??
                (await loadOrCreateP2pIdentity(
                    options.identityPath ?? `${options.irohSecretKeyPath}.instance`,
                ));
        } catch (error) {
            for (const transport of enabledTransports(options.config)) {
                statuses.set(transport, {
                    error:
                        error instanceof Error
                            ? error.message
                            : "The stable P2P identity could not be loaded.",
                    state: "unavailable",
                    transport,
                });
                try {
                    options.onTransportUnavailable?.(transport, error);
                } catch {
                    // Optional diagnostics must not break the P2P service.
                }
            }
            network = new P2pNetwork(transports, statuses, undefined, options.config.name);
            publish();
            return network;
        }

        const trustStore = options.peerTrustStore;
        let peers: readonly P2pTrustedPeer[];
        try {
            peers = trustStore.peers();
        } catch (error) {
            for (const transport of enabledTransports(options.config)) {
                statuses.set(transport, {
                    error:
                        error instanceof Error
                            ? error.message
                            : "The saved P2P peer trust could not be loaded.",
                    state: "unavailable",
                    transport,
                });
                try {
                    options.onTransportUnavailable?.(transport, error);
                } catch {
                    // Optional diagnostics must not break the P2P service.
                }
            }
            network = new P2pNetwork(transports, statuses, identity, options.config.name);
            publish();
            return network;
        }

        if (options.config.enableDirect) {
            const kind = "direct";
            try {
                const onDirectStatusChange = (status: P2pTransportStatus): void => {
                    statuses.set(kind, status);
                    publish();
                };
                const direct =
                    options.createDirectTransport === undefined
                        ? await DirectTlsNetwork.create({
                              apiExposed: options.config.exposeApi,
                              commitPeer: (peerIdentity, publicKey) =>
                                  trustStore.verifyOrPin(peerIdentity, kind, publicKey),
                              config: options.config.direct,
                              identity,
                              onStatusChange: onDirectStatusChange,
                              peers,
                              ...(options.serveRequest !== undefined
                                  ? { serveRequest: options.serveRequest }
                                  : {}),
                              ...(options.config.exposeApi && options.serveTunnel !== undefined
                                  ? { serveTunnel: options.serveTunnel }
                                  : {}),
                              validatePeer: (peerIdentity, publicKey) =>
                                  trustStore.validate(peerIdentity, kind, publicKey),
                          })
                        : await options.createDirectTransport(onDirectStatusChange);
                transports.push(direct);
                statuses.set(direct.kind, direct.status());
            } catch (error) {
                statuses.set(kind, {
                    error:
                        error instanceof Error
                            ? error.message
                            : "Direct P2P networking could not start.",
                    state: "unavailable",
                    transport: kind,
                });
                try {
                    options.onTransportUnavailable?.(kind, error);
                } catch {
                    // Optional diagnostics must not break the P2P service.
                }
            }
        }

        if (options.config.enableIroh) {
            const kind = "iroh";
            try {
                const peersByEndpoint = new Map(
                    peers.flatMap((peer) =>
                        peer.connections.iroh === undefined
                            ? []
                            : [[peer.connections.iroh.endpointId, peer] as const],
                    ),
                );
                const peerTickets = new Map(
                    peers.flatMap((peer) =>
                        peer.connections.iroh?.ticket === undefined
                            ? []
                            : [
                                  [
                                      peer.connections.iroh.endpointId,
                                      peer.connections.iroh.ticket,
                                  ] as const,
                              ],
                    ),
                );
                const onIrohStatusChange = (status: P2pTransportStatus): void => {
                    statuses.set(kind, status);
                    publish();
                };
                const validateIrohPeer = async (
                    peerIdentity: P2pPeerIdentity,
                    endpointId: string,
                ): Promise<void> => {
                    // Pairing can add trust after this network starts, so the durable store—not
                    // the startup projection used to seed the transport—is authoritative here.
                    const configured = trustStore.peerForBinding("iroh", endpointId);
                    if (
                        configured === undefined ||
                        configured.instanceId !== peerIdentity.instanceId ||
                        configured.publicKey !== peerIdentity.publicKey
                    ) {
                        throw new Error(
                            "The Iroh peer identity does not match its trusted peer record.",
                        );
                    }
                    await trustStore.validate(peerIdentity, "iroh", endpointId);
                };
                const iroh =
                    options.createIrohTransport === undefined
                        ? await IrohNetwork.create({
                              apiExposed: options.config.exposeApi,
                              commitPeer: (peerIdentity, endpointId) =>
                                  trustStore.verifyOrPin(peerIdentity, "iroh", endpointId),
                              config: options.config.iroh,
                              endpointIds: [...peersByEndpoint.keys()],
                              identity,
                              knownPeer: (endpointId) => {
                                  const peer = peersByEndpoint.get(endpointId);
                                  return peer === undefined
                                      ? undefined
                                      : {
                                            instanceId: peer.instanceId,
                                            name: peer.name,
                                            publicKey: peer.publicKey,
                                        };
                              },
                              onStatusChange: onIrohStatusChange,
                              peerTickets,
                              secretKey: await loadOrCreateIrohSecretKey(options.irohSecretKeyPath),
                              updatePeerAddress: (peerIdentity, endpointId, ticket) =>
                                  trustStore.verifyOrPin(peerIdentity, "iroh", endpointId, {
                                      iroh: { endpointId, ticket },
                                  }),
                              ...(options.serveRequest !== undefined
                                  ? { serveRequest: options.serveRequest }
                                  : {}),
                              ...(options.config.exposeApi && options.serveTunnel !== undefined
                                  ? { serveTunnel: options.serveTunnel }
                                  : {}),
                              validatePeer: validateIrohPeer,
                          })
                        : await options.createIrohTransport(onIrohStatusChange, validateIrohPeer);
                transports.push(iroh);
                statuses.set(iroh.kind, iroh.status());
            } catch (error) {
                statuses.set(kind, {
                    error: error instanceof Error ? error.message : "Iroh could not start.",
                    state: "unavailable",
                    transport: kind,
                });
                try {
                    options.onTransportUnavailable?.(kind, error);
                } catch {
                    // Optional diagnostics must not break the P2P service.
                }
            }
        }

        if (options.config.enableSsh) {
            const kind = "ssh";
            try {
                const onSshStatusChange = (status: P2pTransportStatus): void => {
                    statuses.set(kind, status);
                    publish();
                };
                const ssh =
                    options.createSshTransport === undefined
                        ? SshTransport.create({
                              commitPeer: (peerIdentity, binding) =>
                                  trustStore.verifyOrPin(peerIdentity, kind, binding),
                              identity,
                              onStatusChange: onSshStatusChange,
                              peers,
                              ...(options.config.exposeApi && options.serveTunnel !== undefined
                                  ? { serveTunnel: options.serveTunnel }
                                  : {}),
                              validatePeer: (peerIdentity, binding) =>
                                  trustStore.validate(peerIdentity, kind, binding),
                          })
                        : await options.createSshTransport(onSshStatusChange);
                transports.push(ssh);
                statuses.set(ssh.kind, ssh.status());
            } catch (error) {
                statuses.set(kind, {
                    error:
                        error instanceof Error
                            ? error.message
                            : "SSH P2P networking could not start.",
                    state: "unavailable",
                    transport: kind,
                });
                try {
                    options.onTransportUnavailable?.(kind, error);
                } catch {
                    // Optional diagnostics must not break the P2P service.
                }
            }
        }

        const sshBridgeResponder =
            options.config.enableSsh && options.serveRequest !== undefined && peers.length > 0
                ? new SshBridgeResponder({
                      commitPeer: (peerIdentity, binding) =>
                          trustStore.verifyOrPin(peerIdentity, "ssh", binding),
                      identity,
                      peers,
                      serveRequest: options.serveRequest,
                      ...(options.serveTunnel === undefined
                          ? {}
                          : { serveTunnel: options.serveTunnel }),
                      validatePeer: (peerIdentity, binding) =>
                          trustStore.validate(peerIdentity, "ssh", binding),
                  })
                : undefined;
        network = new P2pNetwork(
            transports,
            statuses,
            identity,
            options.config.name,
            sshBridgeResponder,
        );
        publish();
        return network;
    }

    async close(): Promise<void> {
        this.#sshBridgeResponder?.close();
        await Promise.allSettled(this.#transports.map((transport) => transport.close()));
    }

    async acceptSshBridge(stream: Duplex): Promise<void> {
        if (this.#sshBridgeResponder === undefined) {
            stream.destroy();
            throw new Error("SSH P2P API sharing is disabled.");
        }
        await this.#sshBridgeResponder.accept(stream);
    }

    sshBridgeEnabled(): boolean {
        return this.#sshBridgeResponder !== undefined;
    }

    async fetch(
        peerId: string,
        request: P2pHttpRequest,
        signal: AbortSignal,
    ): Promise<{ response: P2pHttpResponse; transport: P2pTransportKind }> {
        const transport = this.#selectTransport(peerId, "fetch");
        if (transport?.fetch === undefined) {
            throw new Error("No active P2P transport owns that trusted peer ID.");
        }
        return {
            response: await transport.fetch(peerId, request, signal),
            transport: transport.kind,
        };
    }

    async openTunnel(
        peerId: string,
        request: P2pTunnelRequestHead,
        signal: AbortSignal,
    ): Promise<{ connection: P2pTunnelConnection; transport: P2pTransportKind }> {
        const transport = this.#selectTransport(peerId, "openTunnel");
        if (transport?.openTunnel === undefined) {
            throw new Error("No active P2P transport can tunnel to that trusted peer ID.");
        }
        return {
            connection: await transport.openTunnel(peerId, request, signal),
            transport: transport.kind,
        };
    }

    status(): P2pStatus {
        return createStatus(this.#statuses, this.#identity, this.#name);
    }

    setName(name: string): void {
        this.#name = name;
    }

    async irohEndpointTicket(): Promise<string | undefined> {
        for (const transport of this.#transports) {
            if (transport instanceof IrohNetwork) return transport.endpointTicket();
        }
        return undefined;
    }

    addTrustedPeer(peer: P2pTrustedPeer): void {
        if (peer.connections.iroh === undefined) return;
        for (const transport of this.#transports) {
            if (transport instanceof IrohNetwork) {
                transport.addPeer(
                    peer.connections.iroh.endpointId,
                    {
                        instanceId: peer.instanceId,
                        publicKey: peer.publicKey,
                    },
                    peer.name,
                    peer.connections.iroh.ticket,
                );
            }
        }
    }

    #selectTransport(peerId: string, capability: "fetch" | "openTunnel"): P2pTransport | undefined {
        return this.#transports
            .map((candidate) => {
                const status = candidate.status();
                const peer =
                    status.state === "ready"
                        ? status.peers.find((entry) => entry.peerId === peerId)
                        : undefined;
                return {
                    candidate,
                    rank:
                        peer?.status === "connected"
                            ? 2
                            : peer?.status === "connecting"
                              ? 1
                              : peer === undefined
                                ? -1
                                : 0,
                };
            })
            .filter(({ candidate, rank }) => candidate[capability] !== undefined && rank >= 0)
            .sort((left, right) => right.rank - left.rank)[0]?.candidate;
    }
}

function enabledTransports(config: ConfigP2p): readonly P2pTransportKind[] {
    return [
        ...(config.enableDirect ? (["direct"] as const) : []),
        ...(config.enableIroh ? (["iroh"] as const) : []),
        ...(config.enableSsh ? (["ssh"] as const) : []),
    ];
}

function createStatus(
    statuses: ReadonlyMap<P2pTransportKind, P2pTransportStatus>,
    identity: P2pInstanceIdentity | undefined,
    name: string,
): P2pStatus {
    return {
        ...(identity === undefined
            ? {}
            : { instanceId: identity.instanceId, publicKey: identity.publicKey }),
        name,
        transports: [...statuses.values()],
    };
}
