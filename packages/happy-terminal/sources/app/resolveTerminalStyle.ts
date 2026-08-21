const ANSI_FOREGROUNDS: Readonly<Record<string, number>> = {
    black: 30,
    red: 31,
    green: 32,
    yellow: 33,
    blue: 34,
    magenta: 35,
    cyan: 36,
    white: 37,
    "bright-black": 90,
    "bright-red": 91,
    "bright-green": 92,
    "bright-yellow": 93,
    "bright-blue": 94,
    "bright-magenta": 95,
    "bright-cyan": 96,
    "bright-white": 97,
};

export function resolveTerminalStyle(value: string, role: string): string {
    const normalized = value.trim().toLowerCase().replaceAll("_", "-");
    if (normalized === "default") return "\x1b[39m";
    if (normalized === "dim") return "\x1b[2m\x1b[39m";

    const ansi = ANSI_FOREGROUNDS[normalized];
    if (ansi !== undefined) return `\x1b[${ansi}m`;

    const palette = /^ansi:(\d{1,3})$/u.exec(normalized);
    if (palette !== null) {
        const index = Number(palette[1]);
        if (index <= 255) return `\x1b[38;5;${index}m`;
    }

    const rgb = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/u.exec(normalized);
    if (rgb !== null) {
        return `\x1b[38;2;${parseInt(rgb[1] ?? "0", 16)};${parseInt(rgb[2] ?? "0", 16)};${parseInt(rgb[3] ?? "0", 16)}m`;
    }

    throw new Error(
        `Invalid theme.${role} value ${JSON.stringify(value)}. Use default, dim, an ANSI color name, ansi:<0-255>, or #RRGGBB.`,
    );
}
