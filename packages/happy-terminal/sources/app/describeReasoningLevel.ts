import { humanizeReasoningLevel } from "./humanizeReasoningLevel.js";

export function describeReasoningLevel(
    level: string,
    options: { isCurrent: boolean; isDefault: boolean },
): string {
    const descriptions: Record<string, string> = {
        off: "Skip reasoning for fast, direct replies.",
        on: "Enable the model's native thinking mode.",
        minimal: "Use a tiny reasoning budget for quick edits.",
        low: "Use light reasoning for simple coding tasks.",
        medium: "Balance speed and depth for everyday coding.",
        high: "Spend more time on harder changes.",
        xhigh: "Think deeply through complex work.",
        max: "Use the largest reasoning budget available.",
        ultra: "Use maximum reasoning with task delegation.",
    };
    const parts = [descriptions[level] ?? `Use ${humanizeReasoningLevel(level)} reasoning.`];

    if (options.isCurrent) {
        parts.push("Current level.");
    } else if (options.isDefault) {
        parts.push("Default level.");
    }

    return parts.join(" ");
}
