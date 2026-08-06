import { and, eq, lt, or } from "drizzle-orm";
import { Value } from "@sinclair/typebox/value";

import type { TX } from "../persistence/Transaction.js";
import { p2pPeerPairings } from "../persistence/database/schema.js";
import { inTx } from "../persistence/inTx.js";
import { p2pPeerValidate } from "../persistence/p2p/p2pPeerValidate.js";
import { p2pPeerVerifyOrPin } from "../persistence/p2p/p2pPeerVerifyOrPin.js";
import { queryP2pPeers } from "../persistence/p2p/queryP2pPeers.js";
import type { P2pPeerIdentity } from "./P2pIdentity.js";
import {
    p2pPeerPairingTrustSchema,
    p2pPairingTransactionIdSchema,
    type P2pPeerConnections,
    type P2pPeerPairingTrust,
    type P2pTransportBinding,
    type P2pTrustedPeer,
} from "./P2pPeer.js";
import type { P2pTransportKind } from "./P2pTransport.js";

export interface P2pPeerTrustDatabase {
    query<T>(operation: (tx: TX) => T): T;
    transaction<T>(operation: (tx: TX) => T): T;
}

export interface P2pPeerTrustStoreContract {
    preparePairing(
        pairingId: string,
        identity: P2pPeerIdentity,
        transport: P2pTransportKind,
        address: string,
        connections: P2pPeerConnections,
        name: string,
        assignPrimary: boolean,
        expiresAt: number,
    ): Promise<P2pPreparedPairingTrust>;
    peers(): readonly P2pTrustedPeer[];
    peerForBinding(transport: P2pTransportKind, address: string): P2pPeerIdentity | undefined;
    validate(
        identity: P2pPeerIdentity,
        transport?: P2pTransportKind,
        address?: string,
    ): Promise<void>;
    verifyOrPin(
        identity: P2pPeerIdentity,
        transport?: P2pTransportKind,
        address?: string,
        connections?: P2pPeerConnections,
        name?: string,
    ): Promise<void>;
    readyPairings(): readonly P2pPreparedPairingTrust[];
}

export interface P2pPreparedPairingTrust {
    pairing: P2pPeerPairingTrust;
    activate(): Promise<P2pTrustedPeer>;
    abort(): Promise<void>;
    complete(): Promise<void>;
    markConfirmed(): Promise<void>;
    markLocallyReady(): Promise<void>;
}

export class P2pPeerTrustStore implements P2pPeerTrustStoreContract {
    readonly #database: P2pPeerTrustDatabase;
    readonly #now: () => number;

    constructor(database: P2pPeerTrustDatabase, options: { now?: () => number } = {}) {
        this.#database = database;
        this.#now = options.now ?? Date.now;
    }

    static fromDatabase(database: TX, options: { now?: () => number } = {}): P2pPeerTrustStore {
        return new P2pPeerTrustStore(
            {
                query: (operation) => operation(database),
                transaction: (operation) => inTx(database, operation),
            },
            options,
        );
    }

