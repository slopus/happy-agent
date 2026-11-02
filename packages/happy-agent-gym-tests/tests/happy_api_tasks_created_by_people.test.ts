import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const running = new Set<AgentGym>();
afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

const TASK_ID = "taskcreatedbyperson00001";

/** A gym whose naming model answers `names`, and whose task agent says it is on it. */
async function namingGym(names: string) {
    const gym = await createAgentGym({
        timeoutMs: 20_000,
        inference: (request) =>
            request.sessionId.startsWith("naming:")
                ? { content: [{ type: "text", text: names }] }
                : { content: [{ type: "text", text: "On it." }] },
    });
    running.add(gym);
    return gym;
}

describe("tasks people create", () => {
    it("is ready at once, retries without side effects, runs, names itself, and renames", async () => {
        const gym = await namingGym(
            "<title>Audit billing exports</title><short>Billing</short><slug>audit-billing-exports</slug>",
        );
        const before = (await gym.client.getEvents()).latestCursor;

        const { task, membership } = await gym.client.createTask({
            id: TASK_ID,
            mutationId: "create-task-1",
        });
        expect(task).toMatchObject({
            id: TASK_ID,
            name: "New Task",
            folderName: "task",
            ownerUserId: null,
            creatorAgentId: null,
            status: "active",
            canArchive: true,
            agent: { userVisible: true, managedByAnotherAgent: false, canSendMessages: true },
        });
        // The installation's one person joins the task at the top of their list.
        expect(membership).toMatchObject({ taskId: TASK_ID, userId: null });
        expect((await gym.client.getAgentMode(task.agent.id)).mode).toBeNull();

        // Its workspace is a real folder, worked on like a bot's.
        expect((await gym.client.getWorkspace(task.workspaceId)).workspace).toMatchObject({
            kind: "task",
            taskId: TASK_ID,
        });
        await gym.client.writeFile(task.workspaceId, {
            path: "notes.md",
            content: Buffer.from("# Notes\n").toString("base64"),
            expectedHash: null,
        });
        expect(
            (await gym.client.getFileTree(task.workspaceId)).entries.map((entry) => entry.path),
        ).toEqual(["notes.md"]);

        // Repeating the ID answers the same task and changes nothing.
        const again = await gym.client.createTask({ id: TASK_ID, name: "Ignored" });
        expect(again.task).toMatchObject({ id: TASK_ID, name: "New Task", version: task.version });
        const types = (await gym.client.getEvents({ after: before })).events
            .map((event) => event.type)
            .filter((type) => type.startsWith("task.") || type === "agent.created");
        expect(types.filter((type) => type.startsWith("task."))).toEqual([
            "task.created",
            "task.joined",
        ]);
        expect(types.filter((type) => type === "agent.created")).toHaveLength(1);

        // The person's first message runs on the mode it carries and names the task.
        await gym.send("Audit the billing exports for duplicate rows.", {
            sessionId: task.agent.id,
        });
        expect(
            gym.inference.requests.find((request) => request.sessionId === task.agent.id),
        ).toMatchObject({ model: gym.selection.modelId, effort: gym.selection.effort });
        const named = await gym.waitUntil(async () => {
            const current = (await gym.client.getTask(TASK_ID)).task;
            return current.name === "Audit billing exports" ? current : undefined;
        }, "the task's generated name");
        expect(named.folderName).toBe("task");
        // The short name comes from the same single naming request.
        expect(named.shortName).toBe("Billing");
        expect((await gym.client.getDesktopBootstrap()).tasks).toEqual([
            expect.objectContaining({ id: TASK_ID, shortName: "Billing" }),
        ]);
        const naming = gym.inference.requests.filter((r) => r.sessionId.startsWith("naming:"));
        expect(naming).toHaveLength(1);
        expect(JSON.stringify(naming[0])).toContain("within 13 characters");

        // A rename is a person's decision and is checked against the current version.
        const renamed = await gym.client.renameTask(
            TASK_ID,
            { name: "Billing audit" },
            { ifMatch: named.version },
        );
        expect(renamed.task).toMatchObject({ name: "Billing audit", folderName: "task" });
        // The generated short name described the old name, so a rename clears it.
        expect(renamed.task.shortName).toBeUndefined();
        expect((await gym.client.getAgent(task.agent.id)).agent.title).toBe("Billing audit");
        await expect(
            gym.client.renameTask(TASK_ID, { name: "Stale" }, { ifMatch: named.version }),
        ).rejects.toMatchObject({ status: 409 });
        expect(gym.inference.unscripted).toEqual([]);
    });

    it("leaves the short name out rather than cutting one over its budget", async () => {
        const gym = await namingGym(
            "<title>Audit billing exports</title><short>Billing exports audit</short>",
        );
        const { task } = await gym.client.createTask({ id: TASK_ID });
        await gym.send("Audit the billing exports for duplicate rows.", {
            sessionId: task.agent.id,
        });
        const named = await gym.waitUntil(async () => {
            const current = (await gym.client.getTask(TASK_ID)).task;
            return current.name === "Audit billing exports" ? current : undefined;
        }, "the task's generated name");
        expect(named.shortName).toBeUndefined();
        expect(
            gym.inference.requests.filter((r) => r.sessionId.startsWith("naming:")),
        ).toHaveLength(1);
        expect(gym.errors).toEqual([]);
    });
});
