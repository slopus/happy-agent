import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const running = new Set<AgentGym>();
afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

async function gymWith() {
    const gym = await createAgentGym();
    running.add(gym);
    const tasks: Record<string, string> = {};
    for (const name of ["A", "B", "C", "D"]) {
        tasks[name] = (await gym.client.createTask({ name })).task.id;
    }
    return { gym, tasks };
}

const PRIORITIES = "s9d8f7g6h5j4k3l2m1n0b9v8";
const LATER = "s1q2w3e4r5t6y7u8i9o0p1a2";

describe("task sections and hidden tasks", () => {
    it("head the list without changing the order an older client reads", async () => {
        const { gym, tasks } = await gymWith();
        const joined = async () => await gym.client.listTasks({ scope: "joined" });
        const before = await joined();
        expect(before.tasks.map((task) => task.name)).toEqual(["D", "C", "B", "A"]);
        expect(before.sections).toEqual([]);

        // Headers go in beside the tasks; no membership moves.
        const { sections } = await gym.client.replaceTaskSections({
            sections: [
                { id: PRIORITIES, name: "Priorities", collapsed: false, after: null },
                { id: LATER, name: "Later", collapsed: true, after: { taskId: tasks["C"]! } },
            ],
        });
        expect(sections.map((section) => section.name)).toEqual(["Priorities", "Later"]);
        const sectioned = await joined();
        expect(sectioned.memberships).toEqual(before.memberships);
        expect(sectioned.tasks.map((task) => task.id)).toEqual(before.tasks.map((task) => task.id));
        expect(sectioned.sections).toEqual(sections);
        expect((await gym.client.getDesktopBootstrap()).taskSections).toEqual(sections);

        // A move into another section changes exactly one key: the moved task's.
        const cursor = (await gym.client.getEvents()).latestCursor;
        await gym.client.reorderTask(tasks["D"]!, { afterSectionId: LATER });
        const moved = await joined();
        const changed = moved.memberships.filter(
            (membership) => !before.memberships.some((was) => was.orderKey === membership.orderKey),
        );
        expect(changed.map((membership) => membership.taskId)).toEqual([tasks["D"]]);
        const keyOf = (id: string) =>
            moved.memberships.find((membership) => membership.taskId === id)!.orderKey;
        expect(keyOf(tasks["D"]!) > sections[1]!.orderKey).toBe(true);
        expect(keyOf(tasks["D"]!) < keyOf(tasks["B"]!)).toBe(true);
        expect(moved.sections).toEqual(sections);

        // Moving a section takes its tasks along: Later, D, B, A, then Priorities, C.
        await gym.client.replaceTaskSections({
            sections: [
                { id: PRIORITIES, name: "Priorities", collapsed: false },
                { id: LATER, name: "Later", collapsed: true, after: null },
            ],
        });
        const regrouped = await joined();
        expect(regrouped.tasks.map((task) => task.name)).toEqual(["D", "B", "A", "C"]);
        const events = (await gym.client.getEvents({ after: cursor })).events;
        expect(events.map((event) => event.type)).toEqual([
            "task.reordered",
            "task.reordered",
            "task.reordered",
            "task.reordered",
            "task.sections.updated",
        ]);

        // Hidden is the member's own, keeps the task's place, and round-trips.
        const hidden = await gym.client.updateTaskMembership(tasks["A"]!, { hidden: true });
        const listed = await joined();
        expect(listed.memberships).toEqual(
            regrouped.memberships.map((m) => (m.taskId === tasks["A"] ? hidden.membership : m)),
        );
        expect(hidden.membership?.hidden).toBe(true);
        await gym.client.updateTaskMembership(tasks["A"]!, { hidden: true });
        const shown = await gym.client.updateTaskMembership(tasks["A"]!, { hidden: false });
        expect(shown.membership?.hidden).toBe(false);
        const hides = (await gym.client.getEvents({ after: cursor })).events.filter(
            (event) => event.type === "task.membership.updated",
        );
        expect(hides).toHaveLength(2);

        // Limits.
        const put = async (body: unknown) => await gym.http.put("/v0/tasks/sections", body);
        const entry = (id: string, name: string) => ({ id, name, collapsed: false });
        expect(
            (await put({ sections: [entry(PRIORITIES, "Same"), entry(LATER, "SAME")] })).status,
        ).toBe(400);
        const many = Array.from({ length: 51 }, (_, index) =>
            entry(`s${String(index).padStart(23, "0")}`, `Section ${String(index)}`),
        );
        expect((await put({ sections: many })).status).toBe(400);
        const after = { taskId: "t0000000000000000000000x" };
        expect((await put({ sections: [{ ...entry(LATER, "Later"), after }] })).status).toBe(409);
        const reorder = await gym.http.post(`/v0/tasks/${tasks["A"]!}/reorder`, {
            afterSectionId: "s0000000000000000000000x",
        });
        expect(reorder.status).toBe(409);
        expect((await joined()).sections?.map((section) => section.name)).toEqual([
            "Later",
            "Priorities",
        ]);
        expect(gym.errors).toEqual([]);
    }, 60_000);
});
