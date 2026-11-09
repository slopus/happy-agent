import type { GymInferenceRequest, GymTurn } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

import {
    OnboardingGyms,
    STUB_CLAUDE,
    act,
    messagesOf,
    textOf,
    uiOf,
} from "./support/onboardingGym.js";

/**
 * A sign-in widget a model showed in an ordinary conversation, outside onboarding: connecting the
 * AI leaves the model a hidden note that starts a turn of its own, so the model answers without
 * waiting for the person to write.
 */

const gyms = new OnboardingGyms();
const TEST_TIMEOUT_MS = 60_000;

afterEach(async () => {
    await gyms.dispose();
});

const READY = "Claude is ready for your agents.";

function answer(request: GymInferenceRequest): GymTurn {
    if (request.sessionId.endsWith(":title") || request.sessionId.startsWith("naming:")) {
        return { content: [{ type: "text", text: "<title>Claude</title><slug>claude</slug>" }] };
    }
    const last = request.messages.at(-1);
    if (JSON.stringify(last).includes("<happy-note>")) {
        return { content: [{ type: "text", text: READY }] };
    }
    if (last?.role === "tool") return { content: [] };
    return {
        content: [
            { type: "text", text: "Connect Claude here." },
            {
                type: "tool_call",
                name: "show_ui",
                arguments: {
                    components: [
                        { id: "claude", type: "provider_sign_in", props: { provider: "claude" } },
                    ],
                },
            },
        ],
    };
}

describe("A sign-in widget outside onboarding", () => {
    it(
        "wakes the model with a hidden note once the AI is connected",
        async () => {
            const { gym } = await gyms.start({
                stubs: { claude: STUB_CLAUDE },
                machine: { "home/.stub-claude-signed-in": "" },
                inference: answer,
            });
            const agentId = gym.defaultSessionId;
            await gym.send("Connect Claude for me.");
            const shown = await gym.waitUntil(
                async () => (await messagesOf(gym, agentId)).find((message) => uiOf(message)),
                "the sign-in to be shown",
            );
            const used = await act(gym, agentId, shown, "claude", "sign_in");
            expect(used.record).toMatchObject({ content: [{ outcome: { status: "accepted" } }] });
            await gym.waitUntil(async () => {
                const all = await messagesOf(gym, agentId);
                return all.some((message) => textOf(message) === READY) ? true : undefined;
            }, "the model to answer the note");
            const woken = gym.inference.requests.filter((request) =>
                JSON.stringify(request.messages.at(-1)).includes("<happy-note>"),
            );
            expect(woken).toHaveLength(1);
            expect(JSON.stringify(woken[0]!.messages.at(-1))).toContain(
                "Claude is connected and signed in.",
            );
            // The note is hidden: no one's message in the conversation.
            for (const message of await messagesOf(gym, agentId)) {
                expect(textOf(message)).not.toContain("happy-note");
            }
            expect(gym.errors).toEqual([]);
        },
        TEST_TIMEOUT_MS,
    );
});
