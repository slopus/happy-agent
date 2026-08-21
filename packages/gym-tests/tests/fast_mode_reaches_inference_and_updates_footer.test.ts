import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/happy-terminal-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("fast inference mode", () => {
    it("toggles from the terminal, reaches inference, and updates the footer", async () => {
        const gym = await createGym({
            inference: (request, callIndex) => {
                if (callIndex === 0) {
                    // The provider wire names the tier "priority"; "fast" is its display name.
                    expect(request.options.serviceTier).toBe("priority");
                    return { content: [{ text: "FAST_REQUEST_CAPTURED", type: "text" }] };
                }

                expect(callIndex).toBe(1);
                expect(request.options.serviceTier).toBeUndefined();
                return { content: [{ text: "DEFAULT_REQUEST_CAPTURED", type: "text" }] };
            },
        });
        running.add(gym);

        submit(gym, "/fast");
        const enabled = await gym.terminal.waitForText("Fast mode is on", 30_000);
        expect(enabled.text).toContain("gym off fast · /workspace · full access");
        expect(enabled.text).toContain("2× plan usage");

        submit(gym, "Use fast inference.");
        await gym.terminal.waitForText("FAST_REQUEST_CAPTURED", 30_000);

        submit(gym, "/fast off");
        const disabled = await gym.terminal.waitForText("Fast mode is off", 30_000);
        expect(disabled.text).toContain("gym off · /workspace · full access");
        expect(disabled.text).not.toContain("gym off fast ·");

        submit(gym, "Use default inference.");
        await gym.terminal.waitForText("DEFAULT_REQUEST_CAPTURED", 30_000);
    }, 90_000);
});

function submit(gym: Gym, value: string): void {
    gym.terminal.type(value);
    gym.terminal.press("enter");
}
