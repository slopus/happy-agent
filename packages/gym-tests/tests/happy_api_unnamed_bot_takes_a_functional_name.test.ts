import { stat } from "node:fs/promises";

import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, expect, it } from "vitest";

const running = new Set<AgentGym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

it("creates without a name, names from the first user message, and preserves manual identity across restart", async () => {
    const gym = await createAgentGym({
        inference(request) {
            return {
                content: [
                    {
                        type: "text",
                        text: request.sessionId.startsWith("naming:")
                            ? "<title>Release Steward</title>"
                            : "I will track releases.",
                    },
                ],
            };
        },
    });
    running.add(gym);

    await expect(gym.client.getHealth()).resolves.toMatchObject({
        version: { protocol: 25 },
    });
    const created = (await gym.client.createBot({})).bot;
    expect(created).toMatchObject({
        name: "New Bot",
        username: "bot",
        status: "active",
        agent: { title: "New Bot", canSendMessages: true },
    });
    expect(created).not.toHaveProperty("nameConfigured");
    if (created.compute.type !== "host") throw new Error("Expected a local bot folder.");
    expect((await stat(created.compute.path)).isDirectory()).toBe(true);
    await expect(gym.client.getWorkspace(created.workspaceId)).resolves.toMatchObject({
        workspace: {
            botId: created.id,
            agents: [expect.objectContaining({ id: created.agent.id })],
        },
    });

    await gym.send("Track releases and flag regressions for me.", { sessionId: created.agent.id });
    const named = await gym.waitUntil(async () => {
        const bot = (await gym.client.getBot(created.id)).bot;
        return bot.name === "Release Steward" ? bot : undefined;
    }, "the bot to receive its functional name");
    expect(named).toMatchObject({
        id: created.id,
        workspaceId: created.workspaceId,
        username: created.username,
        compute: created.compute,
        agent: { id: created.agent.id, title: "Release Steward" },
    });
    const naming = gym.inference.requests.filter((request) =>
        request.sessionId.startsWith("naming:"),
    );
    expect(naming).toHaveLength(1);
    expect(naming[0]?.instructions).toContain("rather than a task title");
    expect(naming[0]?.tools).toEqual([]);
    expect(JSON.stringify(naming[0]?.messages)).toContain("flag regressions");

    await gym.client.renameBot(named.id, { name: "Scout" }, { ifMatch: named.version });
    await gym.restart();
    await gym.send("Now inspect this release.", { sessionId: created.agent.id });
    await expect(gym.client.getBot(created.id)).resolves.toMatchObject({
        bot: {
            name: "Scout",
            username: created.username,
            workspaceId: created.workspaceId,
            compute: created.compute,
            agent: { id: created.agent.id, title: "Scout" },
        },
    });
    expect(
        gym.inference.requests.filter((request) => request.sessionId.startsWith("naming:")),
    ).toHaveLength(1);
    expect(gym.errors).toEqual([]);
    expect(gym.inference.unscripted).toEqual([]);
});
