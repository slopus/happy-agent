import { createGym } from "@slopus/happy-terminal-gym";
import { describe, expect, it } from "vitest";

describe("team sender notifications in standalone chat", () => {
    it("keeps normal messages and model context free of team profiles across reload", async () => {
        const gym = await createGym({
            inference(request, index) {
                expect(JSON.stringify(request.context.messages)).not.toContain(
                    "# Team sender profile",
                );
                expect(request.context.messages.at(-1)).toEqual({
                    role: "user",
                    content: [
                        {
                            type: "text",
                            text:
                                index === 0 ? "First ordinary message" : "Second ordinary message",
                        },
                    ],
                });
                return {
                    content: [
                        {
                            type: "text",
                            text: index === 0 ? "FIRST_STANDALONE_OK" : "SECOND_STANDALONE_OK",
                        },
                    ],
                };
            },
        });
        try {
            gym.terminal.type("First ordinary message");
            gym.terminal.press("enter");
            await gym.terminal.waitForText("FIRST_STANDALONE_OK", 30_000);
            const before = await gym.terminal.snapshot();
            gym.terminal.type("/reload");
            gym.terminal.press("enter");
            await gym.terminal.waitUntil(
                (screen) =>
                    screen.outputRevision > before.outputRevision &&
                    screen.text.includes("FIRST_STANDALONE_OK") &&
                    screen.text.includes("Ask Happy Terminal to do anything"),
                "the standalone conversation after reload",
                30_000,
            );
            gym.terminal.type("Second ordinary message");
            gym.terminal.press("enter");
            const screen = await gym.terminal.waitForText("SECOND_STANDALONE_OK", 30_000);
            expect(screen.text).not.toContain("Team sender profile");
            expect(screen.text).toContain("First ordinary message");
            expect(
                gym.inference.requests.filter(
                    (request) => !request.options.sessionId?.endsWith(":title"),
                ),
            ).toHaveLength(2);
        } finally {
            await gym.dispose();
        }
    }, 90_000);
});
