import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { compactionBlockSchema } from "../sources/protocol/messages.js";

const base = {
    type: "compaction",
    trigger: "manual",
    tokensBefore: 201_000,
    startedAt: 1_755_400_000_000,
} as const;

describe("compaction message protocol", () => {
    it("describes a running compaction without inferring from agent status", () => {
        expect(
            Value.Check(compactionBlockSchema, {
                ...base,
                status: "running",
                tokensAfter: null,
                failureReason: null,
                completedAt: null,
            }),
        ).toBe(true);
    });

    it("describes a completed automatic compaction inside its service message", () => {
        expect(
            Value.Check(compactionBlockSchema, {
                ...base,
                trigger: "automatic",
                status: "completed",
                tokensAfter: 45_000,
                failureReason: null,
                completedAt: 1_755_400_001_000,
            }),
        ).toBe(true);
    });

    it("requires a terminal timestamp and meaningful reason for failure", () => {
        const failed = {
            ...base,
            status: "failed",
            tokensAfter: null,
            failureReason: "The provider could not compact the context.",
            completedAt: 1_755_400_001_000,
        };
        expect(Value.Check(compactionBlockSchema, failed)).toBe(true);
        expect(Value.Check(compactionBlockSchema, { ...failed, failureReason: null })).toBe(false);
    });
});
