import { truncateToWidth } from "@earendil-works/pi-tui";

const RESET = "\x1b[0m";
const HAPPY_LOGO = [
    "██╗  ██╗ █████╗ ██████╗ ██████╗ ██╗   ██╗",
    "██║  ██║██╔══██╗██╔══██╗██╔══██╗╚██╗ ██╔╝",
    "███████║███████║██████╔╝██████╔╝ ╚████╔╝ ",
    "██╔══██║██╔══██║██╔═══╝ ██╔═══╝   ╚██╔╝  ",
    "██║  ██║██║  ██║██║     ██║        ██║   ",
    "╚═╝  ╚═╝╚═╝  ╚═╝╚═╝     ╚═╝        ╚═╝   ",
] as const;
const HAPPY_LOGO_WIDTH = Math.max(...HAPPY_LOGO.map((line) => line.length));
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

    if (contentWidth < HAPPY_LOGO_WIDTH + BANNER_GAP.length + options.version.length) {
        const lines = [
            truncateToWidth(
                `${options.brand}HAPPY${RESET} ${options.secondary}${options.version}${RESET}`,
                contentWidth,
                "",
                false,
            ),
        ];
        return padBannerLines(lines);
    }

    const lines = HAPPY_LOGO.map((line, index) => {
        const version =
            index === HAPPY_LOGO.length - 1
                ? `${BANNER_GAP}${options.secondary}${options.version}${RESET}`
                : "";
        return `${options.brand}${line.padEnd(HAPPY_LOGO_WIDTH)}${RESET}${version}`;
    });
    return padBannerLines(lines);
}

function padBannerLines(lines: string[]): string[] {
    return lines.map((line) => `${BANNER_PADDING}${line}${BANNER_PADDING}`);
}
