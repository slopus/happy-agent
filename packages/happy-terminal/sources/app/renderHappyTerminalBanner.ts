import { truncateToWidth } from "@earendil-works/pi-tui";

import { renderHappyTerminalVersion } from "./renderHappyTerminalVersion.js";

const RESET = "\x1b[0m";
const HAPPY_TERMINAL_LOGO = [
    "██╗  ██╗ █████╗ ██████╗ ██████╗ ██╗   ██╗",
    "██║  ██║██╔══██╗██╔══██╗██╔══██╗╚██╗ ██╔╝",
    "███████║███████║██████╔╝██████╔╝ ╚████╔╝ ",
    "██╔══██║██╔══██║██╔═══╝ ██╔═══╝   ╚██╔╝  ",
    "██║  ██║██║  ██║██║     ██║         ██║   ",
    "╚═╝  ╚═╝╚═╝  ╚═╝╚═╝     ╚═╝         ╚═╝  TERMINAL",
] as const;
const HAPPY_TERMINAL_LOGO_WIDTH = 54;
const BANNER_GAP = "  ";
const BANNER_PADDING = "  ";

export function renderHappyTerminalBanner(options: {
    brand: string;
    secondary: string;
    version: string;
    width: number;
}): string[] {
    const width = Math.max(1, options.width);
    const contentWidth = width - BANNER_PADDING.length * 2;
    if (contentWidth <= 0) return [" ".repeat(width)];

    if (contentWidth < HAPPY_TERMINAL_LOGO_WIDTH + BANNER_GAP.length + options.version.length) {
        const lines = [
            truncateToWidth(
                `${options.brand}Happy Terminal${RESET} ${options.secondary}${options.version}${RESET}`,
                contentWidth,
                "",
                false,
            ),
        ];
        return padBannerLines(lines);
    }

    const versionWidth = contentWidth - HAPPY_TERMINAL_LOGO_WIDTH - BANNER_GAP.length;
    const versionLines = renderHappyTerminalVersion(options.version, versionWidth);
    if (versionLines.length === HAPPY_TERMINAL_LOGO.length) {
        const lines = HAPPY_TERMINAL_LOGO.map(
            (line, index) =>
                `${options.brand}${line.padEnd(HAPPY_TERMINAL_LOGO_WIDTH)}${RESET}${BANNER_GAP}${options.secondary}${versionLines[index]}${RESET}`,
        );
        return padBannerLines(lines);
    }

    const lines = HAPPY_TERMINAL_LOGO.map((line, index) => {
        const version =
            index === HAPPY_TERMINAL_LOGO.length - 1
                ? `${BANNER_GAP}${options.secondary}${versionLines[0]}${RESET}`
                : "";
        return `${options.brand}${line.padEnd(HAPPY_TERMINAL_LOGO_WIDTH)}${RESET}${version}`;
    });
    return padBannerLines(lines);
}

function padBannerLines(lines: string[]): string[] {
    return lines.map((line) => `${BANNER_PADDING}${line}${BANNER_PADDING}`);
}
