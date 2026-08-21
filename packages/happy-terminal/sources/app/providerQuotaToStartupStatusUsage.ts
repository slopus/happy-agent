import type { ProviderQuota, ProviderQuotaWindow } from "@slopus/happy-providers";
import { formatResetDuration } from "./formatResetDuration.js";
import type {
    StartupStatusCardUsage,
    StartupStatusCardUsageWindow,
} from "./StartupStatusCardModel.js";

export function providerQuotaToStartupStatusUsage(
    quota: ProviderQuota | undefined,
    now = Date.now(),
): StartupStatusCardUsage | undefined {
    const fiveHour = mapWindow(quota?.windows.fiveHour, now);
    const weekly = mapWindow(quota?.windows.weekly, now);
    if (fiveHour === undefined && weekly === undefined) return undefined;
    return {
        ...(fiveHour === undefined ? {} : { fiveHour }),
        ...(weekly === undefined ? {} : { weekly }),
    };
}

function mapWindow(
    window: ProviderQuotaWindow | undefined,
    now: number,
): StartupStatusCardUsageWindow | undefined {
    if (window?.status !== "available") return undefined;
    const percentLeft = Math.max(0, Math.min(100, 100 - window.usedPercent));
    return {
        capturedAt: window.capturedAt,
        percentLeft: Math.round(percentLeft * 10) / 10,
        resetsIn: formatResetDuration(window.resetsAt - now),
    };
}
