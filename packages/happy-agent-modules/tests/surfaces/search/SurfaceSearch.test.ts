import {
    agentDatabaseRows,
    agentDatabaseRun,
    ensureAgentDatabaseConnection,
    type AgentSystemRef,
} from "@slopus/happy-agent-base";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import type { ArtifactsModule } from "../../../sources/artifacts/index.js";
import type { BotsModule } from "../../../sources/bots/index.js";
import type { ComputeModule } from "../../../sources/compute/index.js";
import type { ConfigModule } from "../../../sources/config/index.js";
import { DurableFunctionsModule } from "../../../sources/durableFunctions/index.js";
import type { RunnersModule } from "../../../sources/runners/index.js";
import { SurfacesModule } from "../../../sources/surfaces/index.js";
import type { TasksModule } from "../../../sources/tasks/index.js";
import type { TeamModule } from "../../../sources/team/index.js";
import { moduleDatabase } from "../../support/moduleDatabase.js";

const close: (() => void)[] = [];
afterEach(() => {
    close
        .splice(0)
        .reverse()
        .forEach((dispose) => dispose());
});

const actor = { userId: "alice", agentId: null };

async function fixture() {
    const durable = new DurableFunctionsModule();
    const surfaces = new SurfacesModule(
        durable,
        {
            enabled: true,
            getUser: async (_ctx: unknown, id: string) =>
                id === "alice" ? { id, authentication: "jwt" } : undefined,
        } as unknown as TeamModule,
        { forAgent: async () => undefined } as unknown as BotsModule,
        { get: async () => undefined } as unknown as TasksModule,
        { get: async () => undefined } as unknown as ArtifactsModule,
        {} as ComputeModule,
        {} as ConfigModule,
        { localExecution: true } as RunnersModule,
    );
    const db = moduleDatabase([...durable.migrations, ...surfaces.migrations], "surface-search");
    ensureAgentDatabaseConnection(db.database);
    close.push(() => {
        durable.stop();
        db.close();
    });
    await db.ready;
    const ctx = db.context;
    const agents = {} as AgentSystemRef;
    const durableHooks = durable.beforeStart(ctx);
    const hooks = surfaces.beforeStart(ctx, agents);
    const start = async () => {
        await durableHooks.afterStart?.(ctx, agents);
        await hooks.afterStart?.(ctx, agents);
    };
    return { surfaces, search: surfaces.search, ctx, start };
}

