import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, expectTypeOf, it } from "vitest";

import {
    desktopBootstrapResponseSchema,
    type DesktopBootstrapResponse,
} from "../sources/protocol/bootstrap.js";
import { healthResponseSchema, type HealthResponse } from "../sources/protocol/daemon.js";

const schema = Type.Pick(desktopBootstrapResponseSchema, ["health"]);
const health: HealthResponse = {
    healthy: true,
    ready: true,
    status: "ready",
    version: { protocol: 31, daemon: "2026.11.1" },
    capabilities: { feed: true, search: true, webSocketTunnels: true },
};

describe("desktop bootstrap health", () => {
    it("reuses the complete health response as an optional field", () => {
        expectTypeOf<DesktopBootstrapResponse["health"]>().toEqualTypeOf<
            HealthResponse | undefined
        >();
        expect(schema.properties.health).toEqual(Type.Optional(healthResponseSchema));
        expect(Value.Check(schema, {})).toBe(true);
        expect(Value.Check(schema, { health })).toBe(true);
    });

    it.each([
        null,
        { ...health, version: { ...health.version, protocol: "31" } },
        { ...health, capabilities: { feed: "yes" } },
    ])("rejects malformed health %j", (health) => {
        expect(Value.Check(schema, { health })).toBe(false);
    });
});
