import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    createAgentGym,
    GYM_MODELS,
    type AgentGym,
    type GymInferenceRequest,
    type GymTurn,
} from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Happy's model leading onboarding once an AI is connected. Codex is a stand-in inside a stand-in
 * ChatGPT app, signed in by a fake auth file in a throwaway home; its account is a scripted
 * provider registered as Codex, so the first answer is the gym's, and nothing leaves this machine.
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

const CODEX = `#!/bin/sh
case "$*" in
  "--version") echo "codex-cli 0.164.0" ;;
  "login status") echo "Logged in using ChatGPT" ;;
  *) exit 2 ;;
esac
`;

const PROFILE_STEP = [
    "What should I call you? I found this in your Git settings:",
    "",
    "**Ada Lovelace** · ada@example.com",
    "",
    "<menu>",
    '  <button data-action="onboarding.profileConfirm" data-emphasis>That\'s me</button>',
    '  <button data-action="onboarding.profileChange">Change it</button>',
    "</menu>",
].join("\n");

const WORK_STEP = "Thanks, Ada. Here's where I'd look for your work.";

function jwt(claims: object): string {
    const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
    return `${part({ alg: "none" })}.${part(claims)}.signature`;
}

interface Flow {
    step: string;
    happyAgentId: string | null;
    composer: string;
    completedVersion: number | null;
    requirements: { provider: boolean; profile: boolean };
}

interface Message {
    id: string;
    role: string;
    content: { type: string; text?: string }[];
}

/** The hidden event a request's newest message carries, if any. */
function eventIn(request: GymInferenceRequest): string | undefined {
    const text = JSON.stringify(request.messages.at(-1) ?? {});
    return /\\"kind\\":\\"(\w+)\\"/u.exec(text)?.[1];
}

