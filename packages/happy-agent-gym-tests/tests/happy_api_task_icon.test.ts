import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const running = new Set<AgentGym>();
afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("task icon API", () => {
    it("serves a current digest for a stored slug and ignores a caller's stale digest", async () => {
        const gym = await createAgentGym();
        running.add(gym);
        const fresh = (await gym.client.createTask({ name: "Review" })).task;
        const chosen = await gym.client.updateTask(
            fresh.id,
            {
                icon: { type: "library", slug: "code-review", hash: "0".repeat(64) },
            },
            { ifMatch: fresh.version },
        );
        expect(chosen.task.icon).toMatchObject({
            type: "library",
            slug: "code-review",
            hash: expect.stringMatching(/^[a-f0-9]{64}$/),
        });
        expect(chosen.task.icon?.hash).not.toBe("0".repeat(64));
        const hash = chosen.task.icon!.hash!;
        expect((await gym.http.get(`/v0/task-icons/code-review?v=${hash}`)).status).toBe(200);
        await gym.restart();
        expect((await gym.client.getTask(fresh.id)).task.icon).toEqual(chosen.task.icon);
        const invalid = await gym.http.patch(`/v0/tasks/${fresh.id}`, {
            icon: { type: "library", slug: "invented-topic" },
        });
        expect(invalid.status).toBe(400);
        expect((await gym.client.getTask(fresh.id)).task.icon).toEqual(chosen.task.icon);
        expect(gym.errors).toEqual([]);
    }, 30_000);

    it("leaves ordinary title naming unchanged and skips both fields when rich tasks are enabled", async () => {
        let naming = 0;
        const gym = await createAgentGym({
            inference: (request) => {
                if (request.sessionId.startsWith("naming:")) {
                    naming += 1;
                    expect(request.instructions).not.toContain("<icon>");
                    return { content: [{ type: "text", text: "<title>Login redirect</title>" }] };
                }
                return { content: [{ type: "text", text: "On it." }] };
            },
        });
        running.add(gym);
        const plain = (await gym.client.createTask({})).task;
        await gym.send("Fix the login redirect.", { sessionId: plain.agent.id });
        await gym.waitUntil(
            async () =>
                (await gym.client.getTask(plain.id)).task.name === "Login redirect"
                    ? true
                    : undefined,
            "ordinary task naming",
        );
        expect((await gym.client.getTask(plain.id)).task.icon).toBeNull();
        await gym.client.saveUserSetting("tasks.rich", { value: true });
        const rich = (await gym.client.createTask({})).task;
        const before = naming;
        await gym.send("Fix the login redirect.", { sessionId: rich.agent.id });
        expect((await gym.client.getTask(rich.id)).task.name).toBe("New Task");
        expect((await gym.client.getTask(rich.id)).task.icon).toBeNull();
        expect(naming).toBe(before);
        expect(gym.errors).toEqual([]);
    }, 30_000);
});
