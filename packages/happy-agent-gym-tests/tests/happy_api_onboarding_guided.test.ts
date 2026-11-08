import {
    GYM_MODELS,
    type AgentGym,
    type GymInferenceRequest,
    type GymTurn,
} from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

import {
    OnboardingGyms,
    flowOf,
    messagesOf,
    press,
    startOnboarding,
    textOf,
    waitForSaid,
    waitForStep,
} from "./support/onboardingGym.js";

/**
 * The conversation's own model leading onboarding once an AI is connected. Codex is a stand-in
 * inside a stand-in ChatGPT app, signed in by a fake auth file; its account is a scripted provider
 * registered as Codex, so every answer is the gym's and nothing leaves this machine.
 */

const gyms = new OnboardingGyms();
const TEST_TIMEOUT_MS = 60_000;

afterEach(async () => {
    await gyms.dispose();
});

const CODEX = `#!/bin/sh
case "$*" in
  "--version") echo "codex-cli 0.164.0" ;;
  "login status") echo "Logged in using ChatGPT" ;;
  *) exit 2 ;;
esac
`;

/** A stand-in Claude Code, signed in as Ada on Max. */
const CLAUDE = `#!/bin/sh
case "$*" in
  "--version") echo "2.1.312 (Claude Code)" ;;
  "auth status --json") echo '{"loggedIn":true,"authMethod":"claude.ai","email":"ada@example.com","subscriptionType":"max"}' ;;
  *) exit 2 ;;
esac
`;

const PROFILE_STEP = [
    "What should I call you? I found this in your Git settings:",
    "",
    "**Ada Lovelace** · ada@example.com",
    "",
    "<menu>",
    '  <button data-action="reply" data-emphasis>That\'s me</button>',
    '  <button data-action="reply">Change it</button>',
    "</menu>",
].join("\n");

const PROJECT_STEP = [
    "Thanks, Ada. Let's start with one project.",
    "",
    "<menu>",
    '  <button data-action="reply" data-emphasis>Find my recent projects</button>',
    '  <button data-action="reply">Skip for now</button>',
    "</menu>",
].join("\n");

const DONE = "You're all set, Ada. I stay at the top of your sidebar.";

function jwt(claims: object): string {
    const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
    return `${part({ alg: "none" })}.${part(claims)}.signature`;
}

