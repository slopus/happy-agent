import type { RgbColor } from "@earendil-works/pi-tui";

export function blendComposerBackground(background: RgbColor): RgbColor {
    const lightness = 0.299 * background.r + 0.587 * background.g + 0.114 * background.b;
    const light = lightness > 128;
    const alpha = light ? 0.04 : 0.12;
    const top = light ? 0 : 255;
    return {
        r: Math.floor(top * alpha + background.r * (1 - alpha)),
        g: Math.floor(top * alpha + background.g * (1 - alpha)),
        b: Math.floor(top * alpha + background.b * (1 - alpha)),
    };
}
