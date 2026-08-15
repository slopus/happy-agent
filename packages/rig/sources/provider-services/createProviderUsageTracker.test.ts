import type { ProviderUsage } from "@slopus/happy-providers";
import { describe, expect, it, vi } from "vitest";

import { delay, gracefulShutdown } from "../concurrency/index.js";
import { createProviderUsageTracker } from "./createProviderUsageTracker.js";

function usage(providerId: string, usedPercent: number): ProviderUsage {
    return {
        providerId,
        vendor: "codex",
        capturedAt: 1_000,
        planName: "Pro",
        exhausted: false,
        windows: {
            fiveHour: null,
            weekly: { usedPercent, resetsAt: null, startsAt: null, durationMs: null },
            monthly: null,
        },
        credits: null,
    };
}

describe("createProviderUsageTracker", () => {
    it("lists every provider before anything has been read", () => {
        const shutdown = gracefulShutdown();
        const tracker = createProviderUsageTracker({
            loadUsage: () => Promise.resolve(null),
            providerIds: ["codex", "claude"],
            shutdown,
        });

        expect(tracker.all()).toEqual([
            { providerId: "codex", usage: null, checkedAt: null, error: null },
            { providerId: "claude", usage: null, checkedAt: null, error: null },
        ]);
    });

    it("stores a reading and when it was taken", async () => {
        const shutdown = gracefulShutdown();
        const tracker = createProviderUsageTracker({
            loadUsage: (providerId) => Promise.resolve(usage(providerId, 42)),
            now: () => 5_000,
            providerIds: ["codex"],
            shutdown,
        });

        await tracker.refresh("codex");

        expect(tracker.get("codex")?.usage?.windows.weekly?.usedPercent).toBe(42);
        expect(tracker.get("codex")?.checkedAt).toBe(5_000);
        expect(tracker.get("codex")?.error).toBeNull();
    });

    it("keeps the previous reading visible when a provider stops answering", async () => {
        const shutdown = gracefulShutdown();
        let answer: ProviderUsage | null = usage("codex", 10);
        const tracker = createProviderUsageTracker({
            loadUsage: () => Promise.resolve(answer),
            providerIds: ["codex"],
            shutdown,
        });

        await tracker.refresh("codex");
        answer = null;
        await tracker.refresh("codex");

        // The stale reading is still the best thing we know, and it carries its
        // own capture time so a reader can judge it.
        expect(tracker.get("codex")?.usage?.windows.weekly?.usedPercent).toBe(10);
        expect(tracker.get("codex")?.error).toBeNull();
    });

    it("keeps the previous reading visible while reporting a refresh failure", async () => {
        const shutdown = gracefulShutdown();
        const onError = vi.fn();
        const loadUsage = vi
            .fn<() => Promise<ProviderUsage | null>>()
            .mockResolvedValueOnce(usage("claude", 10))
            .mockRejectedValueOnce(new Error("Claude usage returned HTTP 429."));
        const tracker = createProviderUsageTracker({
            loadUsage,
            onError,
            providerIds: ["claude"],
            shutdown,
        });

        await tracker.refresh("claude");
        await tracker.refresh("claude");

        expect(tracker.get("claude")?.usage?.windows.weekly?.usedPercent).toBe(10);
        expect(tracker.get("claude")?.error).toBeNull();
        expect(onError).toHaveBeenCalledWith(
            "claude",
            expect.objectContaining({ message: "Claude usage returned HTTP 429." }),
        );
    });

    it("records a thrown failure without losing the entry", async () => {
        const shutdown = gracefulShutdown();
        const onError = vi.fn();
        const tracker = createProviderUsageTracker({
            loadUsage: () => Promise.reject(new Error("network is down")),
            onError,
            providerIds: ["grok"],
            shutdown,
        });

        await tracker.refresh("grok");

        expect(tracker.get("grok")?.error).toBe("network is down");
        expect(onError).toHaveBeenCalledOnce();
    });

    it("runs only one read per provider when refresh overlaps polling", async () => {
        const shutdown = gracefulShutdown();
        let calls = 0;
        let active = 0;
        let maximumActive = 0;
        let releaseFirst!: () => void;
        const firstCanFinish = new Promise<void>((resolve) => {
            releaseFirst = resolve;
        });
        const tracker = createProviderUsageTracker({
            loadUsage: async (providerId) => {
                calls += 1;
                active += 1;
                maximumActive = Math.max(maximumActive, active);
                if (calls === 1) await firstCanFinish;
                active -= 1;
                return usage(providerId, calls);
            },
            providerIds: ["codex"],
            shutdown,
        });

        const first = tracker.refresh("codex");
        await vi.waitFor(() => expect(calls).toBe(1));
        const second = tracker.refresh("codex");
        await Promise.resolve();

        expect(calls).toBe(1);
        releaseFirst();
        await Promise.all([first, second]);

        expect(calls).toBe(2);
        expect(maximumActive).toBe(1);
        expect(tracker.get("codex")?.usage?.windows.weekly?.usedPercent).toBe(2);
    });

    it("polls every provider in parallel and keeps polling on a schedule", async () => {
        const shutdown = gracefulShutdown();
        const calls: string[] = [];
        const tracker = createProviderUsageTracker({
            intervalMs: 5,
            loadUsage: (providerId) => {
                calls.push(providerId);
                return Promise.resolve(usage(providerId, 1));
            },
            providerIds: ["codex", "claude"],
            shutdown,
        });

        tracker.start();
        await delay(30);
        await shutdown.shutdown();

        expect(calls.filter((id) => id === "codex").length).toBeGreaterThan(1);
        expect(calls.filter((id) => id === "claude").length).toBeGreaterThan(1);
    });

    it("stops polling when the daemon shuts down", async () => {
        const shutdown = gracefulShutdown();
        let calls = 0;
        const tracker = createProviderUsageTracker({
            intervalMs: 1,
            loadUsage: () => {
                calls += 1;
                return Promise.resolve(null);
            },
            providerIds: ["codex"],
            shutdown,
        });

        tracker.start();
        await delay(20);
        const report = await shutdown.shutdown();
        const afterShutdown = calls;
        await delay(20);

        expect(report.timedOut).toEqual([]);
        expect(calls).toBe(afterShutdown);
    });

    it("registers each loop under a name that identifies the provider", async () => {
        const shutdown = gracefulShutdown();
        const register = vi.spyOn(shutdown, "register");
        const tracker = createProviderUsageTracker({
            intervalMs: 1_000,
            loadUsage: () => Promise.resolve(null),
            providerIds: ["kirill_claude"],
            shutdown,
        });

        tracker.start();
        await shutdown.shutdown();

        expect(register).toHaveBeenCalledWith("provider-usage:kirill_claude", expect.any(Function));
    });

    it("starts only once", async () => {
        const shutdown = gracefulShutdown();
        const register = vi.spyOn(shutdown, "register");
        const tracker = createProviderUsageTracker({
            intervalMs: 1_000,
            loadUsage: () => Promise.resolve(null),
            providerIds: ["codex"],
            shutdown,
        });

        tracker.start();
        tracker.start();
        await shutdown.shutdown();

        expect(register).toHaveBeenCalledOnce();
    });

    it("ignores a provider it does not track", async () => {
        const shutdown = gracefulShutdown();
        const tracker = createProviderUsageTracker({
            loadUsage: () => Promise.resolve(null),
            providerIds: ["codex"],
            shutdown,
        });

        await expect(tracker.refresh("unknown")).resolves.toBeUndefined();
    });
});
