import {
    AgentKV,
    AgentStorage,
    type AgentBaseSystemNotificationBoundary,
    type AgentModuleScope,
    type AgentSystemRef,
} from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TasksModule } from "../../sources/tasks/index.js";
import {
    TeamAuthenticationError,
    TeamModule,
    withTeamUser,
    type TeamUser,
} from "../../sources/team/index.js";
import {
    MAX_USER_DEVICES,
    UserEnvironmentError,
    UserEnvironmentModule,
    type UserEnvironmentReport,
} from "../../sources/userEnvironment/index.js";
import { moduleDatabase } from "../support/moduleDatabase.js";
import { resolveModuleHooks } from "../support/moduleHooks.js";
import { testProfileModule } from "../support/testProfileModule.js";

const ALICE = "alice0000000000000000001";
const BOB = "bob00000000000000000000002";
/** Tuesday, November 10, 2026, 09:30 UTC. */
const NOW = Date.UTC(2026, 10, 10, 9, 30);
const DAY = 24 * 60 * 60 * 1000;

const cleanup: (() => void)[] = [];

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
});

afterEach(() => {
    vi.useRealTimers();
    for (const close of cleanup.splice(0)) close();
});

const inference: AgentBaseSystemNotificationBoundary = {
    type: "inference",
    inference: {
        loopId: "loop",
        turnId: "turn",
        inferenceId: "inference",
        contextTokens: undefined,
    },
};

/** A message the person sent, from `deviceId` when given, or a message no device sent. */
function message(deviceId?: unknown): AgentBaseSystemNotificationBoundary {
    return {
        type: "message",
        accepted: {
            id: "message123",
            kind: "send",
            profile: null,
            message: { role: "user", content: [{ type: "text", text: "Hello" }] },
            metadata: {
                messageOrigin: "user",
                ...(deviceId === undefined ? {} : { deviceId: deviceId as never }),
            },
        },
    };
}

/**
 * Alice owns `alice-task` and its subtask `alice-subtask`; Bob owns `bob-task`. `shared-bot` is a
 * bot, which in team mode belongs to nobody in particular.
 */
const PARENTS = new Map<string, string | null>([
    ["alice-task", null],
    ["alice-subtask", "alice-task"],
    ["bob-task", null],
    ["shared-bot", null],
]);
const TASK_OWNERS = new Map([
    ["alice-task", ALICE],
    ["bob-task", BOB],
]);

const LAPTOP = { deviceId: "laptop" } as const;

const BERLIN: UserEnvironmentReport = {
    ...LAPTOP,
    timeZone: "Europe/Berlin",
    utcOffsetMinutes: 60,
    locale: "de-DE",
    languages: ["de-DE", "en-US"],
    hourCycle: "h23",
    firstDayOfWeek: 1,
    calendar: "gregory",
};

async function setup(teamEnabled: boolean) {
    const team = createTeam(teamEnabled);
    const tasks = {
        forAgent: async (_ctx: Context, agentId: string) =>
            TASK_OWNERS.has(agentId) ? { ownerUserId: TASK_OWNERS.get(agentId) } : undefined,
    } as unknown as TasksModule;
    const agents = {
        parentOf: async (_ctx: Context, agentId: string) => PARENTS.get(agentId) ?? null,
    } as unknown as AgentSystemRef;
    const environment = new UserEnvironmentModule(team, tasks);
    const database = moduleDatabase(environment.migrations, "user-environment");
    cleanup.push(database.close);
    await database.ready;
    const storage = new AgentStorage({
        database: database.database,
        acquireLock: async () => ({ release: async () => {} }),
    });
    await storage.migrate(database.context, []);
    const scope = (id: string): AgentModuleScope => {
        const persistence = storage.persistence(id);
        return {
            agent: {
                id,
                provider: "scripted",
                providerKind: "gym",
                model: undefined,
                effort: undefined,
                tier: undefined,
                permissionMode: "full_access",
                metadata: undefined,
            },
            kv: new AgentKV(persistence, "userEnvironment.agent."),
            historyKV: new AgentKV(persistence, "userEnvironment.history."),
            runKV: new AgentKV(persistence, "userEnvironment.run."),
            sharedKV: storage.kv.scoped("userEnvironment"),
        };
    };
    /** Resolve a fresh module over the same database, as a restarted daemon would. */
    const start = async () => {
        const module = new UserEnvironmentModule(team, tasks);
        const hooks = await resolveModuleHooks(database.context, module, agents);
        const turn = async (
            agentId: string,
            boundary: AgentBaseSystemNotificationBoundary = message(),
        ): Promise<string | undefined> => {
            const notices = await storage.transaction(
                database.context,
                async (ctx) =>
                    await hooks.systemNotificationsTransact?.(ctx, scope(agentId), boundary),
            );
            if (notices === undefined) return undefined;
            expect(notices).toHaveLength(1);
            const block = notices[0]?.content[0];
            if (block?.type !== "text") throw new Error("The notice is not one text block.");
            return block.text;
        };
        return { module, hooks, turn };
    };
    return { environment, database, storage, scope, start };
}

