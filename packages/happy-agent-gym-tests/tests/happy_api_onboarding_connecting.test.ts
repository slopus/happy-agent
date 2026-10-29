import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Choosing and connecting an AI in Happy's onboarding conversation, against stand-ins for the
 * vendor's program and installer in a throwaway home: `PATH` reaches no real assistant, browser,
 * or installer, so nothing leaves this machine and no real sign-in opens.
 */

const running = new Set<AgentGym>();
const folders = new Set<string>();
const TEST_TIMEOUT_MS = 60_000;

afterEach(async () => {
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
    await Promise.all(
        [...folders].map(async (folder) => await rm(folder, { force: true, recursive: true })),
    );
    folders.clear();
});

/** A stand-in Claude Code that signs in only with the code `good-code`. */
const CLAUDE = `#!/bin/sh
state="$HOME/.stub-claude-signed-in"
case "$*" in
  "--version") echo "2.1.312 (Claude Code)" ;;
  "auth status --json")
    if [ -f "$state" ]; then
      echo '{"loggedIn":true,"authMethod":"claude.ai","email":"ada@example.com","subscriptionType":"max"}'
    else
      echo '{"loggedIn":false,"authMethod":"none"}'; exit 1
    fi ;;
  "auth login --claudeai")
    echo "Opening browser to sign in…"
    echo "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&state=stub"
    printf "Paste code here if prompted > "
    read code
    if [ "$code" = "good-code" ]; then touch "$state"; echo "Login successful."; else echo "Login failed." >&2; exit 1; fi ;;
  *) exit 2 ;;
esac
`;

/** A stand-in for \`curl\` that serves an installer placing the stand-in Claude Code. */
const CURL = `#!/bin/sh
cat <<'INSTALLER'
mkdir -p "$HOME/.local/bin"
cat > "$HOME/.local/bin/claude" <<'PROGRAM'
${CLAUDE}PROGRAM
chmod +x "$HOME/.local/bin/claude"
echo "Claude Code successfully installed!"
INSTALLER
`;

interface Flow {
    step: string;
    happyAgentId: string | null;
}

interface Message {
    id: string;
    role: string;
    content: { type: string; text?: string }[];
    actionChoices?: Record<string, unknown>;
}

async function startGym(): Promise<{ gym: AgentGym; happy: string }> {
    const root = await mkdtemp(join(tmpdir(), "onboarding-connect-"));
    folders.add(root);
    const home = join(root, "home");
    const stubs = join(root, "stubs");
    await mkdir(stubs, { recursive: true });
    await writeFile(join(stubs, "curl"), CURL);
    await chmod(join(stubs, "curl"), 0o755);
    const gym = await createAgentGym({
        environment: {
            HOME: home,
            CODEX_HOME: join(home, ".codex"),
            GROK_HOME: join(home, ".grok"),
            HAPPY_AGENT_APPLICATIONS_DIRECTORY: join(root, "Applications"),
            HAPPY_AGENT_PROGRAM_DIRECTORIES: "",
            HAPPY_AGENT_LOCAL_MODEL_PORTS: "",
            PATH: `${stubs}:/usr/bin:/bin`,
        },
        timeoutMs: 20_000,
    });
    running.add(gym);
    const { flow } = (await gym.http.ok("POST", "/v0/onboarding/flow/start", {})) as {
        flow: Flow;
    };
    if (flow.happyAgentId === null) throw new Error("Happy was not seeded.");
    return { gym, happy: flow.happyAgentId };
}

function textOf(message: Message | undefined): string {
    return message?.content.map((block) => block.text ?? "").join("") ?? "";
}

async function messages(gym: AgentGym, happy: string): Promise<Message[]> {
    const page = (await gym.http.ok("GET", `/v0/agents/${happy}/messages`)) as {
        runs: { messages: Message[] }[];
    };
    return page.runs.flatMap((run) => run.messages);
}

/** Happy's messages once there are `count`, or one matches `predicate`. */
async function waitForMessages(
    gym: AgentGym,
    happy: string,
    count: number,
    description: string,
    predicate: (all: Message[]) => boolean = () => true,
): Promise<Message[]> {
    return await gym.waitUntil(async () => {
        // Happy's messages only: the person's presses are messages too.
        const all = (await messages(gym, happy)).filter((message) => message.role !== "user");
        return all.length >= count && predicate(all) ? all : undefined;
    }, description);
}

