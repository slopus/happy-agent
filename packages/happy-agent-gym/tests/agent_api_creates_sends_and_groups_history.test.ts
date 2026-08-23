import { afterEach, describe, expect, it } from "vitest";

import {
    createAgentGym,
    type AgentGym,
    type GymAgentEvent,
    type GymAgentHistory,
} from "../sources/index.js";

const running = new Set<AgentGym>();

afterEach(async () => {
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
});

interface ProjectWithAgents {
    readonly agents: readonly { readonly id: string }[];
    readonly id: string;
}

interface AgentRecord {
    readonly id: string;
    readonly workspaceId: string;
}

describe("the public agent API", () => {
    it("creates an agent in a project root, sends a message, and groups its history by run", async () => {
        const gym = await createAgentGym({
            inference: [{ content: [{ text: "The API message was answered.", type: "text" }] }],
        });
        running.add(gym);

        const projects = await gym.http.ok<{ readonly projects: readonly ProjectWithAgents[] }>(
            "GET",
            "/v0/projects",
        );
        const root = projects.projects[0];
        expect(root).toBeDefined();
        expect(root?.agents.map((agent) => agent.id)).toContain(gym.defaultSessionId);

        const created = await gym.http.ok<{ readonly agent: AgentRecord }>("POST", "/v0/agents", {
            workspaceId: root?.id,
        });
        expect(created.agent.workspaceId).toBe(root?.id);

        const sent = await gym.http.ok<{
            readonly cursor: string;
            readonly message: { readonly id: string; readonly runId: string | null };
        }>("POST", `/v0/agents/${created.agent.id}/send`, {
            delivery: "queue",
            mode: {
                effort: gym.selection.effort,
                modelId: gym.selection.modelId,
                permissionMode: "auto",
                providerId: gym.selection.providerId,
                serviceTier: null,
            },
            text: "Answer through the public API.",
        });
        expect(sent.cursor).toMatch(/^[0-9a-f]{8}-/);

        const started = await gym.waitForEvent(
            (event) =>
                event.type === "run.started" &&
                agentIdOf(event) === created.agent.id &&
                acceptedMessageIds(event).includes(sent.message.id),
            "the sent message to start a run",
        );
        const runId = runIdOfStarted(started);
        expect(runId).toBeTypeOf("string");
        if (runId === undefined) throw new Error("The started run did not carry an ID.");
        await gym.waitForRun(runId);

        const history = await gym.http.ok<GymAgentHistory>(
            "GET",
            `/v0/agents/${created.agent.id}/messages`,
        );
        await expect(gym.client.getAgentBootstrap(created.agent.id)).resolves.toMatchObject({
            pending: [],
        });
        expect(history.runs).toHaveLength(1);
        expect(JSON.stringify(history.runs[0])).toContain("Answer through the public API.");
        expect(JSON.stringify(history.runs[0])).toContain("The API message was answered.");
    });
});

function acceptedMessageIds(event: GymAgentEvent): readonly string[] {
    const payload = event.payload;
    if (payload === null || typeof payload !== "object") return [];
    const ids = (payload as { readonly acceptedMessageIds?: unknown }).acceptedMessageIds;
    return Array.isArray(ids) && ids.every((id) => typeof id === "string") ? ids : [];
}

function agentIdOf(event: GymAgentEvent): string | undefined {
    const payload = event.payload;
    if (payload === null || typeof payload !== "object") return undefined;
    const agentId = (payload as { readonly agentId?: unknown }).agentId;
    return typeof agentId === "string" ? agentId : undefined;
}

function runIdOfStarted(event: GymAgentEvent): string | undefined {
    const payload = event.payload;
    if (payload === null || typeof payload !== "object") return undefined;
    const run = (payload as { readonly run?: unknown }).run;
    if (run === null || typeof run !== "object") return undefined;
    const id = (run as { readonly id?: unknown }).id;
    return typeof id === "string" ? id : undefined;
}
