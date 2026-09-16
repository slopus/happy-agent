import { describe, expect, it } from "vitest";

import type { Usage } from "../protocol/index.js";

import {
    contextRemaining,
    formatContextLine,
    formatSessionTokenStatus,
} from "./formatSessionTokenStatus.js";

const usage: Usage = {
    cacheRead: 0,
    cacheWrite: 0,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
    input: 0,
    output: 0,
    totalTokens: 0,
};

describe("contextRemaining", () => {
    it("counts down to the compaction threshold when the daemon publishes one", () => {
        expect(
            contextRemaining({
                autoCompactWindow: 400_000,
                contextTokens: 300_000,
                contextWindow: 1_000_000,
            }),
        ).toEqual({ percentLeft: 25, untilCompaction: true });
    });

    it("falls back to the hard window for daemons without a threshold", () => {
        expect(contextRemaining({ contextTokens: 300_000, contextWindow: 1_000_000 })).toEqual({
            percentLeft: 70,
            untilCompaction: false,
        });
    });

    it("reaches zero at the compaction point instead of going negative", () => {
        expect(
            contextRemaining({
                autoCompactWindow: 400_000,
                contextTokens: 412_000,
                contextWindow: 1_000_000,
            }),
        ).toEqual({ percentLeft: 0, untilCompaction: true });
    });

    it("has nothing to say without any limit", () => {
        expect(contextRemaining({ contextTokens: 300_000 })).toBeUndefined();
    });
});

describe("formatSessionTokenStatus", () => {
    it("labels the countdown by what it measures", () => {
        expect(
            formatSessionTokenStatus({
                autoCompactWindow: 400_000,
                contextTokens: 100_000,
                contextWindow: 1_000_000,
                usage,
            }),
        ).toMatch(/75% until auto-compact$/u);
        expect(
            formatSessionTokenStatus({ contextTokens: 100_000, contextWindow: 1_000_000, usage }),
        ).toMatch(/90% ctx left$/u);
    });

    it("warns only once the remaining context is low", () => {
        const warn = (text: string): string => `<warn>${text}</warn>`;
        expect(
            formatSessionTokenStatus({
                autoCompactWindow: 400_000,
                contextTokens: 320_000,
                contextWindow: 1_000_000,
                usage,
                warn,
            }),
        ).toMatch(/<warn>20% until auto-compact<\/warn>$/u);
        expect(
            formatSessionTokenStatus({
                autoCompactWindow: 400_000,
                contextTokens: 300_000,
                contextWindow: 1_000_000,
                usage,
                warn,
            }),
        ).toMatch(/[^>]25% until auto-compact$/u);
    });
});

describe("formatContextLine", () => {
    it("reports occupancy against the threshold and names the hard window", () => {
        expect(
            formatContextLine(120_000, { autoCompactWindow: 400_000, contextWindow: 1_000_000 }),
        ).toBe("Context: 120k / 400k · 70% until auto-compact (window 1m)");
    });

    it("reports against the hard window when no threshold is published", () => {
        expect(formatContextLine(120_000, { contextWindow: 1_000_000 })).toBe(
            "Context: 120k / 1m · 88% ctx left",
        );
    });

    it("reports bare occupancy for a model without limits", () => {
        expect(formatContextLine(120_000, {})).toBe("Context: 120k");
    });
});
