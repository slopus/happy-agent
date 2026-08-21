import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ProviderUsage } from "@slopus/happy-providers";
import { createRootContext } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConfigModule } from "../../sources/config/index.js";
import { ProviderUsageModule } from "../../sources/providerUsage/index.js";

const directories: string[] = [];

afterEach(async () => {
    await Promise.all(
        directories.splice(0).map(async (directory) => {
            await rm(directory, { force: true, recursive: true });
        }),
    );
});

describe("ProviderUsageModule", () => {
    it("keeps every provider and every normalized quota field without discarding a good reading", async () => {
        const home = await mkdtemp(join(tmpdir(), "happy-provider-usage-"));
        directories.push(home);
        const config = await ConfigModule.load(home);
        const reading: ProviderUsage = {
            providerId: "codex",
            vendor: "codex",
            capturedAt: 1_000,
            planName: "Pro",
            exhausted: false,
            windows: {
                fiveHour: {
                    usedPercent: 11,
                    startsAt: 100,
                    resetsAt: 200,
                    durationMs: 100,
                },
                weekly: {
                    usedPercent: 22,
                    startsAt: 300,
                    resetsAt: 400,
                    durationMs: 100,
                },
                monthly: {
                    usedPercent: 33,
                    startsAt: 500,
                    resetsAt: 600,
                    durationMs: 100,
                },
            },
            credits: {
                available: true,
                remainingCents: 1_250,
                unlimited: false,
                usedPercent: 44,
            },
        };
        const load = vi.spyOn(config, "readProviderUsage").mockResolvedValue(reading);
        const module = new ProviderUsageModule(config);
        const ctx = createRootContext().named("provider-usage-test");

        expect(module.list().map((entry) => entry.providerId)).toEqual([
            "bedrock",
            "claude",
            "codex",
            "grok",
        ]);
        await module.refresh(ctx, "codex");
        expect(module.list().find((entry) => entry.providerId === "codex")).toMatchObject({
            providerId: "codex",
            usage: reading,
            checkedAt: expect.any(Number),
            error: null,
        });

        load.mockRejectedValueOnce(new Error("temporary account endpoint failure"));
        await module.refresh(ctx, "codex");
        expect(module.list().find((entry) => entry.providerId === "codex")).toMatchObject({
            usage: reading,
            checkedAt: expect.any(Number),
            error: null,
        });

        load.mockRejectedValueOnce(new Error("first reading failed"));
        await module.refresh(ctx, "claude");
        expect(module.list().find((entry) => entry.providerId === "claude")).toMatchObject({
            usage: null,
            checkedAt: expect.any(Number),
            error: "first reading failed",
        });
    });
});
