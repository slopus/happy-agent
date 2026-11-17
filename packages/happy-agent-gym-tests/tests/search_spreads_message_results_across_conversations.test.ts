import { createAgentGym, type AgentGym, type GymTurn } from "@slopus/happy-agent-gym";
import type { SearchResult } from "@slopus/happy-agent-client";
import { afterEach, describe, expect, it, vi } from "vitest";

const running = new Set<AgentGym>();
afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

/** Fields this daemon adds to message and agent results beyond the published client's types. */
type Placed = SearchResult & { parentAgentId?: string | null; agentMatchCount?: number };

describe("search spreads message results across conversations", () => {
    it("takes at most three messages from a long conversation and names a subtask's parent", async () => {
        const commands = new Map<string, GymTurn>();
        const gym = await createAgentGym({
            timeoutMs: 20_000,
            inference: (request) => {
                const command = commands.get(request.sessionId);
                if (command !== undefined) {
                    commands.delete(request.sessionId);
                    return command;
                }
                const asked = JSON.stringify(request.messages.at(-1) ?? "");
                return {
                    content: [
                        {
                            type: "text",
                            text: asked.includes("zeppelin zeppelin")
                                ? "Noted the zeppelin zeppelin report."
                                : "Ready.",
                        },
                    ],
                };
            },
        });
        running.add(gym);

        // One long conversation where the word matches again and again: the person's message and
        // the answer to it, six in all, each a better match than the short conversation's.
        const long = gym.defaultSessionId;
        for (const day of ["Monday", "Tuesday", "Wednesday"])
            await gym.send(`zeppelin zeppelin report for ${day}`, { sessionId: long });
        const short = (await gym.createSession({ cwd: gym.workspacePath })).id;
        await gym.send("A zeppelin passed somewhere among a great many other words.", {
            sessionId: short,
        });

        // A bot creates a subtask whose first message holds the word.
        const bot = (await gym.client.createBot({ name: "Airship coordinator" })).bot;
        commands.set(bot.agent.id, {
            content: [
                {
                    type: "tool_call",
                    name: "create_subtask",
                    callId: "create_airship_subtask",
                    arguments: {
                        title: "Airship survey",
                        text: "Survey the zeppelin hangar.",
                        model: "gym/model",
                        effort: "low",
                    },
                },
            ],
        });
        await gym.send("Please start the survey.", { sessionId: bot.agent.id });
        const created = await gym.waitUntil(
            async () =>
                gym.inference
                    .toolResults()
                    .find((item) => item.callId === "create_airship_subtask"),
            "the subtask",
        );
        const subtaskId = /Created subtask ([a-z0-9]+)/.exec(created.text)?.[1];
        if (subtaskId === undefined) throw new Error(`No subtask was created: ${created.text}`);

        // Conversations come from a catalog the daemon refreshes every few seconds.
        await vi.waitFor(
            async () => {
                const found = (
                    await gym.client.search({ q: "zeppelin", types: ["message"], limit: 5 })
                ).results as Placed[];
                const messages = found.filter((result) => result.type === "message");
                const fromLong = messages.filter((result) => result.agentId === long);
                expect(fromLong).toHaveLength(3);
                for (const result of fromLong) expect(result.agentMatchCount).toBe(6);
                expect(messages.map((result) => result.agentId)).toEqual(
                    expect.arrayContaining([long, short, subtaskId]),
                );
                expect(messages.find((result) => result.agentId === subtaskId)).toMatchObject({
                    parentAgentId: bot.agent.id,
                    agentMatchCount: 1,
                });
                expect(messages.find((result) => result.agentId === short)).toMatchObject({
                    parentAgentId: null,
                    agentMatchCount: 1,
                });
            },
            { timeout: 15_000, interval: 500 },
        );

        // The subtask's own result names its parent too; a top-level conversation has none.
        const agents = (await gym.client.search({ q: "airship", types: ["agent"] }))
            .results as Placed[];
        expect(agents.find((result) => result.key === `agent:${subtaskId}`)).toMatchObject({
            kind: "subtask",
            parentAgentId: bot.agent.id,
        });
        expect(agents.find((result) => result.key === `agent:${bot.agent.id}`)).toMatchObject({
            kind: "bot",
            parentAgentId: null,
        });
        expect(gym.errors).toEqual([]);
    }, 120_000);
});
