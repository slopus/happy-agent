import { describe, expect, it } from "vitest";

import { EventsModule } from "../../sources/events/EventsModule.js";
import type { UsageInferenceRecord } from "../../sources/usage/Usage.js";
import { UsageModule } from "../../sources/usage/UsageModule.js";
import { UsageDatabase } from "../../sources/usage/impl/usageDatabase.js";
import { isTimeZone, offsetAt, offsetSegments } from "../../sources/usage/impl/localCalendar.js";
import { moduleDatabase, type ModuleDatabase } from "../support/moduleDatabase.js";

const HOUR = 60 * 60 * 1_000;
const DAY = 24 * HOUR;

async function withUsage<T>(
    name: string,
    callback: (database: ModuleDatabase, usage: UsageModule) => Promise<T>,
): Promise<T> {
    const events = new EventsModule();
    const database = moduleDatabase(events.migrations, name);
    await database.ready;
    const usage = new UsageModule(events);
    try {
        for (const [, migration] of usage.migrations) {
            await migration(database.context, database.database);
        }
        return await callback(database, usage);
    } finally {
        database.close();
    }
}

const store = new UsageDatabase();
let sequence = 0;

function inference(
    startedAt: number,
    input: number,
    provider = "codex",
    model = "openai/gpt-5.6-sol",
): UsageInferenceRecord {
    sequence += 1;
    return {
        id: `record-${sequence}`,
        agentId: "agent-1",
        runId: "run-1",
        kind: "inference",
        state: "normal",
        provider,
        model,
        startedAt,
        finishedAt: startedAt + 1_000,
        durationMs: 1_000,
        tokens: { input, output: 1, cacheRead: 2, cacheWrite: 3 },
    };
}

