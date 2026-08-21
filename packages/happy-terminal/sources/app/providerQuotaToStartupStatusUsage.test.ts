import { describe, expect, it } from "vitest";

import type { ProviderQuota } from "@slopus/happy-providers";
import { providerQuotaToStartupStatusUsage } from "./providerQuotaToStartupStatusUsage.js";

describe("providerQuotaToStartupStatusUsage", () => {
    it("maps independent available windows with clamped remaining quota and reset text", () => {
        expect(
            providerQuotaToStartupStatusUsage(
                quota({
                    fiveHour: {
                        capturedAt: 1_000,
                        resetsAt: 1_000 + (2 * 60 + 14) * 60_000,
                        status: "available",
                        usedPercent: -4,
                    },
                    weekly: {
                        capturedAt: 2_000,
                        resetsAt: 1_000 + (4 * 24 + 6) * 60 * 60_000,
                        status: "available",
                        usedPercent: 116,
                    },
                }),
                1_000,
            ),
        ).toEqual({
            fiveHour: { capturedAt: 1_000, percentLeft: 100, resetsIn: "2h 14m" },
            weekly: { capturedAt: 2_000, percentLeft: 0, resetsIn: "4d 6h" },
        });
    });

    it("preserves a partial window and omits unavailable quota", () => {
        expect(
            providerQuotaToStartupStatusUsage(
                quota({
                    fiveHour: {
                        capturedAt: 3_000,
                        resetsAt: 3_000,
                        status: "available",
                        usedPercent: 59,
                    },
                    weekly: { status: "unavailable" },
                }),
                3_000,
            ),
        ).toEqual({ fiveHour: { capturedAt: 3_000, percentLeft: 41, resetsIn: "now" } });
        expect(
            providerQuotaToStartupStatusUsage(
                quota({
                    fiveHour: { status: "unavailable" },
                    weekly: { status: "unavailable" },
                }),
            ),
        ).toBeUndefined();
        expect(providerQuotaToStartupStatusUsage(undefined)).toBeUndefined();
    });

    it("rounds fractional remaining quota without exposing floating-point tails", () => {
        expect(
            providerQuotaToStartupStatusUsage(
                quota({
                    fiveHour: {
                        capturedAt: 1_000,
                        resetsAt: 2_000,
                        status: "available",
                        usedPercent: 99.8,
                    },
                }),
                1_000,
            ),
        ).toEqual({ fiveHour: { capturedAt: 1_000, percentLeft: 0.2, resetsIn: "1s" } });
    });
});

function quota(windows: ProviderQuota["windows"]): ProviderQuota {
    return { capturedAt: 1_000, source: "codex", windows };
}
