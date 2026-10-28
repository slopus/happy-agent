import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    ProviderUsageRequestError,
    type ClaudeUsageEndpointRefusal,
    type ProviderUsage,
} from "@slopus/happy-providers";
import { createRootContext, type Context } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConfigModule, type ProviderSignInObservation } from "../../sources/config/index.js";
import {
    PROVIDER_USAGE_RESET_RECHECK_DELAY_MS,
    PROVIDER_USAGE_POLL_INTERVAL_MS,
    ProviderUsageModule,
    type ProviderUsageEntry,
} from "../../sources/providerUsage/index.js";

const directories: string[] = [];
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    await Promise.all(
        directories.splice(0).map(async (directory) => {
            await rm(directory, { force: true, recursive: true });
        }),
    );
});

type ReadMethod = {
    readonly shouldProbe?: () => boolean;
    readonly skipUsageEndpoint?: boolean;
    readonly onUsageEndpointRefused?: (refusal: ClaudeUsageEndpointRefusal) => void;
};

/**
 * A module over a real configuration whose vendor reads are scripted. `sources` names the
 * accounts that have a usage API; every other configured account behaves like Bedrock.
 */
async function createHarness(options: { sources?: readonly string[]; start?: boolean } = {}) {
    const home = await mkdtemp(join(tmpdir(), "happy-provider-usage-"));
    directories.push(home);
    const config = await ConfigModule.load(home);
    const sources = new Set(options.sources ?? ["claude", "codex"]);
    vi.spyOn(config, "hasProviderUsageSource").mockImplementation((id) => sources.has(id));
    const reads: { providerId: string; method: ReadMethod | undefined }[] = [];
    let answer: (
        providerId: string,
        method: ReadMethod | undefined,
    ) => Promise<ProviderUsage | null> = async () => null;
    const load = vi
        .spyOn(config, "readProviderUsage")
        .mockImplementation(async (_ctx, providerId, method) => {
            reads.push({ providerId, method });
            return await answer(providerId, method);
        });
    let observe: ((usage: ProviderUsage) => void) | undefined;
    vi.spyOn(config, "onProviderAccountUsage").mockImplementation((listener) => {
        observe = listener;
        return () => undefined;
    });
    let observeSignIn:
        | ((providerId: string, signIn: ProviderSignInObservation) => void)
        | undefined;
    vi.spyOn(config, "onProviderSignIn").mockImplementation((listener) => {
        observeSignIn = listener;
        return () => undefined;
    });
    let credentials: "available" | "missing" = "available";
    const probe = vi
        .spyOn(config, "probeLocalProviderCredentials")
        .mockImplementation(async () => credentials);
    const module = new ProviderUsageModule(config);
    const events: ProviderUsageEntry[] = [];
    module.onChanged((entry) => events.push(entry));
    const runtime = new AbortController();
    const root = createRootContext().named("provider-usage-test");
    const ctx = Object.create(root, { lifetime: { value: runtime.signal } }) as Context;
    cleanups.push(async () => {
        runtime.abort(new Error("test finished"));
        await module.close();
    });
    if (options.start === true) module.beforeStart?.(ctx);
    return {
        ctx,
        events,
        load,
        module,
        probe,
        reads,
        entry: (providerId: string) =>
            module.list().find((entry) => entry.providerId === providerId),
        answer: (
            next: (
                providerId: string,
                method: ReadMethod | undefined,
            ) => Promise<ProviderUsage | null>,
        ) => {
            answer = next;
        },
        observe: (usage: ProviderUsage) => {
            if (observe === undefined) throw new Error("Expected an in-band usage subscription");
            observe(usage);
        },
        observeSignIn: (providerId: string, signIn: ProviderSignInObservation) => {
            if (observeSignIn === undefined) throw new Error("Expected a sign-in subscription");
            observeSignIn(providerId, signIn);
        },
        credentials: (next: "available" | "missing") => {
            credentials = next;
        },
    };
}

