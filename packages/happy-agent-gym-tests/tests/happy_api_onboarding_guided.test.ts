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
    type OnboardingFlow,
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

/** The model's first message: what is connected, the profile it saved, and the first task asked. */
const FIRST_TASK_ASKED = [
    "Connected to ChatGPT as ada@example.com. Your agents think with it from now on, on Gym Codex · Medium unless you pick another model.",
    "",
    "I've put **Ada Lovelace** · ada@example.com on your profile, from your Git settings, so your agents know who they work for. Change it anytime.",
    "",
    "Now let's give them real work. With your permission, I'll look at the projects you worked on recently on this computer and their Git history, without changing anything, and suggest where agents can help first.",
    "",
    "<menu>",
    '  <button data-action="reply" data-emphasis>Look at my recent work</button>',
    '  <button data-action="reply">I\'ll name a folder</button>',
    '  <button data-action="reply">Skip for now</button>',
    "</menu>",
].join("\n");

const PHONE_STEP = [
    "Your agents keep working while you step away. Put Happy on your phone, and you can see them finish and answer their questions from anywhere. Scan a code to get the app, then open it.",
    "",
    "<figure data-phone-app></figure>",
    "",
    "<menu>",
    '  <button data-action="reply" data-emphasis>I\'ve opened Happy</button>',
    '  <button data-action="reply">Later</button>',
    "</menu>",
].join("\n");

const DONE =
    "You're all set, Ada. I stay at the top of your sidebar. Tell me what you want done next, and I'll put agents on it. Ask me for the phone code anytime.";

const SAVE_PROFILE = {
    content: [
        {
            type: "tool_call" as const,
            name: "save_profile",
            arguments: { name: "Ada Lovelace", email: "ada@example.com" },
        },
    ],
};

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
    options: {
        /** Claude Code signed in too, beside Codex. */
        readonly claude?: boolean;
        /** The kind of device the start names. */
        readonly device?: string;
    } = {},
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
    if (options.device === undefined) return { gym, agentId: await startOnboarding(gym) };
    const { flow } = (await gym.http.ok("POST", "/v0/onboarding/flow/start", {
        device: options.device,
    })) as { flow: OnboardingFlow };
    return { gym, agentId: flow.agentId! };
}

/** Use selected on the routes table with `values` ticked. */
async function useRoutes(gym: AgentGym, agentId: string, values: string[]): Promise<void> {
    const routes = (await waitForStep(gym, agentId, "providers"))!;
    expect(textOf(routes)).toContain(
        "I found these on this computer. Choose the ones I should use.",
    );
    await press(gym, agentId, { messageId: routes.id, params: { step: "use" }, values });
}

/** Press a `reply` control: `controlIndex` in the menu at `blockIndex`, after any figure. */
async function reply(
    gym: AgentGym,
    agentId: string,
    messageId: string,
    controlIndex: number,
    blockIndex = 0,
) {
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
                blockIndex,
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
                // The profile from Git is said, not asked: saved first, then the first message.
                "event:begin": () => SAVE_PROFILE,
                saved: () => ({ content: [{ text: FIRST_TASK_ASKED, type: "text" }] }),
                "said:Skip for now": () => ({ content: [{ text: PHONE_STEP, type: "text" }] }),
                "said:Later": () => ({
                    content: [{ type: "tool_call", name: "finish_onboarding", arguments: {} }],
                }),
                finished: () => ({ content: [{ text: DONE, type: "text" }] }),
                "said:Thanks": () => ({ content: [{ text: "Anytime.", type: "text" }] }),
            });
            await useRoutes(gym, agentId, ["codex"]);

            const firstTaskStep = await waitForSaid(
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
            expect(begin?.instructions).toContain(
                "Never call it before you have offered the first task, unless they say to stop setting up.",
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

            // Saving the profile with the first answer met every requirement.
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

            const pressed = await reply(gym, agentId, firstTaskStep.id, 2);
            expect(pressed.message.content).toEqual([{ type: "text", text: "Skip for now" }]);
            const phoneStep = await waitForSaid(gym, agentId, "<figure data-phone-app></figure>");
            expect(await flowOf(gym)).toMatchObject({ status: "running" });
            // The phone app figure is the first block, so the menu is the second.
            await reply(gym, agentId, phoneStep.id, 1, 1);
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
                        return SAVE_PROFILE;
                    },
                    saved: () => ({ content: [{ text: FIRST_TASK_ASKED, type: "text" }] }),
                },
                { claude: true },
            );
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
        "tells the model the kind of device onboarding began on, whatever later starts say",
        async () => {
            const { gym, agentId } = await startGuidedGym(
                {
                    "event:begin": () => SAVE_PROFILE,
                    saved: () => ({ content: [{ text: FIRST_TASK_ASKED, type: "text" }] }),
                },
                { device: "phone" },
            );
            // Only the start that began onboarding counts; a device it does not know is refused.
            await gym.http.ok("POST", "/v0/onboarding/flow/start", { device: "desktop" });
            const unknown = await gym.http.request("POST", "/v0/onboarding/flow/start", {
                device: "tablet",
            });
            expect(unknown.status, unknown.text).toBe(400);
            await useRoutes(gym, agentId, ["codex"]);
            await waitForSaid(gym, agentId, "**Ada Lovelace** · ada@example.com");
            const begin = gym.inference.requests.find((request) => cue(request) === "event:begin");
            expect(JSON.stringify(begin?.messages.at(-1))).toContain('\\"device\\":\\"phone\\"');
            expect(gym.errors).toEqual([]);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "keeps what the person unticked when Use selected had nothing selected",
        async () => {
            const { gym, agentId } = await startGuidedGym({
                "event:begin": () => SAVE_PROFILE,
                saved: () => ({ content: [{ text: FIRST_TASK_ASKED, type: "text" }] }),
            });
            const routes = (await waitForStep(gym, agentId, "providers"))!;
            await press(gym, agentId, {
                messageId: routes.id,
                params: { step: "use" },
                values: [],
            });
            const retry = (await waitForStep(gym, agentId, "choose-at-least-one"))!;
            expect(textOf(retry)).toContain(
                "Your agents need at least one AI to think with. Choose one, or sign in to another.",
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
