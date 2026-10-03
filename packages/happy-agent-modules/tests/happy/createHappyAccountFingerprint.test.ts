import { describe, expect, it } from "vitest";

import { createHappyAccountFingerprint } from "../../sources/happy/credentials/createHappyAccountFingerprint.js";
import type { HappyCredentials } from "../../sources/happy/HappyCredentials.js";

const publicKey = Uint8Array.from(Buffer.alloc(32, 7));
const machineKey = Uint8Array.from(Buffer.alloc(32, 9));

function dataKey(token: string, key: Uint8Array = publicKey): HappyCredentials {
    return { encryption: { machineKey, publicKey: key, type: "dataKey" }, token };
}

describe("createHappyAccountFingerprint", () => {
    it("names the same account across a token change", () => {
        const before = createHappyAccountFingerprint(dataKey("first-token"), "https://api.example");
        const after = createHappyAccountFingerprint(dataKey("second-token"), "https://api.example");
        expect(after).toBe(before);
        expect(before).toMatch(/^[0-9a-f]{32}$/u);
    });

    it("names a different account for a different key pair", () => {
        const first = createHappyAccountFingerprint(dataKey("token"), "https://api.example");
        const second = createHappyAccountFingerprint(
            dataKey("token", Uint8Array.from(Buffer.alloc(32, 8))),
            "https://api.example",
        );
        expect(second).not.toBe(first);
    });

    it("reads one server however it is spelled, and another server as another account", () => {
        const credentials = dataKey("token");
        const plain = createHappyAccountFingerprint(credentials, "https://api.example");
        expect(createHappyAccountFingerprint(credentials, "https://api.example/")).toBe(plain);
        expect(createHappyAccountFingerprint(credentials, "https://API.example:443")).toBe(plain);
        expect(createHappyAccountFingerprint(credentials, "https://other.example")).not.toBe(plain);
    });

    it("keys a legacy account by its secret, apart from any data-key account", () => {
        const secret = Uint8Array.from(Buffer.alloc(32, 7));
        const legacy: HappyCredentials = { encryption: { secret, type: "legacy" }, token: "t" };
        const fingerprint = createHappyAccountFingerprint(legacy, "https://api.example");
        expect(fingerprint).toBe(
            createHappyAccountFingerprint({ ...legacy, token: "other" }, "https://api.example"),
        );
        // The same bytes under a different scheme are not the same account.
        expect(fingerprint).not.toBe(
            createHappyAccountFingerprint(dataKey("t", secret), "https://api.example"),
        );
    });
});
