import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { healthResponseSchema } from "../sources/protocol/daemon.js";

const readyHealth = {
    healthy: true,
    ready: true,
    status: "ready",
    version: { daemon: "1.2.3", protocol: 22 },
} as const;

describe("healthResponseSchema", () => {
    it("accepts protocol-22 health responses without shutdown progress", () => {
        expect(Value.Check(healthResponseSchema, readyHealth)).toBe(true);
    });

    it("accepts graceful-shutdown progress while the daemon remains ready", () => {
        expect(
            Value.Check(healthResponseSchema, {
                ...readyHealth,
                shuttingDown: true,
                waitingFor: ["agent-system", "main-database"],
            }),
        ).toBe(true);
    });
});