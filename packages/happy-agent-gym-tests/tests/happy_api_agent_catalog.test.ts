import { createAgentGym, type AgentGym, type GymAgentEvent } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const activeGyms = new Set<AgentGym>();

afterEach(async () => {
    await Promise.all([...activeGyms].map(async (gym) => await gym.dispose()));
    activeGyms.clear();
});

describe("the public agent catalog API", () => {
    it("creates retryable agents and exposes them only through their project or workspace", async () => {
        const gym = await startGym();
        const stream = gym.stream();
        await stream.opened();

        const root = await rootProject(gym);
        const firstId = "catalogagentone";
        const secondId = "catalogagenttwo";
        const firstMutation = "catalog-create-first";
        const secondMutation = "catalog-create-second";

        const first = await gym.client.createAgent({
            id: firstId,
            mutationId: firstMutation,
            title: "First catalog agent",
            workspaceId: root.id,
        });
        expect(first.agent).toMatchObject({
            archivedAt: null,
            id: firstId,
            parentAgentId: null,
            title: "First catalog agent",
            titleStatus: "ready",
            workspaceId: root.id,
        });
        const firstEvent = await waitForAgentEvent(gym, firstId, "agent.created", firstMutation);
        expect(firstEvent.payload.agent).toEqual(first.agent);
        expect(firstEvent.payload.mutationId).toBe(firstMutation);

        const second = await gym.client.createAgent({
            id: secondId,
            mutationId: secondMutation,
            workspaceId: root.id,
        });
        expect(second.agent.parentAgentId).toBeNull();
        await waitForAgentEvent(gym, secondId, "agent.created", secondMutation);

        const beforeReplay = await gym.events();
        const replay = await gym.client.createAgent({
            id: firstId,
            mutationId: "catalog-create-first-retry",
            title: "A title that must not replace the original",
            workspaceId: root.id,
        });
        expect(replay.agent).toMatchObject({
            id: firstId,
            parentAgentId: null,
            title: first.agent.title,
            workspaceId: root.id,
        });
        expect(
            (await gym.events()).filter(
                (event) => event.type === "agent.created" && event.payload.agent.id === firstId,
            ),
        ).toHaveLength(
            beforeReplay.filter(
                (event) => event.type === "agent.created" && event.payload.agent.id === firstId,
            ).length,
        );

        const project = (await gym.client.getProject(root.id)).project;
        expect(project.agents.map((agent) => agent.id)).toEqual([
            ...project.agents.slice(0, -2).map((agent) => agent.id),
            firstId,
            secondId,
        ]);
        expect(project.agents.every((agent) => agent.parentAgentId === null)).toBe(true);

        const child = await readyWorkspace(
            gym,
            (
                await gym.client.createWorkspace({
                    mutationId: "catalog-child-workspace",
                    name: "catalog-child",
                    parentId: root.id,
                })
            ).workspace.id,
        );
        const childAgent = (
            await gym.client.createAgent({
                id: "catalogchildagent",
                mutationId: "catalog-create-child",
                title: "Child workspace agent",
                workspaceId: child.id,
            })
        ).agent;
        await waitForAgentEvent(gym, childAgent.id, "agent.created", "catalog-create-child");

        const rootAfterChild = (await gym.client.getProject(root.id)).project;
        const childAfterCreate = (await gym.client.getWorkspace(child.id)).workspace;
        expect(rootAfterChild.agents.map((agent) => agent.id)).not.toContain(childAgent.id);
        expect(childAfterCreate.agents.map((agent) => agent.id)).toEqual([childAgent.id]);
        expect(childAfterCreate.agents[0]?.workspaceId).toBe(child.id);
        expect(
            (await gym.client.getWorkspace(root.id)).workspace.agents.map((agent) => agent.id),
        ).not.toContain(childAgent.id);

        const global = await gym.raw.get("/v0/agents");
        expect(global.status).toBe(404);
        expect(global.body).toMatchObject({ code: "not_found" });
    }, 60_000);

    it("reorders one owner, versions every changed agent, and keeps draft/read/archive state durable", async () => {
        const gym = await startGym({
            files: { "catalog-root.txt": "catalog root\n" },
            inference: [{ content: [{ text: "catalog response", type: "text" }] }],
        });
        const stream = gym.stream();
        await stream.opened();

        const root = await rootProject(gym);
        const first = (
            await gym.client.createAgent({
                id: "catalogreorderone",
                mutationId: "catalog-reorder-create-one",
                workspaceId: root.id,
            })
        ).agent;
        const second = (
            await gym.client.createAgent({
                id: "catalogreordertwo",
                mutationId: "catalog-reorder-create-two",
                workspaceId: root.id,
            })
        ).agent;
        const child = await readyWorkspace(
            gym,
            (
                await gym.client.createWorkspace({
                    mutationId: "catalog-reorder-child-workspace",
                    name: "catalog-reorder-child",
                    parentId: root.id,
                })
            ).workspace.id,
        );
        const childAgent = (
            await gym.client.createAgent({
                id: "catalogreorderchild",
                mutationId: "catalog-reorder-create-child",
                workspaceId: child.id,
            })
        ).agent;

        const beforeProject = (await gym.client.getProject(root.id)).project;
        const secondBeforeReorder = (await gym.client.getAgent(second.id)).agent;
        const reorder = await gym.client.reorderAgent(second.id, {
            afterId: null,
            mutationId: "catalog-reorder-second-first",
        });
        expect(reorder.agent.orderKey).not.toBe(second.orderKey);
        expect(reorder.agent.version).not.toBe(second.version);
        const projectAfterReorder = (await gym.client.getProject(root.id)).project;
        expect(projectAfterReorder.version).not.toBe(beforeProject.version);
        expect(projectAfterReorder.agents[0]?.id).toBe(second.id);
        expect(projectAfterReorder.agents.map((agent) => agent.id)).not.toContain(childAgent.id);
        expect((await gym.client.getWorkspace(child.id)).workspace.agents).toEqual([
            expect.objectContaining({
                id: childAgent.id,
                workspaceId: child.id,
            }),
        ]);

        const reorderEvent = await waitForAgentEvent(
            gym,
            second.id,
            "agent.updated",
            "catalog-reorder-second-first",
        );
        expect(reorderEvent.payload.previousVersion).toBe(secondBeforeReorder.version);
        expect(reorderEvent.payload.version).toBe(reorder.agent.version);
        expect(reorderEvent.payload.changes).toMatchObject({
            orderKey: reorder.agent.orderKey,
        });
        expect(reorderEvent.payload.mutationId).toBe("catalog-reorder-second-first");

        await expect(gym.client.getAgentMode(first.id)).resolves.toEqual({ mode: null });
        const accepted = await gym.send("remember this mode", {
            effort: "high",
            modelId: "gym/model-2",
            permissionMode: "workspace_write",
            sessionId: first.id,
        });
        expect(accepted.agentId).toBe(first.id);
        const afterSend = await gym.waitUntil(async () => {
            const current = (await gym.client.getAgent(first.id)).agent;
            return current.unread === null ? undefined : current;
        }, "the completed turn to mark the agent unread");
        const afterSendMode = (await gym.client.getAgentMode(first.id)).mode;
        expect(afterSendMode).toEqual({
            effort: "high",
            modelId: "gym/model-2",
            permissionMode: "workspace_write",
            providerId: "gym",
            serviceTier: null,
        });
        expect(afterSend.unread).toMatchObject({ reason: "turn_finished" });
        expect((await gym.client.getAgent(first.id)).agent).not.toHaveProperty("lastMode");

        const read = await gym.client.markAgentRead(first.id, {
            mutationId: "catalog-mark-read",
        });
        expect(read.agent.unread).toBeNull();
        const readEvent = await waitForAgentEvent(
            gym,
            first.id,
            "agent.updated",
            "catalog-mark-read",
        );
        expect(readEvent.payload.changes).toMatchObject({ unread: null });

        const newestDraft = {
            effort: "medium",
            modelId: "gym/model",
            permissionMode: "auto" as const,
            providerId: "gym",
            serviceTier: null,
            text: "newest draft",
        };
        const olderDraft = { ...newestDraft, text: "old draft" };
        const now = Date.now();
        await expect(gym.client.getAgentDraft(first.id)).resolves.toEqual({
            draft: { value: null, updatedAt: null },
        });
        const saved = await gym.client.saveAgentDraft(first.id, {
            draft: newestDraft,
            mutationId: "catalog-draft-new",
            updatedAt: now + 100,
        });
        expect(saved.draft).toEqual({ value: newestDraft, updatedAt: now + 100 });
        const ignored = await gym.client.saveAgentDraft(first.id, {
            draft: olderDraft,
            mutationId: "catalog-draft-old",
            updatedAt: now,
        });
        expect(ignored.draft).toEqual(saved.draft);
        expect((await gym.client.getAgent(first.id)).agent).not.toHaveProperty("draft");
        await expect(gym.client.getAgentBootstrap(first.id)).resolves.toMatchObject({
            draft: saved.draft,
        });
        const draftEvents = (await gym.events()).filter(
            (event) =>
                event.type === "agent.draft.updated" &&
                (event.payload as unknown as Record<string, unknown>).agentId === first.id &&
                ((event.payload as unknown as Record<string, unknown>).mutationId ===
                    "catalog-draft-new" ||
                    (event.payload as unknown as Record<string, unknown>).mutationId ===
                        "catalog-draft-old"),
        );
        expect(
            draftEvents.map(
                (event) => (event.payload as unknown as Record<string, unknown>).mutationId,
            ),
        ).toEqual(["catalog-draft-new"]);
        expect(draftEvents[0]).toMatchObject({
            type: "agent.draft.updated",
            payload: { agentId: first.id, draft: saved.draft },
        });

        const archived = await gym.client.archiveAgent(first.id, {
            mutationId: "catalog-archive",
        });
        expect(archived.agent.archivedAt).not.toBeNull();
        expect(
            (await gym.client.getProject(root.id)).project.agents.map((agent) => agent.id),
        ).not.toContain(first.id);
        await expect(
            gym.client.sendMessage(first.id, {
                mode: {
                    effort: "medium",
                    modelId: "gym/model",
                    permissionMode: "auto",
                    providerId: "gym",
                    serviceTier: null,
                },
                text: "archived agents cannot receive work",
            }),
        ).rejects.toMatchObject({ code: "conflict", status: 409 });

        const unarchived = await gym.client.unarchiveAgent(first.id, {
            mutationId: "catalog-unarchive",
        });
        expect(unarchived.agent.archivedAt).toBeNull();
        expect(
            (await gym.client.getProject(root.id)).project.agents.map((agent) => agent.id),
        ).toContain(first.id);

        await gym.restart();
        const restarted = (await gym.client.getAgent(first.id)).agent;
        expect(restarted).toMatchObject({
            archivedAt: null,
            id: first.id,
            unread: null,
        });
        await expect(gym.client.getAgentDraft(first.id)).resolves.toEqual({ draft: saved.draft });
        await expect(gym.client.getAgentMode(first.id)).resolves.toEqual({
            mode: afterSendMode,
        });
        expect(
            (await gym.client.getProject(root.id)).project.agents.map((agent) => agent.id),
        ).toContain(first.id);
        expect((await gym.client.getWorkspace(child.id)).workspace.agents).toEqual([
            expect.objectContaining({
                id: childAgent.id,
                workspaceId: child.id,
            }),
        ]);
    }, 90_000);

    it("excludes subagents from owner lists and makes all catalog mutations read-only for them", async () => {
        const gym = await startGym({
            inference: (request) =>
                request.callIndex === 1
                    ? {
                          content: [
                              {
                                  arguments: {
                                      effort: "medium",
                                      model: "gym/model",
                                      text: "Do one small child task.",
                                      title: "Catalog subagent",
                                  },
                                  name: "create_agent",
                                  type: "tool_call",
                              },
                              { text: "Created the child.", type: "text" },
                          ],
                      }
                    : { content: [{ text: "Child completed.", type: "text" }] },
        });

        const root = await rootProject(gym);
        await gym.send("Please create a collaborator.");
        const activity = await gym.waitUntil(
            async () => {
                const current = await gym.client.getAgentActivity(gym.defaultSessionId);
                return current.subagents[0];
            },
            "the created subagent",
            30_000,
        );
        const subagent = activity;
        expect(subagent.parentAgentId).toBe(gym.defaultSessionId);
        expect(
            (await gym.client.getProject(root.id)).project.agents.map((agent) => agent.id),
        ).not.toContain(subagent.id);
        expect(
            (await gym.client.getWorkspace(root.id)).workspace.agents.map((agent) => agent.id),
        ).not.toContain(subagent.id);

        const readOnlyOperations: readonly [string, () => Promise<unknown>][] = [
            ["read", () => gym.client.markAgentRead(subagent.id)],
            ["reorder", () => gym.client.reorderAgent(subagent.id, { afterId: null })],
            [
                "draft",
                () =>
                    gym.client.saveAgentDraft(subagent.id, {
                        draft: {
                            effort: "medium",
                            modelId: "gym/model",
                            permissionMode: "auto",
                            providerId: "gym",
                            serviceTier: null,
                            text: "not allowed",
                        },
                    }),
            ],
            ["archive", () => gym.client.archiveAgent(subagent.id)],
            ["unarchive", () => gym.client.unarchiveAgent(subagent.id)],
        ];
        for (const [operation, action] of readOnlyOperations) {
            await expect(action(), operation).rejects.toMatchObject({
                code: "conflict",
                status: 409,
            });
        }
        await expect(
            gym.client.sendMessage(subagent.id, {
                mode: {
                    effort: "medium",
                    modelId: "gym/model",
                    permissionMode: "auto",
                    providerId: "gym",
                    serviceTier: null,
                },
                text: "not allowed",
            }),
        ).rejects.toMatchObject({ code: "conflict", status: 409 });

        await expect(gym.client.getAgent(subagent.id)).resolves.toMatchObject({
            agent: {
                id: subagent.id,
                parentAgentId: gym.defaultSessionId,
            },
        });
        await expect(gym.client.getAgentActivity(gym.defaultSessionId)).resolves.toMatchObject({
            subagents: [expect.objectContaining({ id: subagent.id })],
        });
    }, 90_000);
});