describe("Surface search", () => {
    it("finds todos, calendar events, Surfaces, and documents by their words", async () => {
        const f = await fixture();
        await f.start();
        const todos = await f.surfaces.create(
            f.ctx,
            { type: "todo", name: "Launch tasks" },
            "alice",
        );
        const calendar = await f.surfaces.create(
            f.ctx,
            { type: "calendar", name: "Team" },
            "alice",
        );
        const notes = await f.surfaces.create(
            f.ctx,
            { type: "document", name: "Launch notes" },
            "alice",
            undefined,
            actor,
        );
        const plan = await f.surfaces.create(
            f.ctx,
            { type: "document", name: "Plan", text: "# Plan\n" },
            "alice",
            undefined,
            actor,
        );

        const venue = await f.surfaces.createTodo(
            f.ctx,
            todos.id,
            { text: "Book the Café venue" },
            actor,
            "alice",
        );
        await f.surfaces.createTodo(f.ctx, todos.id, { text: "Order snacks" }, actor, "alice");
        const event = await f.surfaces.createCalendarEvent(
            f.ctx,
            calendar.id,
            {
                title: "Launch review",
                timing: {
                    kind: "timed",
                    start: Date.UTC(2026, 9, 19, 7),
                    end: Date.UTC(2026, 9, 19, 8),
                    timeZone: "UTC",
                },
            },
            actor,
            "alice",
        );

        // Words match by prefix, ignoring case and diacritics.
        expect(await f.search.todos(f.ctx, "cafe VEN", 10)).toEqual([
            {
                type: "todo",
                key: `todo:${venue.id}`,
                surfaceId: todos.id,
                todoId: venue.id,
                text: "Book the Café venue",
                status: "active",
            },
        ]);
        expect(await f.search.calendarEvents(f.ctx, "launch", 10)).toEqual([
            {
                type: "calendar_event",
                key: `calendar_event:${event.id}`,
                surfaceId: calendar.id,
                eventId: event.id,
                title: "Launch review",
                allDay: false,
                start: Date.UTC(2026, 9, 19, 7),
                match: "name",
                snippet: null,
            },
        ]);
        // An event's location and notes are its content, after every title match.
        const offsite = await f.surfaces.createCalendarEvent(
            f.ctx,
            calendar.id,
            {
                title: "Offsite",
                location: "Harbor hall",
                notes: "Bring the slides\nand the launch demo",
                timing: { kind: "allDay", startDate: "2026-10-20", endDate: "2026-10-21" },
            },
            actor,
            "alice",
        );
        expect(
            (await f.search.calendarEvents(f.ctx, "launch", 10)).map((hit) => [
                hit.title,
                hit.match,
                hit.snippet,
            ]),
        ).toEqual([
            ["Launch review", "name", null],
            ["Offsite", "content", "and the launch demo"],
        ]);
        expect(await f.search.calendarEvents(f.ctx, "harbor", 10)).toMatchObject([
            { eventId: offsite.id, allDay: true, match: "content", snippet: "Harbor hall" },
        ]);
        // Documents are found under `document`, every other Surface under `surface`.
        expect((await f.search.surfaces(f.ctx, "launch", 10)).map((hit) => hit.key)).toEqual([
            `surface:${todos.id}`,
        ]);
        expect(await f.search.documents(f.ctx, "launch", 10)).toEqual([
            {
                type: "document",
                key: `document:${notes.id}`,
                surfaceId: notes.id,
                name: "Launch notes",
                match: "name",
                line: null,
                snippet: null,
            },
        ]);

        // A document's text is indexed shortly after the edit, by a durable job.
        await f.surfaces.changeDocumentFromMarkdown(
            f.ctx,
            plan.id,
            (await f.surfaces.document(f.ctx, plan.id)).document.seq,
            "# Plan\n\nThe launch moves to Friday\n",
            actor,
        );
        await vi.waitFor(async () => {
            expect(await f.search.documents(f.ctx, "friday", 10)).toEqual([
                {
                    type: "document",
                    key: `document:${plan.id}`,
                    surfaceId: plan.id,
                    name: "Plan",
                    match: "content",
                    line: 3,
                    snippet: "The launch moves to Friday",
                },
            ]);
        });
        // A name match comes before a content match, and a document is listed once.
        expect(
            (await f.search.documents(f.ctx, "launch", 10)).map((hit) => [hit.name, hit.match]),
        ).toEqual([
            ["Launch notes", "name"],
            ["Plan", "content"],
        ]);

        // A comment's words find its document too, with no line.
        const state = new Y.Doc();
        Y.applyUpdate(
            state,
            Buffer.from((await f.surfaces.documentState(f.ctx, plan.id, {})).update, "base64"),
        );
        const before = Y.encodeStateVector(state);
        const comment = (text: string, deleted: boolean) => {
            const map = new Y.Map<unknown>();
            map.set("id", text);
            map.set("userId", "alice");
            map.set("createdAt", 1);
            map.set("updatedAt", 1);
            if (deleted) map.set("deletedAt", 2);
            else
                map.set("body", [
                    {
                        type: "paragraph",
                        content: [{ type: "text", text, styles: {} }],
                        children: [],
                    },
                ]);
            return map;
        };
        const thread = new Y.Map<unknown>();
        thread.set("id", "thread1");
        const comments = new Y.Array<Y.Map<unknown>>();
        comments.push([comment("Ask the zoologist", false), comment("unseen", true)]);
        thread.set("comments", comments);
        thread.set("resolved", false);
        state.getMap("threads").set("thread1", thread);
        await f.surfaces.changeDocument(
            f.ctx,
            plan.id,
            Buffer.from(Y.encodeStateAsUpdate(state, before)).toString("base64"),
            actor,
            null,
        );
        await vi.waitFor(async () => {
            expect(await f.search.documents(f.ctx, "zoologist", 10)).toEqual([
                {
                    type: "document",
                    key: `document:${plan.id}`,
                    surfaceId: plan.id,
                    name: "Plan",
                    match: "content",
                    line: null,
                    snippet: "Ask the zoologist",
                },
            ]);
        });
        expect(await f.search.documents(f.ctx, "launch zoologist", 10)).toEqual([]);

        // Deleted todos and events leave the index in the same transaction.
        await f.surfaces.mutateTodo(f.ctx, todos.id, venue.id, venue.version, "delete", {}, actor);
        expect(await f.search.todos(f.ctx, "venue", 10)).toEqual([]);
        await f.surfaces.mutateCalendarEvent(
            f.ctx,
            calendar.id,
            event.id,
            event.version,
            "delete",
            actor,
        );
        expect(
            (await f.search.calendarEvents(f.ctx, "launch", 10)).map((hit) => hit.title),
        ).toEqual(["Offsite"]);
    });

    it("indexes what existed before the indexes in a background backfill", async () => {
        const f = await fixture();
        const todos = await f.surfaces.create(f.ctx, { type: "todo", name: "List" }, "alice");
        for (let index = 0; index < 120; index += 1)
            await f.surfaces.createTodo(
                f.ctx,
                todos.id,
                { text: `zeppelin ${index}` },
                actor,
                "alice",
            );
        await f.surfaces.create(
            f.ctx,
            { type: "document", name: "Plan", text: "Airships ahead\n" },
            "alice",
            undefined,
            actor,
        );
        // Forget the indexes, as a daemon upgraded from before them has none.
        for (const statement of [
            sql`DELETE FROM happy_agent_surface_todo_words`,
            sql`DELETE FROM happy_agent_surface_document_words`,
            sql`DELETE FROM happy_agent_surface_search_rows`,
            sql`DELETE FROM happy_agent_surface_documents_to_index`,
            sql`INSERT OR REPLACE INTO happy_agent_surface_search_backfill (id, todos_after, events_after, documents_after) VALUES (1, '', '', '')`,
        ])
            await agentDatabaseRun(f.ctx.db, statement);
        expect(await f.search.todos(f.ctx, "zeppelin", 200)).toEqual([]);

        await f.start();
        await vi.waitFor(async () => {
            expect(await f.search.todos(f.ctx, "zeppelin", 200)).toHaveLength(120);
            expect(await f.search.documents(f.ctx, "airships", 10)).toHaveLength(1);
        });
        await vi.waitFor(async () => {
            expect(
                await agentDatabaseRows(
                    f.ctx.db,
                    sql`SELECT id FROM happy_agent_surface_search_backfill`,
                ),
            ).toEqual([]);
        });
    });
});
