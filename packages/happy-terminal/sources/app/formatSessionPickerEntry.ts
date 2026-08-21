import type { AgentCatalogEntry } from "../client/index.js";
import { formatRelativeTime } from "./formatRelativeTime.js";
import { sanitizeTerminalText } from "./sanitizeTerminalText.js";
import { shortenHomePath } from "./shortenHomePath.js";

const MAX_DETAIL_CHARS = 400;

export interface SessionPickerEntry {
    /** Short badge for sessions that need attention or ended unexpectedly. */
    badge?: string;
    /** Last activity plus context size, shown right-aligned next to the title. */
    meta: string;
    /** The most recent thing that happened, or the directory when titles are missing. */
    detail?: string;
    title: string;
}

export function formatSessionPickerEntry(
    entry: AgentCatalogEntry,
    options: { now: number; showDirectory: boolean },
): SessionPickerEntry {
    const badge = sessionBadge(entry);
    const details: (string | undefined)[] = [];
    if (options.showDirectory) details.unshift(shortenHomePath(entry.cwd));
    const detail = details.filter((part) => part !== undefined).join(" · ");
    return {
        ...(badge === undefined ? {} : { badge }),
        meta: [formatRelativeTime(entry.agent.updatedAt, options.now)]
            .filter((part) => part !== undefined)
            .join(" · "),
        ...(detail.length === 0 ? {} : { detail }),
        title: sessionTitle(entry),
    };
}

function sessionTitle(entry: AgentCatalogEntry): string {
    return oneLine(entry.agent.title ?? undefined) ?? "Untitled agent";
}

function sessionBadge(entry: AgentCatalogEntry): string | undefined {
    const agent = entry.agent;
    if (agent.pendingQuestionId !== null) return "Needs attention";
    if (agent.status !== "idle") return humanizeAgentStatus(agent.status);
    if (agent.archivedAt !== null) return "Archived";
    if (agent.unread?.reason === "turn_finished") return "Finished";
    return undefined;
}

function humanizeAgentStatus(status: AgentCatalogEntry["agent"]["status"]): string {
    if (status === "thinking") return "Thinking";
    if (status === "generating_tools") return "Generating tools";
    if (status === "running_tools") return "Running tools";
    return "Working";
}

function oneLine(value: string | undefined): string | undefined {
    if (value === undefined) return undefined;
    const line = sanitizeTerminalText(value).replace(/\s+/gu, " ").trim();
    if (line.length === 0) return undefined;
    return line.length <= MAX_DETAIL_CHARS ? line : `${line.slice(0, MAX_DETAIL_CHARS - 1)}…`;
}