describe("User environment reports", () => {
    it("merges a device's reports into its record and keeps what a report leaves out", async () => {
        const { environment, database } = await setup(false);
        const ctx = database.context;

        expect(await environment.environment(ctx)).toBeUndefined();
        expect(
            await environment.report(ctx, {
                ...LAPTOP,
                deviceKind: "desktop",
                timeZone: "Europe/Berlin",
            }),
        ).toEqual({
            deviceId: "laptop",
            deviceKind: "desktop",
            environment: { timeZone: "Europe/Berlin" },
            updatedAt: NOW,
            reportedAt: NOW,
            changed: ["timeZone"],
        });
        vi.setSystemTime(NOW + 1_000);
        expect(
            await environment.report(ctx, {
                ...LAPTOP,
                languages: ["de-de", "en-US"],
                hourCycle: "h23",
            }),
        ).toEqual({
            deviceId: "laptop",
            deviceKind: "desktop",
            environment: {
                timeZone: "Europe/Berlin",
                languages: ["de-DE", "en-US"],
                hourCycle: "h23",
            },
            updatedAt: NOW + 1_000,
            reportedAt: NOW + 1_000,
            changed: ["language", "hourCycle"],
        });
        // The advisory offset is accepted but never stored.
        vi.setSystemTime(NOW + 2_000);
        expect(
            await environment.report(ctx, {
                ...LAPTOP,
                timeZone: "Europe/Berlin",
                utcOffsetMinutes: 60,
                firstDayOfWeek: 1,
                calendar: "gregory",
                locale: "de-de",
            }),
        ).toMatchObject({ updatedAt: NOW + 2_000, changed: ["firstDayOfWeek", "calendar"] });
        expect(await environment.environment(ctx)).toEqual({
            deviceId: "laptop",
            deviceKind: "desktop",
            environment: {
                timeZone: "Europe/Berlin",
                locale: "de-DE",
                languages: ["de-DE", "en-US"],
                hourCycle: "h23",
                firstDayOfWeek: 1,
                calendar: "gregory",
            },
            updatedAt: NOW + 2_000,
            reportedAt: NOW + 2_000,
        });
    });

    it("counts every report as the device being seen, even one that changes nothing", async () => {
        const { environment, database } = await setup(false);
        const ctx = database.context;
        await environment.report(ctx, BERLIN);

        vi.setSystemTime(NOW + DAY);
        expect(await environment.report(ctx, LAPTOP)).toMatchObject({
            updatedAt: NOW,
            reportedAt: NOW + DAY,
            changed: [],
        });
        expect(await environment.report(ctx, BERLIN)).toMatchObject({
            updatedAt: NOW,
            reportedAt: NOW + DAY,
            changed: [],
        });
    });

    it("counts only the zone, primary language, clock, week, and calendar as changes", async () => {
        const { environment, database } = await setup(false);
        const ctx = database.context;
        await environment.report(ctx, BERLIN);

        vi.setSystemTime(NOW + 1_000);
        // Another letter case or link of the stored zone keeps the stored name and changes nothing.
        expect(
            await environment.report(ctx, { ...LAPTOP, timeZone: "europe/berlin" }),
        ).toMatchObject({
            environment: { timeZone: "Europe/Berlin" },
            updatedAt: NOW,
            changed: [],
        });
        // Secondary languages and the formatting locale are kept but are not the primary language.
        expect(
            await environment.report(ctx, {
                ...LAPTOP,
                languages: ["de-DE", "fr-FR", "en-US"],
                locale: "en-GB",
            }),
        ).toMatchObject({
            environment: { languages: ["de-DE", "fr-FR", "en-US"], locale: "en-GB" },
            updatedAt: NOW + 1_000,
            changed: [],
        });
        expect(
            await environment.report(ctx, { ...LAPTOP, languages: ["en-US", "de-DE"] }),
        ).toMatchObject({ changed: ["language"] });
        expect(
            await environment.report(ctx, {
                ...LAPTOP,
                timeZone: "Asia/Kolkata",
                hourCycle: "h12",
            }),
        ).toMatchObject({ changed: ["timeZone", "hourCycle"] });
        expect(
            await environment.report(ctx, { ...LAPTOP, timeZone: "Asia/Calcutta" }),
        ).toMatchObject({ environment: { timeZone: "Asia/Kolkata" }, changed: [] });
    });

    it.each([
        ["Asia/Calcutta", "Asia/Kolkata"],
        ["Europe/Kiev", "Europe/Kyiv"],
        ["America/Buenos_Aires", "America/Argentina/Buenos_Aires"],
        ["UTC", "Etc/UTC"],
    ])("treats %s and %s as one zone on every runtime", async (legacy, current) => {
        const { environment, database } = await setup(false);
        const ctx = database.context;
        await environment.report(ctx, { ...LAPTOP, timeZone: legacy });
        expect(await environment.report(ctx, { ...LAPTOP, timeZone: current })).toMatchObject({
            environment: { timeZone: legacy },
            changed: [],
        });
        await environment.report(ctx, { ...LAPTOP, timeZone: "Europe/Paris" });
        await environment.report(ctx, { ...LAPTOP, timeZone: current });
        expect(await environment.report(ctx, { ...LAPTOP, timeZone: legacy })).toMatchObject({
            environment: { timeZone: current },
            changed: [],
        });
    });

    it("stores a time zone in its canonical letter case, never swapped for a legacy name", async () => {
        const { environment, database } = await setup(false);
        const ctx = database.context;
        for (const [index, [sent, stored]] of [
            ["europe/berlin", "Europe/Berlin"],
            ["AMERICA/ARGENTINA/BUENOS_AIRES", "America/Argentina/Buenos_Aires"],
            ["asia/kolkata", "Asia/Kolkata"],
            ["asia/calcutta", "Asia/Calcutta"],
            ["etc/utc", "Etc/UTC"],
        ].entries() as Iterable<[number, [string, string]]>) {
            await environment.report(ctx, { deviceId: `device-${index}`, timeZone: sent });
            expect((await environment.environment(ctx, `device-${index}`))?.environment).toEqual({
                timeZone: stored,
            });
        }
    });

    it("takes the formatting locale as the language while no languages are known", async () => {
        const { environment, database } = await setup(false);
        const ctx = database.context;
        await environment.report(ctx, { ...LAPTOP, locale: "en-US" });

        expect(await environment.report(ctx, { ...LAPTOP, locale: "de-DE" })).toMatchObject({
            changed: ["language"],
        });
        expect(await environment.report(ctx, { ...LAPTOP, languages: ["de-DE"] })).toMatchObject({
            changed: [],
        });
    });

    it.each([
        ["no device", { timeZone: "Europe/Paris" }, "invalid"],
        ["a malformed device", { deviceId: "my laptop", timeZone: "Europe/Paris" }, "invalid"],
        ["an unknown device kind", { ...LAPTOP, deviceKind: "watch" }, "invalid"],
        ["an unknown time zone", { ...LAPTOP, timeZone: "Mars/Olympus" }, "not a time zone"],
        ["a malformed locale", { ...LAPTOP, locale: "not a locale" }, "not a BCP 47"],
        ["a malformed language", { ...LAPTOP, languages: ["de-DE", "??"] }, "not a BCP 47"],
        ["no languages", { ...LAPTOP, languages: [] }, "invalid"],
        ["an unknown hour cycle", { ...LAPTOP, hourCycle: "h13" }, "invalid"],
        ["a day before Monday", { ...LAPTOP, firstDayOfWeek: 0 }, "invalid"],
        ["a day after Sunday", { ...LAPTOP, firstDayOfWeek: 8 }, "invalid"],
        ["a fractional day", { ...LAPTOP, firstDayOfWeek: 1.5 }, "invalid"],
        ["an unknown calendar", { ...LAPTOP, calendar: "gregorian" }, "invalid"],
        ["an offset beyond UTC+14", { ...LAPTOP, utcOffsetMinutes: 900 }, "invalid"],
        ["an unknown field", { ...LAPTOP, country: "DE" }, "invalid"],
    ])("refuses %s and stores nothing", async (_name, report, text) => {
        const { environment, database } = await setup(false);
        const ctx = database.context;
        await environment.report(ctx, { ...LAPTOP, timeZone: "Europe/Berlin" });

        vi.setSystemTime(NOW + 1_000);
        const refused = environment.report(ctx, report as never);
        await expect(refused).rejects.toThrow(UserEnvironmentError);
        await expect(refused).rejects.toThrow(text);
        expect(await environment.environment(ctx)).toEqual({
            deviceId: "laptop",
            environment: { timeZone: "Europe/Berlin" },
            updatedAt: NOW,
            reportedAt: NOW,
        });
    });

    it("accepts every BCP 47 calendar, including those Bun's ICU leaves out", async () => {
        const { environment, database } = await setup(false);
        for (const calendar of ["islamic", "islamic-rgsa", "japanese", "iso8601"] as const) {
            await environment.report(database.context, { ...LAPTOP, calendar });
            expect((await environment.environment(database.context))?.environment).toEqual({
                calendar,
            });
        }
    });

    it("keeps each team member's devices apart and refuses a report without a member", async () => {
        const { environment, database } = await setup(true);
        const alice = member(database.context, ALICE);
        const bob = member(database.context, BOB);

        // The same device ID names a different device for each person.
        await environment.report(alice, { ...LAPTOP, timeZone: "Europe/Berlin" });
        await environment.report(bob, { ...LAPTOP, timeZone: "America/New_York" });

        expect((await environment.environment(alice, "laptop"))?.environment).toEqual({
            timeZone: "Europe/Berlin",
        });
        expect((await environment.environment(bob, "laptop"))?.environment).toEqual({
            timeZone: "America/New_York",
        });
        await expect(
            environment.report(database.context, { ...LAPTOP, timeZone: "Asia/Tokyo" }),
        ).rejects.toThrow(TeamAuthenticationError);
    });
});