    peers(): readonly P2pTrustedPeer[] {
        return this.#database.transaction((tx) => {
            deleteExpiredUnconfirmedPairings(tx, this.#now());
            return queryP2pPeers(tx);
        });
    }

    async preparePairing(
        pairingId: string,
        identity: P2pPeerIdentity,
        transport: P2pTransportKind,
        address: string,
        connections: P2pPeerConnections,
        name: string,
        assignPrimary: boolean,
        expiresAt: number,
    ): Promise<P2pPreparedPairingTrust> {
        if (!Value.Check(p2pPairingTransactionIdSchema, pairingId)) {
            throw new Error("The P2P pairing transaction ID is invalid.");
        }
        let pairing: P2pPeerPairingTrust | undefined;
        this.#database.transaction((tx) => {
            deleteExpiredUnconfirmedPairings(tx, this.#now());
            p2pPeerValidate(tx, identity, { address, transport });
            const candidate: P2pPeerPairingTrust = {
                assignPrimary,
                expiresAt,
                pairingId,
                peer: {
                    bindings: [{ address, transport }],
                    connections,
                    instanceId: identity.instanceId,
                    name,
                    publicKey: identity.publicKey,
                },
                state: "prepared",
            };
            const existing = queryPairingTrust(tx).find((entry) => entry.pairingId === pairingId);
            if (existing !== undefined) {
                if (!samePairing(existing, candidate)) {
                    throw new Error("The P2P pairing transaction ID is already in use.");
                }
                pairing = existing;
                return;
            }
            tx.insert(p2pPeerPairings)
                .values({
                    assignPrimary,
                    bindingsJson: JSON.stringify(candidate.peer.bindings),
                    connectionsJson: JSON.stringify(connections),
                    expiresAtMs: expiresAt,
                    instanceId: identity.instanceId,
                    name,
                    pairingId,
                    publicKey: identity.publicKey,
                    state: "prepared",
                })
                .run();
            pairing = candidate;
        });
        if (pairing === undefined) {
            throw new Error("The P2P pairing trust transaction was not prepared.");
        }
        return this.#handle(pairing);
    }

    readyPairings(): readonly P2pPreparedPairingTrust[] {
        return this.#database.transaction((tx) => {
            deleteExpiredUnconfirmedPairings(tx, this.#now());
            return queryPairingTrust(tx)
                .filter((pairing) => pairing.state === "confirmed")
                .map((pairing) => this.#handle(pairing));
        });
    }

    peerForBinding(transport: P2pTransportKind, address: string): P2pPeerIdentity | undefined {
        const peer = this.peers().find((candidate) =>
            candidate.bindings.some(
                (binding) => binding.transport === transport && binding.address === address,
            ),
        );
        return peer === undefined
            ? undefined
            : { instanceId: peer.instanceId, publicKey: peer.publicKey };
    }

    async validate(
        identity: P2pPeerIdentity,
        transport?: P2pTransportKind,
        address?: string,
    ): Promise<void> {
        const binding = toBinding(transport, address);
        this.#database.query((tx) => p2pPeerValidate(tx, identity, binding));
    }

    async verifyOrPin(
        identity: P2pPeerIdentity,
        transport?: P2pTransportKind,
        address?: string,
        connections?: P2pPeerConnections,
        name?: string,
    ): Promise<void> {
        const binding = toBinding(transport, address);
        this.#database.transaction((tx) =>
            p2pPeerVerifyOrPin(tx, identity, binding, connections, name, this.#now()),
        );
    }

    #handle(pairing: P2pPeerPairingTrust): P2pPreparedPairingTrust {
        return {
            pairing,
            activate: async () => {
                let peer: P2pTrustedPeer | undefined;
                this.#database.transaction((tx) => {
                    const pending = queryPairingTrust(tx).find(
                        (entry) => entry.pairingId === pairing.pairingId,
                    );
                    if (pending === undefined) {
                        peer = queryP2pPeers(tx).find(
                            (entry) =>
                                entry.instanceId === pairing.peer.instanceId &&
                                entry.publicKey === pairing.peer.publicKey,
                        );
                        return;
                    }
                    if (pending.state !== "confirmed") {
                        throw new Error("The P2P pairing transaction is not ready to activate.");
                    }
                    const binding = pending.peer.bindings[0];
                    if (binding === undefined) {
                        throw new Error("The P2P pairing transaction has no transport binding.");
                    }
                    p2pPeerVerifyOrPin(
                        tx,
                        pending.peer,
                        binding,
                        pending.peer.connections,
                        pending.peer.name,
                        this.#now(),
                    );
                    peer = queryP2pPeers(tx).find(
                        (entry) => entry.instanceId === pending.peer.instanceId,
                    );
                });
                if (peer === undefined) {
                    throw new Error("The P2P pairing transaction did not activate its peer.");
                }
                return peer;
            },
            abort: async () => {
                this.#database.transaction((tx) => {
                    tx.delete(p2pPeerPairings)
                        .where(
                            and(
                                eq(p2pPeerPairings.pairingId, pairing.pairingId),
                                or(
                                    eq(p2pPeerPairings.state, "prepared"),
                                    eq(p2pPeerPairings.state, "local_ready"),
                                ),
                            ),
                        )
                        .run();
                });
            },
            complete: async () => {
                this.#database.transaction((tx) => {
                    const pending = queryPairingTrust(tx).find(
                        (entry) => entry.pairingId === pairing.pairingId,
                    );
                    if (pending === undefined) return;
                    if (pending.state !== "confirmed") {
                        throw new Error("The P2P pairing transaction is not ready to complete.");
                    }
                    const active = queryP2pPeers(tx).find(
                        (entry) =>
                            entry.instanceId === pending.peer.instanceId &&
                            entry.publicKey === pending.peer.publicKey,
                    );
                    if (active === undefined) {
                        throw new Error(
                            "The P2P pairing transaction cannot complete before trust is active.",
                        );
                    }
                    tx.delete(p2pPeerPairings)
                        .where(eq(p2pPeerPairings.pairingId, pairing.pairingId))
                        .run();
                });
            },
            markConfirmed: async () => {
                this.#database.transaction((tx) => {
                    const current = queryPairingTrust(tx).find(
                        (entry) => entry.pairingId === pairing.pairingId,
                    );
                    if (current === undefined) {
                        throw new Error("The P2P pairing transaction no longer exists.");
                    }
                    if (current.state === "confirmed") return;
                    if (current.state !== "local_ready") {
                        throw new Error(
                            "The P2P pairing transaction is not locally ready to confirm.",
                        );
                    }
                    tx.update(p2pPeerPairings)
                        .set({ state: "confirmed" })
                        .where(eq(p2pPeerPairings.pairingId, pairing.pairingId))
                        .run();
                });
            },
            markLocallyReady: async () => {
                this.#database.transaction((tx) => {
                    const current = queryPairingTrust(tx).find(
                        (entry) => entry.pairingId === pairing.pairingId,
                    );
                    if (current === undefined) {
                        throw new Error("The P2P pairing transaction no longer exists.");
                    }
                    if (current.state === "confirmed" || current.state === "local_ready") return;
                    tx.update(p2pPeerPairings)
                        .set({ state: "local_ready" })
                        .where(eq(p2pPeerPairings.pairingId, pairing.pairingId))
                        .run();
                });
            },
        };
    }
}

