import { describe, expect, it, vi } from "vitest";

import type { P2pFrameDuplex, P2pFrameReader, P2pFrameWriter } from "./P2pFrameDuplex.js";
import {
    createP2pHelloFinish,
    createP2pHelloProof,
    runP2pInitiatorHello,
    runP2pResponderHello,
    verifyP2pHelloFinish,
    verifyP2pHelloProof,
    type P2pHelloContext,
} from "./P2pHelloProtocol.js";
import { createP2pInstanceIdentity } from "./P2pIdentity.js";

const INITIATOR_BINDING = "1".repeat(64);
const RESPONDER_BINDING = "2".repeat(64);
const NOW = 1_800_000_000_000;

function irohContext(overrides: Partial<P2pHelloContext> = {}): P2pHelloContext {
    return {
        initiatorChannelBinding: INITIATOR_BINDING,
        initiatorNonce: "a".repeat(43),
        responderChannelBinding: RESPONDER_BINDING,
        responderNonce: "b".repeat(43),
        transport: "iroh",
        ...overrides,
    };
}

describe("signed P2P hello", () => {
    it("mutually proves stable identities and binds them to the live channel", async () => {
        const initiator = createP2pInstanceIdentity();
        const responder = createP2pInstanceIdentity();
        const wire = duplexPair();
        const verifyInitiator = vi.fn(async () => undefined);
        const verifyResponder = vi.fn(async () => undefined);

        const [seenResponder, seenInitiator] = await Promise.all([
            runP2pInitiatorHello(wire.left, {
                identity: initiator,
                localChannelBinding: INITIATOR_BINDING,
                now: () => NOW,
                randomNonce: () => "a".repeat(43),
                remoteChannelBinding: RESPONDER_BINDING,
                transport: "iroh",
                commitPeer: verifyResponder,
            }),
            runP2pResponderHello(wire.right, {
                identity: responder,
                localChannelBinding: RESPONDER_BINDING,
                now: () => NOW,
                randomNonce: () => "b".repeat(43),
                remoteChannelBinding: INITIATOR_BINDING,
                transport: "iroh",
                commitPeer: verifyInitiator,
            }),
        ]);

        expect(seenResponder).toEqual({
            instanceId: responder.instanceId,
            publicKey: responder.publicKey,
        });
        expect(seenInitiator).toEqual({
            instanceId: initiator.instanceId,
            publicKey: initiator.publicKey,
        });
        expect(verifyInitiator).toHaveBeenCalledWith(seenInitiator, INITIATOR_BINDING);
        expect(verifyResponder).toHaveBeenCalledWith(seenResponder, RESPONDER_BINDING);
    });

    it("rejects a proof replayed with fresh nonces or different channel bindings", () => {
        const identity = createP2pInstanceIdentity();
        const context = irohContext();
        const proof = createP2pHelloProof(identity, "responder", context, NOW);

        expect(() =>
            verifyP2pHelloProof(
                proof,
                "responder",
                { ...context, responderNonce: "c".repeat(43) },
                NOW,
            ),
        ).toThrow("another connection");
        expect(() =>
            verifyP2pHelloProof(
                proof,
                "responder",
                { ...context, responderChannelBinding: "3".repeat(64) },
                NOW,
            ),
        ).toThrow("another connection");
    });

    it("signs the transport into a proof so it cannot be replayed on another transport", () => {
        const identity = createP2pInstanceIdentity();
        const proof = createP2pHelloProof(identity, "responder", irohContext(), NOW);
        const directContext = irohContext({ transport: "direct" });

        expect(() => verifyP2pHelloProof(proof, "responder", directContext, NOW)).toThrow(
            "another connection",
        );
        // Relabelling the proof passes the field comparison, but not the signature.
        expect(() =>
            verifyP2pHelloProof({ ...proof, transport: "direct" }, "responder", directContext, NOW),
        ).toThrow("could not be verified");
    });

    it("signs the transport into the finish so it cannot be replayed on another transport", () => {
        const initiator = createP2pInstanceIdentity();
        const responder = createP2pInstanceIdentity();
        const context = irohContext();
        const finish = createP2pHelloFinish(responder, initiator, context);

        expect(() => verifyP2pHelloFinish(finish, responder, initiator, context)).not.toThrow();
        expect(() =>
            verifyP2pHelloFinish(finish, responder, initiator, {
                ...context,
                transport: "direct",
            }),
        ).toThrow("did not confirm");
    });

    it("refuses an announcement signed for a different transport", async () => {
        const wire = duplexPair();
        // The initiator writes its announcement, then blocks forever waiting for
        // the proof the responder will never send.
        void runP2pInitiatorHello(wire.left, {
            identity: createP2pInstanceIdentity(),
            localChannelBinding: INITIATOR_BINDING,
            now: () => NOW,
            remoteChannelBinding: RESPONDER_BINDING,
            transport: "iroh",
        }).catch(() => undefined);

        await expect(
            runP2pResponderHello(wire.right, {
                identity: createP2pInstanceIdentity(),
                localChannelBinding: RESPONDER_BINDING,
                now: () => NOW,
                remoteChannelBinding: INITIATOR_BINDING,
                transport: "direct",
            }),
        ).rejects.toThrow("different P2P transport channel");
    });

    it("binds the responder's finish to the initiator identity it accepted", () => {
        const initiator = createP2pInstanceIdentity();
        const substitutedInitiator = createP2pInstanceIdentity();
        const responder = createP2pInstanceIdentity();
        const context = irohContext();
        const finish = createP2pHelloFinish(responder, initiator, context);

        expect(() => verifyP2pHelloFinish(finish, responder, initiator, context)).not.toThrow();
        expect(() =>
            verifyP2pHelloFinish(finish, responder, substitutedInitiator, context),
        ).toThrow("did not confirm");
    });

    it("rejects expired, future-dated, and incorrectly signed claims", () => {
        const identity = createP2pInstanceIdentity();
        const context = irohContext();
        const proof = createP2pHelloProof(identity, "initiator", context, NOW);

        expect(() =>
            verifyP2pHelloProof(proof, "initiator", context, NOW + 20 * 60 * 1_000),
        ).toThrow("expired");
        expect(() =>
            verifyP2pHelloProof(proof, "initiator", context, NOW - 10 * 60 * 1_000),
        ).toThrow("clock differs");
        expect(() =>
            verifyP2pHelloProof({ ...proof, signature: "z".repeat(86) }, "initiator", context, NOW),
        ).toThrow("could not be verified");
    });

    it("rejects an oversized hello before reading its payload", async () => {
        const length = Buffer.allocUnsafe(4);
        length.writeUInt32BE(8 * 1024 + 1, 0);
        const read = vi.fn(async () => new Uint8Array(length));
        const send: P2pFrameWriter = {
            finish: async () => undefined,
            write: async (bytes) => bytes.byteLength,
        };

        await expect(
            runP2pResponderHello(
                { recv: { read } satisfies P2pFrameReader, send },
                {
                    identity: createP2pInstanceIdentity(),
                    localChannelBinding: RESPONDER_BINDING,
                    remoteChannelBinding: INITIATOR_BINDING,
                    transport: "iroh",
                },
            ),
        ).rejects.toThrow("invalid P2P hello frame");
        expect(read).toHaveBeenCalledOnce();
    });
});

function duplexPair(): { left: P2pFrameDuplex; right: P2pFrameDuplex } {
    const leftToRight = bytePipe();
    const rightToLeft = bytePipe();
    return {
        left: { recv: rightToLeft.recv, send: leftToRight.send },
        right: { recv: leftToRight.recv, send: rightToLeft.send },
    };
}

function bytePipe(): P2pFrameDuplex {
    const bytes: number[] = [];
    const waiters: (() => void)[] = [];
    const wake = () => waiters.splice(0).forEach((waiter) => waiter());
    return {
        recv: {
            read: async (length: number) => {
                while (bytes.length < length) {
                    await new Promise<void>((resolve) => waiters.push(resolve));
                }
                return Uint8Array.from(bytes.splice(0, length));
            },
        },
        send: {
            finish: async () => undefined,
            write: async (chunk: Uint8Array) => {
                bytes.push(...chunk);
                wake();
                return chunk.byteLength;
            },
        },
    };
}
