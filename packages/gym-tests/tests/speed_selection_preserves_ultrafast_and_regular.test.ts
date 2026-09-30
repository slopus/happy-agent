import { expect, it } from "vitest";
import { createGym } from "@slopus/happy-terminal-gym";

it("selects Ultrafast, Fast, and Regular through the terminal and forwards exact tiers", async () => {
    const tiers = ["ultrafast", "priority", undefined];
    const gym = await createGym({
        mode: "docker",
        inference: (request, index) => {
            expect(request.options.serviceTier).toBe(tiers[index]);
            return { content: [{ type: "text", text: `SPEED_CAPTURED_${index}` }] };
        },
    });
    try {
        for (const [index, speed] of ["ultrafast", "fast", "regular"].entries()) {
            if (index === 0) {
                gym.terminal.type("/speed");
                gym.terminal.press("enter");
                const picker = await gym.terminal.waitForText("Choose Inference Speed", 30_000);
                expect(picker.text).toContain("Regular");
                expect(picker.text).toContain("Fast");
                expect(picker.text).toContain("Ultrafast");
                gym.terminal.press("down");
                gym.terminal.press("down");
                gym.terminal.press("enter");
            } else {
                gym.terminal.type(`/speed ${speed}`);
                gym.terminal.press("enter");
            }
            const label = speed[0]!.toUpperCase() + speed.slice(1);
            await gym.terminal.waitForText(`Inference speed: ${label}.`, 30_000);
            gym.terminal.type(`Check speed ${index}.`);
            gym.terminal.press("enter");
            await gym.terminal.waitForText(`SPEED_CAPTURED_${index}`, 30_000);
        }
    } finally {
        await gym.dispose();
    }
}, 120_000);
