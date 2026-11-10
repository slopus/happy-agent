import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import type { AgentGym, GymInferenceRequest, GymTurn } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

import {
    connectCodex,
    jwt,
    reply,
    showing,
    startGuidedGym,
    suggesting,
} from "./support/guidedOnboardingGym.js";
import {
    OnboardingGyms,
    act,
    messagesOf,
    textOf,
    uiOf,
    waitForSaid,
} from "./support/onboardingGym.js";

/**
 * Adding another Claude Code account: the vendor's own sign-in runs in a fresh
 * `CLAUDE_CONFIG_DIR`, and the account it signs in is a provider at once, without a restart,
 * in the Claude pool, while the default sign-in stays as it was. Programs are stand-ins on an
 * isolated `PATH`; nothing reaches a real assistant.
 */

const gyms = new OnboardingGyms();
const TEST_TIMEOUT_MS = 60_000;

afterEach(async () => {
    await gyms.dispose();
});

/** A stand-in Claude Code that keeps each account's sign-in in its own configuration folder. */
const CLAUDE = `#!/bin/sh
dir="\${CLAUDE_CONFIG_DIR:-$HOME}"
state="$dir/.stub-claude-signed-in"
email="ada@example.com"
[ -n "$CLAUDE_CONFIG_DIR" ] && email="grace@example.com"
case "$*" in
  "--version") echo "2.1.312 (Claude Code)" ;;
  "auth status --json")
    if [ -f "$state" ]; then
      echo "{\\"loggedIn\\":true,\\"authMethod\\":\\"claude.ai\\",\\"email\\":\\"$email\\",\\"subscriptionType\\":\\"max\\"}"
    else
      echo '{"loggedIn":false,"authMethod":"none"}'; exit 1
    fi ;;
  "auth login --claudeai")
    echo "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&state=stub"
    printf "Paste code here if prompted > "
    read code
    if [ "$code" = "good-code" ]; then touch "$state"; echo "Login successful."; else echo "Login failed." >&2; exit 1; fi ;;
  *) exit 2 ;;
esac
`;

const POOL = `[providers.claude]
enabled = true
[providers.claude_pool]
type = "smart"
name = "Claude pool"
enabled = true
providers = ["claude"]
`;

type Account = {
    id: string;
    label: string;
    email?: string;
    plan?: string;
    signIn: string;
};
type ProviderCli = {
    id: string;
    signIn: { status: string; account: { email: string | null } | null };
    accounts?: Account[];
    operation: {
        kind: string;
        status: string;
        message: string;
        authorization: { acceptsCode: boolean } | null;
    } | null;
};

async function claudeCli(gym: AgentGym): Promise<ProviderCli> {
    return ((await gym.http.ok("GET", "/v0/provider-clis/claude")) as { providerCli: ProviderCli })
        .providerCli;
}

async function waitForOperation(
    gym: AgentGym,
    status: string,
    description: string,
): Promise<ProviderCli> {
    return await gym.waitUntil(async () => {
        const cli = await claudeCli(gym);
        return cli.operation?.status === status ? cli : undefined;
    }, description);
}

