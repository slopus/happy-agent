const DAY_MS = 24 * 60 * 60 * 1_000;
const HOUR_MS = 60 * 60 * 1_000;
/** No zone is further than this from UTC, so it bounds where a local day can begin. */
const MAX_OFFSET_MS = 15 * HOUR_MS;
const ZONE_NAME = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/u;

const formats = new Map<string, Intl.DateTimeFormat>();

/** One run of hours, from `start` onward, that share one offset from UTC. */
export interface OffsetSegment {
    readonly start: number;
    readonly offsetMs: number;
}

/**
 * Whether `timeZone` names a zone the runtime knows, such as `Europe/Berlin` or `UTC`. Offsets
 * such as `+05:00` are refused: the calendar is a place's, which follows its daylight saving.
 */
export function isTimeZone(timeZone: string): boolean {
    if (!ZONE_NAME.test(timeZone)) return false;
    try {
        format(timeZone);
        return true;
    } catch {
        return false;
    }
}

/** How far `timeZone`'s wall clock is ahead of UTC at `instant`, in milliseconds. */
export function offsetAt(timeZone: string, instant: number): number {
    const parts = Object.fromEntries(
        format(timeZone)
            .formatToParts(new Date(instant))
            .map((part) => [part.type, part.value]),
    );
    const wall = Date.UTC(
        Number(parts["year"]),
        Number(parts["month"]) - 1,
        Number(parts["day"]),
        Number(parts["hour"]),
        Number(parts["minute"]),
        Number(parts["second"]),
    );
    return wall - (instant - (((instant % 1_000) + 1_000) % 1_000));
}

/** The local day number, days since 1970-01-01 on `timeZone`'s calendar, of `instant`. */
export function localDay(timeZone: string, instant: number): number {
    return Math.floor((instant + offsetAt(timeZone, instant)) / DAY_MS);
}

/** `YYYY-MM-DD` for a local day number. */
export function formatLocalDay(day: number): string {
    return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

/** The earliest hour that can belong to local day `day` in any zone. */
export function earliestHourOf(day: number): number {
    const start = day * DAY_MS - MAX_OFFSET_MS;
    return start - (((start % HOUR_MS) + HOUR_MS) % HOUR_MS);
}

/**
 * The offsets `timeZone` uses for every hour from `from` through `to`, both whole UTC hours, as
 * runs that start where the offset changes. A zone changes its offset at most a few times a year,
 * so this is a handful of runs however long the range.
 */
export function offsetSegments(timeZone: string, from: number, to: number): OffsetSegment[] {
    const segments: OffsetSegment[] = [{ start: from, offsetMs: offsetAt(timeZone, from) }];
    let previous = from;
    while (previous < to) {
        const next = Math.min(to, previous + DAY_MS);
        const offsetMs = offsetAt(timeZone, next);
        const current = (segments.at(-1) as OffsetSegment).offsetMs;
        if (offsetMs !== current) {
            // A change between two samples a day apart: find the first hour that has it.
            let low = previous;
            let high = next;
            while (high - low > HOUR_MS) {
                const middle = low + Math.floor((high - low) / HOUR_MS / 2) * HOUR_MS;
                if (offsetAt(timeZone, middle) === current) low = middle;
                else high = middle;
            }
            segments.push({ start: high, offsetMs: offsetAt(timeZone, high) });
            if (offsetAt(timeZone, high) !== offsetMs) {
                // Two changes within one day; sample again from the change just found.
                previous = high;
                continue;
            }
        }
        previous = next;
    }
    return segments;
}

function format(timeZone: string): Intl.DateTimeFormat {
    let found = formats.get(timeZone);
    if (found === undefined) {
        found = new Intl.DateTimeFormat("en-US", {
            timeZone,
            hourCycle: "h23",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
        });
        if (formats.size >= 64) formats.clear();
        formats.set(timeZone, found);
    }
    return found;
}
