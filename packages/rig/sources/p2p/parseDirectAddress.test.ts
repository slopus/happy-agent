import { describe, expect, it } from "vitest";

import { formatDirectAddress, parseDirectAddress } from "./parseDirectAddress.js";

describe("direct P2P addresses", () => {
    it("parses hostnames and bracketed IPv6 addresses", () => {
        expect(parseDirectAddress("rig.example:7443")).toEqual({
            host: "rig.example",
            port: 7443,
        });
        const ipv6 = parseDirectAddress("[::1]:7443");
        expect(ipv6).toEqual({ host: "::1", port: 7443 });
        expect(formatDirectAddress(ipv6)).toBe("[::1]:7443");
    });

    it.each(["rig.example", "::1:7443", "rig.example:0", "rig.example:65536"])(
        "rejects malformed address %s",
        (address) => {
            expect(() => parseDirectAddress(address)).toThrow("direct P2P address");
        },
    );
});
