import type { CleanupDeletedItem, CleanupDeletionPlan } from "../CleanupDeletion.js";
import { formatCleanupAgent } from "./formatCleanupItem.js";

/** How many agents a plan lists by name before it only counts the rest. */
const MAX_LISTED_AGENTS = 40;

const KIND_LABELS: Record<CleanupDeletedItem["kind"], string> = {
    bot: "bot",
    task: "task",
    subtask: "subtask",
    project: "project",
    workspace: "workspace",
};

/** A deletion plan as text a model can review with a person before confirming it. */
export function formatCleanupPlan(plan: CleanupDeletionPlan, heading: string): string {
    const running = plan.agents.filter((agent) => agent.state === "running").length;
    const lines = [heading, "", `Items (${String(plan.items.length)}):`];
    lines.push(...plan.items.map(formatDeletedItem));
    lines.push(
        "",
        `Agents erased with their whole conversations (${String(plan.agents.length)}${
            running === 0 ? "" : `, ${String(running)} running now and stopped first`
        }):`,
    );
    lines.push(
        ...plan.agents
            .slice(0, MAX_LISTED_AGENTS)
            .map((agent) => formatCleanupAgent(agent, plan.at)),
    );
    if (plan.agents.length > MAX_LISTED_AGENTS) {
        lines.push(`- …and ${String(plan.agents.length - MAX_LISTED_AGENTS)} more`);
    }
    lines.push("", `Folders removed (${String(plan.folders.length)}):`);
    lines.push(...plan.folders.map((folder) => `- ${folder}`));
    if (plan.branches.length > 0) {
        lines.push("", `Git branches deleted (${String(plan.branches.length)}):`);
        lines.push(
            ...plan.branches.map(({ branch, repository }) => `- ${branch} in ${repository}`),
        );
    }
    if (plan.keptFolders.length > 0) {
        lines.push("", "Folders kept, because a person registered them as projects:");
        lines.push(...plan.keptFolders.map((folder) => `- ${folder}`));
    }
    return lines.join("\n");
}

function formatDeletedItem(item: CleanupDeletedItem): string {
    const facts = [
        `id ${item.id}`,
        item.status,
        ...(item.running ? ["running now"] : []),
        ...(item.folder === undefined ? [] : [`folder ${item.folder}`]),
    ];
    return `- ${KIND_LABELS[item.kind]} ${JSON.stringify(item.name)} — ${facts.join(", ")}`;
}
