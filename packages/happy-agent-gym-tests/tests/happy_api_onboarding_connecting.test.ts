import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

import {
    OnboardingGyms,
    STUB_CLAUDE,
    STUB_CURL,
    flowOf,
    messagesOf,
    press,
    startOnboarding,
    textOf,
    waitForSaid,
    waitForStep,
    type OnboardingMessage,
} from "./support/onboardingGym.js";

/**
 * Choosing and connecting an AI in onboarding's bootstrap, against stand-ins for the vendor's
 * program and installer: nothing leaves this machine and no real sign-in opens. The gym serves no
 * Claude account, so a Claude that signs in still cannot be used, and the flow says so.
 */

const gyms = new OnboardingGyms();
const TEST_TIMEOUT_MS = 60_000;

afterEach(async () => {
    await gyms.dispose();
});

/** Start onboarding, then choose Claude from the menu of AIs. */
async function chooseClaude(gym: AgentGym): Promise<{ agentId: string; offer: OnboardingMessage }> {
    const agentId = await startOnboarding(gym);
    const asked = (await waitForStep(gym, agentId, "providers"))!;
    expect(textOf(asked)).toContain("I didn't find one signed in");
    const chose = await press(gym, agentId, {
        messageId: asked.id,
        controlIndex: 0,
        params: { step: "choose", provider: "claude" },
    });
    expect(textOf(chose)).toBe("Claude");
    const offer = await gym.waitUntil(async () => {
        const flow = await flowOf(gym);
        const last = (await messagesOf(gym, agentId)).at(-1);
        return flow.step !== "choose" && last?.role === "agent" ? last : undefined;
    }, "the offer for Claude");
    return { agentId, offer };
}

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

describe("Connecting an AI in onboarding's bootstrap", () => {
    it(
        "discloses the installer, installs and signs in through the live figure, and never stores the code",
        async () => {
            const { gym } = await gyms.start({ stubs: { curl: STUB_CURL } });
            const { agentId, offer } = await chooseClaude(gym);
            expect((await flowOf(gym)).step).toBe("install-offer");
            expect(textOf(offer)).toContain(
                "Claude Code isn't on this computer yet. I'll install it with Anthropic's official installer from **claude.ai**, then open the sign-in. This is the exact command I'll run:",
            );
            expect(textOf(offer)).toContain(
                "```sh\ncurl -fsSL https://claude.ai/install.sh | bash\n```",
            );

            await press(gym, agentId, {
                messageId: offer.id,
                params: { step: "connect", provider: "claude" },
            });
            const connecting = (await waitForStep(gym, agentId, "connect"))!;
            const written = textOf(connecting);
            expect(written).toContain(
                "Connecting Claude. Finish signing in below, and I'll carry on the moment you're done.",
            );
            expect(written).toContain('<figure data-provider-cli="claude"></figure>');

            // The figure draws the provider CLI itself; its code field calls the generic route.
            await gym.waitUntil(async () => {
                const cli = await claudeCli(gym);
                return cli.operation?.kind === "sign_in" &&
                    cli.operation.status === "waiting" &&
                    cli.operation.authorization?.acceptsCode === true
                    ? true
                    : undefined;
            }, "the sign-in to wait for its code");
            await gym.http.ok("POST", "/v0/provider-clis/claude/sign-in/code", {
                code: "good-code",
            });

            const failed = (await waitForStep(gym, agentId, "use-failed", [connecting.id]))!;
            expect(textOf(failed)).toContain(
                "I couldn't put Claude to work yet. My settings on this computer have no connection for it. Sign in to Claude again, or choose another AI, and we'll keep going.",
            );
            expect(textOf(failed)).toContain(
                '<button data-action="onboarding.next" data-step="connect" data-provider="claude" data-mark="claude" data-emphasis>Sign in again</button>',
            );
            const all = await messagesOf(gym, agentId);
            // Nothing above is redrawn: the connecting message is exactly as it was written.
            expect(textOf(all.find((message) => message.id === connecting.id))).toBe(written);
            for (const message of all) expect(JSON.stringify(message)).not.toContain("good-code");
            expect(gym.inference.requests).toEqual([]);
            expect(gym.errors).toEqual([]);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "waits for a sign-in the person runs in their own terminal",
        async () => {
            const { gym, home } = await gyms.start({ stubs: { claude: STUB_CLAUDE } });
            const { agentId, offer } = await chooseClaude(gym);
            expect((await flowOf(gym)).step).toBe("sign-in-offer");
            expect(textOf(offer)).toContain(
                "Claude Code is already on this computer, so this is quick. I'll open Anthropic's sign-in page, and once you approve, your agents can work with your Claude account.",
            );

            await press(gym, agentId, {
                messageId: offer.id,
                controlIndex: 1,
                params: { step: "manual", provider: "claude" },
            });
            const manual = (await waitForStep(gym, agentId, "manual"))!;
            expect(textOf(manual)).toContain(
                "Sure. Run this in your terminal and sign in. I'll notice the moment you're done and carry on here.",
            );
            expect(textOf(manual)).toContain(
                '<output data-status="running">Waiting for Claude sign-in…</output>',
            );
            // Doing it for them is offered again, never emphasized.
            expect(textOf(manual)).toContain(
                '<button data-action="onboarding.next" data-step="connect" data-provider="claude">Open the sign-in page instead</button>',
            );

            // The person signs in in their own terminal; no client asks the daemon to look.
            await writeFile(join(home, ".stub-claude-signed-in"), "");
            const failed = (await waitForStep(gym, agentId, "use-failed", [manual.id]))!;
            expect(textOf(failed)).toContain("I couldn't put Claude to work yet.");
            expect(gym.errors).toEqual([]);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "says why an install failed and offers a way on",
        async () => {
            const { gym } = await gyms.start({
                stubs: {
                    curl: '#!/bin/sh\necho "curl: (6) Could not resolve host: claude.ai" >&2\nexit 6\n',
                },
            });
            const { agentId, offer } = await chooseClaude(gym);
            await press(gym, agentId, {
                messageId: offer.id,
                params: { step: "connect", provider: "claude" },
            });
            // The connect step's message comes first, then the install fails without a press.
            const failed = await waitForSaid(gym, agentId, "I couldn't finish connecting Claude.");
            expect((await flowOf(gym)).step).toBe("connect-failed");
            expect(textOf(failed)).toMatch(/^I couldn't finish connecting Claude\. \S/u);
            expect(textOf(failed)).toContain(
                [
                    "<menu>",
                    '  <button data-action="onboarding.next" data-step="connect" data-provider="claude" data-emphasis>Try again</button>',
                    '  <button data-action="onboarding.next" data-step="manual" data-provider="claude">I\'ll do it myself</button>',
                    '  <button data-action="onboarding.next" data-step="more">Choose another AI</button>',
                    "</menu>",
                ].join("\n"),
            );
            expect((await claudeCli(gym)).signIn.status).not.toBe("signed_in");
            expect(gym.errors).toEqual([]);
        },
        TEST_TIMEOUT_MS,
    );
});
