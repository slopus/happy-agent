import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

import { messagesOf, pressBody, textOf } from "./support/onboardingGym.js";

/**
 * A press on a `reply` button the model wrote is the person's own message: the words on the
 * button, queued like anything they type and answered by the model. Only the newest offer is live.
 */

const running = new Set<AgentGym>();
const TEST_TIMEOUT_MS = 60_000;

afterEach(async () => {
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
});

const OFFER = [
    "Shall I run the tests now?",
    "",
    "<menu>",
    '  <button data-action="reply" data-emphasis>Yes</button>',
    '  <button data-action="reply" data-text="Not now, thanks">Later</button>',
    "</menu>",
].join("\n");

describe("Pressing a reply button", () => {
    it(
        "sends the button's words as the person's message, once, and only from the newest offer",
        async () => {
            const gym = await createAgentGym({
                inference: [
                    { content: [{ type: "text", text: OFFER }] },
                    { content: [{ type: "text", text: "Understood." }] },
                    { content: [{ type: "text", text: OFFER }] },
                    { content: [{ type: "text", text: "Typed instead." }] },
                ],
            });
            running.add(gym);
            const agentId = gym.defaultSessionId;
            const path = `/v0/agents/${agentId}/send`;
            const mode = { ...gym.selection, permissionMode: "auto" };
            await gym.send("Help me ship.");
            const offer = (await messagesOf(gym, agentId)).findLast(
                (message) => message.role === "agent",
            )!;
            expect(textOf(offer)).toBe(OFFER);
            const later = {
                messageId: offer.id,
                controlIndex: 1,
                actionId: "reply",
                params: { text: "Not now, thanks" },
            };

            // A model answers a reply, so it needs a mode, like anything typed.
            const modeless = await gym.http.request("POST", path, pressBody(later));
            expect(modeless.status).toBe(400);
            // An onboarding control is no use outside onboarding.
            const misplaced = await gym.http.request(
                "POST",
                path,
                pressBody({ ...later, actionId: "onboarding.next" }, { mode }),
            );
            expect(misplaced.status).toBe(400);

            const pressed = await gym.http.request("POST", path, pressBody(later, { mode }));
            expect(pressed.status, pressed.text).toBe(202);
            expect(pressed.body).toMatchObject({
                message: { role: "user", content: [{ type: "text", text: "Not now, thanks" }] },
            });
            await gym.waitUntil(async () => {
                const said = await messagesOf(gym, agentId);
                return said.some((message) => textOf(message) === "Understood.") ? true : undefined;
            }, "the model to answer the press");
            expect(gym.inference.userTexts().at(-1)).toBe("Not now, thanks");
            await gym.waitForEvent(
                (event) =>
                    event.type === "message.updated" &&
                    (event.payload as { message: { id: string; actionChoices?: unknown } }).message
                        .id === offer.id &&
                    (event.payload as { message: { actionChoices?: unknown } }).message
                        .actionChoices !== undefined,
                "the choice to be announced",
            );
            const twice = await gym.http.request("POST", path, pressBody(later, { mode }));
            expect(twice.status).toBe(409);
            expect(twice.body).toMatchObject({
                code: "conflict",
                message: { id: offer.id, actionChoices: { "0": { kind: "button", index: 1 } } },
            });

            // A newer offer, answered by typing instead: its buttons are no longer live.
            await gym.send("Ask me again.");
            const again = (await messagesOf(gym, agentId)).findLast(
                (message) => message.role === "agent",
            )!;
            expect(again.id).not.toBe(offer.id);
            await gym.send("Actually, never mind.");
            const answered = await gym.http.request(
                "POST",
                path,
                pressBody({ ...later, messageId: again.id, controlIndex: 0 }, { mode }),
            );
            expect(answered.status).toBe(409);

            // The choice is part of the message, across a restart.
            await gym.restart();
            const after = (await messagesOf(gym, agentId)).find(
                (message) => message.id === offer.id,
            );
            expect(after?.actionChoices).toEqual({ "0": { kind: "button", index: 1 } });
            expect(gym.inference.unscripted).toEqual([]);
            expect(gym.errors).toEqual([]);
        },
        TEST_TIMEOUT_MS,
    );
});
