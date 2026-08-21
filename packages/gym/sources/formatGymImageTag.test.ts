import { describe, expect, it } from "vitest";

import { formatGymImageTag } from "./formatGymImageTag.js";

describe("formatGymImageTag", () => {
    it("uses a stable runtime dependency fingerprint", () => {
        expect(formatGymImageTag("ABC123def4567890fedcba")).toBe(
            "happy-terminal-gym:runtime-ABC123def4567890",
        );
    });

    it("rejects an empty fingerprint", () => {
        expect(() => formatGymImageTag("")).toThrow("Gym runtime fingerprint must contain a hash.");
    });
});
