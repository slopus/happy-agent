export function humanizeReasoningLevel(level: string): string {
    if (level === "off") {
        return "Off";
    }
    if (level === "minimal") {
        return "Minimal";
    }
    if (level === "low") {
        return "Low";
    }
    if (level === "medium") {
        return "Medium";
    }
    if (level === "high") {
        return "High";
    }
    if (level === "xhigh") {
        return "Extra High";
    }
    if (level === "max") {
        return "Maximum";
    }
    if (level === "ultra") {
        return "Ultra";
    }

    return level
        .split(/[-_\s]+/u)
        .filter((part) => part.length > 0)
        .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
        .join(" ");
}
