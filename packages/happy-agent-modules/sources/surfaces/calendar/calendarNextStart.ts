import { DAY_MS, fromLocal, parseDate, toLocal } from "./zonedTime.js";
import { occurrenceDays, seriesStartDay, type CalendarSeries } from "./expandCalendarEvent.js";

/** How many occurrences one lookup walks before settling for the last it reached. */
const MAX_WALK = 100_000;

/**
 * When a series next happens: the start of its first occurrence not over by `now`, or of its last
 * occurrence once the series has ended. All-day occurrences start at UTC midnight.
 */
export function calendarNextStart(series: CalendarSeries, now: number): number {
    const { timing, recurrence } = series;
    const startDay = seriesStartDay(timing);
    const spanDays =
        timing.kind === "timed" ? 0 : parseDate(timing.endDate)! - parseDate(timing.startDate)!;
    const duration = timing.kind === "timed" ? timing.end - timing.start : spanDays * DAY_MS;
    const startOf = (day: number, index: number) => {
        if (timing.kind !== "timed") return day * DAY_MS;
        if (index === 0) return timing.start;
        return fromLocal(
            { day, time: toLocal(timing.start, timing.timeZone).time },
            timing.timeZone,
        );
    };
    const today =
        timing.kind === "timed" ? toLocal(now, timing.timeZone).day : Math.floor(now / DAY_MS);
    let last: number | undefined;
    let walked = 0;
    for (const { day, index } of occurrenceDays(startDay, recurrence, today - spanDays - 1)) {
        const start = startOf(day, index);
        if (start + duration > now) return start;
        last = start;
        if (++walked >= MAX_WALK) return start;
    }
    if (last !== undefined) return last;
    // Every occurrence ended before the walk began; find the series' last one from its start.
    let final = startOf(startDay, 0);
    walked = 0;
    for (const { day, index } of occurrenceDays(startDay, recurrence, startDay)) {
        final = startOf(day, index);
        if (++walked >= MAX_WALK) break;
    }
    return final;
}
