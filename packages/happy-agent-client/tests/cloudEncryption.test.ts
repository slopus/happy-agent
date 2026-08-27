import { describe, expect, it } from "vitest";

import {
    CLOUD_GENERATED_SECRET_SEED_BYTES,
    deriveCloudKeys,
    normalizeCloudPassword,
    parseCloudGeneratedSecret,
    stringifyCloudGeneratedSecret,
} from "../sources/cloudEncryption.js";

describe("Cloud encryption", () => {
    it("normalizes equivalent Unicode passwords after trimming", () => {
        expect(normalizeCloudPassword(" \tÅngström \n")).toBe("Ångström");
        expect(normalizeCloudPassword(" ①Ａ ")).toBe("1A");
        expect(() => normalizeCloudPassword("   \n")).toThrow("must not be empty");
    });

    it("stringifies and parses the generated factor canonically", () => {
        const seed = Uint8Array.from({ length: CLOUD_GENERATED_SECRET_SEED_BYTES }, (_, i) => i);
        const generatedSecret = stringifyCloudGeneratedSecret(seed);

        expect(generatedSecret).toBe("H1-222A5-AS7TZ-QRFS4-BJ48X-Q4S7SN");
        expect(parseCloudGeneratedSecret(generatedSecret)).toEqual(seed);
    });

    it("rejects malformed, non-canonical, and out-of-range generated factors", () => {
        expect(() => stringifyCloudGeneratedSecret(new Uint8Array(15))).toThrow("exactly 16 bytes");
        expect(() => parseCloudGeneratedSecret("h1-22ah8-ey9a2-7xghv-q6mrv-8rqypx")).toThrow(
            "canonical H1",
        );
        expect(() => parseCloudGeneratedSecret("H1-ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZZ")).toThrow(
            "outside the H1 value range",
        );
    });

    it("derives stable and domain-separated API keys", async () => {
        const generatedSecret = stringifyCloudGeneratedSecret(
            Uint8Array.from({ length: CLOUD_GENERATED_SECRET_SEED_BYTES }, (_, i) => i),
        );
        const first = await deriveCloudKeys(generatedSecret, "  Ångström  ");
        const equivalent = await deriveCloudKeys(generatedSecret, "Ångström");
        const differentPassword = await deriveCloudKeys(generatedSecret, "different password");
        const differentGeneratedSecret = await deriveCloudKeys(
            stringifyCloudGeneratedSecret(
                new Uint8Array(CLOUD_GENERATED_SECRET_SEED_BYTES).fill(1),
            ),
            "Ångström",
        );

        expect(first).toEqual(equivalent);
        expect(first).toEqual({
            authHash: "QxLuf1l-hpmqeyVPrbAQg5tZwS8ow9IS37TpLq4KaiQ",
            encryptionKey: "bucaWxgxGyTaHQAWa-wdzDkdZ3I91xof_yexbhwyOVU",
        });
        expect(first.authHash).not.toBe(first.encryptionKey);
        expect(differentPassword).not.toEqual(first);
        expect(differentGeneratedSecret).not.toEqual(first);
    });
});
