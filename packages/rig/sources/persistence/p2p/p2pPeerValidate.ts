import { Value } from "@sinclair/typebox/value";

import { p2pPeerIdentitySchema, type P2pPeerIdentity } from "../../p2p/P2pIdentity.js";
import type { P2pTransportBinding } from "../../p2p/P2pPeer.js";
import type { TX } from "../Transaction.js";
import { queryP2pPeers } from "./queryP2pPeers.js";

export function p2pPeerValidate(
    tx: TX,
    identity: P2pPeerIdentity,
    binding: P2pTransportBinding | undefined,
): void {
    const normalized = { instanceId: identity.instanceId, publicKey: identity.publicKey };
    if (!Value.Check(p2pPeerIdentitySchema, normalized)) {
        throw new Error("The peer presented an invalid P2P identity.");
    }
    const peers = queryP2pPeers(tx);
    const byInstance = peers.find((peer) => peer.instanceId === identity.instanceId);
    if (byInstance !== undefined && byInstance.publicKey !== identity.publicKey) {
        throw new Error("The peer's stable P2P identity key does not match its pin.");
    }
    const byPublicKey = peers.find((peer) => peer.publicKey === identity.publicKey);
    if (byPublicKey !== undefined && byPublicKey.instanceId !== identity.instanceId) {
        throw new Error("The peer's P2P public key is pinned to another instance.");
    }
    if (binding === undefined) return;
    const byBinding = peers.find((peer) =>
        peer.bindings.some(
            (candidate) =>
                candidate.transport === binding.transport && candidate.address === binding.address,
        ),
    );
    if (byBinding !== undefined && byBinding.instanceId !== identity.instanceId) {
        throw new Error("The transport address is pinned to another P2P instance.");
    }
}
