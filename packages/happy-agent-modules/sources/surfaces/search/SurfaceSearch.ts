import type { AgentKV } from "@slopus/happy-agent-base";
import {
    calendarEventSchema,
    todoSchema,
    type CalendarEvent,
    type Surface,
    type Todo,
} from "@slopus/happy-agent-client";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

import type { DurableFunctionsModule } from "../../durableFunctions/index.js";
import type { SearchHit } from "../../utils/searchHit.js";
import {
    firstSearchWordIndex,
    rankBySearchWords,
    searchLineAt,
    searchQueryWords,
    searchWordMatch,
} from "../../utils/searchWords.js";
import { calendarNextStart } from "../calendar/calendarNextStart.js";
import type { SurfacesPersistence } from "../persistence/SurfacesPersistence.js";
import * as index from "./surfaceSearchIndex.js";

const INDEX_DOCUMENTS = "surfaces.search.documents";
const BACKFILL = "surfaces.search.backfill";
/** How many items one backfill transaction indexes. */
const BATCH = 100;
/** How many index rows one provider looks through for live matches. */
const SCAN = 500;

/** What Surface search reads, handed over by the Surfaces module once its storage is open. */
export interface SurfaceSearchParts {
    readonly store: SurfacesPersistence;
    readonly kv: AgentKV;
    readonly catalog: (ctx: Context) => Promise<Surface[]>;
    readonly documentText: (
        ctx: Context,
        surface: Surface,
    ) => Promise<{ readonly text: string; readonly comments: string }>;
}

/** The words a calendar event is found by beside its title: its location and notes. */
function calendarEventDetails(event: CalendarEvent): string {
    return [event.location, event.notes].filter((part) => part !== null).join("\n");
}

/**
 * Search over Surfaces: the catalog's names, todos, calendar events, and documents. Todo
 * and calendar event words change with them; a document's text and comments are indexed by a
 * durable job soon after each change, so editing never waits for its Markdown to be rebuilt.
 */
export class SurfaceSearch {
    #parts: SurfaceSearchParts | undefined;

    constructor(readonly durable: DurableFunctionsModule) {
        durable.register({
            name: INDEX_DOCUMENTS,
            argumentsSchema: Type.Null(),
            resultSchema: Type.Null(),
            executor: async (ctx) => {
                await this.#indexDocuments(ctx);
                return null;
            },
            // A document marked while the job finished needs another run.
            onSuccess: async (ctx) => {
                if ((await index.queryNextSurfaceDocumentToIndex(ctx)) !== undefined)
                    await this.#indexDocumentsLater(ctx);
            },
        });
        durable.register({
            name: BACKFILL,
            argumentsSchema: Type.Null(),
            resultSchema: Type.Null(),
            executor: async (ctx) => {
                await this.#backfill(ctx);
                return null;
            },
        });
    }

    start(parts: SurfaceSearchParts): void {
        this.#parts = parts;
    }

    /** Index what existed before the search indexes, and documents still waiting. */
    async afterStart(ctx: Context): Promise<void> {
        await ctx.inTx(async (tx) => {
            if ((await index.querySurfaceSearchBackfill(tx)) !== undefined)
                await this.durable.invoke(tx, {
                    function: BACKFILL,
                    arguments: null,
                    operationId: BACKFILL,
                    lockKeys: [BACKFILL],
                });
            if ((await index.queryNextSurfaceDocumentToIndex(tx)) !== undefined)
                await this.#indexDocumentsLater(tx);
        });
    }

    // Keeping the indexes in step, inside the caller's transaction

    async indexTodo(ctx: Context, todo: Todo): Promise<void> {
        await index.indexSurfaceSearchText(
            ctx,
            "todo",
            todo.surfaceId,
            todo.id,
            todo.status === "deleted" ? null : { text: todo.text },
        );
    }

    async indexCalendarEvent(ctx: Context, event: CalendarEvent): Promise<void> {
        await index.indexSurfaceSearchText(
            ctx,
            "calendar_event",
            event.surfaceId,
            event.id,
            event.status === "deleted"
                ? null
                : { title: event.title, details: calendarEventDetails(event) },
        );
    }

    /** Mark a changed document for the indexing job, which runs once this transaction commits. */
    async documentChanged(ctx: Context, surfaceId: string, seq: number): Promise<void> {
        await index.markSurfaceDocumentToIndex(ctx, surfaceId, seq);
        await this.#indexDocumentsLater(ctx);
    }

