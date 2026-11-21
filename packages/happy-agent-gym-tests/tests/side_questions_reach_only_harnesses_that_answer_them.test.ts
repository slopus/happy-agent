import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, expect, it } from "vitest";

const AGENT = fileURLToPath(
    new URL("../fixtures/background-working-acp-agent.mjs", import.meta.url),
);
const MODEL = "acp/scripted/m1";
const SELECTION = {
    providerId: "scripted",
    modelId: MODEL,
    effort: "medium",
    permissionMode: "workspace_write",
} as const;
const running = new Set<AgentGym>();

afterEach(async () => {
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
});

/** A daemon running a scripted ACP agent, which, like every plain ACP agent, has no side questions. */
async function gymWithScriptedHarness(): Promise<AgentGym> {
    const gym = await createAgentGym({
        config: [
            "[harnesses.scripted]",
            'type = "acp"',
            'name = "Scripted Agent"',
            `command = ${JSON.stringify(process.execPath)}`,
            `args = [${JSON.stringify(AGENT)}]`,
            "",
        ].join("\n"),
        liveProviders: ["scripted"],
    });
    running.add(gym);
    // The daemon never asks a test-owned catalog's agents for their models; give it the one.
    const directory = join(gym.happyHome, "agent", "foreign-agents", "scripted");
    await mkdir(directory, { recursive: true });
    await writeFile(
        join(directory, "models.json"),
        JSON.stringify([
            {
                id: MODEL,
                name: "Model One",
                effortLevels: ["medium"],
                defaultEffort: "medium",
                contextWindow: 1_000_000,
            },
        ]),
    );
    await gym.restart();
    return gym;
}

it("refuses side questions a harness cannot answer, and keeps them out of the chat", async () => {
    const gym = await gymWithScriptedHarness();
    const path = `/v0/agents/${gym.defaultSessionId}/side-questions`;

    const health = await gym.http.get<{ capabilities: Record<string, unknown> }>("/v0/health");
    expect(health.body.capabilities["sideQuestions"]).toBe(true);
    const config = await gym.http.get<{
        config: { models: Record<string, Record<string, unknown>> };
    }>("/v0/config");
    expect(config.body.config.models[MODEL]).toBeDefined();
    expect(config.body.config.models[MODEL]).not.toHaveProperty("sideQuestions");

    // Before its first message the agent has no mode, so nothing runs its conversation.
    const early = await gym.http.post(path, { question: "Anything?" });
    expect(early.status).toBe(409);
    expect(early.body).toMatchObject({ code: "harness_not_running" });

    await gym.send("start two background tasks", SELECTION);
    await gym.waitUntil(
        async () => ((await gym.getSession()).status === "idle" ? true : undefined),
        "the turn to end",
    );
    const before = await gym.history();

    const refused = await gym.http.post(path, { question: "What did you start?" });
    expect(refused.status).toBe(501);
    expect(refused.body).toMatchObject({ code: "unsupported" });

    // A side question that is not one is refused before anything is asked.
    expect((await gym.http.post(path, { question: "   " })).status).toBe(400);
    expect(
        (
            await gym.http.post(path, {
                question: "Too much history?",
                history: Array.from({ length: 51 }, () => ({ question: "q", response: "r" })),
            })
        ).status,
    ).toBe(400);

    // An unknown side question is gone; cancelling one is harmless.
    const unknown = await gym.http.get(`${path}/no-such-question`);
    expect(unknown.status).toBe(404);
    expect(unknown.body).toMatchObject({ code: "not_found" });
    const cancelled = await gym.http.delete(`${path}/no-such-question`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toEqual({ cancelled: false });

    // None of it reached the conversation.
    expect(await gym.history()).toEqual(before);

    // An archived agent is asked too, and asking leaves it archived.
    await gym.client.archiveAgent(gym.defaultSessionId);
    const archived = await gym.http.post(path, { question: "What did you start?" });
    expect(archived.status).toBe(501);
    expect((await gym.client.getAgent(gym.defaultSessionId)).agent.archivedAt).toEqual(
        expect.any(Number),
    );
    expect(gym.errors).toEqual([]);
}, 60_000);
