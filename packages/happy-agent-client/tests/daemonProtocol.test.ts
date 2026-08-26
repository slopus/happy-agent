import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
    configPatchSchema,
    healthResponseSchema,
    providerScanResponseSchema,
    providerVerificationResponseSchema,
} from "../sources/protocol/daemon.js";

const readyHealth = {
    healthy: true,
    ready: true,
    status: "ready",
    version: { daemon: "1.2.3", protocol: 23 },
} as const;

describe("healthResponseSchema", () => {
    it("accepts protocol-23 health responses without shutdown progress", () => {
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

    it("accepts bounded structured drain progress while the daemon remains ready", () => {
        expect(
            Value.Check(healthResponseSchema, {
                ...readyHealth,
                draining: true,
                drainWaitingFor: [
                    { name: "api-mutations", count: 2 },
                    {
                        name: "agent-system",
                        count: 101,
                        agents: [
                            { id: "agentone", stage: "inference" },
                            { id: "agenttwo", stage: "tools" },
                        ],
                        truncated: true,
                    },
                    {
                        name: "auto-agent-system",
                        count: 1,
                        agents: [{ id: "reviewer", stage: "settlement" }],
                    },
                ],
            }),
        ).toBe(true);
    });
});

describe("provider control schemas", () => {
    it("accepts an explicit provider enabled override", () => {
        expect(
            Value.Check(configPatchSchema, {
                providers: { codex: { enabled: false } },
            }),
        ).toBe(true);
    });

    it("accepts a completed provider scan without credential details", () => {
        expect(
            Value.Check(providerScanResponseSchema, {
                completedAt: 1_755_400_000_000,
                providers: [
                    {
                        providerId: "codex",
                        credentials: "available",
                        remembered: true,
                        enabled: true,
                        enablement: "scan",
                    },
                ],
            }),
        ).toBe(true);
    });

    it("reports authentication verification falling back to inference", () => {
        expect(
            Value.Check(providerVerificationResponseSchema, {
                checkedAt: 1_755_400_000_000,
                modelId: "openai/gpt-5.6-luna",
                performedLevel: "inference",
                providerId: "codex",
                requestedLevel: "authentication",
                status: "passed",
            }),
        ).toBe(true);
    });
});
