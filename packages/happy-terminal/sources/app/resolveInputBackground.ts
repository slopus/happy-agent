import type { RgbColor } from "@earendil-works/pi-tui";

import { blendComposerBackground } from "./blendComposerBackground.js";
import { nearestXtermColorIndex } from "./nearestXtermColorIndex.js";
import type { TerminalColorLevel } from "./TerminalColorLevel.js";

const FALLBACK_BACKGROUND = "\x1b[48;5;235m";

export function resolveInputBackground(
    background: RgbColor | undefined,
    colorLevel: TerminalColorLevel,
): string {
    if (background === undefined) return FALLBACK_BACKGROUND;

    const blended = blendComposerBackground(background);
    if (colorLevel === "truecolor") {
        return `\x1b[48;2;${blended.r};${blended.g};${blended.b}m`;
    }
    return `\x1b[48;5;${nearestXtermColorIndex(blended)}m`;
}