function reading(overrides: Partial<ProviderUsage> = {}): ProviderUsage {
    return {
        providerId: "claude",
        vendor: "claude",
        capturedAt: Date.now(),
        planName: null,
        exhausted: false,
        windows: { fiveHour: null, weekly: null, monthly: null },
        credits: null,
        ...overrides,
    };
}

function window(usedPercent: number, resetsAt: number) {
    return { usedPercent, resetsAt, startsAt: resetsAt - 18_000_000, durationMs: 18_000_000 };
}

describe("ProviderUsageModule", () => {
    it("backs off successful inference probes independently of cheap reads and menu refreshes", async () => {
        vi.useFakeTimers({ now: 1_800_000_000_000 });
        const harness = await createHarness({ sources: ["claude"], start: true });
        await vi.advanceTimersByTimeAsync(0);
        let probes = 0;
        harness.answer(async (_id, method) => {
            if (!method?.shouldProbe?.()) return null;
            probes += 1;
            return reading({
                windows: {
                    fiveHour: window(25, Date.now() + 18_000_000),
                    weekly: null,
                    monthly: null,
                },
            });
        });
        for (const delay of [
            5 * 60_000,
            40 * 60_000,
            320 * 60_000,
            PROVIDER_USAGE_POLL_INTERVAL_MS,
        ]) {
            const before = probes;
            await harness.module.refresh(harness.ctx, "claude");
            expect(probes).toBe(before + 1);
            vi.setSystemTime(Date.now() + 60_000);
            harness.module.requestRefresh(harness.ctx, {
                providerIds: ["claude"],
                olderThanMs: 60_000,
            });
            await harness.module.refresh(harness.ctx, "claude");
            expect(probes).toBe(before + 1);
            vi.setSystemTime(Date.now() + delay - 60_000);
        }
        harness.observe(
            reading({
                windows: {
                    fiveHour: window(25, Date.now() + 18_000_000),
                    weekly: null,
                    monthly: null,
                },
            }),
        );
        vi.setSystemTime(Date.now() + 60_000);
        await harness.module.refresh(harness.ctx, "claude");
        expect(probes).toBe(4);
        vi.setSystemTime(Date.now() + PROVIDER_USAGE_POLL_INTERVAL_MS - 60_000);
        await harness.module.refresh(harness.ctx, "claude");
        expect(probes).toBe(5);
        vi.setSystemTime(Date.now() + 5 * 60_000);
        await harness.module.refresh(harness.ctx, "claude");
        expect(probes).toBe(6);
    });

    it("checks in the background daily and skips accounts measured by ordinary inference within a day", async () => {
        vi.useFakeTimers({ now: 1_800_000_000_000 });
        const harness = await createHarness({ sources: ["claude"], start: true });
        await vi.advanceTimersByTimeAsync(0);
        expect(harness.load).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(23 * 60 * 60_000);
        harness.observe(
            reading({
                windows: {
                    fiveHour: window(25, Date.now() + 18_000_000),
                    weekly: null,
                    monthly: null,
                },
            }),
        );
        await vi.advanceTimersByTimeAsync(60 * 60_000);
        expect(harness.load).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(PROVIDER_USAGE_POLL_INTERVAL_MS);
        expect(harness.load).toHaveBeenCalledTimes(2);
    });
    it("keeps every provider and every normalized quota field without discarding a good reading", async () => {
        const harness = await createHarness();
        const codex: ProviderUsage = {
            providerId: "codex",
            vendor: "codex",
            capturedAt: 1_000,
            planName: "Pro",
            exhausted: false,
            windows: {
                fiveHour: { usedPercent: 11, startsAt: 100, resetsAt: 200, durationMs: 100 },
                weekly: { usedPercent: 22, startsAt: 300, resetsAt: 400, durationMs: 100 },
                monthly: { usedPercent: 33, startsAt: 500, resetsAt: 600, durationMs: 100 },
            },
            credits: { available: true, remainingCents: 1_250, unlimited: false, usedPercent: 44 },
        };
        harness.answer(async () => codex);

        expect(harness.module.list().map((entry) => entry.providerId)).toEqual([
            "bedrock",
            "claude",
            "codex",
            "grok",
        ]);
        await harness.module.refresh(harness.ctx, "codex");
        expect(harness.entry("codex")).toMatchObject({
            usage: codex,
            checkedAt: expect.any(Number),
            error: null,
            refreshedAt: expect.any(Number),
            refreshError: null,
            retryAt: null,
            refreshing: false,
        });
        // Every window carries the instant it was measured.
        expect(harness.entry("codex")?.usage?.windows.weekly?.capturedAt).toBe(1_000);
        const refreshedAt = harness.entry("codex")?.refreshedAt;

        // A failed read keeps the older reading, and now says why it could not be renewed.
        harness.answer(async () => {
            throw new Error("temporary account endpoint failure");
        });
        await harness.module.refresh(harness.ctx, "codex");
        expect(harness.entry("codex")).toMatchObject({
            usage: codex,
            error: null,
            refreshedAt,
            refreshError: "temporary account endpoint failure",
            refreshing: false,
        });

        harness.answer(async () => {
            throw new Error("first reading failed");
        });
        await harness.module.refresh(harness.ctx, "claude");
        expect(harness.entry("claude")).toMatchObject({
            usage: null,
            error: "first reading failed",
            refreshError: "first reading failed",
            refreshedAt: null,
        });

        // A later success clears the failure.
        harness.answer(async () => codex);
        await harness.module.refresh(harness.ctx, "codex");
        expect(harness.entry("codex")?.refreshError).toBeNull();
    });

    it("announces a read starting and finishing, in order, as complete entries", async () => {
        const harness = await createHarness();
        harness.answer(async () =>
            reading({
                windows: { fiveHour: window(10, Date.now() + 1e6), weekly: null, monthly: null },
            }),
        );

        await harness.module.refresh(harness.ctx, "claude");

        expect(harness.events.map((entry) => [entry.providerId, entry.refreshing])).toEqual([
            ["claude", true],
            ["claude", false],
        ]);
        expect(harness.events[1]).toMatchObject({
            usage: { windows: { fiveHour: { usedPercent: 10 } } },
            refreshedAt: expect.any(Number),
        });
    });

    it("records an account without a usage source once instead of reading it", async () => {
        const harness = await createHarness();

        await harness.module.refresh(harness.ctx, "bedrock");
        await harness.module.refresh(harness.ctx, "bedrock");

        expect(harness.load).not.toHaveBeenCalled();
        expect(harness.events).toHaveLength(1);
        expect(harness.entry("bedrock")).toMatchObject({
            usage: null,
            error: "The provider did not report account usage.",
            refreshing: false,
        });
    });

    it("takes readings a provider volunteers in band and keeps windows it stays silent about", async () => {
        const harness = await createHarness({ start: true });
        harness.answer(async () => {
            throw new Error("the account endpoint must not be consulted");
        });
        // Windows that have not reset yet, so carrying one forward is still telling the truth.
        const now = Date.now();
        const fiveHour = {
            usedPercent: 40,
            startsAt: now - 60_000,
            resetsAt: now + 60_000,
            durationMs: 120_000,
        };
        harness.observe(
            reading({
                capturedAt: now - 5_000,
                planName: "Max",
                windows: { fiveHour, weekly: null, monthly: null },
            }),
        );
        expect(harness.entry("claude")).toMatchObject({
            usage: {
                planName: "Max",
                windows: { fiveHour: { ...fiveHour, capturedAt: now - 5_000 }, weekly: null },
            },
            error: null,
        });

        // A later reading naming only the weekly window must not erase the five-hour one, and the
        // five-hour window keeps the time it was really measured.
        const weekly = {
            usedPercent: 70,
            startsAt: now - 60_000,
            resetsAt: now + 600_000,
            durationMs: 660_000,
        };
        harness.observe(
            reading({ capturedAt: now, windows: { fiveHour: null, weekly, monthly: null } }),
        );
        expect(harness.entry("claude")?.usage).toMatchObject({
            capturedAt: now,
            planName: "Max",
            windows: {
                fiveHour: { ...fiveHour, capturedAt: now - 5_000 },
                weekly: { ...weekly, capturedAt: now },
            },
        });

        // Once that five-hour window has reset, its percentage describes a period that is over.
        // Nobody has mentioned it since, so it must not keep standing in for the current one.
        vi.spyOn(Date, "now").mockReturnValue(fiveHour.resetsAt + 1);
        harness.observe(
            reading({
                capturedAt: fiveHour.resetsAt + 1,
                windows: { fiveHour: null, weekly, monthly: null },
            }),
        );
        const afterReset = harness.entry("claude")?.usage;
        expect(afterReset?.windows.fiveHour).toBeNull();
        // The weekly window has not reset, so it survives.
        expect(afterReset?.windows.weekly).toMatchObject({ usedPercent: 70 });
    });

    it("never lets a report without windows make old windows look fresh", async () => {
        const harness = await createHarness({ start: true });
        const measuredAt = Date.now() - 600_000;
        harness.observe(
            reading({
                capturedAt: measuredAt,
                windows: { fiveHour: window(20, Date.now() + 1e6), weekly: null, monthly: null },
            }),
        );
        const before = harness.entry("claude");

        // Claude reports overage alone when nothing else moved.
        harness.observe(
            reading({
                capturedAt: Date.now(),
                credits: {
                    available: false,
                    remainingCents: null,
                    unlimited: false,
                    usedPercent: null,
                },
            }),
        );

        const after = harness.entry("claude");
        expect(after?.usage?.capturedAt).toBe(measuredAt);
        expect(after?.usage?.windows.fiveHour?.capturedAt).toBe(measuredAt);
        expect(after?.usage?.credits).toMatchObject({ available: false });
        expect(after?.refreshedAt).toBe(before?.refreshedAt);
    });

    it("knows an account inference just reported spent, until its window resets", async () => {
        vi.useFakeTimers({ now: 1_800_000_000_000 });
        const harness = await createHarness({ start: true });
        await vi.advanceTimersByTimeAsync(0);
        const weeklyReset = Date.now() + 3 * 24 * 60 * 60_000;
        expect(harness.module.spentAccount("claude")).toBeUndefined();

        // The reading a rejected weekly limit produces: the spent window, over 100%.
        harness.observe(
            reading({
                exhausted: true,
                windows: { fiveHour: null, weekly: window(102, weeklyReset), monthly: null },
            }),
        );
        expect(harness.module.spentAccount("claude")).toEqual({ resetsAt: weeklyReset });
        expect(harness.module.spentAccount("codex")).toBeUndefined();

        // A stale refusal says nothing about a throttle now.
        await vi.advanceTimersByTimeAsync(16 * 60_000);
        expect(harness.module.spentAccount("claude")).toBeUndefined();

        // A refusal that names no window is dated by when inference reported it.
        harness.observe(reading({ capturedAt: Date.now() - 60 * 60_000, exhausted: true }));
        expect(harness.module.spentAccount("claude")).toEqual({ resetsAt: weeklyReset });

        harness.observe(reading({ exhausted: false }));
        expect(harness.module.spentAccount("claude")).toBeUndefined();
    });

    it("stops calling an account spent once its blocking window has reset", async () => {
        vi.useFakeTimers({ now: 1_800_000_000_000 });
        const harness = await createHarness({ start: true });
        await vi.advanceTimersByTimeAsync(0);
        const resetsAt = Date.now() + 60_000;
        harness.observe(
            reading({
                exhausted: true,
                windows: { fiveHour: window(100, resetsAt), weekly: null, monthly: null },
            }),
        );
        expect(harness.module.spentAccount("claude")).toEqual({ resetsAt });
        vi.setSystemTime(resetsAt + 1);
        expect(harness.module.spentAccount("claude")).toBeUndefined();
    });

    it("waits out a provider's own retry deadline instead of asking again", async () => {
        const harness = await createHarness();
        const retryAt = Date.now() + 2_699_000;
        harness.answer(async () => {
            throw new ProviderUsageRequestError("Claude usage returned HTTP 429.", {
                retryAt,
                status: 429,
            });
        });

        await harness.module.refresh(harness.ctx, "claude");
        expect(harness.load).toHaveBeenCalledTimes(1);
        expect(harness.entry("claude")).toMatchObject({
            retryAt,
            refreshError: "Claude usage returned HTTP 429.",
        });
        // The provider said when it would answer again, so nothing asks before then.
        await harness.module.refresh(harness.ctx, "claude");
        await harness.module.refresh(harness.ctx, "claude");
        expect(harness.load).toHaveBeenCalledTimes(1);
        expect(harness.module.requestRefresh(harness.ctx, { providerIds: ["claude"] })).toEqual([]);
    });

    it("stops asking a Claude usage endpoint that refused or throttled the account", async () => {
        const harness = await createHarness();
        const measured = reading({
            windows: { fiveHour: window(5, Date.now() + 1e6), weekly: null, monthly: null },
        });
        harness.answer(async (_id, method) => {
            if (harness.reads.length === 1) {
                method?.onUsageEndpointRefused?.({ status: 429, retryAt: Date.now() + 60_000 });
            }
            return measured;
        });

        await harness.module.refresh(harness.ctx, "claude");
        await harness.module.refresh(harness.ctx, "claude");
        vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61_000);
        await harness.module.refresh(harness.ctx, "claude");

        // Throttled: the headers answer until the endpoint's own deadline passes.
        expect(harness.reads.map((read) => read.method?.skipUsageEndpoint)).toEqual([
            false,
            true,
            false,
        ]);
        // The headers did answer, so the account itself is not waiting on anything.
        expect(harness.entry("claude")?.retryAt).toBeNull();

        harness.answer(async (_id, method) => {
            method?.onUsageEndpointRefused?.({ status: 403 });
            return measured;
        });
        await harness.module.refresh(harness.ctx, "claude");
        harness.answer(async () => measured);
        vi.spyOn(Date, "now").mockReturnValue(Date.now() + 365 * 24 * 3_600_000);
        await harness.module.refresh(harness.ctx, "claude");
        // A token the endpoint cannot read is never sent there again.
        expect(harness.reads.at(-1)?.method?.skipUsageEndpoint).toBe(true);
    });

    it("starts background reads only for stale, readable, idle accounts", async () => {
        const harness = await createHarness({ sources: ["claude", "codex", "grok"] });
        harness.answer(async (providerId) =>
            reading({
                providerId,
                windows: { fiveHour: window(1, Date.now() + 1e6), weekly: null, monthly: null },
            }),
        );
        await harness.module.refresh(harness.ctx, "codex");
        vi.spyOn(Date, "now").mockReturnValue(Date.now() + 90_000);

        // Codex is 90 seconds old: fresh for the default five minutes, stale for one minute.
        expect(harness.module.requestRefresh(harness.ctx)).toEqual(["claude", "grok"]);
        // Both are now being read, so asking again starts nothing new.
        expect(harness.module.requestRefresh(harness.ctx, { olderThanMs: 0 })).toEqual(["codex"]);
        await vi.waitFor(() => expect(harness.entry("grok")?.refreshing).toBe(false));
        await vi.waitFor(() => expect(harness.entry("codex")?.refreshing).toBe(false));
        // A demand fresher than a minute is raised to one minute.
        expect(
            harness.module.requestRefresh(harness.ctx, {
                providerIds: ["codex", "bedrock", "nope"],
                olderThanMs: 1,
            }),
        ).toEqual([]);
        expect(harness.reads.map((read) => read.providerId).sort()).toEqual([
            "claude",
            "codex",
            "codex",
            "grok",
        ]);
    });

    describe("account sign-in", () => {
        it("is unknown until a check tells, and a check that cannot tell keeps it", async () => {
            const harness = await createHarness({ start: true });
            // A read that returns nothing with the credential still there proves nothing.
            await vi.waitFor(() => expect(harness.entry("claude")?.checkedAt).not.toBeNull());
            expect(harness.probe).toHaveBeenCalledWith("claude");
            expect(harness.entry("claude")?.signIn).toBe("unknown");

            harness.answer(async () => reading());
            await harness.module.refresh(harness.ctx, "claude");
            expect(harness.entry("claude")?.signIn).toBe("signed_in");

            harness.answer(async () => {
                throw new ProviderUsageRequestError("Claude usage returned HTTP 500.", {
                    status: 500,
                });
            });
            await harness.module.refresh(harness.ctx, "claude");
            harness.answer(async () => null);
            await harness.module.refresh(harness.ctx, "claude");
            expect(harness.entry("claude")?.signIn).toBe("signed_in");
        });

        it("is signed out when a read finds no credential, and signed in after signing back in", async () => {
            const harness = await createHarness();
            harness.credentials("missing");
            await harness.module.refresh(harness.ctx, "claude");
            expect(harness.entry("claude")?.signIn).toBe("signed_out");

            harness.credentials("available");
            harness.answer(async () => reading());
            await harness.module.refresh(harness.ctx, "claude");
            expect(harness.entry("claude")?.signIn).toBe("signed_in");
        });

        it("follows inference and announces each change once", async () => {
            const harness = await createHarness({ start: true });
            await vi.waitFor(() => expect(harness.entry("codex")?.checkedAt).not.toBeNull());
            harness.events.splice(0);

            harness.observeSignIn("codex", "signed_out");
            harness.observeSignIn("codex", "signed_out");
            expect(harness.events.map((entry) => [entry.providerId, entry.signIn])).toEqual([
                ["codex", "signed_out"],
            ]);
            // An in-band reading means the vendor accepted the account again.
            harness.observe(reading({ providerId: "codex", vendor: "codex" }));
            expect(harness.entry("codex")?.signIn).toBe("signed_in");
            harness.observeSignIn("codex", "signed_in");
            expect(harness.events.map((entry) => entry.signIn)).toEqual([
                "signed_out",
                "signed_in",
            ]);
            // Accounts this installation does not have configured are not ours.
            harness.observeSignIn("elsewhere", "signed_out");
            expect(harness.entry("elsewhere")).toBeUndefined();
        });
    });

    describe("rechecking a blocked account after its reset", () => {
        async function blockedHarness() {
            vi.useFakeTimers({ now: 1_800_000_000_000 });
            const harness = await createHarness({ start: true });
            harness.answer(async () => null);
            // Let the startup poll settle so later counts are only what the recheck does.
            await vi.advanceTimersByTimeAsync(0);
            harness.load.mockClear();
            harness.reads.splice(0);
            return harness;
        }

        const blocked = (resetsAt: number) =>
            reading({
                exhausted: true,
                windows: {
                    fiveHour: window(100, resetsAt),
                    weekly: window(40, resetsAt + 1e8),
                    monthly: null,
                },
            });
        const unblocked = (resetsAt: number) =>
            reading({
                windows: {
                    fiveHour: window(3, resetsAt + 18_000_000),
                    weekly: null,
                    monthly: null,
                },
            });

        it("reads again just after the blocking window resets", async () => {
            const harness = await blockedHarness();
            const resetsAt = Date.now() + 600_000;
            harness.answer(async () => unblocked(resetsAt));
            harness.observe(blocked(resetsAt));

            await vi.advanceTimersByTimeAsync(600_000 + PROVIDER_USAGE_RESET_RECHECK_DELAY_MS - 1);
            expect(harness.load).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(1);
            expect(harness.load).toHaveBeenCalledTimes(1);
            expect(harness.entry("claude")?.usage?.exhausted).toBe(false);

            // Unblocked, nothing further is scheduled.
            await vi.advanceTimersByTimeAsync(30 * 60_000);
            expect(harness.load).toHaveBeenCalledTimes(1);
        });

        it("backs off while the account still reads blocked after its reset", async () => {
            const harness = await blockedHarness();
            const resetsAt = Date.now() + 60_000;
            harness.answer(async () => blocked(resetsAt));
            harness.observe(blocked(resetsAt));

            await vi.advanceTimersByTimeAsync(60_000 + PROVIDER_USAGE_RESET_RECHECK_DELAY_MS);
            expect(harness.load).toHaveBeenCalledTimes(1);
            await vi.advanceTimersByTimeAsync(60_000);
            expect(harness.load).toHaveBeenCalledTimes(2);
            await vi.advanceTimersByTimeAsync(119_999);
            expect(harness.load).toHaveBeenCalledTimes(2);
            await vi.advanceTimersByTimeAsync(1);
            expect(harness.load).toHaveBeenCalledTimes(3);

            // Unblocked at last: the account reads normally and the backoff ends.
            harness.answer(async () => unblocked(resetsAt));
            await vi.advanceTimersByTimeAsync(5 * 60_000);
            expect(harness.load).toHaveBeenCalledTimes(4);
            await vi.advanceTimersByTimeAsync(30 * 60_000);
            expect(harness.load).toHaveBeenCalledTimes(4);
        });

        it("drops the recheck when a newer reading shows the account working", async () => {
            const harness = await blockedHarness();
            const resetsAt = Date.now() + 600_000;
            harness.observe(blocked(resetsAt));
            harness.observe(unblocked(resetsAt));

            await vi.advanceTimersByTimeAsync(2 * 600_000);
            expect(harness.load).not.toHaveBeenCalled();
        });

        it("moves the recheck when a newer reading names another reset", async () => {
            const harness = await blockedHarness();
            const first = Date.now() + 600_000;
            harness.observe(blocked(first));
            harness.observe(blocked(first + 600_000));

            await vi.advanceTimersByTimeAsync(600_000 + PROVIDER_USAGE_RESET_RECHECK_DELAY_MS);
            expect(harness.load).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(600_000);
            expect(harness.load).toHaveBeenCalledTimes(1);
        });

        it("waits for the vendor's retry deadline when it is later than the reset", async () => {
            const harness = await blockedHarness();
            const resetsAt = Date.now() + 60_000;
            const retryAt = Date.now() + 900_000;
            harness.answer(async () => {
                throw new ProviderUsageRequestError("Claude usage returned HTTP 429.", {
                    retryAt,
                    status: 429,
                });
            });
            await harness.module.refresh(harness.ctx, "claude");
            harness.load.mockClear();
            harness.answer(async () => unblocked(resetsAt));
            harness.observe(blocked(resetsAt));

            await vi.advanceTimersByTimeAsync(899_999);
            expect(harness.load).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(1);
            expect(harness.load).toHaveBeenCalledTimes(1);
            expect(harness.entry("claude")?.usage?.exhausted).toBe(false);
        });

        it("cancels a pending recheck on close", async () => {
            const harness = await blockedHarness();
            harness.observe(blocked(Date.now() + 60_000));

            await harness.module.close();
            await vi.advanceTimersByTimeAsync(10 * 60_000);
            expect(harness.load).not.toHaveBeenCalled();
        });
    });
});
