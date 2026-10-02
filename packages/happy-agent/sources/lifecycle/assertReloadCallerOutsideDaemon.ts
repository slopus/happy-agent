import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import { AgentDaemonError } from "./AgentDaemonError.js";

const execute = promisify(execFile);
const processRow = Type.Tuple([
    Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
]);

/** A reload cannot survive shutdown when its caller belongs to the daemon being stopped. */
export async function assertReloadCallerOutsideDaemon(
    daemonPid: number | undefined,
): Promise<void> {
    const reject = () => {
        throw new AgentDaemonError(
            "Cannot reload Happy Agent from a process owned by that daemon.",
            { hint: "Run happy-agent reload from an independent terminal or supervisor." },
        );
    };
    if (daemonPid === process.pid || daemonPid === process.ppid) reject();

    try {
        if (daemonPid === undefined) throw new Error("The daemon PID is unavailable.");
        const windows = process.platform === "win32";
        const { stdout } = await execute(
            windows ? "powershell.exe" : "/bin/ps",
            windows
                ? [
                      "-NoProfile",
                      "-NonInteractive",
                      "-Command",
                      '$ErrorActionPreference = "Stop"; Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -gt 0 } | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }',
                  ]
                : ["-A", "-o", "pid=,ppid="],
            { timeout: 5_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true, encoding: "utf8" },
        );
        const parents = new Map<number, number>();
        for (const line of stdout.trim().split(/\r?\n/)) {
            const row = line.trim().split(/\s+/).map(Number);
            if (!Value.Check(processRow, row)) throw new Error("Invalid process ancestry.");
            parents.set(row[0]!, row[1]!);
        }
        const visited = new Set<number>();
        let pid = process.ppid;
        while (pid > 0) {
            if (pid === daemonPid) reject();
            if (pid === 1) break;
            if (visited.has(pid)) throw new Error("Cyclic process ancestry.");
            visited.add(pid);
            const parent = parents.get(pid);
            if (parent === undefined) throw new Error("Incomplete process ancestry.");
            pid = parent;
        }
    } catch (error) {
        if (error instanceof AgentDaemonError) throw error;
        throw new AgentDaemonError("Cannot verify that reloading Happy Agent is safe.", {
            cause: error,
            hint: "The daemon was left running. Retry from an independent terminal or supervisor.",
        });
    }
}
