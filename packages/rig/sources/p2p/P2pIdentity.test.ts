import { describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";

import {
    createP2pInstanceIdentity,
    encodeBase64Url,
    p2pEncryptionPublicKey,
    verifyP2pSignature,
} from "./P2pIdentity.js";

describe("P2P instance identity", () => {
    it("uses one Ed25519 public key for signing and deterministic X25519 conversion", () => {
        const seed = Uint8Array.from({ length: 32 }, (_, index) => index);
        const first = createP2pInstanceIdentity("astableidentity", seed);
        const second = createP2pInstanceIdentity("astableidentity", seed);

        expect(first.publicKey).toBe("A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg");
        expect(first.publicKey).toBe(encodeBase64Url(ed25519.getPublicKey(seed)));
        expect(second.publicKey).toBe(first.publicKey);
        expect(p2pEncryptionPublicKey(first.publicKey)).toBe(
            "RwHQhIhFH1RaQJ-1iuPlhYHKQKw_fxFGmM1x3qxzygE",
        );
        expect(() => p2pEncryptionPublicKey(encodeBase64Url(new Uint8Array(32).fill(255)))).toThrow(
            "cannot be used for encryption",
        );
        expect(
            verifyP2pSignature(
                new Uint8Array(),
                encodeBase64Url(new Uint8Array(64)),
                encodeBase64Url(new Uint8Array(32).fill(255)),
            ),
        ).toBe(false);
    });

    it("encrypts and authenticates messages in both directions", () => {
        const alice = createP2pInstanceIdentity();
        const bob = createP2pInstanceIdentity();
        const message = Buffer.from("private P2P payload", "utf8");

        const forBob = alice.encryptFor(message, bob.publicKey);
        expect(Buffer.from(bob.decryptFrom(forBob, alice.publicKey)).toString("utf8")).toBe(
            "private P2P payload",
        );

        const forAlice = bob.encryptFor(message, alice.publicKey);
        expect(Buffer.from(alice.decryptFrom(forAlice, bob.publicKey)).toString("utf8")).toBe(
            "private P2P payload",
        );

        const tampered = {
            ...forBob,
            ciphertext: `${forBob.ciphertext[0] === "A" ? "B" : "A"}${forBob.ciphertext.slice(1)}`,
        };
        expect(() => bob.decryptFrom(tampered, alice.publicKey)).toThrow(
            "could not be authenticated",
        );
        expect(() => bob.decryptFrom(forBob, createP2pInstanceIdentity().publicKey)).toThrow(
            "could not be authenticated",
        );
    });
});
