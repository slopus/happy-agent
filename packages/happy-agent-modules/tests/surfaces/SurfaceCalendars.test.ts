import {
    ensureAgentDatabaseConnection,
    type AgentModuleScope,
    type AgentSystemRef,
} from "@slopus/happy-agent-base";
import type { CalendarEvent, CalendarTimingInput } from "@slopus/happy-agent-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArtifactsModule } from "../../sources/artifacts/index.js";
import type { BotsModule } from "../../sources/bots/index.js";
import type { ComputeModule } from "../../sources/compute/index.js";
import type { ConfigModule } from "../../sources/config/index.js";
import type { RunnersModule } from "../../sources/runners/index.js";
import type { TasksModule } from "../../sources/tasks/index.js";
import type { TeamModule } from "../../sources/team/index.js";
import { DurableFunctionsModule } from "../../sources/durableFunctions/index.js";
import { SurfacesModule, type SurfaceEvent } from "../../sources/surfaces/index.js";
import { SurfacesPersistence } from "../../sources/surfaces/persistence/SurfacesPersistence.js";
import { formatSurfaceChatPrompt } from "../../sources/surfaces/impl/formatSurfaceChatPrompt.js";
import { moduleDatabase } from "../support/moduleDatabase.js";

const close: (() => void)[] = [];
afterEach(() => {
    close
        .splice(0)
        .reverse()
        .forEach((dispose) => dispose());
});

async function fixture() {
    const durable = new DurableFunctionsModule();
    const surfaces = new SurfacesModule(
        durable,
        {
            enabled: true,
            getUser: async (_ctx: unknown, id: string) =>
                ["alice", "bob"].includes(id) ? { id, authentication: "jwt" } : undefined,
        } as unknown as TeamModule,
        {
            forAgent: async (_ctx: unknown, id: string) =>
                id === "admin" ? { isAdmin: true, status: "active" } : undefined,
        } as unknown as BotsModule,
        { get: async () => undefined } as unknown as TasksModule,
        { get: async () => undefined } as unknown as ArtifactsModule,
        {
            resolve: vi.fn(async () => ({})),
            shouldReviewPath: vi.fn(async () => false),
        } as unknown as ComputeModule,
        {} as ConfigModule,
        { localExecution: true } as RunnersModule,
    );
    const db = moduleDatabase([...durable.migrations, ...surfaces.migrations], "calendar-test");
    ensureAgentDatabaseConnection(db.database);
    close.push(() => {
        durable.stop();
        db.close();
    });
    await db.ready;
    const hooks = surfaces.beforeStart(db.context, {} as AgentSystemRef);
    const events: SurfaceEvent[] = [];
    surfaces.onEventTransactional((_ctx, event) => {
        events.push(event);
    });
    const kv = new SurfacesPersistence(db.database).kv();
    const ctx = db.context;
    const calendar = await surfaces.create(ctx, { type: "calendar", name: "Team" }, "alice");
    return { surfaces, hooks, ctx, kv, events, calendar };
}

const actor = { userId: "alice", agentId: null };
const timed: CalendarTimingInput = {
    kind: "timed",
    start: Date.UTC(2026, 9, 19, 7),
    end: Date.UTC(2026, 9, 19, 8),
    timeZone: "Europe/Berlin",
};
const october = { from: Date.UTC(2026, 8, 28), to: Date.UTC(2026, 10, 9), timeZone: "UTC" };

