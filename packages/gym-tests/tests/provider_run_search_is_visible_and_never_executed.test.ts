import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/rig-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("a search the provider runs on its own backend", () => {
    it("is visible while it runs, stays in history, and is never executed as a tool", async () => {
        const gym = await createGym({
            cols: 96,
            inference: [
                {
                    content: [{ text: "People are praising it.", type: "text" }],
                    serverToolCallDeltaDelayMs: 1_500,
                    serverToolCalls: [
                        {
                            arguments: '{"query":"Claude Code","limit":"5","mode":"Latest"}',
                            callId: "x-keyword-1",
                            name: "x_keyword_search",
                        },
                    ],
                },
                { content: [{ text: "That is everything I found.", type: "text" }] },
            ],
            rows: 32,
        });
        running.add(gym);

        gym.terminal.type("What is X saying about Claude Code?");
        gym.terminal.press("enter");

        // The search is the only thing happening, so the user has to be told about it.
        const searching = await gym.terminal.waitForText('Searching X for "Claude Code"', 30_000);
        expect(searching.text).toContain("esc to interrupt");
        expect(searching.text).not.toContain("x_keyword_search");
        expect(searching.text).not.toContain('{"query"');

        const answered = await gym.terminal.waitForText("People are praising it.", 30_000);
        expect(answered.text).toContain('Searched X for "Claude Code"');
        expect(answered.text).not.toContain('Searching X for "Claude Code"');
        expect(answered.text).not.toContain("x_keyword_search");
        expect(answered.text).not.toContain('{"query"');
        expect(answered.text).not.toContain("Unknown tool");

        // The session keeps working, which it could not do with an unanswered tool call open.
        gym.terminal.type("Anything else?");
        gym.terminal.press("enter");
        const finished = await gym.terminal.waitForText("That is everything I found.", 30_000);
        expect(finished.text).not.toContain("Unknown tool");

        const agentRequests = gym.inference.requests.filter(
            (request) => !request.options.sessionId?.endsWith(":title"),
        );
        expect(agentRequests).toHaveLength(2);
        const secondTurnMessages = agentRequests[1]?.context.messages ?? [];
        expect(secondTurnMessages.some((message) => message.role === "toolResult")).toBe(false);
        expect(
            secondTurnMessages.some(
                (message) =>
                    message.role === "assistant" &&
                    message.content.some((block) => block.type === "toolCall"),
            ),
        ).toBe(false);
    }, 120_000);
});
