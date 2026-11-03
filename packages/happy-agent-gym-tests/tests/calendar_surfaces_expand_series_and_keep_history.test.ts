import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import type {
    CalendarEvent,
    CalendarRangeResponse,
    HappyAgentClient,
} from "@slopus/happy-agent-client";
import { afterEach, describe, expect, it } from "vitest";

const running: AgentGym[] = [];
afterEach(async () => {
    await Promise.all(running.splice(0).map((gym) => gym.dispose()));
});
async function start() {
    const gym = await createAgentGym({ permissionMode: "full_access", timeoutMs: 20000 });
    running.push(gym);
    return gym;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Berlin wall-clock 09:00 on 12 October 2026 (CEST, UTC+2). */
const MONDAY_NINE = Date.UTC(2026, 9, 12, 7);
const BERLIN = "Europe/Berlin";

const timedStarts = (range: CalendarRangeResponse) =>
    range.occurrences.map((o) => [o.index, o.timing.kind === "timed" ? o.timing.start : 0]);
const allDayStarts = (range: CalendarRangeResponse) =>
    range.occurrences.map((o) => [o.index, o.timing.kind === "allDay" ? o.timing.startDate : ""]);

async function newCalendar(client: HappyAgentClient, name = "Team") {
    return (await client.createSurface({ type: "calendar", name })).surface;
}

describe("calendar Surfaces through the real daemon", () => {
    it("creates calendars that advertise themselves and expand series across DST, month ends, and ends", async () => {
        const gym = await start();
        const client = gym.client;
        expect((await client.getHealth()).capabilities?.calendarSurfaces).toBe(true);
        const calendar = await newCalendar(client);
        expect(calendar).toMatchObject({ type: "calendar", name: "Team", chatAgentId: null });
        expect((await client.getDesktopBootstrap()).surfaces).toEqual([calendar]);

        const weekly = (
            await client.createCalendarEvent(calendar.id, {
                title: "Standup",
                timing: {
                    kind: "timed",
                    start: MONDAY_NINE,
                    end: MONDAY_NINE + HOUR,
                    timeZone: BERLIN,
                },
                recurrence: { frequency: "weekly", count: 4 },
                mutationId: "create-weekly",
            })
        ).event;
        const monthly = (
            await client.createCalendarEvent(calendar.id, {
                title: "Month end",
                timing: { kind: "allDay", startDate: "2026-08-31", endDate: "2026-09-01" },
                recurrence: { frequency: "monthly", until: "2027-01-31" },
            })
        ).event;
        const autumn = await client.listCalendarEvents(calendar.id, {
            from: Date.UTC(2026, 9, 1),
            to: Date.UTC(2026, 10, 15),
            timeZone: BERLIN,
        });
        // 09:00 Berlin stays 09:00 after 25 October, so its instant moves an hour later in UTC.
        expect(
            timedStarts({
                ...autumn,
                occurrences: autumn.occurrences.filter((o) => o.eventId === weekly.id),
            }),
        ).toEqual([
            [0, MONDAY_NINE],
            [1, MONDAY_NINE + 7 * DAY],
            [2, MONDAY_NINE + 14 * DAY + HOUR],
            [3, MONDAY_NINE + 21 * DAY + HOUR],
        ]);
        expect(autumn.events.map((event) => event.id).sort()).toEqual(
            [weekly.id, monthly.id].sort(),
        );
        expect(autumn.cursor).toEqual(expect.any(String));
        // November lacks a 31st, and the fourth occurrence on 2 November ended the weekly series.
        const winter = await client.listCalendarEvents(calendar.id, {
            from: Date.UTC(2026, 10, 3),
            to: Date.UTC(2027, 1, 1),
            timeZone: BERLIN,
        });
        expect(winter.events.map((event) => event.id)).toEqual([monthly.id]);
        expect(allDayStarts(winter)).toEqual([
            [2, "2026-12-31"],
            [3, "2027-01-31"],
        ]);
        expect(winter.truncated).toBe(false);
        expect(
            (
                await client.listCalendarEvents(calendar.id, {
                    from: Date.UTC(2027, 1, 1),
                    to: Date.UTC(2027, 4, 1),
                    timeZone: BERLIN,
                })
            ).occurrences,
        ).toEqual([]);
        for (const range of [
            { from: Date.UTC(2026, 9, 1), to: Date.UTC(2026, 9, 1), timeZone: BERLIN },
            { from: Date.UTC(2026, 0, 1), to: Date.UTC(2026, 6, 1), timeZone: BERLIN },
            { from: Date.UTC(2026, 9, 1), to: Date.UTC(2026, 9, 2), timeZone: "+02:00" },
        ])
            await expect(client.listCalendarEvents(calendar.id, range)).rejects.toMatchObject({
                status: 400,
            });
        const created = await gym.waitUntil(
            async () =>
                (await client.getEvents({ limit: 1000 })).events.find(
                    (e) => e.type === "calendar_event.created" && e.payload.event.id === weekly.id,
                ),
            "calendar event creation to reach the journal",
        );
        expect(created.payload).toEqual({ event: weekly, mutationId: "create-weekly" });
        expect(gym.errors).toEqual([]);
    });

    it("edits and deletes whole series, guards versions, and retries creation by ID", async () => {
        const gym = await start();
        const client = gym.client;
        const calendar = await newCalendar(client);
        const id = "e4k8m2q9w1e5r7y3u6i0o2p4";
        const timing = {
            kind: "timed",
            start: MONDAY_NINE,
            end: MONDAY_NINE + HOUR,
            timeZone: BERLIN,
        } as const;
        const event = (
            await client.createCalendarEvent(calendar.id, {
                id,
                title: "Review",
                timing,
                recurrence: { frequency: "daily", count: 3 },
            })
        ).event;
        expect(
            (await client.createCalendarEvent(calendar.id, { id, timing, title: "Other" })).event,
        ).toEqual(event);
        const range = { from: Date.UTC(2026, 9, 12), to: Date.UTC(2026, 9, 20), timeZone: BERLIN };

        const moved = (
            await client.updateCalendarEvent(
                calendar.id,
                id,
                {
                    timing: {
                        ...timing,
                        start: timing.start + 2 * HOUR,
                        end: timing.end + 3 * HOUR,
                    },
                    mutationId: "drag",
                },
                { ifMatch: event.version },
            )
        ).event;
        expect(timedStarts(await client.listCalendarEvents(calendar.id, range))).toEqual([
            [0, MONDAY_NINE + 2 * HOUR],
            [1, MONDAY_NINE + DAY + 2 * HOUR],
            [2, MONDAY_NINE + 2 * DAY + 2 * HOUR],
        ]);
        expect(
            (await client.listCalendarEvents(calendar.id, range)).occurrences.every(
                (o) => o.timing.kind === "timed" && o.timing.end - o.timing.start === 2 * HOUR,
            ),
        ).toBe(true);

        const stale = await client
            .updateCalendarEvent(calendar.id, id, { title: "Lost" }, { ifMatch: event.version })
            .catch((error: unknown) => error);
        expect(stale).toMatchObject({
            status: 409,
            code: "conflict",
            body: { currentVersion: moved.version, event: moved },
        });
        await expect(
            client.updateCalendarEvent(calendar.id, id, { title: "x" }, { ifMatch: "nope" }),
        ).rejects.toMatchObject({ status: 400 });
        await expect(
            client.updateCalendarEvent(calendar.id, id, {} as never, { ifMatch: moved.version }),
        ).rejects.toMatchObject({ status: 400 });

        const deleted = (
            await client.deleteCalendarEvent(calendar.id, id, {
                ifMatch: moved.version,
                mutationId: "delete",
            })
        ).event;
        expect(deleted).toMatchObject({ status: "deleted", title: "Review" });
        expect(deleted.deletedAt).toEqual(expect.any(Number));
        expect((await client.listCalendarEvents(calendar.id, range)).occurrences).toEqual([]);
        expect((await client.getCalendarEvent(calendar.id, id)).event).toEqual(deleted);
        expect(
            (await client.deleteCalendarEvent(calendar.id, id, { ifMatch: deleted.version })).event,
        ).toEqual(deleted);
        await gym.restart();
        expect((await gym.client.createCalendarEvent(calendar.id, { id, timing })).event).toEqual(
            deleted,
        );
        expect(gym.errors).toEqual([]);
    });

    it("keeps every revision through edits, recurrence changes, deletion, and restart, then restores one", async () => {
        const gym = await start();
        let client = gym.client;
        const calendar = await newCalendar(client);
        const original = (
            await client.createCalendarEvent(calendar.id, {
                title: "Planning",
                notes: "Bring the roadmap",
                location: "Room 4",
                timing: {
                    kind: "timed",
                    start: MONDAY_NINE,
                    end: MONDAY_NINE + HOUR,
                    timeZone: BERLIN,
                },
                recurrence: { frequency: "weekly", weekdays: ["thursday", "monday"], count: 8 },
            })
        ).event;
        let current: CalendarEvent = original;
        for (const edit of [
            { title: "Planning v2", notes: null },
            { location: null, title: "" },
            { recurrence: { frequency: "monthly", until: "2027-03-31" } },
            { timing: { kind: "allDay", startDate: "2026-10-14", endDate: "2026-10-16" } },
        ] as const)
            current = (
                await client.updateCalendarEvent(calendar.id, original.id, edit, {
                    ifMatch: current.version,
                })
            ).event;
        current = (
            await client.deleteCalendarEvent(calendar.id, original.id, { ifMatch: current.version })
        ).event;
        const before = (await client.listCalendarEventVersions(calendar.id, original.id)).versions;
        expect(before).toHaveLength(6);
        expect(before.map((revision) => revision.source)).toEqual(Array(6).fill("api"));

        await gym.restart();
        client = gym.client;
        expect((await client.listCalendarEventVersions(calendar.id, original.id)).versions).toEqual(
            before,
        );
        const target = (
            await client.getCalendarEventVersion(calendar.id, original.id, original.version)
        ).revision.event;
        expect(target).toEqual(original);
        const { title, notes, location, timing, recurrence, status } = target;
        const restored = (
            await client.updateCalendarEvent(
                calendar.id,
                original.id,
                { title, notes, location, timing, recurrence, status },
                { ifMatch: current.version },
            )
        ).event;
        const { updatedAt: _updatedAt, version: _version, ...fields } = original;
        expect(restored).toMatchObject(fields);
        expect(restored.version > current.version).toBe(true);
        const after = (await client.listCalendarEventVersions(calendar.id, original.id)).versions;
        expect(after).toHaveLength(before.length + 1);
        expect(after.slice(0, before.length)).toEqual(before);
        expect(after.at(-1)!.event).toEqual(restored);
        const occurrences = (
            await client.listCalendarEvents(calendar.id, {
                from: Date.UTC(2026, 9, 12),
                to: Date.UTC(2026, 9, 19),
                timeZone: BERLIN,
            })
        ).occurrences;
        expect(occurrences.map((o) => o.index)).toEqual([0, 1]);
        expect(gym.errors).toEqual([]);
    });

    it("lets only admin bots create calendars and keeps calendar routes to calendar Surfaces", async () => {
        let adminId = "";
        let created = false;
        const gym = await createAgentGym({
            permissionMode: "full_access",
            inference(request) {
                if (request.sessionId.startsWith("naming:"))
                    return { content: [{ type: "text", text: "<title>Calendar</title>" }] };
                if (request.sessionId !== adminId || created)
                    return { content: [{ type: "text", text: "Done." }] };
                created = true;
                return {
                    content: [
                        {
                            type: "tool_call",
                            name: "create_calendar_tab",
                            arguments: { name: "Holidays", creatorUserId: null },
                        },
                    ],
                };
            },
        });
        running.push(gym);
        const client = gym.client;
        const todo = (await client.createSurface({ type: "todo", name: "Errands" })).surface;
        const document = (await client.createSurface({ type: "document", name: "Notes" })).surface;
        await gym.send("What can you do?", { permissionMode: "full_access" });
        const ordinaryTools = gym.inference.requests
            .filter((request) => !request.sessionId.startsWith("naming:"))
            .at(-1)!
            .tools.map((tool) => tool.name);
        expect(ordinaryTools).toEqual(
            expect.arrayContaining(["list_calendar_events", "create_calendar_event"]),
        );
        expect(ordinaryTools).not.toContain("create_calendar_tab");

        adminId = (await client.createBot({ name: "Administrator", isAdmin: true })).bot.agent.id;
        await gym.send("Create a shared calendar named Holidays.", {
            sessionId: adminId,
            permissionMode: "full_access",
        });
        const calendar = (await client.listSurfaces()).surfaces.find(
            (surface) => surface.type === "calendar",
        )!;
        expect(calendar).toMatchObject({ name: "Holidays", members: [{ userId: null }] });

        const timing = { kind: "allDay", startDate: "2026-12-24", endDate: "2026-12-27" } as const;
        for (const other of [todo.id, document.id]) {
            await expect(
                client.listCalendarEvents(other, {
                    from: Date.UTC(2026, 11, 1),
                    to: Date.UTC(2026, 11, 31),
                    timeZone: BERLIN,
                }),
            ).rejects.toMatchObject({ status: 404 });
            await expect(client.createCalendarEvent(other, { timing })).rejects.toMatchObject({
                status: 404,
            });
        }
        const event = (await client.createCalendarEvent(calendar.id, { timing })).event;
        await expect(client.getCalendarEvent(todo.id, event.id)).rejects.toMatchObject({
            status: 404,
        });
        await expect(client.listTodos(calendar.id)).rejects.toMatchObject({ status: 404 });
        await expect(client.getSurfaceDocument(calendar.id)).rejects.toMatchObject({
            status: 404,
        });
        expect(gym.errors).toEqual([]);
        expect(gym.inference.unscripted).toEqual([]);
    });

    it("gives a calendar a shared chat whose agent schedules with local ISO times", async () => {
        let chatId = "";
        let surfaceId = "";
        let called = false;
        const gym = await createAgentGym({
            permissionMode: "full_access",
            inference(request) {
                if (request.sessionId.startsWith("naming:"))
                    return { content: [{ type: "text", text: "<title>Chat</title>" }] };
                if (request.sessionId !== chatId || called)
                    return { content: [{ type: "text", text: "Scheduled." }] };
                called = true;
                return {
                    content: [
                        {
                            type: "tool_call",
                            name: "create_calendar_event",
                            arguments: {
                                tabId: surfaceId,
                                title: "Dentist",
                                timing: {
                                    kind: "timed",
                                    start: "2026-10-26T09:00",
                                    end: "2026-10-26T09:45",
                                    timeZone: BERLIN,
                                },
                                authorUserId: null,
                            },
                        },
                    ],
                };
            },
        });
        running.push(gym);
        const calendar = await newCalendar(gym.client, "Family");
        surfaceId = calendar.id;
        const { agent } = await gym.client.ensureSurfaceChat(calendar.id);
        chatId = agent.id;
        await gym.send("Book the dentist on Monday at nine.", {
            sessionId: chatId,
            permissionMode: "full_access",
        });
        const request = gym.inference.requests.find((r) => r.sessionId === chatId)!;
        expect(request.instructions).toContain("shared calendar");
        expect(request.instructions).toContain(calendar.id);
        const range = await gym.client.listCalendarEvents(calendar.id, {
            from: Date.UTC(2026, 9, 26),
            to: Date.UTC(2026, 9, 27),
            timeZone: BERLIN,
        });
        // 26 October is after the change to winter time, so 09:00 Berlin is 08:00 UTC.
        expect(range.events).toMatchObject([
            {
                title: "Dentist",
                authorUserId: null,
                timing: {
                    kind: "timed",
                    start: Date.UTC(2026, 9, 26, 8),
                    end: Date.UTC(2026, 9, 26, 8, 45),
                },
            },
        ]);
        const [revision] = (
            await gym.client.listCalendarEventVersions(calendar.id, range.events[0]!.id)
        ).versions;
        expect(revision).toMatchObject({ actor: { agentId: chatId }, source: "tool" });
        const result = JSON.stringify(
            gym.inference.requests.filter((r) => r.sessionId === chatId).at(-1)!.messages,
        );
        expect(result).toContain("2026-10-26T09:00:00+01:00");
        expect(gym.errors).toEqual([]);
        expect(gym.inference.unscripted).toEqual([]);
    });
});
