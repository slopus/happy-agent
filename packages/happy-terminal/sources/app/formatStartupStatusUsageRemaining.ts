import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import type { StartupStatusCardUsageWindow } from "./StartupStatusCardModel.js";

export function formatStartupStatusUsageRemaining(
    label: string,
    value: StartupStatusCardUsageWindow,
    width: number,
): string {
    const detailed = `${label} ${value.percentLeft}% left`;
    if (visibleWidth(detailed) <= width) return detailed;
    const compact = `${label} ${value.percentLeft}%`;
    if (visibleWidth(compact) <= width) return compact;
    return truncateToWidth(`${value.percentLeft}%`, width, "", false);
}
