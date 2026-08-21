import type { RgbColor } from "@earendil-works/pi-tui";

import type { ConfigTheme } from "../config/index.js";
import type { TerminalTheme } from "./TerminalTheme.js";
import type { TerminalColorLevel } from "./TerminalColorLevel.js";
import { isLightTerminalBackground } from "./isLightTerminalBackground.js";
import { resolveInputBackground } from "./resolveInputBackground.js";
import { resolveTerminalColorLevel } from "./resolveTerminalColorLevel.js";
import { resolveTerminalStyle } from "./resolveTerminalStyle.js";

export function resolveTerminalTheme(
    config: ConfigTheme,
    terminalBackground?: RgbColor,
    colorLevel: TerminalColorLevel = resolveTerminalColorLevel(),
): TerminalTheme {
    return {
        accent: resolveTerminalStyle(config.accent, "accent"),
        brand: resolveTerminalStyle(config.brand, "brand"),
        error: resolveTerminalStyle(config.error, "error"),
        inputBackground: resolveInputBackground(terminalBackground, colorLevel),
        isLight: isLightTerminalBackground(terminalBackground),
        primary: resolveTerminalStyle(config.primary, "primary"),
        secondary: resolveTerminalStyle(config.secondary, "secondary"),
        success: resolveTerminalStyle(config.success, "success"),
        warning: resolveTerminalStyle(config.warning, "warning"),
    };
}