async function press(
    gym: AgentGym,
    happy: string,
    body: {
        messageId: string;
        blockIndex: number;
        action: { id: string; params: Record<string, string> };
        values?: string[];
    },
): Promise<void> {
    const response = await gym.http.request("POST", `/v0/agents/${happy}/send`, {
        content: [
            {
                type: "action",
                messageId: body.messageId,
                blockIndex: body.blockIndex,
                actionId: body.action.id,
                params: body.action.params,
                ...(body.values === undefined ? {} : { values: body.values }),
            },
        ],
    });
    expect(response.status, JSON.stringify(response.body)).toBe(202);
}

describe("Connecting an AI in Happy's onboarding", () => {
    it(
        "discloses the installer, shows the install and sign-in as a live figure, and never stores the code",
        async () => {
            const { gym, happy } = await startGym();
            const [opening] = await waitForMessages(gym, happy, 1, "Happy's first message");
            await press(gym, happy, {
                messageId: opening!.id,
                blockIndex: 0,
                action: { id: "onboarding.start", params: {} },
            });
            const asked = (await waitForMessages(gym, happy, 2, "the subscriptions question"))[1]!;
            expect(textOf(asked)).toContain("I didn't find any on this");

            await press(gym, happy, {
                messageId: asked.id,
                blockIndex: 0,
                action: { id: "onboarding.provider", params: { provider: "claude" } },
            });
            const offer = (await waitForMessages(gym, happy, 3, "the install offer"))[2]!;
            expect(textOf(offer)).toContain("Claude Code isn't on this");
            expect(textOf(offer)).toContain("curl -fsSL https://claude.ai/install.sh | bash");

            await press(gym, happy, {
                messageId: offer.id,
                blockIndex: 0,
                action: { id: "onboarding.connect", params: { provider: "claude" } },
            });
            const connecting = (await waitForMessages(gym, happy, 4, "the connecting message"))[3]!;
            const written = textOf(connecting);
            expect(written).toContain("Connecting Claude.");
            expect(written).toContain('<figure data-provider-cli="claude"></figure>');
            const flow = (await gym.http.ok("GET", "/v0/onboarding/flow")) as { flow: Flow };
            expect(flow.flow.step).toBe("connecting");

            // The figure draws the provider CLI itself; its code field calls the generic route.
            await gym.waitUntil(async () => {
                const { providerCli } = (await gym.http.ok("GET", "/v0/provider-clis/claude")) as {
                    providerCli: {
                        operation: {
                            status: string;
                            authorization: { acceptsCode: boolean } | null;
                        } | null;
                    };
                };
                return providerCli.operation?.status === "waiting" &&
                    providerCli.operation.authorization?.acceptsCode === true
                    ? true
                    : undefined;
            }, "the sign-in to wait for its code");
            await gym.http.ok("POST", "/v0/provider-clis/claude/sign-in/code", {
                code: "good-code",
            });
            const after = await waitForMessages(
                gym,
                happy,
                5,
                "Happy to carry on after the sign-in",
            );
            // Nothing above is redrawn: the connecting message is exactly as it was written.
            expect(textOf(after[3])).toBe(written);
            // The gym serves no Claude account, so Happy says so and asks again.
            expect(textOf(after[4])).toContain(
                "I couldn't make Claude the AI Happy uses. Happy Agent has no account for it on this computer.",
            );
            const back = (await gym.http.ok("GET", "/v0/onboarding/flow")) as { flow: Flow };
            expect(back.flow.step).toBe("providers");

            for (const message of await messages(gym, happy)) {
                expect(JSON.stringify(message)).not.toContain("good-code");
            }
            expect(gym.errors).toEqual([]);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "answers None yet and shows every AI on Sign in to more",
        async () => {
            const { gym, happy } = await startGym();
            const [opening] = await waitForMessages(gym, happy, 1, "Happy's first message");
            await press(gym, happy, {
                messageId: opening!.id,
                blockIndex: 0,
                action: { id: "onboarding.start", params: {} },
            });
            const asked = (await waitForMessages(gym, happy, 2, "the subscriptions question"))[1]!;
            await press(gym, happy, {
                messageId: asked.id,
                blockIndex: 0,
                action: { id: "onboarding.provider", params: { provider: "none" } },
            });
            const none = (await waitForMessages(gym, happy, 3, "the advice"))[2]!;
            expect(textOf(none)).toContain("I'd start with ChatGPT for general work");
            await press(gym, happy, {
                messageId: none.id,
                blockIndex: 0,
                action: { id: "onboarding.connectAnother", params: {} },
            });
            const catalog = (await waitForMessages(gym, happy, 4, "every AI"))[3]!;
            expect(textOf(catalog)).toContain("Here's every AI Happy can connect:");
            expect(textOf(catalog)).toContain('data-provider="gemini"');
            expect(gym.errors).toEqual([]);
        },
        TEST_TIMEOUT_MS,
    );
});
