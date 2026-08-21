import type { AgentCatalogEntry } from "../client/index.js";

export function formatSessionSummaries(
    sessions: readonly AgentCatalogEntry[],
    options: { columns: number; rows: number },
): readonly string[] {
    const visibleRows = Math.max(0, options.rows);
    if (visibleRows === 0) {
        return [];
    }

    if (sessions.length === 0) {
        return [truncate("No sessions.", options.columns)];
    }

    const limit = Math.max(0, visibleRows - 1);
    const lines = [
        truncate("STATUS     LAST MESSAGE      SESSION ID              TITLE", options.columns),
    ];
    for (const session of sessions.slice(0, limit)) {
        lines.push(truncate(formatSessionSummary(session), options.columns));
    }
    return lines;
}

function formatSessionSummary(entry: AgentCatalogEntry): string {
    return [
        padRight(humanizeSessionStatus(entry), 16),
        padRight(formatTimestamp(entry.agent.updatedAt), 17),
        padRight(entry.agent.id, 23),
        titleText(entry),
    ].join(" ");
}

function formatTimestamp(value: number | undefined): string {
    if (value === undefined) {
        return "No messages";
    }

    const date = new Date(value);
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const hour = String(date.getHours()).padStart(2, "0");
    const minute = String(date.getMinutes()).padStart(2, "0");
    return `${month}-${day} ${hour}:${minute}`;
}

function humanizeSessionStatus(entry: AgentCatalogEntry): string {
    const agent = entry.agent;
    if (agent.pendingQuestionId !== null) return "Attention";
    if (agent.unread?.reason === "turn_finished") return "Finished";
    if (agent.archivedAt !== null) return "Archived";
    return humanizeStatus(agent.status);
}

function humanizeStatus(status: AgentCatalogEntry["agent"]["status"]): string {
    if (status === "idle") return "Idle";
    if (status === "thinking") return "Thinking";
    if (status === "generating_tools") return "Generating tools";
    if (status === "running_tools") return "Running tools";
    return "Working";
}

function padRight(value: string, length: number): string {
    return value.length >= length ? value : `${value}${" ".repeat(length - value.length)}`;
}

function titleText(entry: AgentCatalogEntry): string {
    if (entry.agent.title !== null && entry.agent.title.length > 0) {
        return entry.agent.title;
    }
    if (entry.agent.titleStatus === "idle") {
        return "Generating title";
    }
    return "Untitled agent";
}

function truncate(value: string, columns: number): string {
    if (columns <= 0) {
        return "";
    }
    if (value.length <= columns) {
        return value;
    }
    if (columns === 1) {
        return "…";
    }
    return `${value.slice(0, columns - 1)}…`;
}
