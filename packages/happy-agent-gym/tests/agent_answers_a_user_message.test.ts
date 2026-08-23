import { afterEach, describe, expect, it } from "vitest";

import { createAgentGym, type AgentGym } from "../sources/index.js";

const running = new Set<AgentGym>();

afterEach(async () => {
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
});

describe("the agent answers a user message", () => {
    it("records the answer in the session and shows the model what was asked", async () => {
        const gym = await createAgentGym({
            inference: [{ content: [{ text: "The repository is empty.", type: "text" }] }],
        });
        running.add(gym);

        await gym.send("What is in this repository?");

        expect(agentRequests(gym)).toHaveLength(1);
        expect(gym.inference.userTexts()).toContain("What is in this repository?");
        expect(agentRequests(gym).at(-1)?.model).toBe(gym.selection.modelId);
        expect(gym.inference.unscripted).toEqual([]);

        const events = await gym.sessionEvents();
        const texts = JSON.stringify(events);
        expect(texts).toContain("The repository is empty.");
        expect(gym.errors).toEqual([]);
    });

    it("reports itself healthy and lists the chat a client would open", async () => {
        const gym = await createAgentGym();
        running.add(gym);

        await expect(gym.http.ok("GET", "/v0/health")).resolves.toMatchObject({
            healthy: true,
            ready: true,
        });

        const sessions = await gym.listSessions();
        expect(sessions.map((session) => session.id)).toContain(gym.defaultSessionId);
    });
});

function agentRequests(gym: AgentGym) {
    return gym.inference.requests.filter(
        (request) => !request.instructions.includes("You name a piece of work"),
    );
}
