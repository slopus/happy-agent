import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

import { act, actionId, messagesOf, textOf, uiOf } from "./support/onboardingGym.js";

/**
 * A model shows a `choice` with `show_ui`; a press is the person's own message, the option's
 * label, answered by the model. A `once` offer takes one answer: a repeat of the same press is
 * that answer, and any other press after it, or after the person typed, is recorded as refused.
 */

const running = new Set<AgentGym>();
const TEST_TIMEOUT_MS = 60_000;

afterEach(async () => {
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
});

function offer(text: string) {
    return {
        content: [
            { type: "text" as const, text },
            {
                type: "tool_call" as const,
                name: "show_ui",
                arguments: {
                    components: [
                        {
                            id: "next",
                            type: "choice",
                            props: {
                                options: [
                                    { id: "yes", label: "Yes", primary: true },
                                    { id: "later", label: "Not now" },
                                ],
                            },
                        },
                    ],
                },
            },
        ],
    };
}

/** After `show_ui`, the model writes nothing more. */
const QUIET = { content: [] };

describe("Pressing a choice the model showed", () => {
    it(
        "sends the option's label as the person's message once, and refuses any other answer",
        async () => {
            const gym = await createAgentGym({
                inference: [
                    offer("Shall I run the tests now?"),
                    QUIET,
                    { content: [{ type: "text", text: "Understood." }] },
                    offer("Shall I ask again?"),
                    QUIET,
                    { content: [{ type: "text", text: "Typed instead." }] },
                ],
            });
            running.add(gym);
            const agentId = gym.defaultSessionId;
            const mode = { ...gym.selection, permissionMode: "auto" };
            await gym.send("Help me ship.");
            const shown = (await messagesOf(gym, agentId)).find(
                (message) => uiOf(message) !== undefined,
            )!;
            expect(textOf(shown)).toBe("Shall I run the tests now?");
            expect(uiOf(shown)?.components).toEqual([
                expect.objectContaining({
                    id: "next",
                    type: "choice",
                    fallback: expect.any(String),
                }),
            ]);
            const asked = gym.inference.requests[0]!;
            expect(asked.tools.find((tool) => tool.name === "show_ui")).toBeDefined();

            // A model answers a press, so it needs a mode, like anything typed.
            const ui = uiOf(shown)!;
            const request = (optionId: string, id = actionId()) => ({
                id,
                messageId: shown.id,
                uiId: ui.id,
                componentId: "next",
                action: { type: "choice.choose", payload: { optionId } },
            });
            const modeless = await gym.http.request(
                "POST",
                `/v0/agents/${agentId}/actions`,
                request("later"),
            );
            expect(modeless.status, modeless.text).toBe(400);
            const unoffered = await gym.http.request("POST", `/v0/agents/${agentId}/actions`, {
                ...request("never"),
                mode,
            });
            expect(unoffered.status, unoffered.text).toBe(400);

            const PRESS = "presslater00000000000001";
            const pressed = await act(
                gym,
                agentId,
                shown,
                "next",
                "choose",
                { optionId: "later" },
                { id: PRESS, mode },
            );
            expect(pressed.message).toMatchObject({
                role: "user",
                content: [
                    { type: "text", text: "Not now" },
                    { type: "action", action: { type: "choice.choose" } },
                ],
            });
            const said = pressed.message!.id;
            expect(pressed.record).toMatchObject({
                id: PRESS,
                role: "service",
                content: [{ outcome: { status: "accepted", messageId: said } }],
            });
            await gym.waitUntil(async () => {
                const all = await messagesOf(gym, agentId);
                return all.some((message) => textOf(message) === "Understood.") ? true : undefined;
            }, "the model to answer the press");
            expect(gym.inference.userTexts().at(-1)).toBe("Not now");

            // The same press again is the same answer, not a second one.
            const again = await act(
                gym,
                agentId,
                shown,
                "next",
                "choose",
                { optionId: "later" },
                { id: PRESS, mode },
            );
            expect(again.record).toEqual(pressed.record);
            // Another answer is recorded as refused, naming the answer that won.
            const other = await act(
                gym,
                agentId,
                shown,
                "next",
                "choose",
                { optionId: "yes" },
                {
                    mode,
                },
            );
            expect(other.message).toBeNull();
            expect(other.record).toMatchObject({
                content: [
                    { outcome: { status: "rejected", code: "offer_closed", messageId: said } },
                ],
            });

            // A newer offer the person answered by typing takes no press either.
            await gym.send("Ask me again.");
            const newer = (await messagesOf(gym, agentId)).findLast(
                (message) => uiOf(message) !== undefined,
            )!;
            expect(newer.id).not.toBe(shown.id);
            await gym.send("Actually, never mind.");
            const late = await act(
                gym,
                agentId,
                newer,
                "next",
                "choose",
                { optionId: "yes" },
                {
                    mode,
                },
            );
            expect(late.record).toMatchObject({
                content: [{ outcome: { status: "rejected", code: "offer_closed" } }],
            });

            // The records are history, across a restart.
            await gym.restart();
            const records = (await messagesOf(gym, agentId)).filter(
                (message) => message.role === "service" && message.content[0]?.type === "action",
            );
            expect(records.map((record) => record.content[0]?.["outcome"])).toEqual([
                { status: "accepted", messageId: said },
                expect.objectContaining({ status: "rejected", code: "offer_closed" }),
                expect.objectContaining({ status: "rejected", code: "offer_closed" }),
            ]);

            // A client below protocol 35 reads the choice as text and never sees the records.
            const old = (await gym.http.ok("GET", `/v0/agents/${agentId}/messages`)) as {
                runs: { messages: { role: string; content: { type: string }[] }[] }[];
            };
            const oldMessages = old.runs.flatMap((run) => run.messages);
            for (const message of oldMessages) {
                for (const block of message.content) expect(block.type).not.toBe("action");
            }
            expect(gym.inference.unscripted).toEqual([]);
            expect(gym.errors).toEqual([]);
        },
        TEST_TIMEOUT_MS,
    );
});
