import { createAgentGym, runGymSql, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const running = new Set<AgentGym>();
afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("task child choices", () => {
    it("hide one workspace under one task and show it under another, until forgotten", async () => {
        const gym = await createAgentGym();
        running.add(gym);
        const health = await gym.client.getHealth();
        expect(health.version.protocol).toBe(34);
        expect(health.capabilities?.taskSections).toBe(true);

        const projectId = (await gym.getSession()).workspaceId;
        await gym.waitUntil(async () => {
            const root = await gym.client.getWorkspace(projectId).catch(() => undefined);
            return root?.workspace.initialization.status === "ready" ? root : undefined;
        }, "the project to be ready");
        const shared = (await gym.client.createWorkspace({ name: "shared", parentId: projectId }))
            .workspace;
        const a = (await gym.client.createTask({ name: "A" })).task;
        const b = (await gym.client.createTask({ name: "B" })).task;
        expect(a.children).toEqual([]);
        const ref = { kind: "workspace", id: shared.id } as const;
        const cursor = (await gym.client.getEvents()).latestCursor;

        const hidden = await gym.client.setTaskChild(a.id, ref, {
            visibility: "hidden",
            mutationId: "hide-under-a",
        });
        await gym.client.setTaskChild(b.id, ref, { visibility: "shown" });
        expect(hidden.task.children).toEqual([
            {
                ref,
                visibility: "hidden",
                by: { agentId: null, userId: null },
                updatedAt: expect.any(Number),
            },
        ]);
        expect(hidden.task.version).not.toBe(a.version);
        const { tasks } = await gym.client.listTasks();
        const visibilityUnder = (id: string) =>
            tasks.find((task) => task.id === id)?.children?.map((child) => child.visibility);
        expect(visibilityUnder(a.id)).toEqual(["hidden"]);
        expect(visibilityUnder(b.id)).toEqual(["shown"]);

        // The same choice again changes nothing; forgetting it returns the default.
        const again = await gym.client.setTaskChild(a.id, ref, { visibility: "hidden" });
        expect(again.task.version).toBe(hidden.task.version);
        const cleared = await gym.client.clearTaskChild(a.id, ref, { mutationId: "forget-a" });
        expect(cleared.task.children).toEqual([]);
        await gym.client.clearTaskChild(a.id, ref);
        expect((await gym.client.getTask(b.id)).task.children).toHaveLength(1);
        const updates = (await gym.client.getEvents({ after: cursor })).events.flatMap((event) =>
            event.type === "task.updated" ? [event.payload] : [],
        );
        expect(
            updates.map(({ taskId, changes, mutationId }) => [
                taskId,
                changes.children,
                mutationId,
            ]),
        ).toEqual([
            [a.id, hidden.task.children, "hide-under-a"],
            [b.id, expect.any(Array), undefined],
            [a.id, [], "forget-a"],
        ]);

        // Validation: what the child is, that it exists, and the request body.
        const path = (kind: string, id: string) => `/v0/tasks/${a.id}/children/${kind}/${id}`;
        const put = async (target: string, body: unknown) =>
            (await gym.http.put(target, body)).status;
        expect(await put(path("surface", shared.id), { visibility: "shown" })).toBe(400);
        expect(await put(path("workspace", shared.id), { visibility: "default" })).toBe(400);
        expect(await put(path("workspace", shared.id), {})).toBe(400);
        expect(
            await put(path("artifact", "r0000000000000000000000x"), { visibility: "shown" }),
        ).toBe(404);
        const missingTask = `/v0/tasks/t0000000000000000000000x/children/workspace/${shared.id}`;
        expect(await put(missingTask, { visibility: "shown" })).toBe(404);
        expect(gym.errors).toEqual([]);
    }, 60_000);

    it("resolve every kind of workspace, and neither fail reads nor fill the limit once gone", async () => {
        const gym = await createAgentGym({ config: "[features]\nworkspaces = false\n" });
        running.add(gym);
        const a = (await gym.client.createTask({ name: "A" })).task;
        const b = (await gym.client.createTask({ name: "B" })).task;
        // 200 choices about children that are gone, among them a project workspace.
        const rows = Array.from({ length: 200 }, (_, index) => {
            const kind = index === 0 ? "workspace" : "artifact";
            const id = `r${String(index).padStart(23, "0")}`;
            return `('${a.id}', '${kind}', '${id}', 'hidden', NULL, NULL, ${String(index + 1)})`;
        });
        await gym.restart({
            whileStopped: async () =>
                await runGymSql(gym.happyHome, [
                    `INSERT INTO happy_agent_module_task_children VALUES ${rows.join(", ")}`,
                ]),
        });
        expect((await gym.client.getTask(a.id)).task.children).toEqual([]);
        expect((await gym.client.listTasks()).tasks).toHaveLength(2);
        expect((await gym.client.getDesktopBootstrap()).tasks).toHaveLength(2);

        // A task's workspace and a project root are workspaces; the gone choices make room.
        const root = (await gym.getSession()).workspaceId;
        const show = async (id: string) =>
            await gym.client.setTaskChild(a.id, { kind: "workspace", id }, { visibility: "shown" });
        await show(b.workspaceId);
        const both = await show(root);
        expect(both.task.children?.map((child) => child.ref.id)).toEqual([b.workspaceId, root]);
        expect(gym.errors).toEqual([]);
    }, 60_000);

    it("lists the artifacts each active task made in desktop bootstrap", async () => {
        const gym = await createAgentGym();
        running.add(gym);
        const task = (await gym.client.createTask({ name: "Report" })).task;
        const make = async (title: string, source: unknown) =>
            await gym.client.createArtifact({
                type: "markdown",
                title,
                files: [{ path: "index.md", text: `# ${title}` }],
                source: source as never,
            });
        const fromTask = { kind: "task", taskId: task.id, agentId: task.agent.id };
        const plan = (await make("Plan", fromTask)).artifact;
        const results = (await make("Results", fromTask)).artifact;
        const gone = (await make("Draft", fromTask)).artifact;
        await gym.client.deleteArtifact(gone.id, { ifMatch: gone.version });
        await make("Elsewhere", { kind: "agent", agentId: gym.defaultSessionId });

        const { taskArtifacts } = await gym.client.getDesktopBootstrap();
        const newestFirst = [plan, results].sort(
            (x, y) => y.updatedAt - x.updatedAt || (y.id > x.id ? 1 : -1),
        );
        expect(taskArtifacts).toEqual(
            newestFirst.map((artifact) => ({
                artifactId: artifact.id,
                taskId: task.id,
                agentId: task.agent.id,
                title: artifact.title,
                type: "markdown",
                updatedAt: artifact.updatedAt,
            })),
        );
        expect(gym.errors).toEqual([]);
    }, 60_000);
});