describe("User environment events", () => {
    it("announces every accepted report after it commits, and nothing refused or rolled back", async () => {
        const { environment, database } = await setup(true);
        const alice = member(database.context, ALICE);
        const events: unknown[] = [];
        const stop = environment.onEvent((_ctx, event) => {
            events.push(event);
        });

        await environment.report(alice, { ...LAPTOP, timeZone: "Europe/Berlin" });
        // A report that changes nothing still says the device was seen.
        vi.setSystemTime(NOW + 1_000);
        await environment.report(alice, LAPTOP);
        await expect(
            environment.report(alice, { ...LAPTOP, hourCycle: "h13" } as never),
        ).rejects.toThrow(UserEnvironmentError);
        await expect(
            alice.inTx(async (txCtx) => {
                await environment.report(txCtx, { ...LAPTOP, timeZone: "Asia/Tokyo" });
                throw new Error("The caller's change failed.");
            }),
        ).rejects.toThrow("caller's change failed");

        expect(events).toEqual([
            {
                owner: ALICE,
                device: {
                    deviceId: "laptop",
                    environment: { timeZone: "Europe/Berlin" },
                    updatedAt: NOW,
                    reportedAt: NOW,
                },
            },
            {
                owner: ALICE,
                device: {
                    deviceId: "laptop",
                    environment: { timeZone: "Europe/Berlin" },
                    updatedAt: NOW,
                    reportedAt: NOW + 1_000,
                },
            },
        ]);
        expect((await environment.environment(alice))?.environment).toEqual({
            timeZone: "Europe/Berlin",
        });
        stop();
        await environment.report(alice, LAPTOP);
        expect(events).toHaveLength(2);
    });

    it("counts a new device kind as a change", async () => {
        const { environment, database } = await setup(false);
        await environment.report(database.context, { ...LAPTOP, timeZone: "Europe/Berlin" });
        vi.setSystemTime(NOW + 1_000);
        expect(
            await environment.report(database.context, { ...LAPTOP, deviceKind: "desktop" }),
        ).toMatchObject({ deviceKind: "desktop", updatedAt: NOW + 1_000, changed: [] });
    });
});

