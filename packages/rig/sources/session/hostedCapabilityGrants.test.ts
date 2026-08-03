import { describe, expect, it } from "vitest";

import {
    assertGrantIsNarrowing,
    canSpawnWithCapabilities,
    grantableCapabilities,
} from "./hostedCapabilityGrants.js";

describe("grantableCapabilities", () => {
    it("lets an unrestricted agent that holds nothing grant every capability", () => {
        expect(grantableCapabilities({ held: [], permissionMode: "auto" })).toEqual([
            "web_search",
            "x_search",
        ]);
        expect(grantableCapabilities({ held: [], permissionMode: "full_access" })).toEqual([
            "web_search",
            "x_search",
        ]);
    });

    it("grants nothing from a mode that cannot reach outside the sandbox itself", () => {
        expect(grantableCapabilities({ held: [], permissionMode: "read_only" })).toEqual([]);
        expect(grantableCapabilities({ held: [], permissionMode: "workspace_write" })).toEqual([]);
    });

    it("grants nothing from an agent that already holds a capability", () => {
        expect(
            grantableCapabilities({ held: ["x_search"], permissionMode: "full_access" }),
        ).toEqual([]);
    });
});

describe("canSpawnWithCapabilities", () => {
    it("stops an agent holding an uninterceptable capability from spawning", () => {
        expect(canSpawnWithCapabilities([])).toBe(true);
        expect(canSpawnWithCapabilities(["x_search"])).toBe(false);
    });
});

describe("assertGrantIsNarrowing", () => {
    it("allows a subset", () => {
        expect(() =>
            assertGrantIsNarrowing({
                grantable: ["web_search", "x_search"],
                requested: ["x_search"],
            }),
        ).not.toThrow();
    });

    it("ignores a spawn that asks for nothing", () => {
        expect(() => assertGrantIsNarrowing({ grantable: [], requested: [] })).not.toThrow();
    });

    it("names what it refused rather than silently narrowing", () => {
        expect(() =>
            assertGrantIsNarrowing({ grantable: ["web_search"], requested: ["x_search"] }),
        ).toThrow(/cannot grant x_search.*may grant web_search/su);
    });

    it("explains why an agent that can grant nothing refused", () => {
        expect(() => assertGrantIsNarrowing({ grantable: [], requested: ["x_search"] })).toThrow(
            /holds none itself and is in Auto or Full access/u,
        );
    });
});
