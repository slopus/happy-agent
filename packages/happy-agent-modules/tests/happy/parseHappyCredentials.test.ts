import { describe, expect, it } from "vitest";

import { parseHappyCredentials } from "../../sources/happy/credentials/parseHappyCredentials.js";

const machineKey = Buffer.alloc(32, 1).toString("base64");
const publicKey = Buffer.alloc(32, 2).toString("base64");
const secret = Buffer.alloc(32, 3).toString("base64");

describe("parseHappyCredentials", () => {
    it("reads a data-key account and keeps the stored form untouched", () => {
        const parsed = parseHappyCredentials({
            encryption: { machineKey, publicKey },
            token: "happy-token",
        });

        expect(parsed.credentials).toEqual({
            encryption: {
                machineKey: new Uint8Array(32).fill(1),
                publicKey: new Uint8Array(32).fill(2),
                type: "dataKey",
            },
            token: "happy-token",
        });
        expect(parsed.stored).toEqual({
            encryption: { machineKey, publicKey },
            token: "happy-token",
        });
    });

    it("reads a legacy account secret", () => {
        const parsed = parseHappyCredentials({ secret, token: "happy-token" });

        expect(parsed.credentials).toEqual({
            encryption: { secret: new Uint8Array(32).fill(3), type: "legacy" },
            token: "happy-token",
        });
        expect(parsed.stored).toEqual({ secret, token: "happy-token" });
    });

    it("ignores fields Happy added that Happy Agent does not use", () => {
        const parsed = parseHappyCredentials({
            createdAt: 12,
            secret,
            token: "happy-token",
        });

        expect(parsed.stored).toEqual({ secret, token: "happy-token" });
    });

    it("rejects a file that claims both encryption formats", () => {
        expect(() =>
            parseHappyCredentials({
                encryption: { machineKey, publicKey },
                secret,
                token: "happy-token",
            }),
        ).toThrow("exactly one encryption format");
    });

    it("rejects a file that claims neither encryption format", () => {
        expect(() => parseHappyCredentials({ token: "happy-token" })).toThrow(
            "exactly one encryption format",
        );
    });

    it("rejects a key that is not 32 base64 bytes", () => {
        expect(() =>
            parseHappyCredentials({ secret: Buffer.alloc(16, 3).toString("base64"), token: "t" }),
        ).toThrow("32-byte base64");
    });

    it("rejects a file with no token", () => {
        expect(() => parseHappyCredentials({ secret })).toThrow("format Happy Agent understands");
    });
});
