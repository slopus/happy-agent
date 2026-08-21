import { formatStartupStatusUsageRemaining } from "./formatStartupStatusUsageRemaining.js";
import type { StartupStatusCardUsage } from "./StartupStatusCardModel.js";

const WIDE_USAGE_WIDTH = 48;
const RESET_USAGE_WIDTH = 64;

export function formatStartupStatusUsageRows(
    usage: StartupStatusCardUsage | undefined,
    width: number,
): string[] {
    const windows = [
        ...(usage?.fiveHour === undefined ? [] : [{ label: "5h", value: usage.fiveHour }]),
        ...(usage?.weekly === undefined ? [] : [{ label: "week", value: usage.weekly }]),
    ];
    if (windows.length === 0 || width <= 0) return [];

    if (width < WIDE_USAGE_WIDTH) {
        return windows.map(({ label, value }) =>
            formatStartupStatusUsageRemaining(label, value, width),
        );
    }

    const rows = [
        `Usage: ${windows.map(({ label, value }) => `${label} ${value.percentLeft}% left`).join(" · ")}`,
    ];
    if (width < RESET_USAGE_WIDTH) return rows;

    const resets = windows.flatMap(({ label, value }) =>
        value.resetsIn === undefined ? [] : [`${label} in ${value.resetsIn}`],
    );
    if (resets.length > 0) rows.push(`Resets: ${resets.join(" · ")}`);
    return rows;
}
