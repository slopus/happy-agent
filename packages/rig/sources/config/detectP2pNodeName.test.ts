import { describe, expect, it, vi } from "vitest";

import { detectP2pNodeName } from "./detectP2pNodeName.js";

describe("detectP2pNodeName", () => {
    it("prefers the friendly macOS computer name", () => {
        const hostname = vi.fn(() => "steves-mac.local");

        expect(
            detectP2pNodeName({
                hostname,
                platform: "darwin",
                readMacComputerName: () => "Steve’s MacBook Pro 🛠️\n",
            }),
        ).toBe("Steve’s MacBook Pro 🛠️");
        expect(hostname).not.toHaveBeenCalled();
    });

    it("falls back to the hostname when macOS cannot provide a valid computer name", () => {
        expect(
            detectP2pNodeName({
                hostname: () => "steves-mac.local",
                platform: "darwin",
                readMacComputerName: () => {
                    throw new Error("scutil is unavailable");
                },
            }),
        ).toBe("steves-mac.local");
    });

    it("uses the hostname directly on other platforms", () => {
        const readMacComputerName = vi.fn(() => "Wrong machine");

        expect(
            detectP2pNodeName({
                hostname: () => "build-linux",
                platform: "linux",
                readMacComputerName,
            }),
        ).toBe("build-linux");
        expect(readMacComputerName).not.toHaveBeenCalled();
    });

    it("uses a stable human-readable fallback when detected names are invalid", () => {
        expect(
            detectP2pNodeName({
                hostname: () => "\u0000",
                platform: "darwin",
                readMacComputerName: () => "bad\nname",
            }),
        ).toBe("Rig");
    });
});