    // Providers

    /** Surfaces other than documents, by name. */
    async surfaces(ctx: Context, q: string, limit: number): Promise<SearchHit<"surface">[]> {
        const surfaces = (await this.#partsOf().catalog(ctx)).filter(
            (surface) => surface.type !== "document",
        );
        return rankBySearchWords(
            surfaces.map((surface) => surface.name),
            searchQueryWords(q),
        )
            .slice(0, limit + 1)
            .map((at) => {
                const surface = surfaces[at]!;
                return {
                    type: "surface",
                    key: `surface:${surface.id}`,
                    surfaceId: surface.id,
                    surfaceType: surface.type,
                    name: surface.name,
                };
            });
    }

    /**
     * Documents by name, then by the words of their text, at the line where a word first appears,
     * then by the words of their comments, which have no line.
     */
    async documents(ctx: Context, q: string, limit: number): Promise<SearchHit<"document">[]> {
        const words = searchQueryWords(q);
        if (words.length === 0) return [];
        const documents = new Map(
            (await this.#partsOf().catalog(ctx))
                .filter((surface) => surface.type === "document")
                .map((surface) => [surface.id, surface]),
        );
        const listed = [...documents.values()];
        const hits: SearchHit<"document">[] = rankBySearchWords(
            listed.map((surface) => surface.name),
            words,
        )
            .slice(0, limit + 1)
            .map((at) => ({
                type: "document",
                key: `document:${listed[at]!.id}`,
                surfaceId: listed[at]!.id,
                name: listed[at]!.name,
                match: "name",
                line: null,
                snippet: null,
            }));
        const seen = new Set(hits.map((hit) => hit.surfaceId));
        for (const column of ["text", "comments"] as const)
            for (const found of await index.querySurfaceSearch(
                ctx,
                "document",
                column,
                searchWordMatch(words),
                SCAN,
            )) {
                if (hits.length > limit) return hits;
                const surface = documents.get(found.surfaceId);
                if (surface === undefined || seen.has(surface.id) || found.text === null) continue;
                seen.add(surface.id);
                const at = searchLineAt(found.text, firstSearchWordIndex(found.text, words) ?? 0);
                hits.push({
                    type: "document",
                    key: `document:${surface.id}`,
                    surfaceId: surface.id,
                    name: surface.name,
                    match: "content",
                    line: column === "text" ? at.line : null,
                    snippet: at.snippet,
                });
            }
        return hits;
    }

    /** Todos that are not deleted, by the words of their text. */
    async todos(ctx: Context, q: string, limit: number): Promise<SearchHit<"todo">[]> {
        const words = searchQueryWords(q);
        if (words.length === 0) return [];
        const surfaces = await this.#liveSurfaceIds(ctx, "todo");
        const hits: SearchHit<"todo">[] = [];
        for (const found of await index.querySurfaceSearch(
            ctx,
            "todo",
            "text",
            searchWordMatch(words),
            SCAN,
        )) {
            if (hits.length > limit) break;
            if (!surfaces.has(found.surfaceId)) continue;
            const value = await this.#partsOf().kv.read(
                ctx,
                `todo.${found.surfaceId}.${found.itemId}`,
            );
            if (!Value.Check(todoSchema, value) || value.status === "deleted") continue;
            hits.push({
                type: "todo",
                key: `todo:${value.id}`,
                surfaceId: value.surfaceId,
                todoId: value.id,
                text: value.text,
                status: value.status,
            });
        }
        return hits;
    }

