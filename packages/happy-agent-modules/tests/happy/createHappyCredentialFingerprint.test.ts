import { describe, expect, it } from "vitest";

import { createHappyCredentialFingerprint } from "../../sources/happy/credentials/createHappyCredentialFingerprint.js";
import { parseHappyCredentials } from "../../sources/happy/credentials/parseHappyCredentials.js";

const secret = Buffer.alloc(32, 3).toString("base64");

describe("createHappyCredentialFingerprint", () => {
    it("is canonical for the parsed stored credential and exposes no credential material", () => {
        const first = parseHappyCredentials({
            ignored: "first",
            secret,
            token: "happy-token",
        });
        const second = parseHappyCredentials({
            token: "happy-token",
            secret,
            ignored: "second",
        });

        const fingerprint = createHappyCredentialFingerprint(first.stored);
        expect(fingerprint).toBe(createHappyCredentialFingerprint(second.stored));
        expect(fingerprint).toMatch(/^[0-9a-f]{64}$/u);
        expect(fingerprint).not.toContain(secret);
        expect(fingerprint).not.toContain("happy-token");
    });

    it("changes when any credential-bearing field changes", () => {
        const first = parseHappyCredentials({ secret, token: "first-token" });
        const second = parseHappyCredentials({ secret, token: "second-token" });

        expect(createHappyCredentialFingerprint(first.stored)).not.toBe(
            createHappyCredentialFingerprint(second.stored),
        );
    });
});
