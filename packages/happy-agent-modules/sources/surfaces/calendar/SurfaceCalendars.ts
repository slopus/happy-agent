import type { AgentKV } from "@slopus/happy-agent-base";
import {
    CALENDAR_RANGE_MAX_MS,
    CALENDAR_RANGE_MAX_OCCURRENCES,
    calendarEventRevisionSchema,
    calendarEventSchema,
    createCalendarEventRequestSchema,
    updateCalendarEventRequestSchema,
    type CalendarEvent,
    type CalendarEventRevision,
    type CalendarEventUpdatedPayload,
    type CalendarEventVersionListResponse,
    type CalendarOccurrence,
    type CreateCalendarEventRequest,
    type UpdateCalendarEventRequest,
} from "@slopus/happy-agent-client";
import type { Static, TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";
import { createUuidV7Factory } from "../../utils/createUuidV7.js";
import type { SurfacesPersistence } from "../persistence/SurfacesPersistence.js";
import { SurfaceError } from "../SurfaceError.js";
import {
    CALENDAR_MAX_INSTANT,
    compareOccurrences,
    expandCalendarEvent,
    seriesBounds,
} from "./expandCalendarEvent.js";
import { normalizeRecurrence, validateCalendarSeries } from "./validateCalendarSeries.js";
import { isTimeZone } from "./zonedTime.js";
import type { SurfaceSearch } from "../search/SurfaceSearch.js";

type Actor = CalendarEventRevision["actor"];
type Notify = (
    ctx: Context,
    event:
        | { type: "calendar_event.created"; payload: { event: CalendarEvent; mutationId?: string } }
        | { type: "calendar_event.updated"; payload: CalendarEventUpdatedPayload },
) => Promise<void>;

/** The fields an update may set; a revision's values for them restore it exactly. */
const EDITABLE = ["title", "notes", "location", "timing", "recurrence", "status"] as const;

export type CalendarRange = {
    readonly events: CalendarEvent[];
    readonly occurrences: CalendarOccurrence[];
    readonly truncated: boolean;
};

/**
 * Calendar events of calendar Surfaces. Current records live in their own table with the instant
 * bounds a range read filters on; every change also appends an immutable full revision to AgentKV.
 * Every operation runs in its caller's transaction, and notifications follow its commit.
 */
export class SurfaceCalendars {
    constructor(
        readonly store: SurfacesPersistence,
        readonly kv: AgentKV,
        readonly notify: Notify,
        readonly search: SurfaceSearch,
    ) {}

    /** Occurrences overlapping `[from, to)`, at most a bounded number, with their events. */
    async range(
        ctx: Context,
        surfaceId: string,
        from: number,
        to: number,
        timeZone: string,
        maxOccurrences = CALENDAR_RANGE_MAX_OCCURRENCES,
    ): Promise<CalendarRange> {
        if (
            !Number.isSafeInteger(from) ||
            !Number.isSafeInteger(to) ||
            from < 0 ||
            to > CALENDAR_MAX_INSTANT + 1 ||
            from >= to ||
            to - from > CALENDAR_RANGE_MAX_MS
        )
            throw new SurfaceError(
                "invalid_request",
                "A calendar range needs from before to, at most 100 days apart.",
            );
        if (!isTimeZone(timeZone))
            throw new SurfaceError(
                "invalid_request",
                `${JSON.stringify(timeZone)} is not a recognized IANA time zone, such as Europe/Berlin or UTC.`,
            );
        const events = (await this.store.calendarEventsOverlapping(ctx, surfaceId, from, to)).map(
            readEvent,
        );
        const all = events
            .flatMap((event) => expandCalendarEvent(event.id, event, from, to, timeZone))
            .sort(compareOccurrences);
        const kept = all.slice(0, maxOccurrences);
        const referenced = new Set(kept.map((occurrence) => occurrence.eventId));
        return {
            events: events.filter((event) => referenced.has(event.id)),
            occurrences: kept.map(({ eventId, index, timing }) => ({ eventId, index, timing })),
            truncated: all.length > kept.length,
        };
    }

    async get(ctx: Context, surfaceId: string, id: string): Promise<CalendarEvent> {
        const stored = await this.store.readCalendarEvent(ctx, surfaceId, id);
        if (stored === undefined)
            throw new SurfaceError(
                "not_found",
                "The calendar event was not found in this Surface.",
            );
        return readEvent(stored);
    }

    async create(
        ctx: Context,
        surfaceId: string,
        id: string,
        input: CreateCalendarEventRequest,
        actor: Actor,
        authorUserId: string | null,
    ): Promise<CalendarEvent> {
        checked(createCalendarEventRequestSchema, input);
        const old = await this.store.readCalendarEvent(ctx, surfaceId, id);
        if (old !== undefined) return readEvent(old);
        const recurrence = normalizeRecurrence(input.recurrence);
        validateCalendarSeries(input.timing, recurrence);
        const now = Date.now();
        const event = checked(calendarEventSchema, {
            id,
            surfaceId,
            authorUserId,
            title: input.title ?? "",
            notes: input.notes ?? null,
            location: input.location ?? null,
            timing: input.timing,
            recurrence,
            status: "active",
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
            version: createUuidV7Factory()(),
        });
        await this.#save(ctx, event, actor);
        await this.notify(ctx, {
            type: "calendar_event.created",
            payload: { event, ...echo(input.mutationId) },
        });
        return event;
    }

    /** Apply an edit or deletion to the whole series, guarded by the version the caller read. */
    async mutate(
        ctx: Context,
        surfaceId: string,
        id: string,
        version: string,
        edit: UpdateCalendarEventRequest | "delete",
        actor: Actor,
        mutationId?: string,
    ): Promise<CalendarEvent> {
        const current = await this.get(ctx, surfaceId, id);
        if (current.version !== version)
            throw new SurfaceError("conflict", "The calendar event has changed.", {
                event: current,
            });
        const changes =
            edit === "delete"
                ? { status: "deleted" as const }
                : checked(updateCalendarEventRequestSchema, edit);
        const candidate: Record<string, unknown> = { ...current };
        for (const field of EDITABLE)
            if (changes[field] !== undefined)
                candidate[field] =
                    field === "recurrence"
                        ? normalizeRecurrence(changes.recurrence)
                        : changes[field];
        if (candidate["status"] !== current.status)
            candidate["deletedAt"] = candidate["status"] === "deleted" ? Date.now() : null;
        const changed = [...EDITABLE, "deletedAt" as const].filter(
            (field) => JSON.stringify(candidate[field]) !== JSON.stringify(current[field]),
        );
        if (changed.length === 0) return current;
        if (changed.includes("timing") || changed.includes("recurrence"))
            validateCalendarSeries(
                candidate["timing"] as CalendarEvent["timing"],
                candidate["recurrence"] as CalendarEvent["recurrence"],
            );
        const event = checked(calendarEventSchema, {
            ...candidate,
            updatedAt: Date.now(),
            version: createUuidV7Factory(Date.now, current.version)(),
        });
        await this.#save(ctx, event, actor);
        await this.notify(ctx, {
            type: "calendar_event.updated",
            payload: {
                surfaceId,
                eventId: id,
                previousVersion: current.version,
                version: event.version,
                changes: {
                    ...Object.fromEntries(changed.map((field) => [field, event[field]])),
                    updatedAt: event.updatedAt,
                },
                ...echo(mutationId),
            },
        });
        return event;
    }

    async versions(
        ctx: Context,
        surfaceId: string,
        id: string,
        afterVersion: string | undefined,
        limit: number,
    ): Promise<CalendarEventVersionListResponse> {
        await this.get(ctx, surfaceId, id);
        if (afterVersion !== undefined) await this.version(ctx, surfaceId, id, afterVersion);
        const rows = (
            await this.store.queryPage(
                ctx,
                `calendar-revision.${surfaceId}.${id}.`,
                afterVersion ?? "",
                limit + 1,
            )
        ).map((row) => checked(calendarEventRevisionSchema, row));
        const versions = rows.slice(0, limit);
        return {
            versions,
            nextAfterVersion: rows.length > limit ? versions.at(-1)!.event.version : null,
        };
    }

    async version(
        ctx: Context,
        surfaceId: string,
        id: string,
        version: string,
    ): Promise<CalendarEventRevision> {
        await this.get(ctx, surfaceId, id);
        const row = await this.kv.read(ctx, `calendar-revision.${surfaceId}.${id}.${version}`);
        if (row === undefined)
            throw new SurfaceError("not_found", "The calendar event revision was not found.");
        return checked(calendarEventRevisionSchema, row);
    }

    async #save(ctx: Context, event: CalendarEvent, actor: Actor): Promise<void> {
        const revision = checked(calendarEventRevisionSchema, {
            event,
            actor,
            source: actor.agentId === null ? "api" : "tool",
        });
        if (
            !(await this.store.writeValueIfAbsent(
                ctx,
                `calendar-revision.${event.surfaceId}.${event.id}.${event.version}`,
                revision,
            ))
        )
            throw new Error("A calendar event revision cannot be overwritten.");
        const bounds = seriesBounds(event);
        await this.store.writeCalendarEvent(ctx, {
            surfaceId: event.surfaceId,
            eventId: event.id,
            status: event.status,
            lower: bounds.lower,
            upper: bounds.upper,
            event,
        });
        await this.search.indexCalendarEvent(ctx, event);
    }
}

function readEvent(value: unknown): CalendarEvent {
    return checked(calendarEventSchema, value);
}
function echo(mutationId?: string) {
    return mutationId === undefined ? {} : { mutationId };
}
function checked<S extends TSchema>(schema: S, value: unknown): Static<S> {
    if (!Value.Check(schema, value))
        throw new SurfaceError(
            "invalid_request",
            "The calendar request or stored event is invalid.",
        );
    return value as Static<S>;
}