async function startGym(answers: Record<string, (request: GymInferenceRequest) => GymTurn>) {
    const root = await mkdtemp(join(tmpdir(), "onboarding-guided-"));
    folders.add(root);
    const home = join(root, "home");
    const applications = join(root, "Applications");
    const codex = join(applications, "ChatGPT.app", "Contents", "Resources", "codex-cli", "bin");
    await mkdir(codex, { recursive: true });
    await writeFile(join(codex, "codex"), CODEX);
    await chmod(join(codex, "codex"), 0o755);
    await mkdir(join(home, ".codex"), { recursive: true });
    await writeFile(
        join(home, ".codex", "auth.json"),
        JSON.stringify({
            tokens: {
                id_token: jwt({
                    email: "ada@example.com",
                    "https://api.openai.com/auth": { chatgpt_plan_type: "plus" },
                }),
            },
        }),
    );
    await writeFile(
        join(home, ".gitconfig"),
        "[user]\n\tname = Ada Lovelace\n\temail = ada@example.com\n",
    );
    const gym = await createAgentGym({
        environment: {
            HOME: home,
            CODEX_HOME: join(home, ".codex"),
            GROK_HOME: join(home, ".grok"),
            HAPPY_AGENT_APPLICATIONS_DIRECTORY: applications,
            HAPPY_AGENT_PROGRAM_DIRECTORIES: "",
            HAPPY_AGENT_LOCAL_MODEL_PORTS: "",
            PATH: "/usr/bin:/bin",
        },
        providerIds: ["gym", "codex"],
        providerTypes: { codex: "codex" },
        models: [
            ...GYM_MODELS,
            {
                defaultEffort: "medium",
                effortLevels: ["low", "medium", "high"],
                id: "gym-codex",
                name: "Gym Codex",
                providerId: "codex",
            },
        ],
        inference: (request) => {
            if (request.sessionId.startsWith("naming:")) {
                return {
                    content: [{ text: "<title>Happy</title><slug>happy</slug>", type: "text" }],
                };
            }
            const answer = answers[eventIn(request) ?? ""];
            if (answer === undefined) throw new Error(`Unscripted request: ${eventIn(request)}`);
            return answer(request);
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

async function waitForText(gym: AgentGym, happy: string, text: string): Promise<Message> {
    return await gym.waitUntil(
        async () => (await messages(gym, happy)).find((message) => textOf(message).includes(text)),
        `Happy to say "${text}"`,
    );
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
    const response = await gym.http.request("POST", `/v0/agents/${happy}/chat-actions`, body);
    expect(response.status, JSON.stringify(response.body)).toBe(202);
}

async function flowOf(gym: AgentGym): Promise<Flow> {
    return ((await gym.http.ok("GET", "/v0/onboarding/flow")) as { flow: Flow }).flow;
}

/** Start onboarding and use the Codex Happy found inside the ChatGPT app. */
async function connectCodex(gym: AgentGym, happy: string): Promise<void> {
    const opening = await waitForText(gym, happy, "Hi, I'm Happy");
    await press(gym, happy, {
        messageId: opening.id,
        blockIndex: 0,
        action: { id: "onboarding.start", params: {} },
    });
    const routes = await waitForText(gym, happy, "already reaches these");
    expect(textOf(routes)).toContain('value="codex" checked');
    await press(gym, happy, {
        messageId: routes.id,
        blockIndex: 0,
        action: { id: "onboarding.routesUse", params: {} },
        values: ["codex"],
    });
}

describe("Happy's model leading onboarding", () => {
    it(
        "verifies the chosen AI with Happy's first answer, then saves the profile it showed",
        async () => {
            const { gym, happy } = await startGym({
                begin: () => ({ content: [{ text: PROFILE_STEP, type: "text" }] }),
                profileSaved: () => ({ content: [{ text: WORK_STEP, type: "text" }] }),
            });
            await connectCodex(gym, happy);
            await waitForText(gym, happy, "Connected to ChatGPT");
            const profileStep = await waitForText(gym, happy, "**Ada Lovelace** · ada@example.com");
            const verified = await gym.waitUntil(async () => {
                const flow = await flowOf(gym);
                return flow.step === "guided" ? flow : undefined;
            }, "the first answer to verify Codex");
            expect(verified).toMatchObject({
                composer: "enabled",
                requirements: { provider: true, profile: false },
                completedVersion: null,
            });

            const begin = gym.inference.requests.find((request) => eventIn(request) === "begin");
            expect(begin?.providerId).toBe("codex");
            expect(begin?.instructions).toContain("# Onboarding");
            expect(JSON.stringify(begin?.messages.at(-1))).toContain(
                '\\"profile\\":{\\"name\\":\\"Ada Lovelace\\",\\"email\\":\\"ada@example.com\\",\\"source\\":\\"git\\"}',
            );
            expect(begin?.tools.map((tool) => tool.name)).toContain("save_profile");
            // The events are Happy's, never shown as anyone's message.
            for (const message of await messages(gym, happy)) {
                expect(textOf(message)).not.toContain("<happy-onboarding-event>");
            }

            await press(gym, happy, {
                messageId: profileStep.id,
                blockIndex: 0,
                action: { id: "onboarding.profileConfirm", params: {} },
            });
            await waitForText(gym, happy, WORK_STEP);
            const complete = await gym.waitUntil(async () => {
                const flow = await flowOf(gym);
                return flow.completedVersion === 1 ? flow : undefined;
            }, "onboarding to complete");
            expect(complete.requirements).toEqual({ provider: true, profile: true });
            const profile = (await gym.http.ok("GET", "/v0/profile")) as {
                profile: { name: string; email: string };
            };
            expect(profile.profile).toMatchObject({
                name: "Ada Lovelace",
                email: "ada@example.com",
            });
            const fast = await gym.http.ok("GET", "/v0/onboarding");
            expect(fast).toMatchObject({ completed: true, completedVersion: 1 });
            expect(gym.errors).toEqual([]);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "says what failed when the first answer fails, and verifies on the next try",
        async () => {
            let attempts = 0;
            const { gym, happy } = await startGym({
                begin: () => {
                    attempts += 1;
                    if (attempts === 1) throw new Error("The account is out of credit.");
                    return { content: [{ text: PROFILE_STEP, type: "text" }] };
                },
            });
            await connectCodex(gym, happy);
            const failed = await waitForText(gym, happy, "I couldn't get an answer from ChatGPT.");
            expect(textOf(failed)).toContain("out of credit");
            const back = await gym.waitUntil(async () => {
                const flow = await flowOf(gym);
                return flow.step === "providers" ? flow : undefined;
            }, "onboarding to go back to choosing");
            expect(back).toMatchObject({ composer: "disabled", requirements: { provider: false } });

            await press(gym, happy, {
                messageId: failed.id,
                blockIndex: 0,
                action: { id: "onboarding.connect", params: { provider: "codex" } },
            });
            await waitForText(gym, happy, "**Ada Lovelace** · ada@example.com");
            await gym.waitUntil(async () => {
                const flow = await flowOf(gym);
                return flow.step === "guided" ? flow : undefined;
            }, "the second answer to verify Codex");
        },
        TEST_TIMEOUT_MS,
    );
});
