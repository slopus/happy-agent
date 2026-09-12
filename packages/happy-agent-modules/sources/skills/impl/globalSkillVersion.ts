import { randomUUID } from "node:crypto";

/** Keep observed versions monotonic across restarts and backward clock adjustments. */
export function globalSkillVersion(previous?: string): string {
    const prior =
        previous === undefined
            ? -1
            : Number.parseInt(previous.replaceAll("-", "").slice(0, 12), 16);
    const time = Math.max(Date.now(), prior + 1);
    if (time > 0xffffffffffff) throw new Error("The skill version clock is exhausted.");
    const stamp = time.toString(16).padStart(12, "0");
    return `${stamp.slice(0, 8)}-${stamp.slice(8)}-7${randomUUID().slice(15)}`;
}
