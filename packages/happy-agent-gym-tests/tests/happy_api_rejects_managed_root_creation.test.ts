import { createAgentGym } from "@slopus/happy-agent-gym";
import { expect, it } from "vitest";

it("rejects the removed parent-selection option without changing agents or workspace membership", async () => {
    const gym = await createAgentGym();
    try {
        const root = (await gym.client.getAgent(gym.defaultSessionId)).agent;
        const before = (await gym.client.getWorkspace(root.workspaceId)).workspace;
        for (const id of ["rejectedmanagedagent", root.id]) {
            // Keep the invalid wire field outside a typed object literal: the client no longer exposes it.
            const request = { id, workspaceId: root.workspaceId, parentAgentId: root.id };
            await expect(gym.client.createAgent(request)).rejects.toMatchObject({
                code: "invalid_request",
                status: 400,
            });
        }
        expect((await gym.client.getWorkspace(root.workspaceId)).workspace).toEqual(before);
        await expect(gym.client.getAgent("rejectedmanagedagent")).rejects.toMatchObject({
            status: 404,
        });
        const created = (
            await gym.client.createAgent({ workspaceId: root.workspaceId, title: "Ordinary root" })
        ).agent;
        expect(created).toMatchObject({
            parentAgentId: null,
            subtask: false,
            canSendMessages: true,
        });
        await gym.send("Ordinary creation still works", { sessionId: created.id });
        expect(gym.errors).toEqual([]);
    } finally {
        await gym.dispose();
    }
}, 60_000);