describe("User environment devices", () => {
    it("keeps each device's record apart so devices never overwrite each other", async () => {
        const { environment, database } = await setup(false);
        const ctx = database.context;
        await environment.report(ctx, { ...BERLIN, deviceKind: "desktop" });
        vi.setSystemTime(NOW + 1_000);
        await environment.report(ctx, {
            deviceId: "phone",
            deviceKind: "phone",
            timeZone: "America/New_York",
            hourCycle: "h12",
        });
        vi.setSystemTime(NOW + 2_000);
        await environment.report(ctx, { ...LAPTOP, calendar: "iso8601" });

        expect(await environment.environment(ctx, "phone")).toEqual({
            deviceId: "phone",
            deviceKind: "phone",
            environment: { timeZone: "America/New_York", hourCycle: "h12" },
            updatedAt: NOW + 1_000,
            reportedAt: NOW + 1_000,
        });
        expect(await environment.environment(ctx, "laptop")).toMatchObject({
            deviceKind: "desktop",
            environment: { timeZone: "Europe/Berlin", hourCycle: "h23", calendar: "iso8601" },
        });
        // A report that leaves the kind out keeps the device's kind.
        expect(await environment.report(ctx, { deviceId: "phone" })).toMatchObject({
            deviceKind: "phone",
        });
    });

    it("uses the environment of the device a message came from", async () => {
        const { environment, database, start } = await setup(false);
        const { turn } = await start();
        const ctx = database.context;
        await environment.report(ctx, {
            ...LAPTOP,
            deviceKind: "desktop",
            timeZone: "Europe/Berlin",
        });
        vi.setSystemTime(NOW + 1_000);
        await environment.report(ctx, {
            deviceId: "phone",
            deviceKind: "phone",
            timeZone: "America/New_York",
        });

        expect(await turn("agent", message("laptop"))).toBe(
            "User environment (computer): time zone Europe/Berlin (UTC+1). Their local time is now Tuesday 2026-11-10 10:30.",
        );
        expect(await turn("agent", message("phone"))).toBe(
            "The user is now on their phone. The user's time zone changed from Europe/Berlin to America/New_York (UTC-5). Their local time is now Tuesday 2026-11-10 04:30.",
        );
        expect(await turn("agent", message("phone"))).toBeUndefined();
        expect(await turn("agent", message("laptop"))).toBe(
            "The user is now on their computer. The user's time zone changed from America/New_York to Europe/Berlin (UTC+1). Their local time is now Tuesday 2026-11-10 10:30.",
        );
    });

    it("says nothing when the person moves between devices that agree", async () => {
        const { environment, database, start } = await setup(false);
        const { turn } = await start();
        const ctx = database.context;
        await environment.report(ctx, { ...BERLIN, deviceKind: "desktop" });
        // The phone shares what the agent is told, though its secondary languages differ.
        await environment.report(ctx, {
            ...BERLIN,
            deviceId: "phone",
            deviceKind: "phone",
            languages: ["de-DE", "fr-FR"],
        });
        expect(await turn("agent", message("laptop"))).toContain("User environment (computer)");

        expect(await turn("agent", message("phone"))).toBeUndefined();
        expect(await turn("agent", message("laptop"))).toBeUndefined();
        expect(await turn("agent", message("phone"))).toBeUndefined();

        // A change on the device the person is already on does not claim they moved.
        await environment.report(ctx, { deviceId: "phone", timeZone: "Europe/Paris" });
        expect(await turn("agent", message("phone"))).toBe(
            "The user's time zone changed from Europe/Berlin to Europe/Paris (UTC+1). Their local time is now Tuesday 2026-11-10 10:30.",
        );
    });

    it("names no device it does not know the kind of", async () => {
        const { environment, database, start } = await setup(false);
        const { turn } = await start();
        const ctx = database.context;
        await environment.report(ctx, { ...LAPTOP, timeZone: "Europe/Berlin" });
        await environment.report(ctx, { deviceId: "other", timeZone: "Asia/Tokyo" });

        expect(await turn("agent", message("laptop"))).toBe(
            "User environment: time zone Europe/Berlin (UTC+1). Their local time is now Tuesday 2026-11-10 10:30.",
        );
        expect(await turn("agent", message("other"))).toBe(
            "The user's time zone changed from Europe/Berlin to Asia/Tokyo (UTC+9). Their local time is now Tuesday 2026-11-10 18:30.",
        );
    });

    it("falls back to the device that reported most recently for a message from no device", async () => {
        const { environment, database, start } = await setup(false);
        const { turn } = await start();
        const ctx = database.context;
        await environment.report(ctx, {
            ...LAPTOP,
            deviceKind: "desktop",
            timeZone: "Europe/Berlin",
        });
        vi.setSystemTime(NOW + 1_000);
        await environment.report(ctx, {
            deviceId: "phone",
            deviceKind: "phone",
            timeZone: "America/New_York",
        });

        expect(await turn("agent")).toContain(
            "User environment (phone): time zone America/New_York",
        );
        // An unknown or malformed device is no device.
        expect(await turn("agent", message("tablet"))).toBeUndefined();
        expect(await turn("agent", message("not a device"))).toBeUndefined();
        expect(await turn("agent", message(42))).toBeUndefined();

        vi.setSystemTime(NOW + 2_000);
        await environment.report(ctx, LAPTOP);
        expect(await turn("agent")).toBe(
            "The user is now on their computer. The user's time zone changed from America/New_York to Europe/Berlin (UTC+1). Their local time is now Tuesday 2026-11-10 10:30.",
        );
        expect(await environment.environment(ctx)).toMatchObject({ deviceId: "laptop" });
    });

    it("stops falling back to devices that have not reported for 30 days", async () => {
        const { environment, database, start } = await setup(false);
        const { turn } = await start();
        const ctx = database.context;
        await environment.report(ctx, { ...LAPTOP, timeZone: "Europe/Berlin" });
        vi.setSystemTime(NOW + DAY);
        await environment.report(ctx, { deviceId: "phone", timeZone: "Asia/Tokyo" });

        vi.setSystemTime(NOW + 31 * DAY);
        expect(await environment.environment(ctx)).toMatchObject({ deviceId: "phone" });
        vi.setSystemTime(NOW + 31 * DAY + 1);
        expect(await environment.environment(ctx)).toBeUndefined();
        expect(await turn("agent")).toBeUndefined();
        // A message naming the device still finds it until the person's next report.
        expect(await environment.environment(ctx, "phone")).toMatchObject({ deviceId: "phone" });

        await environment.report(ctx, LAPTOP);
        expect(await environment.environment(ctx)).toMatchObject({ deviceId: "laptop" });
        expect(await environment.environment(ctx, "phone")).toMatchObject({ deviceId: "laptop" });
        expect(await turn("agent", message("phone"))).toContain("time zone Europe/Berlin");
    });

    it("forgets the least recently reported devices beyond the limit", async () => {
        const { environment, database } = await setup(false);
        const ctx = database.context;
        for (let index = 0; index <= MAX_USER_DEVICES; index++) {
            vi.setSystemTime(NOW + index);
            await environment.report(ctx, { deviceId: `browser-${index}`, timeZone: "UTC" });
        }

        expect(await environment.environment(ctx, "browser-0")).toMatchObject({
            deviceId: `browser-${MAX_USER_DEVICES}`,
        });
        expect(await environment.environment(ctx, "browser-1")).toMatchObject({
            deviceId: "browser-1",
        });
    });
});

