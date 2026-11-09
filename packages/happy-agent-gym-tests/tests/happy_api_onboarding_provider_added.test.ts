import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

import {
    FIRST_TASK_TURN,
    SAVE_PROFILE,
    connectCodex,
    cue,
    showing,
    startGuidedGym,
} from "./support/guidedOnboardingGym.js";
import { OnboardingGyms, act, waitForSaid } from "./support/onboardingGym.js";

/**
 * Another AI connected while the model guides onboarding wakes the Chief of Staff once, with a
 * hidden `providerAdded` event: from a sign-in widget the model showed, or from a sign-in the
 * person finished in their own terminal. The widget's note rides along in that turn; it never
 * starts one of its own.
 */

const gyms = new OnboardingGyms();
const TEST_TIMEOUT_MS = 60_000;

afterEach(async () => {
    await gyms.dispose();
});

const CONNECT_CLAUDE = "Connect Claude too, and your agents can use either.";
const ADDED = "Claude is connected too.";

async function claudeSignIn(gym: AgentGym): Promise<string> {
    const { providerCli } = (await gym.http.ok("GET", "/v0/provider-clis/claude")) as {
        providerCli: { signIn: { status: string } };
    };
    return providerCli.signIn.status;
}

describe("Another AI connected while the model guides", () => {
    it(
        "wakes the model once from the sign-in widget it showed, with the widget's note",
        async () => {
            const { gym, agentId } = await startGuidedGym(
                gyms,
                {
                    "event:begin": () => SAVE_PROFILE,
                    saved: () =>
                        showing(CONNECT_CLAUDE, [
                            {
                                id: "claude",
                                type: "provider_sign_in",
                                props: { provider: "claude" },
                            },
                        ]),
                    "event:providerAdded": () => ({ content: [{ type: "text", text: ADDED }] }),
                },
                { claude: true },
            );
            await connectCodex(gym, agentId);
            const shown = await waitForSaid(gym, agentId, CONNECT_CLAUDE);
            const used = await act(gym, agentId, shown, "claude", "sign_in");
            expect(used.record).toMatchObject({ content: [{ outcome: { status: "accepted" } }] });
            await waitForSaid(gym, agentId, ADDED);

            const added = gym.inference.requests.filter(
                (request) => cue(request) === "event:providerAdded",
            );
            expect(added).toHaveLength(1);
            expect(JSON.stringify(added[0]!.messages)).toContain(
                "Claude is connected and signed in.",
            );
            // The note was no turn of its own: the only turn after show_ui is the event's.
            expect(
                gym.inference.requests.filter((request) => cue(request) === "shown"),
            ).toHaveLength(1);
            expect(gym.inference.unscripted).toEqual([]);
            expect(gym.errors).toEqual([]);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "wakes the model when the person signs in in their own terminal",
        async () => {
            const { gym, agentId, home } = await startGuidedGym(
                gyms,
                {
                    "event:begin": () => SAVE_PROFILE,
                    saved: () => FIRST_TASK_TURN,
                    "event:providerAdded": () => ({ content: [{ type: "text", text: ADDED }] }),
                },
                { claude: "terminal" },
            );
            await connectCodex(gym, agentId);
            await waitForSaid(gym, agentId, "**Ada Lovelace** · ada@example.com");
            // Claude is seen signed out, then signed in, with no widget involved.
            expect(await claudeSignIn(gym)).toBe("signed_out");
            await writeFile(join(home, ".stub-claude-signed-in"), "");
            expect(await claudeSignIn(gym)).toBe("signed_in");
            await waitForSaid(gym, agentId, ADDED);
            const added = gym.inference.requests.filter(
                (request) => cue(request) === "event:providerAdded",
            );
            expect(added).toHaveLength(1);
            expect(JSON.stringify(added[0]!.messages)).toContain('\\"app\\":\\"Claude\\"');
            expect(gym.inference.unscripted).toEqual([]);
            expect(gym.errors).toEqual([]);
        },
        TEST_TIMEOUT_MS,
    );
});
