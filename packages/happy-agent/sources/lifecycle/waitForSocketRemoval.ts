import { lstat } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

const POLL_INTERVAL_MS = 50;

export async function waitForSocketRemoval(
    socketPath: string,
    timeoutMs: number,
): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
        try {
            await lstat(socketPath);
        } catch (error) {
            if (
                typeof error === "object" &&
                error !== null &&
                "code" in error &&
                (error as { code?: unknown }).code === "ENOENT"
            ) {
                return true;
            }
        }
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) return false;
        await delay(Math.min(POLL_INTERVAL_MS, remainingMs));
    }
}
