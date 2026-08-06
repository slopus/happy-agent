import { describe, expect, it } from "vitest";

import {
    nobleBoxKeyPairFromSecretKey,
    nobleBoxOpen,
    nobleBoxSeal,
    nobleSecretBoxOpen,
    nobleSecretBoxSeal,
} from "./nobleNaCl.js";

const MESSAGE = new TextEncoder().encode("noble compatibility");
const NONCE = new Uint8Array(24).fill(5);

describe("Noble NaCl compatibility", () => {
    // These fixed values were generated with TweetNaCl 1.0.3. Never regenerate
    // them from the Noble implementation they are intended to verify.
    it("matches the NaCl secretbox wire format", () => {
        const key = new Uint8Array(32).fill(7);
        const ciphertext = nobleSecretBoxSeal(MESSAGE, NONCE, key);

        expect(Buffer.from(ciphertext).toString("hex")).toBe(
            "cdd8ef4738d99dd7a645a7bc024b24438faf214797b234480b50ae561de30ec0724bce",
        );
        expect(nobleSecretBoxOpen(ciphertext, NONCE, key)).toEqual(MESSAGE);
    });

    it("matches the NaCl box wire format", () => {
        const senderInput = new Uint8Array(32).fill(4);
        const sender = nobleBoxKeyPairFromSecretKey(senderInput);
        const recipient = nobleBoxKeyPairFromSecretKey(new Uint8Array(32).fill(3));
        senderInput.fill(0);
        const ciphertext = nobleBoxSeal(MESSAGE, NONCE, recipient.publicKey, sender.secretKey);

        expect(Buffer.from(sender.publicKey).toString("hex")).toBe(
            "ac01b2209e86354fb853237b5de0f4fab13c7fcbf433a61c019369617fecf10b",
        );
        expect(sender.secretKey).toEqual(new Uint8Array(32).fill(4));
        expect(Buffer.from(recipient.publicKey).toString("hex")).toBe(
            "5dfedd3b6bd47f6fa28ee15d969d5bb0ea53774d488bdaf9df1c6e0124b3ef22",
        );
        expect(Buffer.from(ciphertext).toString("hex")).toBe(
            "ce293ebd8309c257e2f2b53def1bc62ad43132a92e6e60636592cd4ad8f455e26b9402",
        );
        expect(nobleBoxOpen(ciphertext, NONCE, sender.publicKey, recipient.secretKey)).toEqual(
            MESSAGE,
        );
    });
});
