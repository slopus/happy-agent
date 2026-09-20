import { createAgentGym } from "@slopus/happy-agent-gym";
import { expect, it } from "vitest";

it("keeps the newest composer draft when older API writes arrive concurrently", async () => {
    const gym = await createAgentGym();
    try {
        const at = Date.now();
        const draft = {
            ...gym.selection,
            permissionMode: "auto" as const,
            text: "Newest draft",
        };
        await Promise.all(
            Array.from({ length: 16 }, (_, index) =>
                gym.client.saveAgentDraft(gym.defaultSessionId, {
                    draft: index === 0 ? draft : { ...draft, text: `Older draft ${index}` },
                    updatedAt: at - index,
                }),
            ),
        );
        await expect(gym.client.getAgentDraft(gym.defaultSessionId)).resolves.toEqual({
            draft: { value: draft, updatedAt: at },
        });
        await gym.restart();
        await expect(gym.client.getAgentDraft(gym.defaultSessionId)).resolves.toEqual({
            draft: { value: draft, updatedAt: at },
        });
        expect(gym.errors).toEqual([]);
    } finally {
        await gym.dispose();
    }
});
