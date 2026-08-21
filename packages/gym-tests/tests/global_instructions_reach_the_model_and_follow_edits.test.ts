import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/happy-terminal-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

/** The conversation the model actually saw, without the automatic title requests. */
function agentRequests(gym: Gym) {
    return gym.inference.requests.filter(
        (request) => !request.options.sessionId?.endsWith(":title"),
    );
}

/** Everything the model saw for one turn: the instructions plus the conversation. */
function conversationText(gym: Gym, index: number): string {
    const request = agentRequests(gym)[index];
    return JSON.stringify(request?.context ?? {});
}

describe("global instructions reach the model and follow edits", () => {
    it("delivers the user's global AGENTS.md and picks up a change before the next turn", async () => {
        const gym = await createGym({
            homeFiles: { "happy/config/AGENTS.md": "Always greet the user in Portuguese.\n" },
            inference: [
                { content: [{ text: "First answer.", type: "text" }] },
                { content: [{ text: "Second answer.", type: "text" }] },
            ],
        });
        running.add(gym);

        gym.terminal.type("Say hello.");
        gym.terminal.press("enter");
        await gym.terminal.waitForText("First answer.");

        expect(conversationText(gym, 0)).toContain("Always greet the user in Portuguese.");
        expect(conversationText(gym, 0)).toContain("Global AGENTS.md instructions");

        // A user editing their global instructions while a session is open must reach the model
        // on the next turn, without restarting anything.
        await gym.runInContainer("node", [
            "-e",
            'require("node:fs").writeFileSync("/home/happy-terminal/happy/config/AGENTS.md", "Always greet the user in Japanese.\\n")',
        ]);

        gym.terminal.type("Say hello again.");
        gym.terminal.press("enter");
        await gym.terminal.waitForText("Second answer.");

        // The updated file replaces the old instructions rather than accumulating beside them:
        // the new text arrives with a replacement notice, and the old text is gone.
        const second = conversationText(gym, 1);
        expect(second).toContain("Always greet the user in Japanese.");
        expect(second).toContain("replace all previously provided AGENTS.md instructions");
    });

    it("adds nothing when the user has no global instructions", async () => {
        const gym = await createGym({
            inference: [{ content: [{ text: "Nothing global.", type: "text" }] }],
        });
        running.add(gym);

        gym.terminal.type("Say hello.");
        gym.terminal.press("enter");
        await gym.terminal.waitForText("Nothing global.");

        expect(conversationText(gym, 0)).not.toContain("Global AGENTS.md instructions");
    });
});
