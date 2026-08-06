import { describe, expect, it } from "vitest";

import { endpointUrl } from "@/endpointUrl.js";

describe("endpointUrl", () => {
    it("keeps endpoint and request query parameters without rewriting them", () => {
        expect(
            endpointUrl(
                "https://connector.test/capability/rig?tenant=acme&signature=one%20two",
                "events/live?after=cursor%2Fone",
            ),
        ).toBe(
            "https://connector.test/capability/rig/events/live?after=cursor%2Fone&tenant=acme&signature=one%20two",
        );
    });

    it("keeps a P2P peer API prefix for ordinary requests and live streams", () => {
        const endpoint = "https://local.rig/p2p/peers/aremoteinstance0000000001/api";
        expect(endpointUrl(endpoint, "health")).toBe(
            "https://local.rig/p2p/peers/aremoteinstance0000000001/api/health",
        );
        expect(endpointUrl(endpoint, "events/live?after=cursor")).toBe(
            "https://local.rig/p2p/peers/aremoteinstance0000000001/api/events/live?after=cursor",
        );
    });
});
