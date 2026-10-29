import { formatHappyReferenceTag } from "@slopus/happy-agent-client";

import type { CleanupAgent, CleanupItem } from "../CleanupSearch.js";

const KIND_LABELS: Record<CleanupItem["kind"], string> = {
    bot: "Bot",
    task: "Task",
    subtask: "Subtask",
    project: "Project",
    workspace: "Workspace",
};

/** One row as one line a model can act on: identity first, then what decides cleanup. */
export function formatCleanupItem(item: CleanupItem, now: number): string {
    const facts = [
        `id ${item.id}`,
        ...(item.agentId === undefined
            ? []
            : [`mention it as ${formatHappyReferenceTag({ kind: "agent", id: item.agentId })}`]),
        ...(item.kind === "workspace" || item.kind === "project"
            ? [`mention it as ${formatHappyReferenceTag({ kind: item.kind, id: item.id })}`]
            : []),
        item.running
            ? "running now"
            : `last active ${formatAge(now, item.lastActivityAt)} (${formatDate(item.lastActivityAt)})`,
        `created ${formatDate(item.createdAt)}`,
        ...(item.ownerUserId === undefined ? [] : [`owner user ID \`${item.ownerUserId}\``]),
        ...(item.parent === undefined
            ? []
            : [`in ${item.parent.kind} ${JSON.stringify(item.parent.name)} (${item.parent.id})`]),
        ...(item.subtasks === undefined || item.subtasks.total === 0
            ? []
            : [
                  `${String(item.subtasks.active)} of ${String(item.subtasks.total)} subtasks active`,
              ]),
        ...(item.workspaces === undefined || item.workspaces.total === 0
            ? []
            : [
                  `${String(item.workspaces.active)} of ${String(item.workspaces.total)} workspaces active`,
              ]),
        `${String(item.agents)} ${item.agents === 1 ? "agent" : "agents"}`,
        ...(item.folder === undefined ? [] : [`folder ${item.folder}`]),
        ...(item.branch === undefined ? [] : [`branch ${item.branch}`]),
    ];
    const status = item.status === "archived" ? " (archived)" : "";
    return `- ${KIND_LABELS[item.kind]} ${JSON.stringify(item.name)}${status} — ${facts.join(", ")}`;
}

/** One agent as one line: who it is, whether it is alive, and where it works. */
export function formatCleanupAgent(agent: CleanupAgent, now: number): string {
    const facts = [
        `agent ID ${agent.agentId}`,
        agent.state === "running"
            ? "running now"
            : `${agent.state}, last active ${formatAge(now, agent.lastActivityAt)} (${formatDate(agent.lastActivityAt)})`,
        ...(agent.folder === undefined ? [] : [`folder ${agent.folder}`]),
    ];
    const title = agent.title === undefined ? "Untitled agent" : JSON.stringify(agent.title);
    return `- ${title} — ${facts.join(", ")}`;
}

export function formatDate(at: number): string {
    return new Date(at).toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

export function formatAge(now: number, at: number): string {
    const minutes = Math.max(0, Math.floor((now - at) / 60_000));
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${String(minutes)} min ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 48) return `${String(hours)} h ago`;
    return `${String(Math.floor(hours / 24))} days ago`;
}
