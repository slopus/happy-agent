import { createAgentGym } from "@slopus/happy-agent-gym";
import { expect, it } from "vitest";

it("bootstraps an archive-heavy owner and keeps restoration, direct reads and restart consistent", async () => {
    const gym = await createAgentGym();
    try {
        const initial = await gym.client.getDesktopBootstrap();
        const root = initial.projects.find((project) =>
            project.agents.some((agent) => agent.id === gym.defaultSessionId),
        );
        if (root === undefined) throw new Error("The gym root project is missing.");
        const archivedIds: string[] = [];
        for (let index = 0; index < 24; index += 1) {
            const { agent } = await gym.client.createAgent({
                id: `bootstraparchived${index}`,
                workspaceId: root.id,
                title: `Archived ${index}`,
            });
            await gym.client.archiveAgent(agent.id);
            archivedIds.push(agent.id);
        }

        const verify = async (expectedIds: readonly string[]) => {
            const snapshot = await gym.client.getDesktopBootstrap();
            const project = snapshot.projects.find((candidate) => candidate.id === root.id);
            const workspace = snapshot.workspaces.find((candidate) => candidate.id === root.id);
            expect(project?.agents.map((agent) => agent.id)).toEqual(expectedIds);
            expect(workspace?.agents).toEqual(project?.agents);
            expect((await gym.client.getProject(root.id)).project.agents).toEqual(project?.agents);
            expect((await gym.client.getWorkspace(root.id)).workspace.agents).toEqual(
                project?.agents,
            );
            return snapshot;
        };
        await verify([gym.defaultSessionId]);
        // Query-count assertions live at the API module boundary. This real-socket measurement
        // is diagnostic only; machine speed is not a correctness gate.
        const started = performance.now();
        for (let index = 0; index < 5; index += 1) await gym.client.getDesktopBootstrap();
        console.info(
            `Archive-heavy bootstrap mean (24 archived): ${(performance.now() - started) / 5} ms`,
        );

        const archivedId = archivedIds[0]!;
        expect((await gym.client.getAgent(archivedId)).agent.archivedAt).not.toBeNull();
        const beforeRestore = await gym.client.getDesktopBootstrap();
        await gym.client.unarchiveAgent(archivedId, { mutationId: "bootstrap-restore" });
        await verify([gym.defaultSessionId, archivedId]);
        const replay = await gym.client.getEvents({ after: beforeRestore.cursor });
        expect(
            replay.events.some(
                (event) => event.type === "agent.updated" && event.payload.agentId === archivedId,
            ),
        ).toBe(true);

        await gym.restart();
        await verify([gym.defaultSessionId, archivedId]);
        expect((await gym.client.getAgent(archivedIds[1]!)).agent.archivedAt).not.toBeNull();
    } finally {
        await gym.dispose();
    }
}, 120_000);
