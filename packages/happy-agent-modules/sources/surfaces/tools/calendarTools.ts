import { createId } from "@paralleldrive/cuid2";
import { defineAgentTool, cuid2Schema } from "@slopus/happy-agent-base";
import { Type } from "@sinclair/typebox";
import {
    calendarDateSchema,
    calendarEventLocationSchema,
    calendarEventNotesSchema,
    calendarEventSchema,
    calendarEventStatusSchema,
    calendarEventTitleSchema,
    calendarRecurrenceInputSchema,
    calendarRecurrenceSchema,
    calendarTimeZoneSchema,
    resourceVersionSchema,
    surfaceIdSchema,
    surfaceMemberSchema,
    type CalendarEvent,
    type CalendarEventRevision,
    type UpdateCalendarEventRequest,
} from "@slopus/happy-agent-client";
import type { SurfacesModule } from "../SurfacesModule.js";
import {
    LOCAL_DATE_TIME_PATTERN,
    apiTimingToTool,
    formatToolDateTime,
    parseToolBoundary,
    toolTimingToApi,
} from "../calendar/calendarToolTime.js";

const textResult = (result: unknown) => [{ type: "text" as const, text: JSON.stringify(result) }];
const localDateTime = Type.String({ pattern: LOCAL_DATE_TIME_PATTERN });
const timedFields = {
    kind: Type.Literal("timed"),
    start: localDateTime,
    end: localDateTime,
    timeZone: calendarTimeZoneSchema,
};
const allDayTiming = Type.Object(
    { kind: Type.Literal("allDay"), startDate: calendarDateSchema, endDate: calendarDateSchema },
    { additionalProperties: false },
);
/** Timed values are local wall-clock date-times in the named IANA zone; all-day ends exclude. */
const toolTimingInput = Type.Union([
    Type.Object(timedFields, { additionalProperties: false }),
    allDayTiming,
]);
const toolTiming = Type.Union([Type.Object(timedFields), allDayTiming]);
const {
    timing: _timing,
    status: _status,
    deletedAt: _deletedAt,
    ...eventFields
} = calendarEventSchema.anyOf[0].properties;
const toolEvent = Type.Object({
    ...eventFields,
    recurrence: Type.Union([calendarRecurrenceSchema, Type.Null()]),
    timing: toolTiming,
    status: calendarEventStatusSchema,
    deletedAt: Type.Union([Type.Integer(), Type.Null()]),
});
const toolRevision = Type.Object({
    event: toolEvent,
    actor: Type.Object({
        userId: Type.Union([Type.String(), Type.Null()]),
        agentId: Type.Union([Type.String(), Type.Null()]),
    }),
    source: Type.Union([Type.Literal("api"), Type.Literal("tool")]),
});
const identity = { surfaceId: surfaceIdSchema, eventId: cuid2Schema };
const guard = { ...identity, version: resourceVersionSchema };
const editable = {
    title: calendarEventTitleSchema,
    notes: Type.Union([calendarEventNotesSchema, Type.Null()]),
    location: Type.Union([calendarEventLocationSchema, Type.Null()]),
    timing: toolTimingInput,
    recurrence: Type.Union([calendarRecurrenceInputSchema, Type.Null()]),
};
/** The most occurrences one tool read returns. */
const TOOL_MAX_OCCURRENCES = 200;

const TIMING_RULES =
    "Timed timing is {kind:'timed', start, end, timeZone}: start and end are local wall-clock date-times such as 2026-10-20T09:00 in timeZone, an IANA name such as Europe/Berlin (never a bare offset). Use the zone the person means, usually their own. An optional trailing offset must match the zone at that time and picks one instant of a repeated hour; without it, a time skipped by a daylight-saving jump moves forward and a repeated time takes the earlier instant. All-day timing is {kind:'allDay', startDate, endDate} with endDate exclusive: a one-day event on 2026-10-20 has endDate 2026-10-21. Events last at most 366 days.";
const RECURRENCE_RULES =
    "Recurrence is null or {frequency: daily|weekly|monthly|yearly, interval (default 1), weekdays (weekly only: monday…sunday, or null for the start's weekday), until (inclusive YYYY-MM-DD) or count (total occurrences)}; at most one of until and count. The event's own timing is occurrence 0. Monthly and yearly skip months or years without the start's day (31st, 29 February). Times stay at the same wall-clock time across daylight-saving changes. There are no per-occurrence exceptions: every edit changes the whole series.";

const forModel = (event: CalendarEvent) => ({ ...event, timing: apiTimingToTool(event.timing) });
const revisionForModel = (revision: CalendarEventRevision) => ({
    ...revision,
    event: forModel(revision.event),
});

