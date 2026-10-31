import { createHash } from "node:crypto";

import {
    createAgentGym,
    createUnixSocketFetch,
    type AgentGym,
    type GymTurn,
} from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const running = new Set<AgentGym>();
afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

const identityTools = ["search_task_icons", "set_task_title_icon"];
const call = (name: string, args: unknown): GymTurn => ({
    content: [{ type: "tool_call", name, arguments: args }],
});

async function start() {
    const plans = new Map<string, GymTurn[]>();
    let naming = 0;
    const gym = await createAgentGym({
        inference: (request) => {
            if (request.sessionId.startsWith("naming:")) {
                naming += 1;
                return { content: [{ type: "text", text: "<title>Ordinary title</title>" }] };
            }
            return (
                plans.get(request.sessionId)?.shift() ?? {
                    content: [{ type: "text", text: "Done." }],
                }
            );
        },
    });
    running.add(gym);
    return {
        gym,
        naming: () => naming,
        act: async (agentId: string, ...turns: GymTurn[]) => {
            plans.set(agentId, turns);
            await gym.send("Review the pull request.", { sessionId: agentId });
        },
    };
}

describe("a rich task chooses its own identity", () => {
    it("has ordinary search and self-edit tools only while rich tasks is enabled", async () => {
        const { gym, act, naming } = await start();
        const plain = (await gym.client.createTask({})).task;
        await act(plain.agent.id);
        await gym.waitUntil(
            async () =>
                (await gym.client.getTask(plain.id)).task.name === "Ordinary title"
                    ? true
                    : undefined,
            "ordinary naming",
        );
        const plainTools = gym.inference.requests
            .find((r) => r.sessionId === plain.agent.id)!
            .tools.map((t) => t.name)
            .sort();
        for (const name of identityTools) expect(plainTools).not.toContain(name);

        await gym.client.saveUserSetting("tasks.rich", { value: true });
        const fresh = (await gym.client.createTask({})).task;
        const before = naming();
        await act(
            fresh.agent.id,
            call("search_task_icons", { query: "pull request review" }),
            call("set_task_title_icon", { title: "Review the request", icon: "code-review" }),
        );
        const selected = await gym.waitUntil(async () => {
            const task = (await gym.client.getTask(fresh.id)).task;
            return task.name === "Review the request" && task.icon?.slug === "code-review"
                ? task
                : undefined;
        }, "the queued identity change");
        expect(selected.name).toBe("Review the request");
        expect(selected.icon).toMatchObject({
            type: "library",
            slug: "code-review",
            hash: expect.stringMatching(/^[a-f0-9]{64}$/),
        });
        expect(naming()).toBe(before);
        const offered = gym.inference.requests
            .find((r) => r.sessionId === fresh.agent.id)!
            .tools.map((t) => t.name);
        for (const name of identityTools) expect(offered).toContain(name);
        expect(offered).toEqual(expect.arrayContaining(plainTools));
        const results = JSON.stringify(gym.inference.toolResults());
        expect(results).toContain("code-review");
        expect(results).toContain("score");

        await act(
            fresh.agent.id,
            call("set_task_title_icon", { title: "Review completed", icon: "testing" }),
        );
        await gym.waitUntil(
            async () =>
                (await gym.client.getTask(fresh.id)).task.name === "Review completed"
                    ? true
                    : undefined,
            "the refined title",
        );
        await gym.client.saveUserSetting("tasks.rich", { value: false });
        await act(fresh.agent.id);
        const afterTools = gym.inference.requests
            .filter((r) => r.sessionId === fresh.agent.id)
            .at(-1)!
            .tools.map((t) => t.name)
            .sort();
        expect(afterTools).toEqual(plainTools);
        await gym.restart();
        expect((await gym.client.getTask(fresh.id)).task.icon?.slug).toBe("testing");
        expect(gym.errors).toEqual([]);
    }, 60_000);

    it("protects each person's chosen field and never accepts an unrelated target", async () => {
        const { gym, act } = await start();
        await gym.client.saveUserSetting("tasks.rich", { value: true });
        const own = (await gym.client.createTask({})).task;
        const other = (await gym.client.createTask({ name: "Other task" })).task;
        await act(
            own.agent.id,
            call("set_task_title_icon", { title: "Agent title", icon: "login" }),
        );
        const current = await gym.waitUntil(async () => {
            const task = (await gym.client.getTask(own.id)).task;
            return task.name === "Agent title" && task.icon?.slug === "login" ? task : undefined;
        }, "the task identity");
        // Choosing the same title is still a person's deliberate final choice.
        const picked = await gym.client.updateTask(
            own.id,
            { name: "Agent title" },
            { ifMatch: current.version },
        );
        await act(own.agent.id, call("set_task_title_icon", { title: "Overwritten" }));
        expect((await gym.client.getTask(own.id)).task.name).toBe("Agent title");
        await act(own.agent.id, call("set_task_title_icon", { icon: "testing" }));
        const iconed = await gym.waitUntil(async () => {
            const task = (await gym.client.getTask(own.id)).task;
            return task.icon?.slug === "testing" ? task : undefined;
        }, "the task's own icon refinement");
        await gym.client.updateTask(own.id, { icon: null }, { ifMatch: iconed.version });
        await act(own.agent.id, call("set_task_title_icon", { icon: "login" }));
        expect((await gym.client.getTask(own.id)).task.icon).toBeNull();
        await act(
            own.agent.id,
            call("set_task_title_icon", { taskId: other.id, title: "Intrusion" }),
        );
        expect((await gym.client.getTask(other.id)).task.name).toBe("Other task");
        expect(picked.task.name).toBe("Agent title");
        expect(JSON.stringify(gym.inference.toolResults())).toMatch(/person|chosen/i);
        expect(gym.errors).toEqual([]);
    }, 60_000);

    it("rejects invented slugs and keeps ordinary bots outside the identity tool surface", async () => {
        const { gym, act } = await start();
        await gym.client.saveUserSetting("tasks.rich", { value: true });
        const own = (await gym.client.createTask({})).task;
        await act(own.agent.id, call("set_task_title_icon", { icon: "not-in-the-catalog" }));
        expect((await gym.client.getTask(own.id)).task.icon).toBeNull();
        const bot = (await gym.client.createBot({ name: "Helper" })).bot;
        await act(bot.agent.id);
        const offered = gym.inference.requests
            .find((r) => r.sessionId === bot.agent.id)!
            .tools.map((t) => t.name);
        for (const name of identityTools) expect(offered).not.toContain(name);
        await act(
            own.agent.id,
            call("create_subtask", {
                title: "Internal review",
                text: "Review this component.",
                model: gym.selection.modelId,
                effort: gym.selection.effort,
            }),
        );
        const child = await gym.waitUntil(
            async () => (await gym.client.getAgent(own.agent.id)).agent.subtasks?.[0],
            "the child subtask",
        );
        const childRequest = await gym.waitUntil(
            () => gym.inference.requests.find((r) => r.sessionId === child.id),
            "the child's inference",
        );
        for (const name of identityTools)
            expect(childRequest.tools.map((t) => t.name)).not.toContain(name);
        expect(gym.errors).toEqual([]);
    }, 60_000);

    it("serves current raw artwork by hash, revalidates, and rejects stale immutable versions", async () => {
        const { gym } = await start();
        const fetch = createUnixSocketFetch(gym.socketPath);
        const headers = { authorization: `Bearer ${gym.token}` };
        const url = "http://happy-agent.invalid/v0/task-icons/code-review";
        const image = await fetch(url, { headers });
        expect(image.status).toBe(200);
        expect(image.headers.get("content-type")).toBe("image/webp");
        expect(image.headers.get("cache-control")).toBe("no-cache");
        const bytes = new Uint8Array(await image.arrayBuffer());
        const hash = createHash("sha256").update(bytes).digest("hex");
        expect(image.headers.get("etag")).toBe(`"${hash}"`);
        const versioned = await fetch(`${url}?v=${hash}`, { headers });
        expect(versioned.status).toBe(200);
        expect(versioned.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
        expect(new Uint8Array(await versioned.arrayBuffer())).toEqual(bytes);
        const unchanged = await fetch(`${url}?v=${hash}`, {
            headers: { ...headers, "if-none-match": `W/"${hash}"` },
        });
        expect(unchanged.status).toBe(304);
        expect(await unchanged.text()).toBe("");
        expect(unchanged.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
        expect((await fetch(`${url}?v=${"0".repeat(64)}`, { headers })).status).toBe(404);
        expect(
            (await fetch("http://happy-agent.invalid/v0/task-icons/missing-icon", { headers }))
                .status,
        ).toBe(404);
        expect((await fetch(url)).status).toBe(401);
        expect(gym.errors).toEqual([]);
    }, 30_000);
});
