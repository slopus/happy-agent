import type { SessionAgentMetadata } from "../protocol/index.js";
import { sanitizeTerminalText } from "./sanitizeTerminalText.js";
import { truncateTextForDisplay } from "./truncateTextForDisplay.js";

const MAXIMUM_IDENTITY_CHARACTERS = 80;

export function sessionAgentFooterLabel(agent: SessionAgentMetadata): string | undefined {
    if (agent.type === "primary") return undefined;
    const description = singleLine(agent.description);
    const identity = description || singleLine(humanizeTaskName(agent.taskName)) || "Subagent";
    const boundedIdentity = truncateTextForDisplay(identity, MAXIMUM_IDENTITY_CHARACTERS).text;
    return `${boundedIdentity} [subagent]`;
}

function singleLine(value: string | undefined): string | undefined {
    if (value === undefined) return undefined;
    const line = sanitizeTerminalText(value).replace(/\s+/gu, " ").trim();
    return line.length === 0 ? undefined : line;
}

function humanizeTaskName(taskName: string | undefined): string | undefined {
    if (taskName === undefined) return undefined;
    const words = taskName.split(/[-_\s]+/u).filter((word) => word.length > 0);
    if (words.length === 0) return undefined;
    return words.map((word) => `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`).join(" ");
}
