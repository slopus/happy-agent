import { createAgentGym, GYM_MODELS, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const activeGyms = new Set<AgentGym>();

afterEach(async () => {
    await Promise.all([...activeGyms].map(async (gym) => await gym.dispose()));
    activeGyms.clear();
});

describe("service tier selection over the API", () => {
    it("returns to ordinary service when a send carries a null tier", async () => {
        const tiers: (string | undefined)[] = [];
        const gym = await createAgentGym({
            inference: (request) => {
                // Naming and retitling run their own untiered inference; count only real turns.
                if (!request.instructions.includes("You are Happy Agent")) {
                    return { content: [{ text: "<title>Tier check</title>", type: "text" }] };
                }
                tiers.push(request.serviceTier);
                return { content: [{ text: `turn-${String(tiers.length)}`, type: "text" }] };
            },
            models: GYM_MODELS.map((model, index) =>
                index === 0 ? { ...model, serviceTiers: ["priority"] } : model,
            ),
        });
        activeGyms.add(gym);

        await sendWithTier(gym, "use priority service", "priority");
        await gym.waitUntil(
            () => (tiers.length >= 1 ? true : undefined),
            "the priority request to reach inference",
        );
        expect(tiers).toEqual(["priority"]);

        // A null tier means the provider's ordinary service. The agent persists the last tier
        // between turns, so the null must clear it rather than leave "priority" sticky forever.
        await sendWithTier(gym, "back to ordinary service", null);
        await gym.waitUntil(
            () => (tiers.length >= 2 ? true : undefined),
            "the ordinary request to reach inference",
        );
        expect(tiers).toEqual(["priority", undefined]);
    });
});

async function sendWithTier(
    gym: AgentGym,
    text: string,
    serviceTier: string | null,
): Promise<void> {
    const response = await gym.client.sendMessage(gym.defaultSessionId, {
        mode: {
            effort: gym.selection.effort,
            modelId: gym.selection.modelId,
            permissionMode: "auto",
            providerId: gym.selection.providerId,
            serviceTier,
        },
        text,
    });
    const runId = response.message.runId;
    if (runId !== null && runId !== undefined) await gym.waitForRun(runId);
}
