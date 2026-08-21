import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/happy-terminal-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("parallel gym instances are isolated", () => {
    it("keeps containers, fixtures, terminals, and inference scripts separate", async () => {
        const makeGym = async (name: string) => {
            const gym = await createGym({
                files: { "identity.txt": `${name}\n` },
                inference: [
                    {
                        content: [{ text: `Hello from ${name}.`, type: "text" }],
                    },
                ],
            });
            running.add(gym);
            return gym;
        };
        const [alpha, beta] = await Promise.all([makeGym("alpha"), makeGym("beta")]);

        alpha.terminal.type("Identify this gym.");
        alpha.terminal.press("enter");
        beta.terminal.type("Identify this gym.");
        beta.terminal.press("enter");

        const [alphaSnapshot, betaSnapshot] = await Promise.all([
            alpha.terminal.waitForText("Hello from alpha."),
            beta.terminal.waitForText("Hello from beta."),
        ]);
        expect(alphaSnapshot.text).not.toContain("Hello from beta.");
        expect(betaSnapshot.text).not.toContain("Hello from alpha.");
        await expect(alpha.readFile("identity.txt")).resolves.toBe("alpha\n");
        await expect(beta.readFile("identity.txt")).resolves.toBe("beta\n");
    });
});
