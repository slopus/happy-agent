import type { ProviderQuota, ProviderQuotaSource, ProviderUsage } from "@slopus/happy-providers";
import { describe, expect, it, vi } from "vitest";

import { createProviderQuotaService } from "./createProviderQuotaService.js";

describe("createProviderQuotaService", () => {
    it("caches Codex quota while it stays fresh", async () => {
        let now = 1_000;
        const loadCodexQuota = vi.fn(async () => quota("codex", now, 30, 10));
        const service = createProviderQuotaService({
            loadCodexQuota,
            now: () => now,
        });

        await expect(service.get("codex")).resolves.toMatchObject({
            windows: {
                fiveHour: { usedPercent: 30 },
                weekly: { usedPercent: 10 },
            },
        });
        now += 1;
        await service.get("codex");

        expect(loadCodexQuota).toHaveBeenCalledTimes(1);
        await expect(service.get("gym")).resolves.toBeUndefined();
    });

    it("derives named Claude quota from the shared account usage source", async () => {
        const loadClaudeUsage = vi.fn(
            async (providerId: string): Promise<ProviderUsage> => ({
                providerId,
                vendor: "claude",
                capturedAt: 1_000,
                planName: "Max",
                exhausted: false,
                windows: {
                    fiveHour: {
                        durationMs: 5 * 60 * 60 * 1_000,
                        resetsAt: 10_000,
                        startsAt: 1,
                        usedPercent: 40,
                    },
                    weekly: {
                        durationMs: 7 * 24 * 60 * 60 * 1_000,
                        resetsAt: 20_000,
                        startsAt: 2,
                        usedPercent: 20,
                    },
                    monthly: null,
                },
                credits: null,
            }),
        );
        const service = createProviderQuotaService({
            loadClaudeUsage,
            providers: {
                kirill_claude: {
                    enabled: true,
                    type: "claude",
                },
            },
        });

        await expect(service.get("kirill_claude")).resolves.toEqual({
            capturedAt: 1_000,
            source: "claude",
            windows: {
                fiveHour: {
                    capturedAt: 1_000,
                    durationMs: 5 * 60 * 60 * 1_000,
                    resetsAt: 10_000,
                    status: "available",
                    usedPercent: 40,
                },
                weekly: {
                    capturedAt: 1_000,
                    durationMs: 7 * 24 * 60 * 60 * 1_000,
                    resetsAt: 20_000,
                    status: "available",
                    usedPercent: 20,
                },
            },
        });
        expect(loadClaudeUsage).toHaveBeenCalledWith("kirill_claude");
    });
});

function quota(
    source: ProviderQuotaSource,
    capturedAt: number,
    fiveHourUsed: number,
    weeklyUsed: number,
): ProviderQuota {
    return {
        capturedAt,
        source,
        windows: {
            fiveHour: {
                capturedAt,
                resetsAt: 10_000,
                status: "available",
                usedPercent: fiveHourUsed,
            },
            weekly: {
                capturedAt,
                resetsAt: 20_000,
                status: "available",
                usedPercent: weeklyUsed,
            },
        },
    };
}
