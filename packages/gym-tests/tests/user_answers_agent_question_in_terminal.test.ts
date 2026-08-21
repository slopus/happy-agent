import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/happy-terminal-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("a person answers the agent's question in the terminal", () => {
    it("shows the question, waits for the answer, and returns it to the model", async () => {
        let answeredResult = "";
        const gym = await createGym({
            inference(request, callIndex) {
                if (callIndex === 0) {
                    return {
                        content: [
                            {
                                arguments: {
                                    input: {
                                        context: "The migration can finish either way.",
                                        header: "Migration",
                                        options: {
                                            choices: [
                                                {
                                                    description: "Rewrite the table in place.",
                                                    label: "Rewrite",
                                                },
                                                {
                                                    description: "Keep both tables for now.",
                                                    label: "Keep both",
                                                },
                                            ],
                                            multiSelect: false,
                                        },
                                        question: "How should the migration finish?",
                                    },
                                },
                                id: "ask-1",
                                name: "request_user_input",
                                type: "toolCall",
                            },
                        ],
                    };
                }
                answeredResult = JSON.stringify(
                    request.context.messages.filter(
                        (message: { readonly role: string }) => message.role === "tool",
                    ),
                );
                return { content: [{ text: "Rewriting the table.", type: "text" }] };
            },
        });
        running.add(gym);

        gym.terminal.type("Finish the migration.");
        gym.terminal.press("enter");

        const asked = await gym.terminal.waitForText("How should the migration finish?", 30_000);
        expect(asked.text).toContain("Migration");
        expect(asked.text).toContain("Rewrite");
        expect(asked.text).toContain("Keep both");

        // The first choice is highlighted, so pressing enter answers with it.
        gym.terminal.press("enter");

        const answered = await gym.terminal.waitForText("Rewriting the table.", 30_000);
        expect(answered.text).not.toContain("How should the migration finish?");
        expect(answeredResult).toContain("Rewrite");
        expect(answeredResult).toContain("Answered");

        // The session is still usable once the question is gone.
        gym.terminal.type("Thanks.");
        const composer = await gym.terminal.waitForText("Thanks.");
        expect(composer.text).toContain("Thanks.");
    });
});
