import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

import {
    OnboardingGyms,
    act,
    flowOf,
    signInRow,
    startOnboarding,
    waitForOpening,
} from "./support/onboardingGym.js";

/**
 * A sign-in Happy saw that a later check can no longer confirm, as when Claude's keychain is out
 * of reach of a daemon started over SSH: the widget says why with a failed sign-in, never a silent
 * drop to "not checked", and a sign-in started from it that still can't be confirmed says so too.
 */

const gyms = new OnboardingGyms();
const TEST_TIMEOUT_MS = 60_000;

afterEach(async () => {
    await gyms.dispose();
});

/** A stand-in Claude Code signed in until `~/.unreadable` exists; then its answer can't be read. */
const FLAKY_CLAUDE = `#!/bin/sh
case "$*" in
  "--version") echo "2.1.312 (Claude Code)" ;;
  "auth status --json")
    if [ -f "$HOME/.unreadable" ]; then echo "Error: the keychain could not be read"; exit 1; fi
    echo '{"loggedIn":true,"authMethod":"claude.ai","email":"ada@example.com","subscriptionType":"max"}' ;;
  "auth login --claudeai") echo "Login successful." ;;
  *) exit 2 ;;
esac
`;

interface Cli {
    readonly signIn: { readonly status: string };
    readonly operation: {
        readonly kind: string;
        readonly status: string;
        readonly error: { readonly code: string; readonly message: string } | null;
    } | null;
}

async function claudeCli(gym: AgentGym): Promise<Cli> {
    return ((await gym.http.ok("GET", "/v0/provider-clis/claude")) as { providerCli: Cli })
        .providerCli;
}

describe("A sign-in Happy can no longer confirm", () => {
    it(
        "says why with a failed sign-in, also after the widget tries to sign in again",
        async () => {
            const { gym, home } = await gyms.start({ stubs: { claude: FLAKY_CLAUDE } });
            const agentId = await startOnboarding(gym);
            const opening = await waitForOpening(gym, agentId);
            const row = await signInRow(gym, agentId, opening, "claude");
            expect((await claudeCli(gym)).signIn.status).toBe("signed_in");

            await writeFile(join(home, ".unreadable"), "");
            expect(await claudeCli(gym)).toMatchObject({
                signIn: { status: "unknown" },
                operation: {
                    kind: "sign_in",
                    status: "failed",
                    error: {
                        code: "sign_in_failed",
                        message:
                            "Happy can no longer confirm Claude Code's sign-in. Claude Code didn't say whether it's signed in.",
                    },
                },
            });

            // "Sign in" from the widget runs the sign-in, and its end still can't be confirmed.
            const used = await act(gym, agentId, row, "claude", "sign_in");
            expect(used.record).toMatchObject({ content: [{ outcome: { status: "accepted" } }] });
            const settled = await gym.waitUntil(async () => {
                const cli = await claudeCli(gym);
                return cli.operation?.status === "failed" &&
                    cli.operation.error?.message.startsWith("Claude Code may have signed in")
                    ? cli
                    : undefined;
            }, "the sign-in to fail with why");
            expect(settled.operation?.error).toEqual({
                code: "sign_in_failed",
                message:
                    "Claude Code may have signed in, but Happy couldn't confirm it. Claude Code didn't say whether it's signed in.",
            });
            expect(await flowOf(gym)).toMatchObject({ step: "opening" });
            expect(gym.errors).toEqual([]);
        },
        TEST_TIMEOUT_MS,
    );
});
