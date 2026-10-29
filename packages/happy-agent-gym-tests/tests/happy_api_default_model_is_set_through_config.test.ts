import {
    createAgentGym,
    GYM_MODEL_ID,
    GYM_SECOND_MODEL_ID,
    type AgentGym,
} from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

/** `PATCH /v0/config` `defaults`: the model new conversations start on, kept across restarts. */

const running = new Set<AgentGym>();
afterEach(async () => {
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
});

interface Defaults {
    providerId: string;
    modelId: string;
    effort: string;
}

async function defaults(gym: AgentGym): Promise<Defaults> {
    return ((await gym.http.ok("GET", "/v0/config")) as { config: { defaults: Defaults } }).config
        .defaults;
}

describe("the default model", () => {
    it("changes at once, announces it, refuses what cannot run, and lasts across a restart", async () => {
        const gym = await createAgentGym({ timeoutMs: 20_000 });
        running.add(gym);
        expect(await defaults(gym)).toMatchObject({ providerId: "gym", modelId: GYM_MODEL_ID });

        const response = await gym.http.request("PATCH", "/v0/config", {
            defaults: { providerId: "gym", modelId: GYM_SECOND_MODEL_ID, effort: "high" },
        });
        expect(response.status).toBe(200);
        expect((response.body as { config: { defaults: Defaults } }).config.defaults).toMatchObject(
            { providerId: "gym", modelId: GYM_SECOND_MODEL_ID, effort: "high" },
        );
        await gym.waitForEvent((event) => event.type === "config.updated", "config.updated");

        // Without an effort, the model's own default effort.
        await gym.http.ok("PATCH", "/v0/config", {
            defaults: { providerId: "gym", modelId: GYM_MODEL_ID },
        });
        expect(await defaults(gym)).toMatchObject({ modelId: GYM_MODEL_ID, effort: "medium" });

        for (const refused of [
            { providerId: "gym", modelId: "gym/no-such-model" },
            { providerId: "nobody", modelId: GYM_MODEL_ID },
            { providerId: "gym", modelId: GYM_MODEL_ID, effort: "extreme" },
        ]) {
            const answer = await gym.http.request("PATCH", "/v0/config", { defaults: refused });
            expect(answer.status, JSON.stringify(refused)).toBe(400);
        }
        expect(await defaults(gym)).toMatchObject({ modelId: GYM_MODEL_ID, effort: "medium" });

        await gym.http.ok("PATCH", "/v0/config", {
            defaults: { providerId: "gym", modelId: GYM_SECOND_MODEL_ID, effort: "low" },
        });
        await gym.restart();
        expect(await defaults(gym)).toMatchObject({
            providerId: "gym",
            modelId: GYM_SECOND_MODEL_ID,
            effort: "low",
        });
        expect(gym.errors).toEqual([]);
    }, 60_000);
});