describe("Adding another provider account", () => {
    it(
        "signs in a fresh Claude Code folder and uses it without a restart, in the pool",
        async () => {
            const { gym, home } = await gyms.start({
                stubs: { claude: CLAUDE },
                machine: { "home/.stub-claude-signed-in": "" },
                config: POOL,
            });
            const before = await claudeCli(gym);
            expect(before.accounts).toEqual([
                {
                    id: "claude",
                    label: "Current CLI",
                    email: "ada@example.com",
                    plan: "Max",
                    signIn: "signed_in",
                },
            ]);

            const started = (await gym.http.ok("POST", "/v0/provider-clis/claude/sign-in", {
                account: "new",
                mutationId: "add-claude",
            })) as { providerCli: ProviderCli; accountId?: string };
            expect(started.accountId).toBe("claude_2");
            expect(started.providerCli.operation).toMatchObject({ kind: "sign_in" });
            // Starting again while it runs joins it and names the same account.
            const joined = (await gym.http.ok("POST", "/v0/provider-clis/claude/sign-in", {
                account: "new",
            })) as { accountId?: string };
            expect(joined.accountId).toBe("claude_2");

            const waiting = await waitForOperation(gym, "waiting", "the page to appear");
            expect(waiting.operation?.authorization?.acceptsCode).toBe(true);
            await gym.http.ok("POST", "/v0/provider-clis/claude/sign-in/code", {
                code: "good-code",
            });
            const done = await waitForOperation(gym, "succeeded", "the account to be added");
            expect(done.operation?.message).toBe(
                "Signed in to Claude Code as grace@example.com · Max.",
            );

            // The default sign-in is untouched; the new account signed in in its own folder.
            expect(done.signIn).toMatchObject({
                status: "signed_in",
                account: { email: "ada@example.com" },
            });
            expect(done.accounts).toEqual([
                before.accounts![0],
                {
                    id: "claude_2",
                    label: "Claude Code 2",
                    email: "grace@example.com",
                    plan: "Max",
                    signIn: "signed_in",
                },
            ]);
            expect((await stat(join(home, ".claude-2", ".stub-claude-signed-in"))).isFile()).toBe(
                true,
            );

            // The account is configured now, and the pool routes through it.
            const { config } = await gym.client.getConfig();
            expect(config.providers["claude_2"]).toMatchObject({
                type: "claude",
                name: "Claude Code 2",
            });
            expect(config.providers["claude_pool"]?.pool?.members).toEqual(["claude", "claude_2"]);
            const runtime = await readFile(join(gym.happyHome, "agent", "runtime.toml"), "utf8");
            expect(runtime).toContain("[providers.claude_2]");
            expect(runtime).toContain(`config_dir = "${join(home, ".claude-2")}"`);
            expect(gym.errors).toEqual([]);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "refuses another account for an assistant without account folders",
        async () => {
            const { gym } = await gyms.start({ stubs: { claude: CLAUDE } });
            const refused = await gym.http.request("POST", "/v0/provider-clis/grok/sign-in", {
                account: "new",
            });
            expect(refused.status).toBe(400);
            expect(refused.body).toMatchObject({ code: "invalid_request" });
            expect(gym.errors).toEqual([]);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "adds the account from a chat's sign-in row and wakes the model once it is signed in",
        async () => {
            const READY = "Your second Claude Code account is ready.";
            const answer = (request: GymInferenceRequest): GymTurn => {
                if (
                    request.sessionId.endsWith(":title") ||
                    request.sessionId.startsWith("naming:")
                ) {
                    return {
                        content: [
                            { type: "text", text: "<title>Claude</title><slug>claude</slug>" },
                        ],
                    };
                }
                const last = request.messages.at(-1);
                if (JSON.stringify(last).includes("<happy-note>")) {
                    return { content: [{ type: "text", text: READY }] };
                }
                if (last?.role === "tool") return { content: [] };
                return {
                    content: [
                        { type: "text", text: "Add it here." },
                        {
                            type: "tool_call",
                            name: "show_ui",
                            arguments: {
                                components: [
                                    {
                                        id: "claude",
                                        type: "provider_sign_in",
                                        props: { provider: "claude", account: "new" },
                                    },
                                ],
                            },
                        },
                    ],
                };
            };
            const { gym } = await gyms.start({
                stubs: { claude: CLAUDE },
                machine: { "home/.stub-claude-signed-in": "" },
                inference: answer,
            });
            const agentId = gym.defaultSessionId;
            await gym.send("Add my work Claude account.");
            const shown = await gym.waitUntil(
                async () => (await messagesOf(gym, agentId)).find((message) => uiOf(message)),
                "the sign-in row to be shown",
            );
            const used = await act(gym, agentId, shown, "claude", "sign_in");
            expect(used.record).toMatchObject({ content: [{ outcome: { status: "accepted" } }] });
            expect(used.result).toEqual({ accountId: "claude_2" });
            await waitForOperation(gym, "waiting", "the page to appear");
            await act(gym, agentId, shown, "claude", "submit_code", { code: "good-code" });

            await gym.waitUntil(async () => {
                const all = await messagesOf(gym, agentId);
                return all.some((message) => textOf(message) === READY) ? true : undefined;
            }, "the model to answer the note");
            const woken = gym.inference.requests.filter((request) =>
                JSON.stringify(request.messages.at(-1)).includes("<happy-note>"),
            );
            expect(woken).toHaveLength(1);
            expect(JSON.stringify(woken[0]!.messages.at(-1))).toContain(
                "Another Claude Code account is connected and signed in as grace@example.com.",
            );
            // The code went only to the program: never into the conversation or its events.
            const events = JSON.stringify((await gym.client.getEvents({ limit: 1000 })).events);
            expect(events).not.toContain("good-code");
            expect(JSON.stringify(gym.inference.requests)).not.toContain("good-code");
            expect(gym.errors).toEqual([]);
        },
        TEST_TIMEOUT_MS,
    );
});

/**
 * A stand-in Codex that keeps each account in `CODEX_HOME`, signing the browser sign-in in as Grace
 * a moment after it prints its page, as a person finishing in the browser would.
 */
function slowCodex(): string {
    const token = jwt({ email: "grace@example.com" });
    return `#!/bin/sh
dir="\${CODEX_HOME:-$HOME/.codex}"
case "$*" in
  "--version") echo "codex-cli 0.164.0" ;;
  "login status")
    if [ -f "$dir/auth.json" ]; then echo "Logged in using ChatGPT"; else echo "Not logged in"; exit 1; fi ;;
  "login")
    echo "If your browser did not open, navigate to this URL to authenticate: https://auth.openai.com/oauth/authorize?state=stub"
    sleep 2
    printf '{"tokens":{"id_token":"${token}"}}' > "$dir/auth.json"
    echo "Successfully logged in" ;;
  *) exit 2 ;;
esac
`;
}

describe("Adding another account during onboarding", () => {
    it(
        "wakes the model once the added Codex account signs in",
        async () => {
            const READY = "Your second Codex account is ready.";
            const { gym, agentId } = await startGuidedGym(
                gyms,
                {
                    "event:begin": () =>
                        suggesting("Codex is connected.", ["Add another Codex account"]),
                    "said:Add another Codex account": () =>
                        showing("Here's Codex, ready for another account:", [
                            {
                                id: "codex-new",
                                type: "provider_sign_in",
                                props: { provider: "codex", account: "new" },
                            },
                        ]),
                    shown: (request) =>
                        JSON.stringify(request.messages.at(-1)).includes(
                            "Another Codex account is connected",
                        )
                            ? { content: [{ type: "text", text: READY }] }
                            : { content: [] },
                },
                { codex: slowCodex() },
            );
            await connectCodex(gym, agentId);
            const offer = await waitForSaid(gym, agentId, "Codex is connected.");
            await reply(gym, agentId, offer.id, 0);
            const row = await gym.waitUntil(
                async () =>
                    (await messagesOf(gym, agentId)).find((message) =>
                        uiOf(message)?.components.some((component) => component.id === "codex-new"),
                    ),
                "the add-account row",
            );
            const used = await act(gym, agentId, row, "codex-new", "sign_in");
            expect(used.result).toEqual({ accountId: "codex_2" });
            await gym.waitUntil(async () => {
                const all = await messagesOf(gym, agentId);
                return all.some((message) => textOf(message) === READY) ? true : undefined;
            }, "the model to answer the added account's note");
            expect(gym.errors).toEqual([]);
        },
        TEST_TIMEOUT_MS,
    );
});
