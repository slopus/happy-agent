import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

import { messagesOf, repliesOf, tapReply, textOf } from "./support/onboardingGym.js";

/**
 * A model suggests replies with `suggest_replies`; a tap is an ordinary `send` of the option's
 * text naming it with `quickReply`. The daemon checks that the option exists and the text matches
 * exactly, and nothing else: any visible suggestion may be sent again, and the stored message
 * keeps where it came from.
 */

const running = new Set<AgentGym>();
const TEST_TIMEOUT_MS = 60_000;

afterEach(async () => {
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
});

const SUGGESTED = {
    content: [
        { type: "text" as const, text: "Shall I run the tests now?" },
        {
            type: "tool_call" as const,
            name: "suggest_replies",
            arguments: { options: ["Yes, run them", "  Not   now "] },
        },
    ],
};

/** After `suggest_replies`, the model writes nothing more. */
const QUIET = { content: [] };

describe("Sending a quick reply", () => {
    it(
        "sends the option as the person's message, checked against the stored suggestion",
        async () => {
            const gym = await createAgentGym({
                inference: [
                    SUGGESTED,
                    QUIET,
                    { content: [{ type: "text", text: "Understood." }] },
                    { content: [{ type: "text", text: "Still understood." }] },
                ],
            });
            running.add(gym);
            const agentId = gym.defaultSessionId;
            await gym.send("Help me ship.");
            expect(gym.inference.requests[0]!.tools.map((tool) => tool.name)).toContain(
                "suggest_replies",
            );
            const shown = (await messagesOf(gym, agentId)).find(
                (message) => repliesOf(message) !== undefined,
            )!;
            // The options are stored with their whitespace collapsed.
            expect(repliesOf(shown)?.options).toEqual(["Yes, run them", "Not now"]);
            const toolCallId = repliesOf(shown)!.toolCallId!;
            expect(gym.inference.toolResults().at(-1)?.text).toContain(
                'Suggested to the person under your message: "Yes, run them", "Not now".',
            );

            // A text that is not the stored option, an option that is not there, or a message that
            // holds no such suggestion is refused, and nothing is stored.
            const before = (await messagesOf(gym, agentId)).length;
            const mode = { ...gym.selection, permissionMode: "auto" };
            const send = async (text: string, quickReply: Record<string, unknown>) =>
                await gym.http.request("POST", `/v0/agents/${agentId}/send`, {
                    text,
                    mode,
                    quickReply,
                });
            const userMessage = (await messagesOf(gym, agentId)).find(
                (message) => message.role === "user",
            )!;
            for (const [text, quickReply] of [
                ["Not  now", { messageId: shown.id, toolCallId, index: 1 }],
                ["Not now", { messageId: shown.id, toolCallId, index: 0 }],
                ["Not now", { messageId: shown.id, toolCallId, index: 5 }],
                ["Not now", { messageId: shown.id, index: 1 }],
                ["Not now", { messageId: shown.id, toolCallId: "elsewhere", index: 1 }],
                ["Not now", { messageId: userMessage.id, toolCallId, index: 1 }],
            ] as const) {
                const refused = await send(text, quickReply);
                expect(refused.status, refused.text).toBe(400);
                expect(refused.body).toMatchObject({ code: "invalid_request" });
            }
            expect(await messagesOf(gym, agentId)).toHaveLength(before);

            // A tap is the person's own message, naming the option it came from.
            const tapped = await tapReply(gym, agentId, shown, 1, {
                id: "tapnotnow000000000000001",
            });
            const quickReply = { messageId: shown.id, toolCallId, index: 1 };
            expect(tapped.message).toMatchObject({
                role: "user",
                content: [{ type: "text", text: "Not now" }],
                quickReply,
            });
            await gym.waitUntil(async () => {
                const all = await messagesOf(gym, agentId);
                return all.some((message) => textOf(message) === "Understood.") ? true : undefined;
            }, "the model to answer the tap");
            expect(gym.inference.userTexts().at(-1)).toBe("Not now");

            // Retrying the same send creates nothing new.
            const retried = await tapReply(gym, agentId, shown, 1, {
                id: "tapnotnow000000000000001",
            });
            expect(retried.message.id).toBe(tapped.message.id);

            // The suggestion takes any number of taps, as typing would.
            await tapReply(gym, agentId, shown, 0);
            await gym.waitUntil(async () => {
                const all = await messagesOf(gym, agentId);
                return all.some((message) => textOf(message) === "Still understood.")
                    ? true
                    : undefined;
            }, "the model to answer the second tap");

            // The provenance is history, across a restart.
            await gym.restart();
            const sent = (await messagesOf(gym, agentId)).filter(
                (message) => message.role === "user" && message.quickReply !== undefined,
            );
            expect(sent.map((message) => [textOf(message), message.quickReply])).toEqual([
                ["Not now", quickReply],
                ["Yes, run them", { ...quickReply, index: 0 }],
            ]);

            // A client below protocol 35 reads the suggestion as one line of text.
            const old = (await gym.http.ok("GET", `/v0/agents/${agentId}/messages`)) as {
                runs: { messages: { id: string; content: { type: string; text?: string }[] }[] }[];
            };
            const oldShown = old.runs
                .flatMap((run) => run.messages)
                .find((message) => message.id === shown.id);
            expect(oldShown?.content).toContainEqual({
                type: "text",
                text: "Suggested replies: Yes, run them · Not now",
            });
            expect(gym.inference.unscripted).toEqual([]);
            expect(gym.errors).toEqual([]);
        },
        TEST_TIMEOUT_MS,
    );
});