describe("daily usage", () => {
    it("lists only days that spent tokens, by provider and model, and the first day ever", async () => {
        await withUsage("usage-daily-basic", async (database, usage) => {
            const ctx = database.context;
            const now = Date.UTC(2026, 10, 11, 15, 30);
            await store.record(ctx, inference(Date.UTC(2024, 0, 5, 9), 7));
            await store.record(ctx, inference(Date.UTC(2026, 10, 9, 1), 10));
            await store.record(ctx, inference(Date.UTC(2026, 10, 9, 23, 59), 5));
            await store.record(
                ctx,
                inference(Date.UTC(2026, 10, 9, 12), 4, "claude-work", "anthropic/opus-5-5"),
            );
            await store.record(ctx, inference(Date.UTC(2026, 10, 11, 15, 10), 20));

            const daily = await usage.readDailyUsage(ctx, { days: 7, timeZone: "UTC" }, now);

            expect(daily).toEqual({
                days: [
                    {
                        date: "2026-11-09",
                        byProvider: {
                            "claude-work": {
                                "anthropic/opus-5-5": {
                                    input: 4,
                                    output: 1,
                                    cacheRead: 2,
                                    cacheWrite: 3,
                                },
                            },
                            codex: {
                                "openai/gpt-5.6-sol": {
                                    input: 15,
                                    output: 2,
                                    cacheRead: 4,
                                    cacheWrite: 6,
                                },
                            },
                        },
                    },
                    {
                        date: "2026-11-11",
                        byProvider: {
                            codex: {
                                "openai/gpt-5.6-sol": {
                                    input: 20,
                                    output: 1,
                                    cacheRead: 2,
                                    cacheWrite: 3,
                                },
                            },
                        },
                    },
                ],
                since: "2024-01-05",
            });
        });
    });

    it("reports no days and no first day before anything was spent", async () => {
        await withUsage("usage-daily-empty", async (database, usage) => {
            const daily = await usage.readDailyUsage(database.context, {
                days: 365,
                timeZone: "Europe/Berlin",
            });
            expect(daily).toEqual({ days: [], since: null });
        });
    });

    it("buckets hours into the requested zone's days across daylight-saving changes", async () => {
        await withUsage("usage-daily-dst", async (database, usage) => {
            const ctx = database.context;
            // Berlin left summer time at 01:00 UTC on 2026-10-25.
            const now = Date.UTC(2026, 9, 27, 12);
            // 22:00 UTC is midnight in summer (UTC+2) and 23:00 in winter (UTC+1).
            await store.record(ctx, inference(Date.UTC(2026, 9, 23, 22), 1));
            await store.record(ctx, inference(Date.UTC(2026, 9, 25, 22), 2));
            await store.record(ctx, inference(Date.UTC(2026, 9, 25, 23), 3));

            const berlin = await usage.readDailyUsage(
                ctx,
                { days: 10, timeZone: "Europe/Berlin" },
                now,
            );
            expect(
                berlin.days.map((day) => [
                    day.date,
                    day.byProvider["codex"]?.["openai/gpt-5.6-sol"]?.input,
                ]),
            ).toEqual([
                ["2026-10-24", 1],
                ["2026-10-25", 2],
                ["2026-10-26", 3],
            ]);
            expect(berlin.since).toBe("2026-10-24");

            const utc = await usage.readDailyUsage(ctx, { days: 10, timeZone: "UTC" }, now);
            expect(utc.days.map((day) => day.date)).toEqual(["2026-10-23", "2026-10-25"]);
        });
    });

    it("keeps hours outside the requested days out, in zones far from UTC", async () => {
        await withUsage("usage-daily-range", async (database, usage) => {
            const ctx = database.context;
            const now = Date.UTC(2026, 10, 10, 12);
            // 2026-11-09 11:00 UTC is already 2026-11-10 in Kiritimati (UTC+14), where now is
            // 2026-11-11, and still 2026-11-09 in Honolulu (UTC-10), where now is 2026-11-10.
            await store.record(ctx, inference(Date.UTC(2026, 10, 9, 11), 1));
            await store.record(ctx, inference(Date.UTC(2026, 10, 9, 9), 2));

            const kiritimati = await usage.readDailyUsage(
                ctx,
                { days: 2, timeZone: "Pacific/Kiritimati" },
                now,
            );
            expect(kiritimati.days.map((day) => day.date)).toEqual(["2026-11-10"]);
            expect(kiritimati.since).toBe("2026-11-09");

            const honolulu = await usage.readDailyUsage(
                ctx,
                { days: 1, timeZone: "Pacific/Honolulu" },
                now,
            );
            expect(honolulu.days).toEqual([]);
        });
    });

    it("refuses an unknown zone, an offset, and an unbounded range", async () => {
        await withUsage("usage-daily-invalid", async (database, usage) => {
            expect(usage.isDailyUsageQuery({ days: 365, timeZone: "UTC" })).toBe(true);
            expect(usage.isDailyUsageQuery({ days: 1_096, timeZone: "Asia/Kolkata" })).toBe(true);
            for (const query of [
                { days: 0, timeZone: "UTC" },
                { days: 1_097, timeZone: "UTC" },
                { days: Number.NaN, timeZone: "UTC" },
                { days: 30, timeZone: "Mars/Olympus" },
                { days: 30, timeZone: "+05:00" },
                { days: 30, timeZone: "" },
            ]) {
                expect(usage.isDailyUsageQuery(query)).toBe(false);
                await expect(usage.readDailyUsage(database.context, query)).rejects.toThrow(
                    "Daily usage query is invalid.",
                );
            }
        });
    });
});

describe("local calendar", () => {
    it("knows zones and refuses offsets", () => {
        expect(isTimeZone("Europe/Berlin")).toBe(true);
        expect(isTimeZone("America/Argentina/Buenos_Aires")).toBe(true);
        expect(isTimeZone("Etc/GMT+5")).toBe(true);
        expect(isTimeZone("Nowhere/Special")).toBe(false);
        expect(isTimeZone("-03:00")).toBe(false);
    });

    it("finds the exact hour of every offset change over three years", () => {
        const from = Date.UTC(2024, 0, 1);
        const to = Date.UTC(2026, 11, 31);
        for (const zone of ["Europe/Berlin", "America/New_York", "Australia/Lord_Howe", "UTC"]) {
            const segments = offsetSegments(zone, from, to);
            for (const [index, segment] of segments.entries()) {
                expect(offsetAt(zone, segment.start)).toBe(segment.offsetMs);
                if (index > 0) {
                    expect(offsetAt(zone, segment.start - HOUR)).not.toBe(segment.offsetMs);
                }
            }
            // Every hour in between uses its run's offset.
            for (let hour = from; hour <= to; hour += 7 * HOUR) {
                const run = segments.findLast((segment) => segment.start <= hour);
                expect(offsetAt(zone, hour)).toBe(run?.offsetMs);
            }
            expect(segments.length).toBe(zone === "UTC" ? 1 : 7);
        }
        expect(offsetAt("Asia/Kolkata", Date.UTC(2026, 0, 1))).toBe(5.5 * HOUR);
        expect(DAY).toBe(86_400_000);
    });
});
