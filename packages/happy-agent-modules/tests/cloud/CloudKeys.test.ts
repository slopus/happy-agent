import { describe, expect, it } from "vitest";

import {
    CloudKeyMaterialError,
    createCloudKeyBundle,
    deriveCloudIdentityKey,
    openCloudKeyBundle,
} from "../../sources/cloud/CloudKeys.js";

const key = (byte: number): string => Buffer.alloc(32, byte).toString("base64url");

describe("Cloud key bundles", () => {
    it("round-trips one authenticated root and derives a stable public identity", async () => {
        const created = await createCloudKeyBundle(key(1));
        const opened = await openCloudKeyBundle(created.bundle, key(1));

        expect(opened).toEqual({
            identityKey: created.identityKey,
            rootSecret: created.rootSecret,
        });
        expect(deriveCloudIdentityKey(opened.rootSecret)).toBe(created.identityKey);
        expect(created.identityKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(created.bundle).not.toContain(created.rootSecret);
    });

    it("rejects a wrong encryption key and authenticated-bundle tampering", async () => {
        const created = await createCloudKeyBundle(key(2));
        const envelope = JSON.parse(created.bundle) as { ciphertext: string };
        envelope.ciphertext = `${envelope.ciphertext.slice(0, -1)}${
            envelope.ciphertext.endsWith("A") ? "B" : "A"
        }`;

        await expect(openCloudKeyBundle(created.bundle, key(3))).rejects.toBeInstanceOf(
            CloudKeyMaterialError,
        );
        await expect(openCloudKeyBundle(JSON.stringify(envelope), key(2))).rejects.toBeInstanceOf(
            CloudKeyMaterialError,
        );
    });

    it("requires canonical, exactly 32-byte key material", async () => {
        await expect(createCloudKeyBundle("A".repeat(42))).rejects.toBeInstanceOf(
            CloudKeyMaterialError,
        );
        await expect(createCloudKeyBundle(`${key(4)}=`)).rejects.toBeInstanceOf(
            CloudKeyMaterialError,
        );
    });
});
