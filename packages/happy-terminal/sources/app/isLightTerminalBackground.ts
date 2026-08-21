import type { RgbColor } from "@earendil-works/pi-tui";

export function isLightTerminalBackground(background: RgbColor | undefined): boolean {
    if (background === undefined) return false;
    return 0.299 * background.r + 0.587 * background.g + 0.114 * background.b > 128;
}
