import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

import {
    OnboardingGyms,
    STUB_CLAUDE,
    STUB_CURL,
    act,
    flowOf,
    messagesOf,
    startOnboarding,
    textOf,
    uiOf,
    waitForOpening,
} from "./support/onboardingGym.js";

/**
 * Connecting an AI from the opening's `provider_sign_in` components, against stand-ins for the
 * vendor's program and installer: nothing leaves this machine and no real sign-in opens. The gym
 * serves no Claude account, so a Claude that signs in still cannot be used, and the opening says
 * so with its sign-ins again.
 */

const gyms = new OnboardingGyms();
const TEST_TIMEOUT_MS = 60_000;

const NO_CONNECTION =
    "I couldn't put Claude to work yet. My settings on this computer have no connection for it. Sign in again, or connect another AI, and we'll keep going.";

afterEach(async () => {
    await gyms.dispose();
});

interface Cli {
    readonly signIn: { readonly status: string };
    readonly operation: {
        readonly kind: string;
        readonly status: string;
        readonly authorization: { readonly acceptsCode: boolean } | null;
    } | null;
}

async function claudeCli(gym: AgentGym): Promise<Cli> {
    return ((await gym.http.ok("GET", "/v0/provider-clis/claude")) as { providerCli: Cli })
        .providerCli;
}

/** Everything a person or a client could read about the conversation, as one string. */
async function everythingSaid(gym: AgentGym, agentId: string): Promise<string> {
    return JSON.stringify({
        messages: await messagesOf(gym, agentId),
        events: await gym.events(),
        inference: gym.inference.requests,
    });
}

describe("Connecting an AI from the opening", () => {
    it(
        "installs and signs in from the widget, and never stores the code",
        async () => {
            const { gym } = await gyms.start({ stubs: { curl: STUB_CURL } });
            const agentId = await startOnboarding(gym);
            const opening = await waitForOpening(gym, agentId);

            const installed = await act(gym, agentId, opening, "claude", "install");
            expect(installed.record).toMatchObject({
                role: "service",
                content: [
                    {
                        type: "action",
                        messageId: opening.id,
                        componentId: "claude",
                        action: { type: "provider_sign_in.install", payload: {} },
                        outcome: { status: "accepted" },
                    },
                ],
            });
            // A silent action is no one's message.
            expect(installed.message).toBeNull();

            // The install the widget started goes on to sign in by itself, and waits for a code.
            await gym.waitUntil(async () => {
                const cli = await claudeCli(gym);
                return cli.operation?.kind === "sign_in" &&
                    cli.operation.status === "waiting" &&
                    cli.operation.authorization?.acceptsCode === true
                    ? true
                    : undefined;
            }, "the sign-in to wait for its code");
            const submitted = await act(gym, agentId, opening, "claude", "submit_code", {
                code: "good-code",
            });
            expect(submitted.record).toMatchObject({
                content: [
                    {
                        action: { type: "provider_sign_in.submit_code", payload: {} },
                        outcome: { status: "accepted" },
                    },
                ],
            });

            // Signed in, it connects, and the gym has no Claude account to run it on.
            const failed = await waitForOpening(gym, agentId, [opening.id]);
            expect(textOf(failed)).toBe(NO_CONNECTION);
            expect(uiOf(failed)?.components.map((component) => component.id)).toEqual(
                expect.arrayContaining(["claude", "codex"]),
            );
            expect((await claudeCli(gym)).signIn.status).toBe("signed_in");

            // The attempt records are history, each in a finished run of its own.
            const records = (await messagesOf(gym, agentId)).filter(
                (message) => message.role === "service",
            );
            expect(records.map((record) => record.content[0]?.["action"])).toEqual([
                { type: "provider_sign_in.install", payload: {} },
                { type: "provider_sign_in.submit_code", payload: {} },
            ]);
            expect(await everythingSaid(gym, agentId)).not.toContain("good-code");
            expect(gym.inference.requests).toEqual([]);
            expect(gym.errors).toEqual([]);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "refuses a token its AI would not take, and keeps it nowhere",
        async () => {
            const { gym } = await gyms.start({ stubs: { claude: STUB_CLAUDE } });
            const agentId = await startOnboarding(gym);
            const opening = await waitForOpening(gym, agentId);
            const token = "pasted-SECRET-7f3a9c-not-a-claude-token";

            const refused = await act(gym, agentId, opening, "claude", "submit_token", { token });
            expect(refused.record).toMatchObject({
                content: [
                    {
                        action: { type: "provider_sign_in.submit_token", payload: {} },
                        outcome: { status: "rejected", code: "token_rejected" },
                    },
                ],
            });
            // Nothing in the request is trusted: an action the component has not, a component
            // the message does not show, and a message that is not there.
            for (const [request, status] of [
                [{ componentId: "claude", action: { type: "choice.choose", payload: {} } }, 400],
                [{ componentId: "nosuchcomponent" }, 404],
                [{ messageId: "nosuchmessage1234567890ab" }, 404],
            ] as const) {
                const valid = {
                    id: `bad${String(status)}${Math.random().toString(36).slice(2, 10)}`,
                    messageId: opening.id,
                    uiId: uiOf(opening)!.id,
                    componentId: "claude",
                    action: { type: "provider_sign_in.submit_token", payload: { token } },
                };
                const response = await gym.http.request("POST", `/v0/agents/${agentId}/actions`, {
                    ...valid,
                    ...request,
                });
                expect(response.status, `${JSON.stringify(request)}: ${response.text}`).toBe(
                    status,
                );
                expect(response.text).not.toContain(token);
            }

            expect(await everythingSaid(gym, agentId)).not.toContain(token);
            expect(await flowOf(gym)).toMatchObject({ step: "opening" });
            expect(gym.errors).toEqual([]);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "takes the same action twice as one, by its ID",
        async () => {
            const { gym } = await gyms.start({ stubs: { claude: STUB_CLAUDE } });
            const agentId = await startOnboarding(gym);
            const opening = await waitForOpening(gym, agentId);
            const id = "samesignin0000000000000a";
            const first = await act(gym, agentId, opening, "claude", "sign_in", {}, { id });
            const again = await act(gym, agentId, opening, "claude", "sign_in", {}, { id });
            expect(again.record).toEqual(first.record);
            const records = (await messagesOf(gym, agentId)).filter(
                (message) => message.role === "service",
            );
            expect(records.map((record) => record.id)).toEqual([id]);
            await act(gym, agentId, opening, "claude", "cancel");
            expect(gym.errors).toEqual([]);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "connects a sign-in the person finishes in their own terminal once it is seen",
        async () => {
            const { gym, home } = await gyms.start({ stubs: { claude: STUB_CLAUDE } });
            const agentId = await startOnboarding(gym);
            const opening = await waitForOpening(gym, agentId);
            // The widget reads its AI's live state, which finds it signed out.
            expect((await claudeCli(gym)).signIn.status).toBe("signed_out");
            // The person signs in in their own terminal, and the widget's next read sees it.
            await writeFile(join(home, ".stub-claude-signed-in"), "");
            expect((await claudeCli(gym)).signIn.status).toBe("signed_in");
            const failed = await waitForOpening(gym, agentId, [opening.id]);
            expect(textOf(failed)).toBe(NO_CONNECTION);
            expect(gym.errors).toEqual([]);
        },
        TEST_TIMEOUT_MS,
    );
});
