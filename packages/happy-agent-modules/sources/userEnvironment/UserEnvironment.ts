import { cuid2Schema } from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";

/** The one person of a standalone installation, who has no team user ID. */
export const STANDALONE_USER_ENVIRONMENT_OWNER = "standalone";

/** Whose environment: a team user's installation-local ID, or the standalone installation's person. */
export const userEnvironmentOwnerSchema = Type.Union([
    cuid2Schema,
    Type.Literal(STANDALONE_USER_ENVIRONMENT_OWNER),
]);
export type UserEnvironmentOwner = Static<typeof userEnvironmentOwnerSchema>;

const nameSchema = Type.String({
    minLength: 1,
    maxLength: 64,
    pattern: "^[^\\u0000-\\u001f\\u007f-\\u009f]+$",
});

/** An IANA time zone name, such as `Europe/Berlin`. */
export const userTimeZoneSchema = nameSchema;

/** A BCP 47 language tag, such as `de-DE`. */
export const userLocaleSchema = nameSchema;

/** How the person's clock counts hours, as `Intl.Locale` names it. */
export const userHourCycleSchema = Type.Union([
    Type.Literal("h11"),
    Type.Literal("h12"),
    Type.Literal("h23"),
    Type.Literal("h24"),
]);
export type UserHourCycle = Static<typeof userHourCycleSchema>;

/**
 * The BCP 47 calendar identifiers. They are listed rather than read from the runtime, because
 * runtimes disagree: Bun does not offer `islamic` or `islamic-rgsa`.
 */
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

/** How long a device may go without reporting before it no longer stands in for the person. */
export const USER_DEVICE_STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The most devices one person keeps. A browser that clears its storage comes back as a new
 * device, so the least recently reported are forgotten beyond this.
 */
export const MAX_USER_DEVICES = 32;

/**
 * One of the person's devices, named by an opaque ID its client generates once and keeps, such as
 * a UUID. It identifies a device only among that person's own; it carries no authority.
 */
export const userDeviceIdSchema = Type.String({ pattern: "^[A-Za-z0-9._:-]{1,64}$" });

/** What kind of device it is, so an agent can be told the person moved to their phone. */
export const userDeviceKindSchema = Type.Union([
    Type.Literal("phone"),
    Type.Literal("tablet"),
    Type.Literal("desktop"),
    Type.Literal("web"),
]);
export type UserDeviceKind = Static<typeof userDeviceKindSchema>;

/**
 * Everything known about one device's environment. Every field is optional, because each is known
 * only once that device has reported it.
 */
export const userEnvironmentSchema = Type.Object(
    {
        timeZone: Type.Optional(userTimeZoneSchema),
        /** The formatting locale. */
        locale: Type.Optional(userLocaleSchema),
        /** Preferred languages in order; the first is the primary language. */
        languages: Type.Optional(Type.Array(userLocaleSchema, { minItems: 1, maxItems: 16 })),
        hourCycle: Type.Optional(userHourCycleSchema),
        /** ISO numbering, 1 for Monday through 7 for Sunday, as `Intl.Locale` week info. */
        firstDayOfWeek: Type.Optional(Type.Integer({ minimum: 1, maximum: 7 })),
        calendar: Type.Optional(userCalendarSchema),
    },
    { additionalProperties: false },
);
export type UserEnvironment = Static<typeof userEnvironmentSchema>;

/**
 * What one device reports. A field it leaves out, `deviceKind` included, was not reported and
 * keeps what that device stored before. `utcOffsetMinutes` is advisory and never stored: the offset follows from the zone
 * and the moment, and a reported one goes stale at the next daylight-saving change.
 */
export const userEnvironmentReportSchema = Type.Object(
    {
        deviceId: userDeviceIdSchema,
        deviceKind: Type.Optional(userDeviceKindSchema),
        ...userEnvironmentSchema.properties,
        utcOffsetMinutes: Type.Optional(Type.Integer({ minimum: -720, maximum: 840 })),
    },
    { additionalProperties: false },
);
export type UserEnvironmentReport = Static<typeof userEnvironmentReportSchema>;

/** One device's stored environment, when it last changed, and when the device last reported. */
export interface StoredUserEnvironment {
    readonly deviceId: string;
    readonly deviceKind?: UserDeviceKind;
    readonly environment: UserEnvironment;
    readonly updatedAt: number;
    readonly reportedAt: number;
}

/** The parts of an environment an agent is told about. Secondary languages are not among them. */
export type UserEnvironmentAspect =
    | "timeZone"
    | "language"
    | "hourCycle"
    | "firstDayOfWeek"
    | "calendar";

/**
 * What one report did: the device's environment now stored, and which of its aspects changed. A
 * report that changed nothing lists none.
 */
export interface UserEnvironmentReportResult extends StoredUserEnvironment {
    readonly changed: readonly UserEnvironmentAspect[];
}