/** What a request answers: the hidden event's kind, the person's words, or a tool's result. */
function cue(request: GymInferenceRequest): string {
    const last = request.messages.at(-1);
    const text = JSON.stringify(last ?? {});
    const event = /happy-onboarding-event>\\n\{\\"kind\\":\\"(\w+)\\"/u.exec(text);
    if (event !== null) return `event:${event[1]!}`;
    if (last?.role === "user") {
        return `said:${last.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("")}`;
    }
    if (text.includes("Saved their name and email")) return "saved";
    if (text.includes("Onboarding is finished")) return "finished";
    if (text.includes("Not finished.")) return "not finished";
    return `unknown:${text.slice(0, 200)}`;
}

async function startGuidedGym(
    answers: Record<string, (request: GymInferenceRequest) => GymTurn>,
    options: { /** Claude Code signed in too, beside Codex. */ readonly claude?: boolean } = {},
): Promise<{ gym: AgentGym; agentId: string }> {
    const codex = "Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex";
    const { gym } = await gyms.start({
        machine: {
            [codex]: { content: CODEX, mode: 0o755 },
            "home/.codex/auth.json": JSON.stringify({
                tokens: {
                    id_token: jwt({
                        email: "ada@example.com",
                        "https://api.openai.com/auth": { chatgpt_plan_type: "plus" },
                    }),
                },
            }),
            "home/.gitconfig": "[user]\n\tname = Ada Lovelace\n\temail = ada@example.com\n",
            ...(options.claude === true
                ? { "home/.local/bin/claude": { content: CLAUDE, mode: 0o755 } }
                : {}),
        },
        providerIds: options.claude === true ? ["gym", "codex", "claude"] : ["gym", "codex"],
        providerTypes:
            options.claude === true ? { codex: "codex", claude: "claude" } : { codex: "codex" },
        models: [
            ...GYM_MODELS,
            {
                defaultEffort: "medium",
                effortLevels: ["low", "medium", "high"],
                id: "gym-codex",
                name: "Gym Codex",
                providerId: "codex",
            },
            ...(options.claude === true
                ? [
                      {
                          defaultEffort: "high" as const,
                          effortLevels: ["low" as const, "medium" as const, "high" as const],
                          id: "gym-claude",
                          name: "Gym Claude",
                          providerId: "claude",
                      },
                  ]
                : []),
        ],
        inference: (request) => {
            if (request.sessionId.startsWith("naming:")) {
                return {
                    content: [{ text: "<title>Chief</title><slug>chief</slug>", type: "text" }],
                };
            }
            const answer = answers[cue(request)];
            if (answer === undefined) throw new Error(`Unscripted request: ${cue(request)}`);
            return answer(request);
        },
    });
    return { gym, agentId: await startOnboarding(gym) };
}

/** Press Start, then Use selected on the routes table with `values` ticked. */
async function useRoutes(gym: AgentGym, agentId: string, values: string[]): Promise<void> {
    const opening = (await waitForStep(gym, agentId, "welcome"))!;
    await press(gym, agentId, { messageId: opening.id, params: { step: "providers" } });
    const routes = (await waitForStep(gym, agentId, "providers"))!;
    expect(textOf(routes)).toContain(
        "I found these on this computer; choose which ones I should use.",
    );
    await press(gym, agentId, { messageId: routes.id, params: { step: "use" }, values });
}

async function reply(gym: AgentGym, agentId: string, messageId: string, controlIndex: number) {
    const response = await gym.http.request("POST", `/v0/agents/${agentId}/send`, {
        mode: {
            ...gym.selection,
            providerId: "codex",
            modelId: "gym-codex",
            permissionMode: "auto",
        },
        content: [
            {
                type: "action",
                messageId,
                blockIndex: 0,
                controlIndex,
                actionId: "reply",
                params: {},
            },
        ],
    });
    expect(response.status, response.text).toBe(202);
    return response.body as { message: { id: string; content: { type: string; text?: string }[] } };
}

describe("The model leading onboarding", () => {
    it(
        "verifies the chosen AI with its first answer, saves the profile, and finishes",
        async () => {
            const { gym, agentId } = await startGuidedGym({
                "event:begin": () => ({ content: [{ text: PROFILE_STEP, type: "text" }] }),
                "said:That's me": () => ({
                    content: [
                        {
                            type: "tool_call",
                            name: "save_profile",
                            arguments: { name: "Ada Lovelace", email: "ada@example.com" },
                        },
                    ],
                }),
                saved: () => ({ content: [{ text: PROJECT_STEP, type: "text" }] }),
                "said:Skip for now": () => ({
                    content: [{ type: "tool_call", name: "finish_onboarding", arguments: {} }],
                }),
                finished: () => ({ content: [{ text: DONE, type: "text" }] }),
                "said:Thanks": () => ({ content: [{ text: "Anytime.", type: "text" }] }),
            });
            await useRoutes(gym, agentId, ["codex"]);

            const profileStep = await waitForSaid(
                gym,
                agentId,
                "**Ada Lovelace** · ada@example.com",
            );
            const verified = await gym.waitUntil(async () => {
                const flow = await flowOf(gym);
                return flow.status === "running" && flow.step === null ? flow : undefined;
            }, "the model to take over");
            expect(verified).toMatchObject({
                composer: "enabled",
                composerPlaceholder: "Or just tell me in your own words…",
                completedVersion: null,
            });

            const begin = gym.inference.requests.find((request) => cue(request) === "event:begin");
            expect(begin?.providerId).toBe("codex");
            expect(begin?.model).toBe("gym-codex");
            expect(begin?.instructions).toContain("# Onboarding");
            expect(begin?.instructions).toContain(
                "You are Chief of Staff, the person's chief of staff",
            );
            expect(begin?.instructions).toMatch(
                /first-project recipe at \/\S+\/docs\/recipe\/first-project\.md/u,
            );
            const event = JSON.stringify(begin?.messages.at(-1));
            expect(event).toContain('\\"connected\\":[{\\"app\\":\\"ChatGPT\\"');
            expect(event).toContain(
                '\\"model\\":{\\"name\\":\\"Gym Codex\\",\\"effort\\":\\"Medium\\"}',
            );
            expect(event).toContain(
                '\\"profile\\":{\\"name\\":\\"Ada Lovelace\\",\\"email\\":\\"ada@example.com\\",\\"source\\":\\"git\\"}',
            );
            expect(begin?.tools.map((tool) => tool.name)).toEqual(
                expect.arrayContaining(["save_profile", "set_default_model", "finish_onboarding"]),
            );
            // The scripted bootstrap was never model input.
            expect(JSON.stringify(begin?.messages)).not.toContain("I found these on this computer");
            // The hidden event is no one's message.
            for (const message of await messagesOf(gym, agentId)) {
                expect(textOf(message)).not.toContain("happy-onboarding-event");
            }
            // The chosen model is the default now, and the conversation shows it.
            const { config } = (await gym.http.ok("GET", "/v0/config")) as {
                config: { defaults: Record<string, unknown> };
            };
            expect(config.defaults).toMatchObject({ providerId: "codex", modelId: "gym-codex" });

            const pressed = await reply(gym, agentId, profileStep.id, 0);
            expect(pressed.message.content).toEqual([{ type: "text", text: "That's me" }]);
            const projectStep = await waitForSaid(gym, agentId, "Thanks, Ada.");
            const complete = await gym.waitUntil(async () => {
                const flow = await flowOf(gym);
                return flow.completedVersion === 1 ? flow : undefined;
            }, "onboarding to complete");
            expect(complete.status).toBe("running");
            expect(await gym.http.ok("GET", "/v0/onboarding")).toMatchObject({
                completed: true,
                completedVersion: 1,
            });
            const { profile } = (await gym.http.ok("GET", "/v0/profile")) as {
                profile: { name: string; email: string };
            };
            expect(profile).toMatchObject({ name: "Ada Lovelace", email: "ada@example.com" });

            await reply(gym, agentId, projectStep.id, 1);
            await waitForSaid(gym, agentId, DONE);
            expect(await flowOf(gym)).toMatchObject({
                status: "finished",
                step: null,
                composerPlaceholder: null,
                completedVersion: 1,
            });

            // An ordinary chat from here: no guide, no onboarding tools.
            await gym.send("Thanks", {
                sessionId: agentId,
                providerId: "codex",
                modelId: "gym-codex",
            });
            const after = gym.inference.requests.at(-1);
            expect(cue(after!)).toBe("said:Thanks");
            expect(after?.instructions).not.toContain("# Onboarding");
            expect(after?.tools.map((tool) => tool.name)).not.toContain("save_profile");
            expect(gym.inference.unscripted).toEqual([]);
            expect(gym.errors).toEqual([]);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "offers the other AIs chosen when the first one fails to answer, and verifies on the next",
        async () => {
            let attempts = 0;
            const { gym, agentId } = await startGuidedGym(
                {
                    "event:begin": () => {
                        attempts += 1;
                        if (attempts === 1)
                            return { error: { message: "The account is out of credit." } };
                        return { content: [{ text: PROFILE_STEP, type: "text" }] };
                    },
                },
                { claude: true },
            );
            const opening = (await waitForStep(gym, agentId, "welcome"))!;
            await press(gym, agentId, { messageId: opening.id, params: { step: "providers" } });
            const routes = (await waitForStep(gym, agentId, "providers"))!;
            expect(textOf(routes)).toContain('value="claude" checked');
            expect(textOf(routes)).toContain('value="codex" checked');
            await press(gym, agentId, {
                messageId: routes.id,
                params: { step: "use" },
                values: ["claude", "codex"],
            });

            const failed = await waitForSaid(gym, agentId, "I couldn't get an answer from Claude.");
            expect((await flowOf(gym)).step).toBe("verify-failed");
            expect(textOf(failed)).toContain("out of credit");
            // The AI that failed starts unticked; the other one chosen is still ticked.
            expect(textOf(failed)).toContain('value="claude">');
            expect(textOf(failed)).toContain('value="codex" checked');
            expect(await flowOf(gym)).toMatchObject({ status: "running", composer: "disabled" });

            await press(gym, agentId, {
                messageId: failed.id,
                params: { step: "use" },
                values: ["codex"],
            });
            await waitForSaid(gym, agentId, "**Ada Lovelace** · ada@example.com");
            const begins = gym.inference.requests.filter(
                (request) => cue(request) === "event:begin",
            );
            expect(begins.map((request) => request.providerId)).toEqual(["claude", "codex"]);
            expect(gym.errors).toEqual([]);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "keeps what the person unticked when Use selected had nothing selected",
        async () => {
            const { gym, agentId } = await startGuidedGym({
                "event:begin": () => ({ content: [{ text: PROFILE_STEP, type: "text" }] }),
            });
            const opening = (await waitForStep(gym, agentId, "welcome"))!;
            await press(gym, agentId, { messageId: opening.id, params: { step: "providers" } });
            const routes = (await waitForStep(gym, agentId, "providers"))!;
            await press(gym, agentId, {
                messageId: routes.id,
                params: { step: "use" },
                values: [],
            });
            const retry = (await waitForStep(gym, agentId, "choose-at-least-one"))!;
            expect(textOf(retry)).toContain(
                "Your agents need at least one AI to think with. Tick one, or sign in to another AI.",
            );
            expect(textOf(retry)).toContain('value="codex"');
            expect(textOf(retry)).not.toContain("checked");
            await press(gym, agentId, {
                messageId: retry.id,
                params: { step: "use" },
                values: ["codex"],
            });
            await waitForSaid(gym, agentId, "**Ada Lovelace** · ada@example.com");
            expect(gym.errors).toEqual([]);
        },
        TEST_TIMEOUT_MS,
    );
});
