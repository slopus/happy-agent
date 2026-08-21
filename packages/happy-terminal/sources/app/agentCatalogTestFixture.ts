import type { AgentCatalogEntry } from "../client/index.js";

export const AGENT_FIXTURE_NOW = 1_700_000_000_000;

export function agentCatalogEntry(
    overrides: Partial<AgentCatalogEntry["agent"]> = {},
    cwd = "/workspace",
): AgentCatalogEntry {
    const id = overrides.id ?? "agent-1";
    return {
        agent: {
            archivedAt: null,
            createdAt: AGENT_FIXTURE_NOW,
            id,
            lastCursor: "01900000-0000-7000-8000-000000000000",
            orderKey: "a",
            parentAgentId: null,
            pendingQuestionId: null,
            processes: { running: 0 },
            status: "idle",
            subagents: { running: 0, total: 0 },
            title: null,
            titleStatus: "idle",
            unread: null,
            updatedAt: AGENT_FIXTURE_NOW,
            version: "01900000-0000-7000-8000-000000000001",
            workspaceId: "project-1",
            ...overrides,
        },
        cwd,
        projectId: "project-1",
        workspaceId: "project-1",
    };
}
