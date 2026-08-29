import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ProviderUsageRequestError, type ProviderUsage } from "@slopus/happy-providers";
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

    it("takes readings a provider volunteers in band and keeps windows it stays silent about", async () => {
        const home = await mkdtemp(join(tmpdir(), "happy-provider-usage-inband-"));
        directories.push(home);
        const config = await ConfigModule.load(home);
        const module = new ProviderUsageModule(config);
        // The polling loops belong to this lifetime, so ending it is what lets close() return.
        const runtime = new AbortController();
        const root = createRootContext().named("provider-usage-in-band-test");
        const ctx = Object.create(root, {
            lifetime: { value: runtime.signal },
        }) as typeof root;
        // Never ask the account endpoint: the point is that inference alone measures the account.
        // The in-band reading must stand on its own, so the account endpoint never answers here.
        vi.spyOn(config, "readProviderUsage").mockRejectedValue(
            new Error("the account endpoint must not be consulted"),
        );
        // Whatever the module subscribes with is what a real Claude session drives.
        let observe: ((usage: ProviderUsage) => void) | undefined;
        vi.spyOn(config, "onProviderAccountUsage").mockImplementation((listener) => {
            observe = listener;
            return () => undefined;
        });
        module.beforeStart?.(ctx);
        if (observe === undefined) throw new Error("Expected an in-band usage subscription");

        // Windows that have not reset yet, so carrying one forward is still telling the truth.
        const now = Date.now();
        const fiveHour = {
            usedPercent: 40,
            startsAt: now - 60_000,
            resetsAt: now + 60_000,
            durationMs: 120_000,
        };
        observe({
            providerId: "claude",
            vendor: "claude",
            capturedAt: now,
            planName: "Max",
            exhausted: false,
            windows: { fiveHour, weekly: null, monthly: null },
            credits: null,
        });
        expect(module.list().find((entry) => entry.providerId === "claude")).toMatchObject({
            usage: { planName: "Max", windows: { fiveHour, weekly: null } },
            error: null,
        });

        // A later reading naming only the weekly window must not erase the five-hour one.
        const weekly = {
            usedPercent: 70,
            startsAt: now - 60_000,
            resetsAt: now + 600_000,
            durationMs: 660_000,
        };
        observe({
            providerId: "claude",
            vendor: "claude",
            capturedAt: now,
            planName: null,
            exhausted: false,
            windows: { fiveHour: null, weekly, monthly: null },
            credits: null,
        });
        expect(module.list().find((entry) => entry.providerId === "claude")?.usage).toMatchObject({
            planName: "Max",
            windows: { fiveHour, weekly },
        });
        // Once that five-hour window has reset, its percentage describes a period that is over.
        // Nobody has mentioned it since, so it must not keep standing in for the current one.
        vi.spyOn(Date, "now").mockReturnValue(fiveHour.resetsAt + 1);
        observe({
            providerId: "claude",
            vendor: "claude",
            capturedAt: fiveHour.resetsAt + 1,
            planName: null,
            exhausted: false,
            windows: { fiveHour: null, weekly, monthly: null },
            credits: null,
        });
        const afterReset = module.list().find((entry) => entry.providerId === "claude")?.usage;
        expect(afterReset?.windows.fiveHour).toBeNull();
        // The weekly window has not reset, so it survives.
        expect(afterReset?.windows.weekly).toMatchObject({ usedPercent: 70 });
        vi.mocked(Date.now).mockRestore();

        runtime.abort(new Error("test finished"));
        await module.close();
    });

    it("waits out a provider's own retry deadline instead of asking again", async () => {
        const home = await mkdtemp(join(tmpdir(), "happy-provider-usage-retry-"));
        directories.push(home);
        const config = await ConfigModule.load(home);
        const module = new ProviderUsageModule(config);
        const ctx = createRootContext().named("provider-usage-retry-test");
        const load = vi.spyOn(config, "readProviderUsage").mockRejectedValue(
            new ProviderUsageRequestError("Claude usage returned HTTP 429.", {
                retryAt: Date.now() + 2_699_000,
                status: 429,
            }),
        );

        await module.refresh(ctx, "claude");
        expect(load).toHaveBeenCalledTimes(1);
        // The provider said when it would answer again, so nothing asks before then.
        await module.refresh(ctx, "claude");
        await module.refresh(ctx, "claude");
        expect(load).toHaveBeenCalledTimes(1);
    });
});
