import { describe, expect, it } from "vitest";

import { assertGymProviderEndpointAllowed } from "../sources/lifecycle/gymInference.js";

describe("Gym inference boundaries", () => {
    it.each(["http://127.0.0.1:4111/v1", "http://localhost:4111", "http://[::1]:4111"])(
        "allows a scenario-owned loopback endpoint in a deterministic gym: %s",
        (endpoint) => {
            expect(() => assertGymProviderEndpointAllowed(endpoint, false)).not.toThrow();
        },
    );

    it("rejects an external endpoint without the live inference opt-in", () => {
        expect(() => assertGymProviderEndpointAllowed("https://api.example.com/v1", false)).toThrow(
            'Non-live Gym inference cannot use external provider endpoint "https://api.example.com/v1".',
        );
    });

    it("allows an external endpoint after the live inference opt-in", () => {
        expect(() =>
            assertGymProviderEndpointAllowed("https://api.example.com/v1", true),
        ).not.toThrow();
    });
});