function queryPairingTrust(tx: TX): readonly P2pPeerPairingTrust[] {
    return tx
        .select()
        .from(p2pPeerPairings)
        .all()
        .map((row) => {
            const candidate: unknown = {
                assignPrimary: row.assignPrimary,
                expiresAt: row.expiresAtMs,
                pairingId: row.pairingId,
                peer: {
                    bindings: JSON.parse(row.bindingsJson) as unknown,
                    connections: JSON.parse(row.connectionsJson) as unknown,
                    instanceId: row.instanceId,
                    name: row.name,
                    publicKey: row.publicKey,
                },
                state: row.state,
            };
            if (!Value.Check(p2pPeerPairingTrustSchema, candidate)) {
                throw new Error("The saved P2P pairing transaction is invalid.");
            }
            return candidate;
        });
}

function deleteExpiredUnconfirmedPairings(tx: TX, now: number): void {
    tx.delete(p2pPeerPairings)
        .where(
            and(
                or(eq(p2pPeerPairings.state, "prepared"), eq(p2pPeerPairings.state, "local_ready")),
                lt(p2pPeerPairings.expiresAtMs, now),
            ),
        )
        .run();
}

function samePairing(left: P2pPeerPairingTrust, right: P2pPeerPairingTrust): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

function toBinding(
    transport: P2pTransportKind | undefined,
    address: string | undefined,
): P2pTransportBinding | undefined {
    if (transport === undefined && address === undefined) return undefined;
    if (transport === undefined || address === undefined) {
        throw new Error("A verified P2P transport binding needs both its kind and address.");
    }
    return { address, transport };
}
