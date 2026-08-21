import type { TerminalColorLevel } from "./TerminalColorLevel.js";

export function resolveTerminalColorLevel(
    environment: NodeJS.ProcessEnv = process.env,
): TerminalColorLevel {
    const colorTerm = environment.COLORTERM?.toLowerCase() ?? "";
    const term = environment.TERM?.toLowerCase() ?? "";
    if (
        colorTerm.includes("truecolor") ||
        colorTerm.includes("24bit") ||
        term.includes("truecolor") ||
        term.includes("24bit") ||
        term.includes("direct")
    ) {
        return "truecolor";
    }
    return "ansi256";
}
