import { expect, it } from "vitest";
import { createGym } from "@slopus/happy-terminal-gym";

it("hides unverified Ultrafast while preserving Regular and Fast for a Codex account", async () => {
    const tiers = [undefined, "priority"];
    const gym = await createGym({
        mode: "docker",
        providerId: "codex",
        providerOverrides: ["codex"],
        modelId: "openai/gpt-6-astra",
        inference: (request, index) => {
            expect(request.options.serviceTier).toBe(tiers[index]);
            return { content: [{ type: "text", text: `ACCOUNT_SPEED_${index}` }] };
        },
    });
    try {
        gym.terminal.type("/speed");
        gym.terminal.press("enter");
        const picker = await gym.terminal.waitForText("Choose Inference Speed", 30_000);
        expect(picker.text).toContain("Regular");
        expect(picker.text).toContain("Fast");
        expect(picker.text).not.toContain("Ultrafast");
        gym.terminal.press("escape");
        gym.terminal.type("/speed ultrafast");
        gym.terminal.press("enter");
        await gym.terminal.waitForText("Ultrafast inference is not available", 30_000);
        gym.terminal.type("Check regular account speed.");
        gym.terminal.press("enter");
        await gym.terminal.waitForText("ACCOUNT_SPEED_0", 30_000);
        gym.terminal.type("/speed fast");
        gym.terminal.press("enter");
        await gym.terminal.waitForText("Inference speed: Fast.", 30_000);
        gym.terminal.type("Check fast account speed.");
        gym.terminal.press("enter");
        await gym.terminal.waitForText("ACCOUNT_SPEED_1", 30_000);
    } finally {
        await gym.dispose();
    }
}, 120_000);
