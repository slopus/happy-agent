import type { TerminalTheme } from "./TerminalTheme.js";

const RESET = "\x1b[0m";
export const ACTIVITY_WAVE_FRAME_COUNT = 12;
const DARK_BACKGROUND_COLORS = [255, 253, 250, 247, 244] as const;
const LIGHT_BACKGROUND_COLORS = [232, 234, 236, 238, 240] as const;

export function renderActivityWave(
    text: string,
    frame: number,
    theme: Pick<TerminalTheme, "isLight">,
): string {
    return `${Array.from(text)
        .map((character, index) => {
            if (character === " ") {
                return character;
            }

            return `\x1b[38;5;${activityWaveColor(index, frame, theme.isLight === true)}m${character}`;
        })
        .join("")}${RESET}`;
}

function activityWaveColor(index: number, frame: number, lightBackground: boolean): number {
    const phase = positiveModulo(index - frame, ACTIVITY_WAVE_FRAME_COUNT);
    const distance = Math.min(phase, ACTIVITY_WAVE_FRAME_COUNT - phase);
    const colors = lightBackground ? LIGHT_BACKGROUND_COLORS : DARK_BACKGROUND_COLORS;
    return colors[Math.min(distance, colors.length - 1)] ?? colors.at(-1)!;
}

function positiveModulo(value: number, modulus: number): number {
    return ((value % modulus) + modulus) % modulus;
}
