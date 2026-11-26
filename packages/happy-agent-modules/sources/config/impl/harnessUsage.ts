import type { ProviderUsage, ProviderUsageWindow } from "@slopus/happy-providers";

import { execFileHidden } from "../../utils/hiddenChildProcess.js";

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
const FIVE_HOUR_DURATION_MS = 5 * 60 * 60 * 1_000;
const WEEKLY_DURATION_MS = 7 * 24 * 60 * 60 * 1_000;

/**
 * Antigravity's own quota, from `agy -p /usage`: one tab-separated row per window, naming the
 * models it covers, the window, the share left, and when it resets. The command reads the
 * signed-in account's quota without running a model. `AGY_BIN` names another `agy`, as it does
 * for the adapter.
 */
export async function readAntigravityUsage(
    environment: NodeJS.ProcessEnv,
    signal?: AbortSignal,
): Promise<readonly HarnessUsageWindow[]> {
    const binary = environment["AGY_BIN"] ?? (process.platform === "win32" ? "agy.exe" : "agy");
    const stdout = await new Promise<string>((resolve, reject) => {
        const child = execFileHidden(
            binary,
            ["-p", "/usage"],
            {
                env: environment,
                timeout: USAGE_TIMEOUT_MS,
                maxBuffer: 1024 * 1024,
                ...(signal === undefined ? {} : { signal }),
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
        const parsedReset = Date.parse(resetsAt);
        // agy reports 1970-01-01T00:00:00Z when a window is untouched; treat epoch <= 0 as unset.
        windows.push({
            scope,
            window,
            remainingPercent: percent,
            resetsAt: Number.isNaN(parsedReset) || parsedReset <= 0 ? null : resetsAt,
        });
    }
    return windows;
}

/**
 * Normalize `agy -p /usage` windows into {@link ProviderUsage}. Gemini Models fill the primary
 * `fiveHour` and `weekly` windows; Claude and GPT models fill `claudeGptFiveHour` and
 * `claudeGptWeekly`.
 */
export function antigravityProviderUsage(
    providerId: string,
    rows: readonly HarnessUsageWindow[],
    now = Date.now(),
): ProviderUsage | null {
    let fiveHour: ProviderUsageWindow | null = null;
    let weekly: ProviderUsageWindow | null = null;
    let claudeGptFiveHour: ProviderUsageWindow | null = null;
    let claudeGptWeekly: ProviderUsageWindow | null = null;

    for (const row of rows) {
        const isFiveHour = /five\s*hour|5\s*hour|session/iu.test(row.window);
        const isWeekly = /week/iu.test(row.window);
        if (!isFiveHour && !isWeekly) continue;
        const durationMs = isFiveHour ? FIVE_HOUR_DURATION_MS : WEEKLY_DURATION_MS;
        const parsedReset = row.resetsAt === null ? Number.NaN : Date.parse(row.resetsAt);
        const resetsAt = Number.isFinite(parsedReset) && parsedReset > 0 ? parsedReset : null;
        const normalized: ProviderUsageWindow = {
            usedPercent: Math.max(0, Math.min(100, 100 - row.remainingPercent)),
            resetsAt,
            startsAt: resetsAt === null ? null : resetsAt - durationMs,
            durationMs,
        };
        if (/gemini/iu.test(row.scope)) {
            if (isFiveHour) fiveHour = normalized;
            else weekly = normalized;
        } else if (/claude|gpt/iu.test(row.scope)) {
            if (isFiveHour) claudeGptFiveHour = normalized;
            else claudeGptWeekly = normalized;
        }
    }

    if (
        fiveHour === null &&
        weekly === null &&
        claudeGptFiveHour === null &&
        claudeGptWeekly === null
    ) {
        return null;
    }

    const scopes: boolean[] = [];
    if (fiveHour !== null || weekly !== null) {
        scopes.push((fiveHour?.usedPercent ?? 0) >= 100 || (weekly?.usedPercent ?? 0) >= 100);
    }
    if (claudeGptFiveHour !== null || claudeGptWeekly !== null) {
        scopes.push(
            (claudeGptFiveHour?.usedPercent ?? 0) >= 100 ||
                (claudeGptWeekly?.usedPercent ?? 0) >= 100,
        );
    }
    const exhausted = scopes.length > 0 && scopes.every(Boolean);

    // happy-providers 0.0.68 types only claude | codex | grok and omits claudeGpt* windows.
    return {
        providerId,
        vendor: "antigravity" as ProviderUsage["vendor"],
        capturedAt: now,
        planName: null,
        exhausted,
        windows: {
            fiveHour,
            weekly,
            monthly: null,
            ...(claudeGptFiveHour === null ? {} : { claudeGptFiveHour }),
            ...(claudeGptWeekly === null ? {} : { claudeGptWeekly }),
        } as ProviderUsage["windows"],
        credits: null,
    };
}
