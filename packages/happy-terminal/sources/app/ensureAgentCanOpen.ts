import type { Agent } from "@slopus/happy-agent-client";

/** Subtasks retain their parent while remaining user-interactive conversations. */
export function ensureAgentCanOpen(agent: Pick<Agent, "parentAgentId" | "subtask">): void {
    if (agent.parentAgentId !== null && agent.subtask !== true) {
        throw new Error(
            "Subagents are driven by their parent and cannot be opened as an interactive Happy Terminal agent.",
        );
    }
}
