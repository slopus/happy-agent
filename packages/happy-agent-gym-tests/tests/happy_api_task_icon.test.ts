import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const running = new Set<AgentGym>();
afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

/** A gym whose naming requests wait for `release`, so a person can act while one runs. */
async function iconGym(environment: Record<string, string>) {
    const naming: string[] = [];
    const held = { gate: Promise.resolve(), release: () => {} };
    const gym = await createAgentGym({
        environment,
        inference: async (request) => {
            if (!request.sessionId.startsWith("naming:")) {
                return { content: [{ type: "text", text: "On it." }] };
            }
            naming.push(request.instructions);
            await held.gate;
            const text = "<title>Fix the login redirect</title><icon>login</icon>";
            return { content: [{ type: "text", text }] };
        },
    });
    running.add(gym);
    const hold = () => (held.gate = new Promise((resolve) => (held.release = resolve)));
    const started = async (count: number) =>
        await gym.waitUntil(() => (naming.length === count ? true : undefined), "naming");
    /** The task once its one naming request, the `count`th, has written a name and an icon. */
    const named = async (taskId: string, count: number) => {
        await started(count);
        return await gym.waitUntil(async () => {
            const { task } = await gym.client.getTask(taskId);
            return task.name !== "New Task" && task.icon !== null ? task : undefined;
        }, "the naming job to finish");
    };
    return { gym, naming, hold, release: () => held.release(), started, named };
}

describe("task icons", () => {
    it("are picked by the naming request, and a person's pick or rename always wins", async () => {
        const { gym, naming, hold, release, started, named } = await iconGym({
            HAPPY_AGENT_TASK_SECTIONS: "1",
        });
        // Rich tasks off: today's naming request, and no icon.
        const plain = (await gym.client.createTask({})).task;
        expect(plain.icon).toBeNull();
        await gym.send("Fix the login redirect.", { sessionId: plain.agent.id });
        await gym.waitUntil(async () => {
            const { task } = await gym.client.getTask(plain.id);
            return task.name === "Fix the login redirect" ? task : undefined;
        }, "the plain task to be named");
        expect((await gym.client.getTask(plain.id)).task.icon).toBeNull();
        expect(naming[0]).not.toContain("<icon>");

        await gym.client.saveUserSetting("tasks.rich", { value: true });
        const fresh = (await gym.client.createTask({})).task;
        await gym.send("The login page loops.", { sessionId: fresh.agent.id });
        const iconed = await named(fresh.id, 2);
        expect(iconed).toMatchObject({ name: "Fix the login redirect" });
        expect(iconed.icon).toEqual({ type: "library", slug: "login" });
        expect(naming[1]).toContain("<title>");
        expect(naming[1]).toContain("<icon>");

        // A named task gets its icon alone, from the same job.
        const titled = (await gym.client.createTask({ name: "Release notes" })).task;
        await gym.send("Write them.", { sessionId: titled.agent.id });
        expect(await named(titled.id, 3)).toMatchObject({ name: "Release notes" });
        expect(naming[2]).not.toContain("<title>");

        // A person's icon, committed while naming runs, survives it.
        hold();
        const picked = (await gym.client.createTask({})).task;
        await gym.send("Login breaks.", { sessionId: picked.agent.id });
        await started(4);
        const pick = await gym.client.updateTask(
            picked.id,
            { icon: { type: "library", slug: "crash" } },
            { ifMatch: picked.version },
        );
        release();
        expect(await named(picked.id, 4)).toMatchObject({
            name: "Fix the login redirect",
            icon: { type: "library", slug: "crash" },
        });
        expect(pick.task.icon).toEqual({ type: "library", slug: "crash" });

        // So does a rename, while the icon still comes from naming.
        hold();
        const renamed = (await gym.client.createTask({})).task;
        await gym.send("Login breaks again.", { sessionId: renamed.agent.id });
        await started(5);
        await gym.client.updateTask(
            renamed.id,
            { name: "My own name" },
            { ifMatch: renamed.version },
        );
        release();
        expect(await named(renamed.id, 5)).toMatchObject({
            name: "My own name",
            icon: { type: "library", slug: "login" },
        });
        await gym.restart();
        expect((await gym.client.getTask(picked.id)).task.icon?.slug).toBe("crash");
        expect(gym.errors).toEqual([]);
    }, 60_000);

    it("are neither served nor accepted until the daemon serves rich tasks", async () => {
        const { gym, naming, started } = await iconGym({});
        await gym.client.saveUserSetting("tasks.rich", { value: true });
        const { task } = await gym.client.createTask({});
        expect("icon" in task).toBe(false);
        await gym.send("Fix the login redirect.", { sessionId: task.agent.id });
        await started(1);
        expect(naming[0]).not.toContain("<icon>");
        const response = await gym.http.patch(`/v0/tasks/${task.id}`, {
            icon: { type: "library", slug: "crash" },
        });
        expect(response.status).toBe(400);
        expect(gym.errors).toEqual([]);
    }, 30_000);
});
