const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

/** Turns a past timestamp into a short human phrase such as "just now" or "3 days ago". */
export function formatRelativeTime(timestamp: number, now: number): string {
    const elapsed = Math.max(0, now - timestamp);
    if (elapsed < MINUTE_MS) return "just now";
    if (elapsed < HOUR_MS) return pluralize(Math.floor(elapsed / MINUTE_MS), "minute");
    if (elapsed < DAY_MS) return pluralize(Math.floor(elapsed / HOUR_MS), "hour");
    if (elapsed < WEEK_MS) return pluralize(Math.floor(elapsed / DAY_MS), "day");
    return new Date(timestamp).toLocaleDateString(undefined, {
        day: "numeric",
        month: "short",
    });
}

function pluralize(value: number, unit: string): string {
    return `${value} ${unit}${value === 1 ? "" : "s"} ago`;
}
