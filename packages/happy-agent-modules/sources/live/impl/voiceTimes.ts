/**
 * Times as voice says them: how long ago, as said aloud, and the exact minute on the person's
 * clock with its offset, so a spoken answer can be relative and an exact one is still at hand.
 */
export function voiceAgo(ms: number): string {
    const minutes = Math.floor(Math.max(0, ms) / 60_000);
    if (minutes < 1) return "just now";
    if (minutes === 1) return "a minute ago";
    if (minutes < 60) return `${String(minutes)} minutes ago`;
    const hours = Math.floor(minutes / 60);
    if (hours === 1) return "an hour ago";
    if (hours < 24) return `${String(hours)} hours ago`;
    const days = Math.floor(hours / 24);
    return days === 1 ? "yesterday" : `${String(days)} days ago`;
}

/** `2026-11-06T09:15+01:00` in the given IANA zone, to the minute; UTC for an unknown zone. */
export function voiceClock(at: number, timeZone: string | undefined): string {
    const zone = validZone(timeZone) ?? "UTC";
    const parts = Object.fromEntries(
        new Intl.DateTimeFormat("en-US", {
            timeZone: zone,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            hourCycle: "h23",
        })
            .formatToParts(new Date(at))
            .map((part) => [part.type, part.value]),
    );
    const local = Date.UTC(
        Number(parts["year"]),
        Number(parts["month"]) - 1,
        Number(parts["day"]),
        Number(parts["hour"]),
        Number(parts["minute"]),
    );
    const offset = Math.round((local - Math.floor(at / 60_000) * 60_000) / 60_000);
    const sign = offset < 0 ? "-" : "+";
    const hours = String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0");
    const minutes = String(Math.abs(offset) % 60).padStart(2, "0");
    return `${parts["year"]}-${parts["month"]}-${parts["day"]}T${parts["hour"]}:${parts["minute"]}${sign}${hours}:${minutes}`;
}

/** "5 minutes ago (2026-11-06T09:10+01:00)". */
export function voiceWhen(at: number, now: number, timeZone: string | undefined): string {
    return `${voiceAgo(now - at)} (${voiceClock(at, timeZone)})`;
}

/** The zone to tell voice about: the desktop's when it is a real zone, else this machine's. */
export function voiceTimeZone(timeZone: string | undefined): string {
    return validZone(timeZone) ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function validZone(timeZone: string | undefined): string | undefined {
    if (timeZone === undefined) return undefined;
    try {
        new Intl.DateTimeFormat("en-US", { timeZone });
        return timeZone;
    } catch {
        return undefined;
    }
}