describe("User environment notices", () => {
    it("tells an agent the whole environment once, on its first turn", async () => {
        const { environment, database, start } = await setup(false);
        const { turn } = await start();

        // Nothing is known yet, so there is nothing to tell.
        expect(await turn("agent")).toBeUndefined();
        await environment.report(database.context, BERLIN);

        expect(await turn("agent", inference)).toBeUndefined();
        expect(await turn("agent")).toBe(
            "User environment: time zone Europe/Berlin (UTC+1), language de-DE, 24-hour clock, week starts Monday, Gregorian calendar. Their local time is now Tuesday 2026-11-10 10:30.",
        );
        expect(await turn("agent")).toBeUndefined();
        expect(await turn("agent", inference)).toBeUndefined();
    });

    it("tells an agent created after a change the environment, not the change", async () => {
        const { environment, database, start } = await setup(false);
        const { turn } = await start();
        await environment.report(database.context, { ...LAPTOP, timeZone: "Europe/Berlin" });
        await turn("early");
        await environment.report(database.context, { ...LAPTOP, timeZone: "Asia/Tokyo" });

        expect(await turn("early")).toBe(
            "The user's time zone changed from Europe/Berlin to Asia/Tokyo (UTC+9). Their local time is now Tuesday 2026-11-10 18:30.",
        );
        expect(await turn("late")).toBe(
            "User environment: time zone Asia/Tokyo (UTC+9). Their local time is now Tuesday 2026-11-10 18:30.",
        );
    });

    it("lists only what changed", async () => {
        const { environment, database, start } = await setup(false);
        const { turn } = await start();
        const ctx = database.context;
        await environment.report(ctx, { ...BERLIN, languages: ["en-US", "de-DE"] });
        await turn("agent");

        await environment.report(ctx, { ...LAPTOP, languages: ["de-DE", "en-US"] });
        expect(await turn("agent")).toBe("The user's language changed from en-US to de-DE.");

        await environment.report(ctx, {
            ...LAPTOP,
            hourCycle: "h12",
            firstDayOfWeek: 7,
            calendar: "japanese",
        });
        expect(await turn("agent")).toBe(
            "The user's clock changed from 24-hour to 12-hour. The user's first day of the week changed from Monday to Sunday. The user's calendar changed from Gregorian to Japanese.",
        );

        // Secondary languages and the formatting locale are not news to an agent.
        await environment.report(ctx, {
            ...LAPTOP,
            languages: ["de-DE", "fr-FR"],
            locale: "fr-FR",
        });
        expect(await turn("agent")).toBeUndefined();
    });

    it("says what is newly known rather than what it changed from", async () => {
        const { environment, database, start } = await setup(false);
        const { turn } = await start();
        await environment.report(database.context, { ...LAPTOP, languages: ["de-DE"] });
        expect(await turn("agent")).toBe("User environment: language de-DE.");

        await environment.report(database.context, {
            ...LAPTOP,
            timeZone: "America/St_Johns",
            hourCycle: "h11",
        });
        expect(await turn("agent")).toBe(
            "The user's time zone is now America/St_Johns (UTC-3:30). The user's clock is now 12-hour (0–11). Their local time is now Tuesday 2026-11-10 06:00.",
        );
    });

    it("tells an agent only the latest of several changes it missed", async () => {
        const { environment, database, start } = await setup(false);
        const { turn } = await start();
        const ctx = database.context;
        await environment.report(ctx, {
            ...LAPTOP,
            timeZone: "Europe/Berlin",
            languages: ["en-US"],
        });
        await turn("agent");

        await environment.report(ctx, { ...LAPTOP, timeZone: "Asia/Tokyo", languages: ["ja-JP"] });
        await environment.report(ctx, { ...LAPTOP, timeZone: "America/New_York" });
        expect(await turn("agent")).toBe(
            "The user's time zone changed from Europe/Berlin to America/New_York (UTC-5). The user's language changed from en-US to ja-JP. Their local time is now Tuesday 2026-11-10 04:30.",
        );

        // Leaving and coming back before the agent's next turn is no change to it.
        await environment.report(ctx, { ...LAPTOP, timeZone: "Asia/Tokyo", languages: ["de-DE"] });
        await environment.report(ctx, {
            ...LAPTOP,
            timeZone: "America/New_York",
            languages: ["ja-JP"],
        });
        expect(await turn("agent")).toBeUndefined();
    });

    it("delivers a notice again when the transaction carrying it rolls back", async () => {
        const { environment, database, storage, scope, start } = await setup(false);
        const { hooks, turn } = await start();
        const ctx = database.context;
        await environment.report(ctx, { ...LAPTOP, timeZone: "Europe/Berlin" });
        await turn("agent");
        await environment.report(ctx, { ...LAPTOP, timeZone: "Asia/Tokyo" });

        await expect(
            storage.transaction(ctx, async (txCtx) => {
                await hooks.systemNotificationsTransact?.(txCtx, scope("agent"), message());
                throw new Error("The message could not be appended.");
            }),
        ).rejects.toThrow("could not be appended");

        expect(await turn("agent")).toContain("to Asia/Tokyo");
        expect(await turn("agent")).toBeUndefined();
    });

    it("keeps each device's environment and what each agent was told across restarts", async () => {
        const { environment, database, start } = await setup(false);
        const ctx = database.context;
        await environment.report(ctx, BERLIN);
        expect(await (await start()).turn("agent")).toContain("User environment:");

        const restarted = await start();
        expect((await restarted.module.environment(ctx, "laptop"))?.environment).toMatchObject({
            timeZone: "Europe/Berlin",
            languages: ["de-DE", "en-US"],
        });
        expect(await restarted.turn("agent")).toBeUndefined();
        await restarted.module.report(ctx, { ...LAPTOP, timeZone: "Asia/Tokyo" });

        expect(await (await start()).turn("agent")).toContain("from Europe/Berlin to Asia/Tokyo");
        expect(await (await start()).turn("agent")).toBeUndefined();
    });

    it("tells every agent of the person whose environment changed, and nobody else", async () => {
        const { environment, database, start } = await setup(true);
        const { turn } = await start();
        const alice = member(database.context, ALICE);
        const bob = member(database.context, BOB);
        await environment.report(alice, { ...LAPTOP, timeZone: "Europe/Berlin" });
        await environment.report(bob, { ...LAPTOP, timeZone: "America/New_York" });
        expect(await turn("alice-task")).toContain("Europe/Berlin");
        expect(await turn("alice-subtask")).toContain("Europe/Berlin");
        expect(await turn("bob-task")).toContain("America/New_York");
        expect(await turn("shared-bot")).toBeUndefined();

        await environment.report(alice, { ...LAPTOP, timeZone: "Asia/Kolkata" });

        expect(await turn("alice-task")).toContain("from Europe/Berlin to Asia/Kolkata (UTC+5:30)");
        expect(await turn("alice-subtask")).toContain("to Asia/Kolkata");
        expect(await turn("bob-task")).toBeUndefined();
        expect(await turn("shared-bot")).toBeUndefined();
        expect(await turn("alice-task")).toBeUndefined();
        expect(await turn("alice-subtask")).toBeUndefined();
    });

    it("tells every agent of a standalone installation's one person", async () => {
        const { environment, database, start } = await setup(false);
        const { turn } = await start();
        await environment.report(database.context, { ...LAPTOP, timeZone: "Europe/London" });
        for (const agent of ["alice-task", "shared-bot"]) await turn(agent);

        await environment.report(database.context, { ...LAPTOP, timeZone: "Etc/UTC" });

        expect(await turn("alice-task")).toContain("from Europe/London to Etc/UTC (UTC)");
        expect(await turn("shared-bot")).toContain("from Europe/London to Etc/UTC (UTC)");
    });
});

function member(ctx: Context, id: string): Context {
    return withTeamUser(ctx, {
        id,
        authentication: "workos",
        subject: `user_${id}`,
        firstName: "Test",
        lastName: null,
        email: `${id}@example.com`,
        isOwner: false,
        photo: null,
        createdAt: 0,
        updatedAt: 0,
        version: "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e",
    } as TeamUser);
}

function createTeam(enabled: boolean): TeamModule {
    return new TeamModule(
        {
            configuration: {
                values: {
                    feature: {
                        team: {
                            authentication: "workos",
                            enabled,
                            host: "127.0.0.1",
                            ownerWorkOSUserId: "user_01TESTUSER123",
                            port: 3_000,
                            workosClientId: "client_test123",
                            workosOrganizationId: "org_01TESTORG123",
                        },
                    },
                },
            },
        } as never,
        testProfileModule(),
    );
}
