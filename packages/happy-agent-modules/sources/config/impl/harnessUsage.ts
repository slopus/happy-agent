import { execFile } from "node:child_process";

/** Share of one quota window a foreign agent says is left. */
export interface HarnessUsageWindow {
    /** Which models the window covers, in the agent's words, such as "Gemini Models". */
    readonly scope: string;
    /** The window, in the agent's words, such as "Weekly Limit Remaining". */
    readonly window: string;
    readonly remainingPercent: number;
    /** ISO time the window resets, or null when unreported. */
    readonly resetsAt: string | null;
}

const USAGE_TIMEOUT_MS = 60_000;

/**
 * Antigravity's own quota, from `agy -p /usage`: one tab-separated row per window, naming the
 * models it covers, the window, the share left, and when it resets. The command reads the
 * signed-in account's quota without running a model. `AGY_BIN` names another `agy`, as it does
 * for the adapter.
 */
export async function readAntigravityUsage(
    environment: NodeJS.ProcessEnv,
): Promise<readonly HarnessUsageWindow[]> {
    const binary = environment["AGY_BIN"] ?? (process.platform === "win32" ? "agy.exe" : "agy");
    const stdout = await new Promise<string>((resolve, reject) => {
        const child = execFile(
            binary,
            ["-p", "/usage"],
            {
                env: environment,
                timeout: USAGE_TIMEOUT_MS,
                maxBuffer: 1024 * 1024,
                windowsHide: true,
            },
            (error, out) => (error === null ? resolve(out) : reject(error)),
        );
        child.stdin?.end();
    });
    return parseAntigravityUsage(stdout);
}

export function parseAntigravityUsage(output: string): readonly HarnessUsageWindow[] {
    const windows: HarnessUsageWindow[] = [];
    for (const line of output.split("\n")) {
        const columns = line.split("\t").map((column) => column.trim());
        if (columns.length !== 4) continue;
        const [scope, window, remaining, resetsAt] = columns as [string, string, string, string];
        const percent = Number.parseFloat(remaining);
        if (scope === "" || window === "" || !Number.isFinite(percent)) continue;
        windows.push({
            scope,
            window,
            remainingPercent: percent,
            resetsAt: Number.isNaN(Date.parse(resetsAt)) ? null : resetsAt,
        });
    }
    return windows;
}
