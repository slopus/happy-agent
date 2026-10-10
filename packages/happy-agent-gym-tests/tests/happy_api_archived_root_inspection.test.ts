import { afterEach, describe, expect, it } from "vitest";

import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";

const running = new Set<AgentGym>();

afterEach(async () => {
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
});

describe("archived project root inspection through the public API", () => {
    it(
        "keeps an archived project and its root workspace inspectable across restart",
        { timeout: 60_000 },
        async () => {
            const gym = await createAgentGym({ timeoutMs: 15_000 });
            running.add(gym);

            const defaultAgent = (await gym.client.getAgent(gym.defaultSessionId)).agent;
            const project = (await gym.client.getProject(defaultAgent.workspaceId)).project;

            const ready = await gym.waitUntil(
                async () => {
                    const current = (await gym.client.getProject(project.id)).project;
                    if (current.initialization.status === "failed") {
                        throw new Error(
                            current.initialization.error ??
                                "The root project failed to initialize without a reason.",
                        );
                    }
                    return current.initialization.status === "ready" ? current : undefined;
                },
                "the root project to become ready",
                30_000,
            );
            expect(ready.id).toBe(project.id);
            expect(ready.status).toBe("active");

            const archivedResponse = await gym.client.archiveProject(project.id, {
                ifMatch: ready.version,
                mutationId: "archive-root-for-inspection",
            });
            expect(archivedResponse.project).toMatchObject({
                id: project.id,
                status: "archived",
            });

            const archivedProject = (await gym.client.getProject(project.id)).project;
            expect(archivedProject).toMatchObject({
                id: project.id,
                status: "archived",
            });

            const archivedRoot = (await gym.client.getWorkspace(project.id)).workspace;
            expect(archivedRoot).toMatchObject({
                id: project.id,
                projectId: project.id,
                kind: "root",
                parentId: null,
                status: "archived",
            });

            await gym.restart();

            const persistedProject = (await gym.client.getProject(project.id)).project;
            const persistedRoot = (await gym.client.getWorkspace(project.id)).workspace;
            expect(persistedProject).toMatchObject({
                id: project.id,
                status: "archived",
            });
            expect(persistedRoot).toMatchObject({
                id: project.id,
                projectId: project.id,
                kind: "root",
                parentId: null,
                status: "archived",
            });
        },
    );
});
