/**
 * User environment: what each of a person's devices reports about the time zone, languages,
 * clock, week, and calendar they work in, so the person's agents can be told about it.
 */

import { type Static, Type } from "@sinclair/typebox";

import { mutationIdSchema } from "./common.js";

/** An opaque ID a client generates once for its device and keeps, such as a UUID. */
export const userDeviceIdSchema = Type.String({ pattern: "^[A-Za-z0-9._:-]{1,64}$" });
export type UserDeviceId = Static<typeof userDeviceIdSchema>;

export const userDeviceKindSchema = Type.Union([
    Type.Literal("phone"),
    Type.Literal("tablet"),
    Type.Literal("desktop"),
    Type.Literal("web"),
]);
export type UserDeviceKind = Static<typeof userDeviceKindSchema>;

const environmentNameSchema = Type.String({
    minLength: 1,
    maxLength: 64,
    pattern: "^[^\\u0000-\\u001f\\u007f-\\u009f]+$",
});

export const userHourCycleSchema = Type.Union([
    Type.Literal("h11"),
    Type.Literal("h12"),
    Type.Literal("h23"),
    Type.Literal("h24"),
]);
export type UserHourCycle = Static<typeof userHourCycleSchema>;

/** The BCP 47 calendar identifiers the daemon accepts. */
export const USER_CALENDARS = [
    "buddhist",
    "chinese",
    "coptic",
    "dangi",
    "ethioaa",
    "ethiopic",
    "gregory",
    "hebrew",
    "indian",
    "islamic",
    "islamic-civil",
    "islamic-rgsa",
    "islamic-tbla",
    "islamic-umalqura",
    "iso8601",
    "japanese",
    "persian",
    "roc",
] as const;
export const userCalendarSchema = Type.Union(USER_CALENDARS.map((id) => Type.Literal(id)));
export type UserCalendar = Static<typeof userCalendarSchema>;

const environmentFields = {
    /** An IANA time zone, stored in its canonical spelling. */
    timeZone: Type.Optional(environmentNameSchema),
    /** The formatting locale, a BCP 47 tag. */
    locale: Type.Optional(environmentNameSchema),
    /** Preferred languages, most preferred first, as BCP 47 tags. */
    languages: Type.Optional(Type.Array(environmentNameSchema, { minItems: 1, maxItems: 16 })),
    hourCycle: Type.Optional(userHourCycleSchema),
    /** 1 for Monday through 7 for Sunday. */
    firstDayOfWeek: Type.Optional(Type.Integer({ minimum: 1, maximum: 7 })),
    calendar: Type.Optional(userCalendarSchema),
};

/**
 * `PUT /v0/environment` — one device's report. A field left out keeps its stored value; nothing
 * can be cleared. `utcOffsetMinutes` is advisory and never stored.
 */
export const reportEnvironmentRequestSchema = Type.Object(
    {
        mutationId: Type.Optional(mutationIdSchema),
        deviceId: userDeviceIdSchema,
        deviceKind: Type.Optional(userDeviceKindSchema),
        ...environmentFields,
        utcOffsetMinutes: Type.Optional(Type.Integer({ minimum: -720, maximum: 840 })),
    },
    { additionalProperties: false },
);
export type ReportEnvironmentRequest = Static<typeof reportEnvironmentRequestSchema>;

/** One device's stored environment; a field the device never reported is omitted. */
export const userDeviceEnvironmentSchema = Type.Object({
    deviceId: userDeviceIdSchema,
    deviceKind: Type.Optional(userDeviceKindSchema),
    ...environmentFields,
    /** When this device's environment or kind last changed. */
    updatedAt: Type.Integer({ minimum: 0 }),
    /** When this device last reported, whether or not anything changed. */
    reportedAt: Type.Integer({ minimum: 0 }),
});
export type UserDeviceEnvironment = Static<typeof userDeviceEnvironmentSchema>;

/** `PUT /v0/environment` — the device's environment as now stored. */
export const reportEnvironmentResponseSchema = Type.Object({
    environment: userDeviceEnvironmentSchema,
});
export type ReportEnvironmentResponse = Static<typeof reportEnvironmentResponseSchema>;
