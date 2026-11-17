import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
    configPatchSchema,
    daemonDrainSchema,
    drainRequestSchema,
    healthResponseSchema,
    modelDefinitionSchema,
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
    it.each([22, 23, 24, 25])("accepts additive protocol %i health responses", (protocol) => {
        expect(
            Value.Check(healthResponseSchema, {
                ...readyHealth,
                version: { ...readyHealth.version, protocol },
            }),
        ).toBe(true);
    });

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

describe("drain intent schemas", () => {
    const restart = {
        cause: "reload",
        currentVersion: "1.2.3",
        intent: "restart",
        startedAt: 1,
        targetVersion: "1.2.3",
    } as const;

    it("accepts health that says why the daemon is going away", () => {
        expect(Value.Check(healthResponseSchema, { ...readyHealth, drain: null })).toBe(true);
        expect(
            Value.Check(healthResponseSchema, { ...readyHealth, draining: true, drain: restart }),
        ).toBe(true);
        expect(
            Value.Check(daemonDrainSchema, { ...restart, targetVersion: null, cause: "signal" }),
        ).toBe(true);
    });

    it("never lets a shutdown name a target version", () => {
        expect(
            Value.Check(daemonDrainSchema, { ...restart, intent: "shutdown", cause: "stop" }),
        ).toBe(false);
        expect(
            Value.Check(daemonDrainSchema, {
                ...restart,
                cause: "stop",
                intent: "shutdown",
                targetVersion: null,
            }),
        ).toBe(true);
        expect(Value.Check(drainRequestSchema, { intent: "shutdown", targetVersion: "1" })).toBe(
            false,
        );
        expect(Value.Check(drainRequestSchema, { targetVersion: "1" })).toBe(false);
    });

    it("accepts every drain request the daemon documents and nothing else", () => {
        expect(Value.Check(drainRequestSchema, {})).toBe(true);
        expect(Value.Check(drainRequestSchema, { cause: "stop", intent: "shutdown" })).toBe(true);
        expect(
            Value.Check(drainRequestSchema, {
                cause: "update",
                intent: "restart",
                targetVersion: "1.2.4",
            }),
        ).toBe(true);
        expect(Value.Check(drainRequestSchema, { intent: "restart" })).toBe(true);
        expect(Value.Check(drainRequestSchema, { cause: "desktop" })).toBe(false);
        expect(Value.Check(drainRequestSchema, { intent: "restart", targetVersion: "" })).toBe(
            false,
        );
        expect(Value.Check(drainRequestSchema, { intent: "restart", extra: true })).toBe(false);
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

    it("explains a failed verification", () => {
        const failed = {
            checkedAt: 1_755_400_000_000,
            failure: {
                kind: "network",
                message:
                    "Couldn't connect to bedrock-runtime.us-east-1.amazonaws.com (connection refused). Check your network or proxy settings.",
            },
            modelId: "anthropic/fable-5",
            performedLevel: "inference",
            providerId: "bedrock",
            requestedLevel: "inference",
            status: "failed",
        };
        expect(Value.Check(providerVerificationResponseSchema, failed)).toBe(true);
        expect(
            Value.Check(providerVerificationResponseSchema, {
                ...failed,
                failure: { kind: "network", message: "x".repeat(501) },
            }),
        ).toBe(false);
    });
});

describe("modelDefinitionSchema", () => {
    const definition = {
        contextWindow: 1_000_000,
        defaultEffort: "medium",
        efforts: ["off", "low", "medium", "high"],
        name: "Opus 5 1M",
        serviceTiers: [],
    } as const;

    it("accepts definitions from older daemons that omit the compaction threshold", () => {
        expect(Value.Check(modelDefinitionSchema, definition)).toBe(true);
    });

    it("accepts a curated compaction threshold below the context window", () => {
        expect(
            Value.Check(modelDefinitionSchema, { ...definition, autoCompactWindow: 400_000 }),
        ).toBe(true);
    });

    it("accepts a null threshold for a model without a curated limit", () => {
        expect(
            Value.Check(modelDefinitionSchema, {
                ...definition,
                autoCompactWindow: null,
                contextWindow: null,
            }),
        ).toBe(true);
    });

    it("rejects a non-positive compaction threshold", () => {
        expect(Value.Check(modelDefinitionSchema, { ...definition, autoCompactWindow: 0 })).toBe(
            false,
        );
    });
});