describe("calendar Surfaces", () => {
    it("creates idempotently, reads a range, and rejects other Surface types", async () => {
        const f = await fixture();
        const id = "e4k8m2q9w1e5r7y3u6i0o2p4";
        const event = await f.surfaces.createCalendarEvent(
            f.ctx,
            f.calendar.id,
            { id, timing: timed, recurrence: { frequency: "weekly" }, mutationId: "m" },
            actor,
            "alice",
        );
        expect(event).toMatchObject({
            id,
            title: "",
            notes: null,
            location: null,
            authorUserId: "alice",
            status: "active",
            deletedAt: null,
            recurrence: {
                frequency: "weekly",
                interval: 1,
                weekdays: null,
                until: null,
                count: null,
            },
        });
        expect(
            await f.surfaces.createCalendarEvent(
                f.ctx,
                f.calendar.id,
                { id, timing: timed, title: "Ignored" },
                actor,
                "bob",
            ),
        ).toEqual(event);
        expect(f.events.map((e) => e.type)).toEqual(["surface.created", "calendar_event.created"]);
        expect(f.events[1]!.payload).toEqual({ event, mutationId: "m" });

        const range = await f.surfaces.listCalendar(f.ctx, f.calendar.id, october);
        expect(range.events).toEqual([event]);
        expect(range.occurrences.map((o) => o.index)).toEqual([0, 1, 2]);
        expect(range.truncated).toBe(false);
        const limited = await f.surfaces.listCalendar(f.ctx, f.calendar.id, october, 2);
        expect(limited).toMatchObject({ truncated: true, events: [event] });
        expect(limited.occurrences).toHaveLength(2);

        const todo = await f.surfaces.create(f.ctx, { type: "todo", name: "List" }, "alice");
        await expect(f.surfaces.listCalendar(f.ctx, todo.id, october)).rejects.toMatchObject({
            code: "not_found",
        });
        await expect(f.surfaces.getCalendarEvent(f.ctx, todo.id, id)).rejects.toMatchObject({
            code: "not_found",
        });
        await expect(f.surfaces.listTodos(f.ctx, f.calendar.id)).rejects.toMatchObject({
            code: "not_found",
        });
        for (const bad of [
            { ...october, to: october.from },
            { ...october, to: october.from + 101 * 86_400_000 },
            { ...october, timeZone: "+02:00" },
        ])
            await expect(f.surfaces.listCalendar(f.ctx, f.calendar.id, bad)).rejects.toMatchObject({
                code: "invalid_request",
            });
    });

    it("validates whole series, including edits that move timing past until", async () => {
        const f = await fixture();
        const create = (input: Parameters<SurfacesModule["createCalendarEvent"]>[2]) =>
            f.surfaces.createCalendarEvent(f.ctx, f.calendar.id, input, actor, null);
        for (const timing of [
            { ...timed, end: timed.start },
            { ...timed, end: timed.start + 367 * 86_400_000 },
            { ...timed, timeZone: "Nowhere/Else" },
            { kind: "allDay", startDate: "2026-10-20", endDate: "2026-10-20" },
            { kind: "allDay", startDate: "2026-02-30", endDate: "2026-03-02" },
        ] as CalendarTimingInput[])
            await expect(create({ timing })).rejects.toMatchObject({ code: "invalid_request" });
        await expect(
            create({ timing: timed, recurrence: { frequency: "daily", until: "2026-10-18" } }),
        ).rejects.toMatchObject({ code: "invalid_request" });
        await expect(
            create({
                timing: timed,
                recurrence: { frequency: "daily", until: "2026-12-01", count: 2 },
            }),
        ).rejects.toMatchObject({ code: "invalid_request" });
        const bounded = await create({
            timing: timed,
            recurrence: { frequency: "daily", until: "2026-10-25" },
        });
        await expect(
            f.surfaces.mutateCalendarEvent(
                f.ctx,
                f.calendar.id,
                bounded.id,
                bounded.version,
                { timing: { ...timed, start: Date.UTC(2026, 10, 2), end: Date.UTC(2026, 10, 3) } },
                actor,
            ),
        ).rejects.toMatchObject({ code: "invalid_request" });
    });

    it("restores any revision exactly through ordinary update, appending one revision", async () => {
        const f = await fixture();
        const s = f.surfaces;
        const first = await s.createCalendarEvent(
            f.ctx,
            f.calendar.id,
            {
                title: "Standup",
                notes: "Daily",
                location: "Room 4",
                timing: timed,
                recurrence: { frequency: "weekly", weekdays: ["thursday", "monday"], count: 10 },
            },
            actor,
            "alice",
        );
        const edits = [
            { title: "", notes: null, location: null },
            {
                timing: { kind: "allDay", startDate: "2026-10-21", endDate: "2026-10-23" },
                recurrence: null,
            },
            { recurrence: { frequency: "monthly", until: "2027-06-30" } },
        ] as const;
        let current: CalendarEvent = first;
        for (const edit of edits)
            current = await s.mutateCalendarEvent(
                f.ctx,
                f.calendar.id,
                first.id,
                current.version,
                edit,
                actor,
            );
        const deleted = await s.mutateCalendarEvent(
            f.ctx,
            f.calendar.id,
            first.id,
            current.version,
            "delete",
            actor,
        );
        expect(deleted).toMatchObject({ status: "deleted", title: "" });
        expect(
            await s.mutateCalendarEvent(
                f.ctx,
                f.calendar.id,
                first.id,
                deleted.version,
                "delete",
                actor,
            ),
        ).toEqual(deleted);
        await expect(
            s.mutateCalendarEvent(
                f.ctx,
                f.calendar.id,
                first.id,
                first.version,
                { title: "Stale" },
                actor,
            ),
        ).rejects.toMatchObject({ code: "conflict", current: { event: deleted } });

        const before = (await s.calendarEventVersions(f.ctx, f.calendar.id, first.id)).versions;
        expect(before).toHaveLength(5);
        const { title, notes, location, timing, recurrence, status } = before[0]!.event;
        const restored = await s.mutateCalendarEvent(
            f.ctx,
            f.calendar.id,
            first.id,
            deleted.version,
            { title, notes, location, timing, recurrence, status },
            { userId: "bob", agentId: null },
        );
        const { updatedAt: _u, version: _v, ...same } = first;
        expect(restored).toMatchObject(same);
        expect(restored.version > deleted.version).toBe(true);
        const after = (await s.calendarEventVersions(f.ctx, f.calendar.id, first.id)).versions;
        expect(after.slice(0, 5)).toEqual(before);
        expect(after).toHaveLength(6);
        expect(after[5]).toEqual({
            event: restored,
            actor: { userId: "bob", agentId: null },
            source: "api",
        });
        const payload = f.events.at(-1)!.payload as { changes: Record<string, unknown> };
        expect(Object.keys(payload.changes).sort()).toEqual([
            "deletedAt",
            "location",
            "notes",
            "recurrence",
            "status",
            "timing",
            "title",
            "updatedAt",
        ]);
        expect(
            await s.mutateCalendarEvent(
                f.ctx,
                f.calendar.id,
                first.id,
                restored.version,
                { title: "Standup" },
                actor,
            ),
        ).toEqual(restored);
        expect(
            (await s.getCalendarEventVersion(f.ctx, f.calendar.id, first.id, first.version)).event,
        ).toEqual(first);
        const page = await s.calendarEventVersions(f.ctx, f.calendar.id, first.id, undefined, 2);
        expect(page.nextAfterVersion).toBe(page.versions[1]!.event.version);
    });

    it("gives models local ISO times, replays creation, and names the calendar in its chat", async () => {
        const f = await fixture();
        const agentKv = f.kv.scoped("agent");
        await agentKv.write(f.ctx, "owner", "alice");
        const tools = await f.hooks.tools!(f.ctx, {
            agent: { id: "ordinary" },
            kv: agentKv,
        } as AgentModuleScope);
        const tool = (name: string) => tools.find((item) => item.name === name)!;
        expect(tools.some((item) => item.name === "create_calendar_surface")).toBe(false);
        const call = { kv: f.kv.scoped("create-call") } as never;
        const input = {
            surfaceId: f.calendar.id,
            title: "Planning",
            timing: {
                kind: "timed",
                start: "2026-10-19T09:00",
                end: "2026-10-19T10:00",
                timeZone: "Europe/Berlin",
            },
            recurrence: { frequency: "daily", count: 10 },
            authorUserId: null,
        };
        const created = (await tool("create_calendar_event").execute(f.ctx, input, call)) as {
            id: string;
            version: string;
            timing: unknown;
        };
        expect(created.timing).toEqual({
            kind: "timed",
            start: "2026-10-19T09:00:00+02:00",
            end: "2026-10-19T10:00:00+02:00",
            timeZone: "Europe/Berlin",
        });
        expect(await tool("create_calendar_event").execute(f.ctx, input, call)).toEqual(created);
        expect(
            (await f.surfaces.calendarEventVersions(f.ctx, f.calendar.id, created.id)).versions,
        ).toHaveLength(1);

        const listed = (await tool("list_calendar_events").execute(
            f.ctx,
            {
                surfaceId: f.calendar.id,
                from: "2026-10-24",
                to: "2026-10-27",
                timeZone: "America/New_York",
            },
            {} as never,
        )) as { occurrences: { index: number; timing: { start: string } }[] };
        // 09:00 in Berlin stays 09:00 there; New York changes its clocks a week later.
        expect(listed.occurrences.map((o) => `${o.index} ${o.timing.start}`)).toEqual([
            "5 2026-10-24T03:00:00-04:00",
            "6 2026-10-25T04:00:00-04:00",
            "7 2026-10-26T04:00:00-04:00",
        ]);
        const moved = (await tool("update_calendar_event").execute(
            f.ctx,
            {
                surfaceId: f.calendar.id,
                eventId: created.id,
                version: created.version,
                timing: {
                    kind: "timed",
                    start: "2026-10-19T09:30",
                    end: "2026-10-19T11:00",
                    timeZone: "Europe/Berlin",
                },
            },
            {} as never,
        )) as { timing: { end: string } };
        expect(moved.timing.end).toBe("2026-10-19T11:00:00+02:00");
        expect(formatSurfaceChatPrompt(f.calendar)).toContain("shared calendar");
        expect(formatSurfaceChatPrompt(f.calendar)).toContain("list_calendar_events");
        const admin = await f.hooks.tools!(f.ctx, {
            agent: { id: "admin" },
            kv: agentKv,
        } as AgentModuleScope);
        const surface = await admin
            .find((item) => item.name === "create_calendar_surface")!
            .execute(f.ctx, { name: "Admin calendar", creatorUserId: "bob" }, {
                kv: f.kv.scoped("surface-call"),
            } as never);
        expect(surface).toMatchObject({ type: "calendar", members: [{ userId: "bob" }] });
    });
});
