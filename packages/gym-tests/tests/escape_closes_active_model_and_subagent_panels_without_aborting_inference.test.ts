import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/happy-terminal-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("Escape in active response panels", () => {
    it("keeps model selection available while a response is active", async () => {
        const gym = await createGym({
            homeFiles: {
                ".codex/auth.json": JSON.stringify({
                    auth_mode: "chatgpt",
                    tokens: {
                        access_token: "active-model-token",
                        account_id: "active-model-account",
                    },
                }),
            },
            inference: [
                {
                    content: [{ text: "ACTIVE_MODEL_RESPONSE", type: "text" }],
                    delayMs: 30_000,
                },
            ],
            modelId: "openai/gpt-5.6-sol",
            providerId: "codex",
            providerOverrides: ["codex"],
        });
        running.add(gym);

        submit(gym, "Keep this response running while I choose the next model.");
        await gym.terminal.waitForText("Working", 30_000);
        submit(gym, "/model");
        const modelMenu = await gym.terminal.waitForText("Choose Model", 30_000);
        expect(modelMenu.text).not.toContain("Unavailable while running");
        expect(modelMenu.text).not.toContain("Wait for the active response to finish");

        gym.terminal.press("down");
        gym.terminal.press("enter");
        await gym.terminal.waitForText("Choose Reasoning", 30_000);
        gym.terminal.press("enter");

        const selected = await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("gpt-5.6-terra medium") &&
                !snapshot.text.includes("Choose Reasoning"),
            "the next-message model selection",
            30_000,
        );
        expect(selected.text).not.toContain("Unavailable while running");

        gym.terminal.press("escape");
        await gym.terminal.waitUntil(
            (snapshot) => !snapshot.text.includes("esc to interrupt"),
            "the active response to stop",
            30_000,
        );
    }, 90_000);

    it("closes the model and subagent panels without aborting inference", async () => {
        const responses = ["MODEL_RESPONSE_FINISHED", "SUBAGENT_RESPONSE_FINISHED"];
        const gym = await createGym({
            inference(_request, callIndex) {
                const response = responses[callIndex];
                if (response === undefined) {
                    throw new Error(`Unexpected inference call ${String(callIndex)}`);
                }
                return {
                    content: [{ text: response, type: "text" }],
                    delayMs: 1_500,
                };
            },
        });
        running.add(gym);

        submit(gym, "Keep running while I inspect the model list.");
        await gym.terminal.waitForText("Working", 30_000);
        submit(gym, "/model");
        await gym.terminal.waitForText("Choose Model", 30_000);

        gym.terminal.press("escape");

        const modelResponse = await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("MODEL_RESPONSE_FINISHED") &&
                !snapshot.text.includes("Choose Model"),
            "the model panel to close without aborting the active response",
            30_000,
        );
        expect(modelResponse.text).not.toContain("Interrupted");

        submit(gym, "Keep running while I inspect the subagent list.");
        await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("Keep running while I inspect the subagent list.") &&
                snapshot.text.includes("Working"),
            "the second response to start",
            30_000,
        );
        submit(gym, "/agents");
        const subagentPanel = await gym.terminal.waitForText("Subagents", 30_000);
        expect(subagentPanel.text).toContain("0 delegated tasks");

        gym.terminal.press("escape");

        const subagentResponse = await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("SUBAGENT_RESPONSE_FINISHED") &&
                !snapshot.text.includes("0 delegated tasks"),
            "the subagent panel to close without aborting the active response",
            30_000,
        );
        expect(subagentResponse.text).not.toContain("Interrupted");

        const requests = gym.inference.requests.filter(
            (request) => !request.options.sessionId?.endsWith(":title"),
        );
        expect(requests).toHaveLength(2);
    }, 90_000);
});

function submit(gym: Gym, text: string): void {
    gym.terminal.type(text);
    gym.terminal.press("enter");
}
