import { setTimeout as delay } from "node:timers/promises";
import type { Context } from "@steve.kite/stdlib";

import { isProcessRunning } from "./isProcessRunning.js";

const POLL_INTERVAL_MS = 50;

export function waitForProcessExit(
    ctx: Context,
    processId: number,
    timeoutMs: number,
): Promise<boolean> {
    return ctx.span("happy.terminal.process.wait_for_exit", async () => {
        const deadline = Date.now() + timeoutMs;
        while (await isProcessRunning(processId)) {
            const remainingMs = deadline - Date.now();
            if (remainingMs <= 0) return false;
            await delay(Math.min(POLL_INTERVAL_MS, remainingMs));
        }
        return true;
    });
}
