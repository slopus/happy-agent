import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

import { messagesOf, tapReply, textOf } from "./support/onboardingGym.js";

/**
 * A quick reply may carry a reply component, a display-only drawing beside its text such as an
 * AI's mark. The options stay plain strings, `ui` sits beside them, and a tap still sends only the
 * text. The daemon checks each `ui` against the types it serves before anything is suggested.
 */

const running = new Set<AgentGym>();
const TEST_TIMEOUT_MS = 60_000;

afterEach(async () => {
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
});

function suggesting(options: unknown[]) {
    return {
        content: [
            { type: "text" as const, text: "Which AI should I set up?" },
            { type: "tool_call" as const, name: "suggest_replies", arguments: { options } },
        ],
    };
}

const CLAUDE = { type: "provider", props: { provider: "claude" } };

describe("Quick replies with reply components", () => {
    it(
        "stores each option's ui beside it and sends only the text on a tap",
        async () => {
            const gym = await createAgentGym({
                inference: [
                    suggesting([{ text: "Set up Claude", ui: { type: "slideshow", props: {} } }]),
                    suggesting([
                        { text: "Set up Claude", ui: CLAUDE },
                        {
                            text: "Set up Gemini",
                            ui: { type: "provider", props: { provider: "gemini" } },
                        },
                    ]),
                    suggesting([{ text: "Set up Claude", ui: CLAUDE }, "Skip for now"]),
                    { content: [] },
                    { content: [{ type: "text", text: "Setting up Claude." }] },
                ],
            });
            running.add(gym);
            const agentId = gym.defaultSessionId;
            const health = await gym.client.getHealth();
            expect(health.capabilities?.chatUi?.replies).toEqual(["provider"]);

            await gym.send("Get me started.");
            const tool = gym.inference.requests[0]!.tools.find(
                (each) => each.name === "suggest_replies",
            );
            expect(tool?.description).toContain("- provider: ");

            // An unknown type, and a provider this daemon has no AI for, are refused.
            const refused = await gym.waitUntil(async () => {
                const results = gym.inference.toolResults();
                return results.length >= 2 ? results : undefined;
            }, "both refusals");
            expect(refused[0]!.text).toContain('there is no "slideshow" reply ui here');
            expect(refused[1]!.text).toContain("Reply 2:");

            const shown = await gym.waitUntil(async () => {
                const all = await messagesOf(gym, agentId);
                return all.find((message) =>
                    message.content.some(
                        (block) =>
                            block.type === "tool_call" &&
                            block.presentation?.type === "quick_replies",
                    ),
                );
            }, "the suggestion");
            const call = shown.content.find(
                (block) =>
                    block.type === "tool_call" && block.presentation?.type === "quick_replies",
            )!;
            expect(call.presentation).toEqual({
                type: "quick_replies",
                options: ["Set up Claude", "Skip for now"],
                ui: [CLAUDE, null],
            });

            const tapped = await tapReply(gym, agentId, shown, 0);
            expect(tapped.message).toMatchObject({
                role: "user",
                content: [{ type: "text", text: "Set up Claude" }],
            });
            await gym.waitUntil(async () => {
                const all = await messagesOf(gym, agentId);
                return all.some((message) => textOf(message) === "Setting up Claude.")
                    ? true
                    : undefined;
            }, "the model to answer the tap");
            expect(gym.inference.userTexts().at(-1)).toBe("Set up Claude");
            expect(gym.inference.unscripted).toEqual([]);
        },
        TEST_TIMEOUT_MS,
    );
});
