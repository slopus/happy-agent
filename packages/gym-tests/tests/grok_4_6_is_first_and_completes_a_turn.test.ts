import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/rig-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("Grok 4.6 model support", () => {
    it("lists Grok 4.6 first and completes a turn with it", async () => {
        const gym = await createGym({
            environment: { XAI_API_KEY: "grok-test-key" },
            inference(request) {
                expect(request.providerId).toBe("grok");
                expect(request.modelId).toBe("xai/grok-4.6");
                expect(request.options.effort).toBe("high");
                expect(request.context.systemPrompt).toContain(
                    "# Runtime model\nModel ID: xai/grok-4.6\nProvider ID: grok",
                );
                expect(request.context.tools?.map((tool) => tool.name)).toContain(
                    "run_terminal_command",
                );
                return { content: [{ text: "GROK_46_GYM_COMPLETE", type: "text" }] };
            },
            providerId: "grok",
        });
        running.add(gym);

        gym.terminal.type("/model");
        gym.terminal.press("enter");
        const modelMenu = await gym.terminal.waitForText("Choose Model", 30_000);
        const grok46Position = modelMenu.text.indexOf("Grok 4.6");
        expect(grok46Position).toBeGreaterThanOrEqual(0);
        expect(grok46Position).toBeLessThan(modelMenu.text.indexOf("Grok Build"));
        expect(grok46Position).toBeLessThan(modelMenu.text.indexOf("Grok 4.5"));
        expect(grok46Position).toBeLessThan(modelMenu.text.indexOf("Composer 2.5"));

        gym.terminal.press("escape");
        await gym.terminal.waitForText("Ask Rig to do anything", 30_000);
        gym.terminal.type("Confirm Grok 4.6 works.");
        gym.terminal.press("enter");

        const completed = await gym.terminal.waitForText("GROK_46_GYM_COMPLETE", 30_000);
        expect(completed.text).toContain("GROK_46_GYM_COMPLETE");
        expect(completed.text).not.toContain("�");
    }, 120_000);
});