/** Fixed common calendar tools; every vendor receives the same definitions. */
export function calendarTools(
    surfaces: SurfacesModule,
    actor: (ctx: Parameters<SurfacesModule["actor"]>[0]) => ReturnType<SurfacesModule["actor"]>,
) {
    return [
        defineAgentTool({
            name: "list_calendar_events",
            defer: true,
            capabilities: ["Read the events of a shared calendar in a date range."],
            searchKeywords: [
                "list calendar events",
                "calendar agenda",
                "upcoming meetings",
                "what is on the calendar",
            ],
            description: `List the event occurrences of one calendar Surface that overlap a range of at most 100 days, with the events they belong to. Give from and to as local dates (YYYY-MM-DD, meaning midnight) or local date-times in timeZone, the IANA zone the person thinks in. Happy expands recurring events for you; never compute repeats yourself. Occurrence times are written in timeZone with offsets, as {kind:'timed', start, end} or all-day dates; each names its eventId and index in the series. Event timing is written in the event's own zone. Keep event versions for guarded edits. At most ${TOOL_MAX_OCCURRENCES} occurrences are returned in time order; when truncated is true, read a narrower range.`,
            parameters: Type.Object(
                {
                    surfaceId: surfaceIdSchema,
                    from: Type.String({ minLength: 10, maxLength: 40 }),
                    to: Type.String({ minLength: 10, maxLength: 40 }),
                    timeZone: calendarTimeZoneSchema,
                },
                { additionalProperties: false },
            ),
            returnType: Type.Object({
                timeZone: Type.String(),
                events: Type.Array(toolEvent),
                occurrences: Type.Array(
                    Type.Object({
                        eventId: Type.String(),
                        index: Type.Integer(),
                        timing: Type.Union([
                            Type.Object({
                                kind: Type.Literal("timed"),
                                start: Type.String(),
                                end: Type.String(),
                            }),
                            allDayTiming,
                        ]),
                    }),
                ),
                truncated: Type.Boolean(),
            }),
            durable: false,
            shouldReviewInAutoMode: () => false,
            autoReview: "never",
            execute: async (ctx, input) => {
                const range = await surfaces.listCalendar(
                    ctx,
                    input.surfaceId,
                    {
                        from: parseToolBoundary(input.from, input.timeZone, "from"),
                        to: parseToolBoundary(input.to, input.timeZone, "to"),
                        timeZone: input.timeZone,
                    },
                    TOOL_MAX_OCCURRENCES,
                );
                return {
                    timeZone: input.timeZone,
                    events: range.events.map(forModel),
                    occurrences: range.occurrences.map(({ eventId, index, timing }) => ({
                        eventId,
                        index,
                        timing:
                            timing.kind === "allDay"
                                ? timing
                                : {
                                      kind: "timed" as const,
                                      start: formatToolDateTime(timing.start, input.timeZone),
                                      end: formatToolDateTime(timing.end, input.timeZone),
                                  },
                    })),
                    truncated: range.truncated,
                };
            },
            toLLM: textResult,
        }),
        defineAgentTool({
            name: "create_calendar_event",
            defer: true,
            capabilities: ["Add a one-off or recurring event to a shared calendar."],
            searchKeywords: [
                "create calendar event",
                "schedule meeting",
                "add appointment",
                "recurring event",
            ],
            description: `Add an event to one calendar Surface. ${TIMING_RULES} ${RECURRENCE_RULES} The title may be empty. Explicitly supply authorUserId as a local Happy user ID, or null for no attribution; only null is allowed in standalone mode. The author is immutable and separate from the revision's audit actor. This never joins anyone to the Surface.`,
            parameters: Type.Object(
                {
                    surfaceId: surfaceIdSchema,
                    title: Type.Optional(editable.title),
                    notes: Type.Optional(editable.notes),
                    location: Type.Optional(editable.location),
                    timing: editable.timing,
                    recurrence: Type.Optional(editable.recurrence),
                    authorUserId: surfaceMemberSchema.properties.userId,
                },
                { additionalProperties: false },
            ),
            returnType: toolEvent,
            durable: true,
            transactional: true,
            requiresAutoOrFullAccess: true,
            shouldReviewInAutoMode: () => true,
            describeAutoPermissionAction: ({ surfaceId }) =>
                `adding an event to shared calendar Surface ${JSON.stringify(surfaceId)}. Access: shared data write`,
            execute: async (ctx, input, call) => {
                const { surfaceId, authorUserId, timing, ...fields } = input;
                return forModel(
                    await surfaces.createCalendarEvent(
                        ctx,
                        surfaceId,
                        {
                            ...fields,
                            timing: toolTimingToApi(timing),
                            id: await call.kv.getOrCreate(ctx, "eventId", createId),
                        },
                        await actor(ctx),
                        authorUserId,
                    ),
                );
            },
            toLLM: textResult,
        }),
        defineAgentTool({
            name: "update_calendar_event",
            defer: true,
            capabilities: ["Change, move, or restore a calendar event, including its recurrence."],
            searchKeywords: [
                "edit calendar event",
                "move meeting",
                "reschedule event",
                "restore calendar event",
                "undelete event",
            ],
            description: `Edit one calendar event with the version you read. Supply only the fields to change; timing and recurrence replace the whole value. Edits change the whole series. Set notes, location, or recurrence to null to clear them and title to "" to empty it. status 'active' undeletes a deleted event and 'deleted' deletes it. To restore an earlier state, read it with list_calendar_event_versions and pass its title, notes, location, timing, recurrence, and status here with the current version; history keeps every state. ${TIMING_RULES} ${RECURRENCE_RULES} Conflicts require a fresh read.`,
            parameters: Type.Object(
                {
                    ...guard,
                    title: Type.Optional(editable.title),
                    notes: Type.Optional(editable.notes),
                    location: Type.Optional(editable.location),
                    timing: Type.Optional(editable.timing),
                    recurrence: Type.Optional(editable.recurrence),
                    status: Type.Optional(calendarEventStatusSchema),
                },
                { additionalProperties: false },
            ),
            returnType: toolEvent,
            durable: true,
            transactional: true,
            requiresAutoOrFullAccess: true,
            shouldReviewInAutoMode: () => true,
            describeAutoPermissionAction: ({ surfaceId, eventId }) =>
                `editing calendar event ${JSON.stringify(eventId)} in shared Surface ${JSON.stringify(surfaceId)}. Access: shared data write`,
            execute: async (ctx, { surfaceId, eventId, version, timing, ...edit }) =>
                forModel(
                    await surfaces.mutateCalendarEvent(
                        ctx,
                        surfaceId,
                        eventId,
                        version,
                        // The module validates that at least one field is being edited.
                        (timing === undefined
                            ? edit
                            : {
                                  ...edit,
                                  timing: toolTimingToApi(timing),
                              }) as UpdateCalendarEventRequest,
                        await actor(ctx),
                    ),
                ),
            toLLM: textResult,
        }),
        defineAgentTool({
            name: "delete_calendar_event",
            defer: true,
            capabilities: ["Delete a calendar event series while preserving its history."],
            searchKeywords: ["delete calendar event", "cancel meeting", "remove appointment"],
            description:
                "Delete one calendar event with the version you read. A recurring event is deleted as a whole series. Every revision stays readable, and update_calendar_event with status 'active' restores it.",
            parameters: Type.Object(guard, { additionalProperties: false }),
            returnType: toolEvent,
            durable: true,
            transactional: true,
            requiresAutoOrFullAccess: true,
            shouldReviewInAutoMode: () => true,
            describeAutoPermissionAction: ({ surfaceId, eventId }) =>
                `deleting calendar event ${JSON.stringify(eventId)} from shared Surface ${JSON.stringify(surfaceId)} while preserving its history. Access: shared data write`,
            execute: async (ctx, input) =>
                forModel(
                    await surfaces.mutateCalendarEvent(
                        ctx,
                        input.surfaceId,
                        input.eventId,
                        input.version,
                        "delete",
                        await actor(ctx),
                    ),
                ),
            toLLM: textResult,
        }),
        defineAgentTool({
            name: "list_calendar_event_versions",
            defer: true,
            capabilities: ["Read a calendar event's permanent revisions and who made them."],
            searchKeywords: [
                "calendar event history",
                "event versions",
                "previous event state",
                "deleted event",
            ],
            description:
                "Read a bounded page of one calendar event's permanent full revisions and their actors, oldest first, with timing in the event's own zone. Each entry is a complete snapshot; restore one by passing its fields to update_calendar_event with the current version. Continue with nextAfterVersion.",
            parameters: Type.Object(
                {
                    ...identity,
                    afterVersion: Type.Optional(resourceVersionSchema),
                    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
                },
                { additionalProperties: false },
            ),
            returnType: Type.Object({
                versions: Type.Array(toolRevision),
                nextAfterVersion: Type.Union([resourceVersionSchema, Type.Null()]),
            }),
            durable: false,
            shouldReviewInAutoMode: () => false,
            autoReview: "never",
            execute: async (ctx, input) => {
                const page = await surfaces.calendarEventVersions(
                    ctx,
                    input.surfaceId,
                    input.eventId,
                    input.afterVersion,
                    input.limit ?? 10,
                );
                return {
                    versions: page.versions.map(revisionForModel),
                    nextAfterVersion: page.nextAfterVersion,
                };
            },
            toLLM: textResult,
        }),
    ];
}
