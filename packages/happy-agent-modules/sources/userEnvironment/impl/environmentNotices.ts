import type { SessionSystemMessage } from "@slopus/happy-providers";

import type { UserCalendar, UserDeviceKind, UserHourCycle } from "../UserEnvironment.js";
import { USER_ENVIRONMENT_ASPECTS, type ToldEnvironment } from "./toldEnvironment.js";

/**
 * The text an agent receives. It is fixed English built from the values themselves rather than
 * from `Intl` display names, which differ between runtimes and ICU versions.
 */

const CLOCKS: Record<UserHourCycle, string> = {
    h11: "12-hour (0–11)",
    h12: "12-hour",
    h23: "24-hour",
    h24: "24-hour (1–24)",
};

/** Where the person is, as the first-turn note names it and as a move is announced. */
const DEVICES: Record<UserDeviceKind, { readonly name: string; readonly moved: string }> = {
    phone: { name: "phone", moved: "on their phone" },
    tablet: { name: "tablet", moved: "on their tablet" },
    desktop: { name: "computer", moved: "on their computer" },
    web: { name: "web browser", moved: "in a web browser" },
};

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

const CALENDARS: Record<UserCalendar, string> = {
    buddhist: "Buddhist",
    chinese: "Chinese",
    coptic: "Coptic",
    dangi: "Dangi",
    ethioaa: "Ethiopic Amete Alem",
    ethiopic: "Ethiopic",
    gregory: "Gregorian",
    hebrew: "Hebrew",
    indian: "Indian national",
    islamic: "Hijri",
    "islamic-civil": "Hijri (tabular, civil epoch)",
    "islamic-rgsa": "Hijri (Saudi Arabia sighting)",
    "islamic-tbla": "Hijri (tabular, astronomical epoch)",
    "islamic-umalqura": "Hijri (Umm al-Qura)",
    iso8601: "ISO 8601",
    japanese: "Japanese",
    persian: "Persian",
    roc: "Minguo",
};

/**
 * What an agent that has never been told the environment receives on its first turn, e.g.
 * `User environment (phone): time zone Europe/Berlin (UTC+1), language de-DE, 24-hour clock, week
 * starts Monday, Gregorian calendar. Their local time is now Tuesday 2026-11-10 10:30.`
 */
export function environmentNotice(
    told: ToldEnvironment,
    device: UserDeviceKind | undefined,
    at: number,
): SessionSystemMessage {
    const parts = [
        told.timeZone === undefined
            ? undefined
            : `time zone ${told.timeZone} (${utcOffset(told.timeZone, at)})`,
        told.language === undefined ? undefined : `language ${told.language}`,
        told.hourCycle === undefined ? undefined : `${CLOCKS[told.hourCycle]} clock`,
        told.firstDayOfWeek === undefined
            ? undefined
            : `week starts ${DAYS[told.firstDayOfWeek - 1]}`,
        told.calendar === undefined ? undefined : `${CALENDARS[told.calendar]} calendar`,
    ].filter((part) => part !== undefined);
    const source = device === undefined ? "" : ` (${DEVICES[device].name})`;
    return notice([
        `User environment${source}: ${parts.join(", ")}.`,
        localTime(told.timeZone, at),
    ]);
}

/**
 * What an agent receives when the environment differs from the one it was last told: where the
 * person moved to when the environment now comes from another device of a known kind, one
 * sentence for each aspect that changed, and the local time when the zone did.
 */
export function environmentChangeNotice(
    before: ToldEnvironment,
    after: ToldEnvironment,
    movedTo: UserDeviceKind | undefined,
    at: number,
): SessionSystemMessage {
    const sentences = USER_ENVIRONMENT_ASPECTS.filter(
        (aspect) => after[aspect] !== undefined && before[aspect] !== after[aspect],
    ).map((aspect) => {
        const subject = SUBJECTS[aspect];
        const to = describe(aspect, after, at);
        return before[aspect] === undefined
            ? `The user's ${subject} is now ${to}.`
            : `The user's ${subject} changed from ${describe(aspect, before)} to ${to}.`;
    });
    const zoneChanged = after.timeZone !== undefined && before.timeZone !== after.timeZone;
    return notice([
        movedTo === undefined ? undefined : `The user is now ${DEVICES[movedTo].moved}.`,
        ...sentences,
        zoneChanged ? localTime(after.timeZone, at) : undefined,
    ]);
}

const SUBJECTS = {
    timeZone: "time zone",
    language: "language",
    hourCycle: "clock",
    firstDayOfWeek: "first day of the week",
    calendar: "calendar",
} as const;

/** One aspect's value as the model reads it; a zone carries its offset only when `at` is given. */
function describe(
    aspect: (typeof USER_ENVIRONMENT_ASPECTS)[number],
    told: ToldEnvironment,
    at?: number,
): string {
    switch (aspect) {
        case "timeZone":
            return at === undefined
                ? told.timeZone!
                : `${told.timeZone!} (${utcOffset(told.timeZone!, at)})`;
        case "language":
            return told.language!;
        case "hourCycle":
            return CLOCKS[told.hourCycle!];
        case "firstDayOfWeek":
            return DAYS[told.firstDayOfWeek! - 1]!;
        case "calendar":
            return CALENDARS[told.calendar!];
    }
}

function notice(sentences: readonly (string | undefined)[]): SessionSystemMessage {
    const text = sentences.filter((sentence) => sentence !== undefined).join(" ");
    return { role: "system", content: [{ type: "text", text }] };
}

/** `Their local time is now Tuesday 2026-11-10 18:30.`, or nothing without a zone. */
function localTime(timeZone: string | undefined, at: number): string | undefined {
    if (timeZone === undefined) return undefined;
    const local = new Date(at + offsetMinutes(timeZone, at) * 60_000);
    const day = DAYS[(local.getUTCDay() + 6) % 7];
    const date = local.toISOString().slice(0, 10);
    const time = local.toISOString().slice(11, 16);
    return `Their local time is now ${day} ${date} ${time}.`;
}

/** `UTC+9`, `UTC+5:30`, `UTC-3:30`, or `UTC` for the zone at that moment. */
function utcOffset(timeZone: string, at: number): string {
    const minutes = offsetMinutes(timeZone, at);
    if (minutes === 0) return "UTC";
    const sign = minutes < 0 ? "-" : "+";
    const hours = Math.floor(Math.abs(minutes) / 60);
    const rest = Math.abs(minutes) % 60;
    return `UTC${sign}${hours}${rest === 0 ? "" : `:${String(rest).padStart(2, "0")}`}`;
}

function offsetMinutes(timeZone: string, at: number): number {
    const name = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
        .formatToParts(at)
        .find((part) => part.type === "timeZoneName")?.value;
    const match = /^GMT([+-])(\d{2}):(\d{2})$/.exec(name ?? "");
    if (match === null) return 0;
    const minutes = Number(match[2]) * 60 + Number(match[3]);
    return match[1] === "-" ? -minutes : minutes;
}
