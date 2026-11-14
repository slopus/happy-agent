import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, expect, it } from "vitest";

const running = new Set<AgentGym>();
afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

it("runs and persists advertised Ultra while rejecting it for an unsupported model", async () => {
    const gym = await createAgentGym({
        timeoutMs: 20_000,
        models: [
            {
                id: "gym/astra",
                providerId: "gym",
                name: "Astra fixture",
                defaultEffort: "max",
                effortLevels: ["low", "max", "ultra"],
            },
            {
                id: "gym/ordinary",
                providerId: "gym",
                name: "Ordinary fixture",
                defaultEffort: "high",
                effortLevels: ["low", "high"],
            },
        ],
        inference: [
            { content: [{ type: "text", text: "Ultra completed." }] },
            { content: [{ type: "text", text: "Max completed." }] },
        ],
    });
    running.add(gym);
    const ultra = { providerId: "gym", modelId: "gym/astra", effort: "ultra" };
    await gym.http.ok("PATCH", "/v0/config", { defaults: ultra });
    await gym.send("Use the advertised Ultra setting.", ultra);
    expect(gym.inference.last).toMatchObject({ model: "gym/astra", effort: "ultra" });
    expect(await gym.http.ok("GET", `/v0/agents/${gym.defaultSessionId}/mode`)).toMatchObject({
        mode: ultra,
    });

    const refused = await gym.http.request("PATCH", "/v0/config", {
        defaults: { ...ultra, modelId: "gym/ordinary" },
    });
    expect(refused.status).toBe(400);
    const refusedTurn = await gym.http.request("POST", `/v0/agents/${gym.defaultSessionId}/send`, {
        text: "Unsupported effort must fail before inference.",
        mode: { ...ultra, modelId: "gym/ordinary", serviceTier: null, permissionMode: "auto" },
    });
    expect(refusedTurn.status).toBe(400);

    await gym.restart();
    expect(await gym.http.ok("GET", "/v0/config")).toMatchObject({ config: { defaults: ultra } });
    expect(await gym.http.ok("GET", `/v0/agents/${gym.defaultSessionId}/mode`)).toMatchObject({
        mode: ultra,
    });
    await gym.send("Switch back to max explicitly.", { ...ultra, effort: "max" });
    expect(gym.inference.last).toMatchObject({ model: "gym/astra", effort: "max" });
    expect(gym.errors).toEqual([]);
    expect(gym.inference.unscripted).toEqual([]);
}, 60_000);
