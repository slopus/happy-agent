import { randomUUID } from "node:crypto";

/** A UUIDv7 after `previous`, so the list version keeps rising even if the clock moves backward. */
export function createRunnersVersion(previous?: string): string {
    const priorTime =
        previous === undefined
            ? -1
            : Number.parseInt(previous.replaceAll("-", "").slice(0, 12), 16);
    const time = Math.max(Date.now(), priorTime + 1);
    if (time > 0xffffffffffff) throw new Error("The runner list version clock is exhausted.");
    const timestamp = time.toString(16).padStart(12, "0");
    return `${timestamp.slice(0, 8)}-${timestamp.slice(8)}-7${randomUUID().slice(15)}`;
}
