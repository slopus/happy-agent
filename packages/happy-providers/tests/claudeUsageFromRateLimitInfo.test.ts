import { describe, expect, it } from "vitest";

import { claudeUsageFromRateLimitInfo } from "@/vendors/claude/claudeUsageFromRateLimitInfo.js";

const context = { capturedAt: 1_000, providerId: "kirill_claude" };

describe("claudeUsageFromRateLimitInfo", () => {
    it("reads the five-hour window Claude reports during inference", () => {
        const usage = claudeUsageFromRateLimitInfo(
            {
                status: "allowed",
                rateLimitType: "five_hour",
                utilization: 0.15,
                resetsAt: 1_785_559_800,
            },
            context,
        );

        expect(usage).toMatchObject({
            providerId: "kirill_claude",
            capturedAt: 1_000,
            exhausted: false,
        });
        expect(usage?.windows.fiveHour).toEqual({
            usedPercent: 15,
            resetsAt: 1_785_559_800_000,
            startsAt: 1_785_559_800_000 - 5 * 60 * 60 * 1_000,
            durationMs: 5 * 60 * 60 * 1_000,
        });
        // Only the constraining window is reported, so the other stays unknown
        // rather than being reported as empty.
        expect(usage?.windows.weekly).toBeNull();
    });

    it("reads the weekly window and marks a refused account as exhausted", () => {
        const usage = claudeUsageFromRateLimitInfo(
            {
                status: "rejected",
                rateLimitType: "seven_day",
                utilization: 1,
                resetsAt: 1_785_844_800,
            },
            context,
        );

        expect(usage?.windows.weekly?.usedPercent).toBe(100);
        expect(usage?.windows.fiveHour).toBeNull();
        expect(usage?.exhausted).toBe(true);
    });

    it("keeps a refused account working when it can still spend overage", () => {
        const usage = claudeUsageFromRateLimitInfo(
            { status: "rejected", overageStatus: "allowed" },
            context,
        );

        expect(usage?.exhausted).toBe(false);
        expect(usage?.credits).toMatchObject({ available: true });
    });

    it("reports nothing when an allowed account measured nothing", () => {
        expect(claudeUsageFromRateLimitInfo({ status: "allowed" }, context)).toBeNull();
    });

    it("leaves a model-scoped limit out of the account's own windows", () => {
        const usage = claudeUsageFromRateLimitInfo(
            { status: "rejected", rateLimitType: "seven_day_opus", utilization: 1 },
            context,
        );

        expect(usage?.windows.fiveHour).toBeNull();
        expect(usage?.windows.weekly).toBeNull();
        expect(usage?.exhausted).toBe(true);
    });

    it("reads Fable's weekly allowance as its own window", () => {
        const usage = claudeUsageFromRateLimitInfo(
            {
                status: "rejected",
                // @ts-expect-error Anthropic emits this before its SDK includes it in the union.
                rateLimitType: "seven_day_fable",
                utilization: 1,
                resetsAt: 1_785_844_800,
            },
            context,
        );

        expect(usage?.windows.fableWeekly?.usedPercent).toBe(100);
        expect(usage?.windows.weekly).toBeNull();
        expect(usage?.exhausted).toBe(true);
    });
});
