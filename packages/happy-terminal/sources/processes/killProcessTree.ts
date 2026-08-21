import { spawn } from "node:child_process";

import type { Context } from "@steve.kite/stdlib";

export function killProcessTree(
    ctx: Context,
    pid: number,
    signal: NodeJS.Signals = "SIGTERM",
): Promise<void> {
    return ctx.span("happy.terminal.process.signal_tree", async () =>
        signalProcessTree(pid, signal),
    );
}

function signalProcessTree(pid: number, signal: NodeJS.Signals): void {
    if (process.platform === "win32") {
        try {
            const args =
                signal === "SIGKILL"
                    ? ["/F", "/T", "/PID", String(pid)]
                    : ["/T", "/PID", String(pid)];
            const killer = spawn("taskkill", args, {
                detached: true,
                stdio: "ignore",
                windowsHide: true,
            });
            killer.unref();
        } catch {
            // The process may already be gone.
        }
        return;
    }

    try {
        process.kill(-pid, signal);
    } catch {
        try {
            process.kill(pid, signal);
        } catch {
            // The process may already be gone.
        }
    }
}
