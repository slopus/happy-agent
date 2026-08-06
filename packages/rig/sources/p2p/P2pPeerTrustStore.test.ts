import { afterEach, describe, expect, it } from "vitest";

import { migrateSessionDatabase } from "../persistence/database/migrateSessionDatabase.js";
import {
    openSessionDatabase,
    type OpenSessionDatabase,
} from "../persistence/database/openSessionDatabase.js";
import { createP2pInstanceIdentity } from "./P2pIdentity.js";
import { P2pPeerTrustStore } from "./P2pPeerTrustStore.js";

const databases: OpenSessionDatabase[] = [];

afterEach(() => {
    for (const opened of databases.splice(0)) opened.client.close();
});

describe("P2pPeerTrustStore", () => {
    it("pins authenticated identity, bindings, and reusable connections in SQLite", async () => {
        const opened = openTrustDatabase();
        const identity = createP2pInstanceIdentity();
        const store = P2pPeerTrustStore.fromDatabase(opened.database);

        await store.validate(identity, "iroh", "a".repeat(64));
        expect(store.peerForBinding("iroh", "a".repeat(64))).toBeUndefined();
        await store.verifyOrPin(identity, "iroh", "a".repeat(64), {
            iroh: { endpointId: "a".repeat(64) },
        });
        const restored = P2pPeerTrustStore.fromDatabase(opened.database);

        expect(restored.peerForBinding("iroh", "a".repeat(64))).toEqual({
            instanceId: identity.instanceId,
            publicKey: identity.publicKey,
        });
        expect(restored.peers()[0]?.connections.iroh?.endpointId).toBe("a".repeat(64));
    });

    it("refreshes an Iroh address ticket without changing the trusted identity", async () => {
        const opened = openTrustDatabase();
        const identity = createP2pInstanceIdentity();
        const store = P2pPeerTrustStore.fromDatabase(opened.database);
        const endpointId = "a".repeat(64);

        await store.verifyOrPin(identity, "iroh", endpointId, {
            iroh: { endpointId, ticket: "first-ticket" },
        });
        await store.verifyOrPin(identity, "iroh", endpointId, {
            iroh: { endpointId, ticket: "second-ticket" },
        });

        expect(store.peers()[0]).toMatchObject({
            connections: { iroh: { endpointId, ticket: "second-ticket" } },
            instanceId: identity.instanceId,
            publicKey: identity.publicKey,
        });
    });

    it("lets one stable identity add transport addresses but rejects conflicting pins", async () => {
        const opened = openTrustDatabase();
        const trusted = createP2pInstanceIdentity();
        const impostor = createP2pInstanceIdentity(trusted.instanceId);
        const other = createP2pInstanceIdentity();
        const store = P2pPeerTrustStore.fromDatabase(opened.database);

        await store.verifyOrPin(trusted, "iroh", "a".repeat(64));
        await store.verifyOrPin(trusted, "iroh", "b".repeat(64));

        await expect(store.verifyOrPin(impostor, "iroh", "c".repeat(64))).rejects.toThrow(
            "does not match",
        );
        await expect(store.verifyOrPin(other, "iroh", "a".repeat(64))).rejects.toThrow(
            "another P2P instance",
        );
        expect(store.peerForBinding("iroh", "b".repeat(64))?.instanceId).toBe(trusted.instanceId);
    });

    it("keeps prepared pairing trust inactive and removes it when pairing aborts", async () => {
        const opened = openTrustDatabase();
        const identity = createP2pInstanceIdentity();
        const store = P2pPeerTrustStore.fromDatabase(opened.database);

        const prepared = await store.preparePairing(
            "A".repeat(43),
            identity,
            "iroh",
            "a".repeat(64),
            { iroh: { endpointId: "a".repeat(64) } },
            "Remote",
            false,
            Date.now() + 60_000,
        );
        expect(store.peers()).toEqual([]);
        expect(store.readyPairings()).toEqual([]);

        await prepared.abort();
        expect(store.peers()).toEqual([]);
        expect(store.readyPairings()).toEqual([]);
    });

    it("recovers a durable ready pairing and promotes it into active trust", async () => {
        const opened = openTrustDatabase();
        const identity = createP2pInstanceIdentity();
        const store = P2pPeerTrustStore.fromDatabase(opened.database);
        const prepared = await store.preparePairing(
            "A".repeat(43),
            identity,
            "iroh",
            "a".repeat(64),
            { iroh: { endpointId: "a".repeat(64) } },
            "Remote",
            true,
            Date.now() + 60_000,
        );
        await prepared.markLocallyReady();
        await prepared.markConfirmed();

        const restored = P2pPeerTrustStore.fromDatabase(opened.database);
        expect(restored.peers()).toEqual([]);
        expect(restored.readyPairings()).toHaveLength(1);
        await restored.readyPairings()[0]!.activate();
        expect(restored.readyPairings()).toHaveLength(1);
        await restored.readyPairings()[0]!.complete();
        expect(restored.peers()[0]).toMatchObject({
            instanceId: identity.instanceId,
            name: "Remote",
        });
        expect(restored.readyPairings()).toEqual([]);
    });

    it("aborting one transaction cannot erase an identical pairing that finalized", async () => {
        const opened = openTrustDatabase();
        const identity = createP2pInstanceIdentity();
        const store = P2pPeerTrustStore.fromDatabase(opened.database);
        const first = await store.preparePairing(
            "A".repeat(43),
            identity,
            "iroh",
            "a".repeat(64),
            { iroh: { endpointId: "a".repeat(64) } },
            "Remote",
            false,
            Date.now() + 60_000,
        );
        const second = await store.preparePairing(
            "B".repeat(43),
            identity,
            "iroh",
            "a".repeat(64),
            { iroh: { endpointId: "a".repeat(64) } },
            "Remote",
            false,
            Date.now() + 60_000,
        );

        await second.markLocallyReady();
        await second.markConfirmed();
        await second.activate();
        await second.complete();
        await first.abort();

        expect(store.peers()).toHaveLength(1);
        expect(store.peers()[0]?.instanceId).toBe(identity.instanceId);
    });
});

function openTrustDatabase(): OpenSessionDatabase {
    const opened = openSessionDatabase(":memory:");
    migrateSessionDatabase(opened.database);
    databases.push(opened);
    return opened;
}