async function startGym(options: Parameters<typeof createAgentGym>[0] = {}): Promise<AgentGym> {
    const gym = await createAgentGym(options);
    activeGyms.add(gym);
    return gym;
}

async function rootProject(gym: AgentGym) {
    return await gym.waitUntil(
        async () => {
            const projects = await gym.client.listProjects();
            const project = projects.projects.find((candidate) =>
                candidate.agents.some((agent) => agent.id === gym.defaultSessionId),
            );
            if (project?.initialization.status !== "ready") return undefined;
            return project;
        },
        "the gym root project to be ready",
        30_000,
    );
}

async function readyWorkspace(gym: AgentGym, workspaceId: string) {
    return await gym.waitUntil(
        async () => {
            const workspace = (await gym.client.getWorkspace(workspaceId)).workspace;
            if (workspace.initialization.status === "failed") {
                throw new Error(
                    workspace.initialization.error ??
                        `Workspace ${workspaceId} failed without an error.`,
                );
            }
            return workspace.initialization.status === "ready" ? workspace : undefined;
        },
        `workspace ${workspaceId} to be ready`,
        30_000,
    );
}

type AgentCreatedEvent = Extract<GymAgentEvent, { type: "agent.created" }>;
type AgentUpdatedEvent = Extract<GymAgentEvent, { type: "agent.updated" }>;

async function waitForAgentEvent(
    gym: AgentGym,
    agentId: string,
    type: "agent.created",
    mutationId?: string,
): Promise<AgentCreatedEvent>;
async function waitForAgentEvent(
    gym: AgentGym,
    agentId: string,
    type: "agent.updated",
    mutationId?: string,
): Promise<AgentUpdatedEvent>;
async function waitForAgentEvent(
    gym: AgentGym,
    agentId: string,
    type: "agent.created" | "agent.updated",
    mutationId?: string,
): Promise<AgentCreatedEvent | AgentUpdatedEvent> {
    const event = await gym.waitForEvent(
        (event) => {
            if (event.type !== type) return false;
            const payload = event.payload as unknown as Record<string, unknown>;
            if (type === "agent.created") {
                const agent = payload.agent as Record<string, unknown> | undefined;
                if (agent?.id !== agentId) return false;
            } else if (payload.agentId !== agentId) return false;
            if (mutationId !== undefined && payload.mutationId !== mutationId) {
                return false;
            }
            return true;
        },
        `${type} for agent ${agentId}`,
        30_000,
    );
    return event as AgentCreatedEvent | AgentUpdatedEvent;
}