    /**
     * Calendar events that are not deleted, by the words of their title, then by those of their
     * location and notes, at the line where a word first appears.
     */
    async calendarEvents(
        ctx: Context,
        q: string,
        limit: number,
    ): Promise<SearchHit<"calendar_event">[]> {
        const words = searchQueryWords(q);
        if (words.length === 0) return [];
        const surfaces = await this.#liveSurfaceIds(ctx, "calendar");
        const now = Date.now();
        const hits: SearchHit<"calendar_event">[] = [];
        const seen = new Set<string>();
        for (const column of ["title", "details"] as const)
            for (const found of await index.querySurfaceSearch(
                ctx,
                "calendar_event",
                column,
                searchWordMatch(words),
                SCAN,
            )) {
                if (hits.length > limit) return hits;
                if (!surfaces.has(found.surfaceId)) continue;
                const stored = await this.#partsOf().store.readCalendarEvent(
                    ctx,
                    found.surfaceId,
                    found.itemId,
                );
                if (
                    !Value.Check(calendarEventSchema, stored) ||
                    stored.status === "deleted" ||
                    seen.has(stored.id)
                )
                    continue;
                seen.add(stored.id);
                const details = calendarEventDetails(stored);
                hits.push({
                    type: "calendar_event",
                    key: `calendar_event:${stored.id}`,
                    surfaceId: stored.surfaceId,
                    eventId: stored.id,
                    title: stored.title,
                    allDay: stored.timing.kind === "allDay",
                    start: calendarNextStart(stored, now),
                    match: column === "title" ? "name" : "content",
                    snippet:
                        column === "title"
                            ? null
                            : searchLineAt(details, firstSearchWordIndex(details, words) ?? 0)
                                  .snippet,
                });
            }
        return hits;
    }

    // Background indexing

    async #indexDocumentsLater(ctx: Context): Promise<void> {
        await this.durable.invoke(ctx, {
            function: INDEX_DOCUMENTS,
            arguments: null,
            operationId: INDEX_DOCUMENTS,
            lockKeys: [INDEX_DOCUMENTS],
        });
    }

    /** Index every marked document's text and comments, one transaction each, until none is left. */
    async #indexDocuments(ctx: Context): Promise<void> {
        const parts = this.#partsOf();
        for (;;) {
            ctx.lifetime?.throwIfAborted();
            const done = await ctx.inTx(async (tx) => {
                const next = await index.queryNextSurfaceDocumentToIndex(tx);
                if (next === undefined) return true;
                const surface = (await parts.catalog(tx)).find(
                    (candidate) => candidate.id === next.surfaceId,
                );
                await index.indexSurfaceSearchText(
                    tx,
                    "document",
                    next.surfaceId,
                    next.surfaceId,
                    surface?.type === "document" ? await parts.documentText(tx, surface) : null,
                );
                await index.clearSurfaceDocumentToIndex(tx, next.surfaceId, next.seq);
                return false;
            });
            if (done) return;
        }
    }

    /** Index todos, calendar events, and documents made before the indexes, in bounded batches. */
    async #backfill(ctx: Context): Promise<void> {
        const parts = this.#partsOf();
        for (;;) {
            ctx.lifetime?.throwIfAborted();
            const more = await ctx.inTx(async (tx) => {
                const state = await index.querySurfaceSearchBackfill(tx);
                if (state === undefined) return false;
                const todos = (
                    await parts.store.queryPage(tx, "todo.", state.todosAfter, BATCH)
                ).filter((value): value is Todo => Value.Check(todoSchema, value));
                for (const todo of todos) await this.indexTodo(tx, todo);
                const events = await index.queryCalendarEventsAfter(tx, state.eventsAfter, BATCH);
                for (const { event } of events)
                    if (Value.Check(calendarEventSchema, event))
                        await this.indexCalendarEvent(tx, event);
                const documents = (await parts.catalog(tx))
                    .filter(
                        (surface) =>
                            surface.type === "document" && surface.id > state.documentsAfter,
                    )
                    .sort((left, right) => (left.id < right.id ? -1 : 1))
                    .slice(0, BATCH);
                for (const document of documents) await this.documentChanged(tx, document.id, 0);
                if (todos.length < BATCH && events.length < BATCH && documents.length < BATCH) {
                    await index.updateSurfaceSearchBackfill(tx, null);
                    return false;
                }
                await index.updateSurfaceSearchBackfill(tx, {
                    todosAfter:
                        todos.length === 0
                            ? state.todosAfter
                            : `${todos.at(-1)!.surfaceId}.${todos.at(-1)!.id}`,
                    eventsAfter: events.at(-1)?.key ?? state.eventsAfter,
                    documentsAfter: documents.at(-1)?.id ?? state.documentsAfter,
                });
                return true;
            });
            if (!more) return;
        }
    }

    async #liveSurfaceIds(ctx: Context, type: Surface["type"]): Promise<Set<string>> {
        return new Set(
            (await this.#partsOf().catalog(ctx))
                .filter((surface) => surface.type === type)
                .map((surface) => surface.id),
        );
    }

    #partsOf(): SurfaceSearchParts {
        if (this.#parts === undefined) throw new Error("Surface search has not started.");
        return this.#parts;
    }
}
