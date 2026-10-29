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
import { afterEach, describe, expect, it, vi } from "vitest";

// The phone is written from API.md alone, independently of the daemon's own pairing code.
import {
    httpPhoneTransport,
    startPhonePairing,
} from "../../happy-agent-modules/tests/mobileConnector/support/fakePhone.js";

/**
 * The rest of onboarding once the profile is saved: discovering the person's work from their
 * Codex sessions, Focus's proposal, Looks right opening the chats, New, the phone, and finishing.
 * Codex is a stand-in signed in by a fake auth file in a throwaway home, its sessions are written
 * by the test, and every model answer is the gym's; nothing leaves this machine.
 */

const running = new Set<AgentGym>();
const folders = new Set<string>();
const TEST_TIMEOUT_MS = 90_000;

afterEach(async () => {
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
    vi.unstubAllEnvs();
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

const ASKED = "Ship the onboarding redesign before Friday";

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

const WORK_STEP = [
    "Thanks, Ada. Want me to look at what you've been working on?",
    "",
    "<menu>",
    '  <button data-action="onboarding.discover" data-emphasis>Discover what I\'ve been working on</button>',
    '  <button data-action="onboarding.workTell">I\'ll tell you instead</button>',
    "</menu>",
].join("\n");

const NEW_STEP = [
    "Your chats are making a plan. New opens a fresh chat.",
    "",
    "<menu>",
    '  <button data-action="onboarding.newChat" data-emphasis>Try New</button>',
    '  <button data-action="onboarding.newChatSkip">Maybe later</button>',
    "</menu>",
].join("\n");

const PHONE_STEP = [
    "Want Happy on your phone too?",
    "",
    "<figure data-phone-app></figure>",
    "",
    "<menu>",
    '  <button data-action="onboarding.phone" data-choice="opened" data-emphasis>I have the app</button>',
    '  <button data-action="onboarding.phone" data-choice="later">Later</button>',
    "</menu>",
].join("\n");

const PROPOSAL = {
    intro: "Here's what I think you're focused on, most important first.",
    rows: [
        {
            title: "Onboarding redesign",
            icon: "not-an-icon",
            topic: "Product",
            why: "Asked in Codex this week",
            firstMessage:
                "Plan: ship the onboarding redesign. List what's left and wait for me before changing anything.",
        },
        {
            title: "Release check-in",
            icon: "wip",
            topic: "Releases",
            why: "You check releases by hand",
            firstMessage: "Plan a weekday release check-in and wait for me.",
            ongoing: true,
        },
    ],
};

function jwt(claims: object): string {
    const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
    return `${part({ alg: "none" })}.${part(claims)}.signature`;
}

interface Flow {
    step: string;
    happyAgentId: string | null;
    completedVersion: number | null;
}

interface Message {
    id: string;
    role: string;
    content: { type: string; text?: string }[];
    mode?: { permissionMode?: string } | null;
}

type Answers = Record<string, (request: GymInferenceRequest) => GymTurn>;

/** The hidden event a request's newest message carries, if any. */
function eventIn(request: GymInferenceRequest): string | undefined {
    const text = JSON.stringify(request.messages.at(-1) ?? {});
    return /\\"kind\\":\\"(\w+)\\"/u.exec(text)?.[1];
}

/** The hidden event of that kind Happy's model was told, parsed. */
function told(gym: AgentGym, kind: string): Record<string, unknown> | undefined {
    const request = gym.inference.requests.find((each) => eventIn(each) === kind);
    if (request === undefined) return undefined;
    const text = JSON.stringify(request.messages.at(-1));
    const json = (JSON.parse(text) as { content: { text?: string }[] }).content
        .map((block) => block.text ?? "")
        .join("");
    return JSON.parse(
        json.replace(/^<happy-onboarding-event>\n|\n<\/happy-onboarding-event>$/gu, ""),
    );
}

function say(text: string): () => GymTurn {
    return () => ({ content: [{ text, type: "text" }] });
}

/** Where the phone connector's relay listens, for the scenario that pairs a phone. */
const PHONE_PORT = 24_879;

/**
 * Only the Tailcat binary is fake: it publishes an address and stays up. The relay, the loopback
 * listener, and the pairing behind them are the daemon's own.
 */
async function fakeTailcat(root: string): Promise<void> {
    const executable = join(root, "tailcat");
    await writeFile(
        executable,
        `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "genkey") {
    writeFileSync(args.find((value) => value.startsWith("--key=")).slice(6), "key\\n", { mode: 0o600 });
    process.exit(0);
}
writeFileSync(process.env.TAILCAT_ADDR_FILE, "tcGymOnboardingPhone\\n", { mode: 0o600 });
process.on("SIGTERM", () => process.exit(0));
setInterval(() => undefined, 1_000);
`,
    );
    await chmod(executable, 0o755);
    vi.stubEnv("HAPPY_AGENT_TAILCAT_PATH", executable);
}

async function startGym(
    answers: Answers,
    options: {
        /** Pair a phone through the daemon's own connector, or turn phone connections off. */
        phone?: "on" | "off";
        /** What Focus proposes, one per request in order; the last one repeats. */
        proposals?: readonly object[];
    } = {},
) {
    const proposals = options.proposals ?? [PROPOSAL];
    let proposed = 0;
    const root = await mkdtemp(join(tmpdir(), "onboarding-work-"));
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
    // One Codex session, in a project that is not a Git repository.
    const project = join(root, "projects", "happy-desktop");
    await mkdir(project, { recursive: true });
    const sessions = join(home, ".codex", "sessions", "2026", "10", "27");
    await mkdir(sessions, { recursive: true });
    await writeFile(
        join(sessions, "rollout-1.jsonl"),
        [
            { type: "session_meta", payload: { cwd: project } },
            {
                type: "response_item",
                payload: {
                    type: "message",
                    role: "user",
                    content: [{ type: "input_text", text: "<environment_context/>" }],
                },
            },
            {
                type: "response_item",
                payload: {
                    type: "message",
                    role: "user",
                    content: [{ type: "input_text", text: ASKED }],
                },
            },
        ]
            .map((line) => JSON.stringify(line))
            .join("\n"),
    );
    if (options.phone === "on") await fakeTailcat(root);
    const gym = await createAgentGym({
        ...(options.phone === "on"
            ? { config: `[feature.mobile_connector]\nport = ${String(PHONE_PORT)}\n` }
            : options.phone === "off"
              ? { config: "[feature.mobile_connector]\nenabled = false\n" }
              : {}),
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
                    content: [{ text: "<title>Work</title><slug>work</slug>", type: "text" }],
                };
            }
            if (request.sessionId.startsWith("focus-proposal:")) {
                const proposal = proposals[Math.min(proposed, proposals.length - 1)];
                proposed += 1;
                return { content: [{ text: JSON.stringify(proposal), type: "text" }] };
            }
            const answer = answers[eventIn(request) ?? ""] ?? answers["*"];
            if (answer === undefined) return { content: [{ text: "Done.", type: "text" }] };
            return answer(request);
        },
        timeoutMs: 20_000,
    });
    running.add(gym);
    const { flow } = (await gym.http.ok("POST", "/v0/onboarding/flow/start", {})) as {
        flow: Flow;
    };
    if (flow.happyAgentId === null) throw new Error("Happy was not seeded.");
    return { gym, happy: flow.happyAgentId, project };
}

function textOf(message: Message | undefined): string {
    return message?.content.map((block) => block.text ?? "").join("") ?? "";
}

async function messages(gym: AgentGym, agentId: string): Promise<Message[]> {
    const page = (await gym.http.ok("GET", `/v0/agents/${agentId}/messages`)) as {
        runs: { messages: Message[] }[];
    };
    return page.runs.flatMap((run) => run.messages);
}

async function waitForText(gym: AgentGym, agentId: string, text: string): Promise<Message> {
    return await gym.waitUntil(
        async () =>
            (await messages(gym, agentId)).find((message) => textOf(message).includes(text)),
        `"${text}" to be said`,
    );
}

async function press(
    gym: AgentGym,
    happy: string,
    message: Message,
    action: { id: string; params?: Record<string, string>; block?: number },
    values?: string[],
): Promise<unknown> {
    const response = await gym.http.request("POST", `/v0/agents/${happy}/chat-actions`, {
        messageId: message.id,
        blockIndex: action.block ?? 0,
        action: { id: action.id, params: action.params ?? {} },
        ...(values === undefined ? {} : { values }),
    });
    expect(response.status, JSON.stringify(response.body)).toBe(202);
    return (response.body as { result: unknown }).result;
}

async function flowOf(gym: AgentGym): Promise<Flow> {
    return ((await gym.http.ok("GET", "/v0/onboarding/flow")) as { flow: Flow }).flow;
}

/** Start onboarding, use the Codex Happy found, and confirm the profile it showed. */
async function reachWork(gym: AgentGym, happy: string): Promise<Message> {
    const opening = await waitForText(gym, happy, "Hi, I'm Happy");
    await press(gym, happy, opening, { id: "onboarding.start" });
    const routes = await waitForText(gym, happy, "already reaches these");
    await press(gym, happy, routes, { id: "onboarding.routesUse" }, ["codex"]);
    const profile = await waitForText(gym, happy, "**Ada Lovelace** · ada@example.com");
    await gym.waitUntil(
        async () => ((await flowOf(gym)).step === "guided" ? true : undefined),
        "Codex to be verified",
    );
    await press(gym, happy, profile, { id: "onboarding.profileConfirm" });
    return await waitForText(gym, happy, "Want me to look at what you've been working on?");
}

describe("onboarding the person's work", () => {
    it(
        "proposes work from their Codex sessions, opens the chats they kept, then finishes",
        async () => {
            const { gym, happy, project } = await startGym({
                begin: say(PROFILE_STEP),
                profileSaved: say(WORK_STEP),
                workAccepted: say(NEW_STEP),
                newChatOpened: say(PHONE_STEP),
                phoneAnswered: say(
                    [
                        "You're ready, Ada.",
                        "",
                        "<menu>",
                        '  <button data-action="onboarding.workOpen" data-item="work-1" data-emphasis>Onboarding redesign</button>',
                        '  <button data-action="onboarding.finish">Stay here</button>',
                        "</menu>",
                    ].join("\n"),
                ),
            });
            const work = await reachWork(gym, happy);
            await press(gym, happy, work, { id: "onboarding.discover" });

            const proposal = await waitForText(gym, happy, PROPOSAL.intro);
            const shown = textOf(proposal);
            // The progress message became the proposal in place. Once the proposal is announced,
            // the progress words are never typed over it, even when the change landed before
            // their typing began.
            const proposalRun = (
                (await gym.http.ok("GET", `/v0/agents/${happy}/messages`)) as {
                    runs: { id: string; messages: Message[] }[];
                }
            ).runs.find((run) => run.messages.some((message) => message.id === proposal.id))?.id;
            await gym.waitForEvent(
                (event) =>
                    event.type === "run.finished" &&
                    (event.payload as { run: { id: string } }).run.id === proposalRun,
                "the proposal's run to be announced",
            );
            const announced = (await gym.events())
                .map(
                    (event) =>
                        event as unknown as { type: string; payload: Record<string, unknown> },
                )
                .filter(
                    (event) =>
                        (event.payload["message"] as { id?: string } | undefined)?.id ===
                            proposal.id || event.payload["messageId"] === proposal.id,
                );
            const shownAt = announced.findIndex(
                (event) =>
                    event.type !== "message.delta" &&
                    JSON.stringify(event.payload).includes(PROPOSAL.intro),
            );
            expect(shownAt).toBeGreaterThanOrEqual(0);
            expect(
                announced.slice(shownAt).filter((event) => event.type === "message.delta"),
            ).toEqual([]);
            expect(shown).toContain('<form data-action="onboarding.workAccept" data-table>');
            expect(shown).toContain('value="work-1" checked>Onboarding redesign');
            // An icon outside the library is drawn plain; the ongoing row says so.
            expect(shown).toContain('data-icon="wip"');
            expect(shown).toContain("data-ongoing");
            expect(shown).toContain(PROPOSAL.rows[0]!.firstMessage);
            // Focus read only what was disclosed: the session's project and what was asked.
            const asked = gym.inference.requests.find((request) =>
                request.sessionId.startsWith("focus-proposal:"),
            );
            const findings = JSON.stringify(asked?.messages);
            expect(findings).toContain(project);
            expect(findings).toContain(ASKED);
            expect(findings).not.toContain("environment_context");
            expect(asked?.providerId).toBe("codex");

            // Only the first row is kept.
            await press(gym, happy, proposal, { id: "onboarding.workAccept" }, ["work-1"]);
            await gym.waitUntil(async () => told(gym, "workAccepted"), "Looks right to finish");
            const accepted = told(gym, "workAccepted") as {
                started: { id: string; title: string; topic: string }[];
                failed: string[];
            };
            expect(accepted).toMatchObject({
                started: [{ id: "work-1", title: "Onboarding redesign", topic: "Product" }],
                failed: [],
            });
            expect(accepted).not.toHaveProperty("topicsError");

            // Its chat got the first message exactly as shown, to run read-only.
            const { spaces } = (await gym.http.ok("GET", "/v0/spaces")) as {
                spaces: { id: string; target: { kind: string; agentId?: string } }[];
            };
            const sidebar = (await gym.http.ok("GET", "/v0/spaces/sidebar")) as { html: string };
            expect(sidebar.html).toContain('label="Product"');
            expect(sidebar.html).not.toContain('label="Releases"');
            const opened = await gym.waitUntil(async () => {
                for (const space of spaces) {
                    const agentId = space.target.agentId;
                    if (agentId === undefined || agentId === happy) continue;
                    const found = (await messages(gym, agentId)).find(
                        (message) => textOf(message) === PROPOSAL.rows[0]!.firstMessage,
                    );
                    if (found !== undefined) return { agentId, spaceId: space.id, found };
                }
                return undefined;
            }, "the kept chat's first message");
            expect(opened.found.role).toBe("user");
            expect(opened.found.mode?.permissionMode).toBe("read_only");
            // Its row has the proposal's name and icon from the start and keeps them: it is never
            // a stem cell that names itself or grows an icon later.
            const rowOf = async () =>
                (
                    (await gym.http.ok("GET", "/v0/spaces")) as {
                        spaces: { id: string; title: string; icon: unknown }[];
                    }
                ).spaces.find((space) => space.id === opened.spaceId);
            expect(await rowOf()).toMatchObject({
                title: "Onboarding redesign",
                icon: { type: "library", slug: "wip" },
            });
            const published = (await gym.events())
                .map((event) => event as unknown as { type: string; payload: { space?: unknown } })
                .filter(
                    (event) =>
                        event.type.startsWith("space.") &&
                        (event.payload.space as { id?: string } | undefined)?.id === opened.spaceId,
                );
            expect(published.length).toBeGreaterThan(0);
            for (const event of published) {
                expect(event.payload.space).toMatchObject({
                    icon: { type: "library", slug: "wip" },
                });
            }
            const placedAt = sidebar.html.indexOf('label="Product"');
            expect(sidebar.html.indexOf(opened.spaceId)).toBeGreaterThan(placedAt);

            // Try New opens a fresh chat and names it.
            const newStep = await waitForText(gym, happy, "New opens a fresh chat.");
            const fresh = (await press(gym, happy, newStep, { id: "onboarding.newChat" })) as {
                agentId: string;
                spaceId: string;
            };
            expect(fresh.agentId).not.toBe(opened.agentId);
            const after = (await gym.http.ok("GET", "/v0/spaces")) as {
                spaces: { id: string }[];
            };
            expect(after.spaces.map((space) => space.id)).toContain(fresh.spaceId);
            expect(await messages(gym, fresh.agentId)).toEqual([]);

            const phone = await waitForText(gym, happy, "Want Happy on your phone too?");
            await press(gym, happy, phone, {
                id: "onboarding.phone",
                params: { choice: "later" },
                // The menu follows the app's download codes.
                block: 1,
            });
            await gym.waitUntil(async () => told(gym, "phoneAnswered"), "the phone answer");
            expect(told(gym, "phoneAnswered")).toMatchObject({
                choice: "later",
                name: "Ada Lovelace",
                started: [{ id: "work-1" }],
                placed: true,
            });

            const done = await waitForText(gym, happy, "You're ready, Ada.");
            const result = await press(gym, happy, done, {
                id: "onboarding.workOpen",
                params: { item: "work-1" },
            });
            expect(result).toEqual({ agentId: opened.agentId, spaceId: opened.spaceId });
            expect((await flowOf(gym)).step).toBe("finished");
            expect(gym.errors).toEqual([]);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "proposes what the person typed through Happy's tool, and finishes without starting anything",
        async () => {
            const { gym, happy } = await startGym({
                begin: say(PROFILE_STEP),
                profileSaved: say(WORK_STEP),
                workTellAsked: say("What are you working on right now?"),
                workAccepted: say(NEW_STEP),
                newChatSkipped: say(PHONE_STEP),
                phoneAnswered: say(
                    [
                        "You're ready, Ada.",
                        "",
                        "<menu>",
                        '  <button data-action="onboarding.finish" data-emphasis>Done</button>',
                        "</menu>",
                    ].join("\n"),
                ),
                "*": (request) => {
                    const last = JSON.stringify(request.messages.at(-1));
                    if (last.includes("Happy shows the proposal right below your reply")) {
                        return say("Here's how I'd start.")();
                    }
                    if (last.includes("I write release notes")) {
                        return {
                            content: [
                                {
                                    type: "tool_call",
                                    name: "propose_work",
                                    arguments: { about: "I write release notes for Happy." },
                                },
                            ],
                        };
                    }
                    return say("Done.")();
                },
            });
            const work = await reachWork(gym, happy);
            const tools = gym.inference.requests.find(
                (request) => eventIn(request) === "profileSaved",
            )?.tools;
            expect(tools?.map((tool) => tool.name)).toContain("propose_work");

            const workTell = await press(gym, happy, work, { id: "onboarding.workTell" });
            expect(workTell).toBeNull();
            await waitForText(gym, happy, "What are you working on right now?");
            // Happy's scripted messages may still be typing out; the send never waits on them.
            const sentAt = Date.now();
            await gym.send("I write release notes every week.", {
                wait: false,
                sessionId: happy,
                providerId: "codex",
                modelId: "gym-codex",
                effort: "medium",
            });
            expect(Date.now() - sentAt).toBeLessThan(5_000);
            await waitForText(gym, happy, "Here's how I'd start.");
            const proposal = await waitForText(gym, happy, PROPOSAL.intro);
            const asked = gym.inference.requests.find((request) =>
                request.sessionId.startsWith("focus-proposal:"),
            );
            expect(JSON.stringify(asked?.messages)).toContain("I write release notes for Happy.");
            // The proposal follows Happy's reply.
            const order = (await messages(gym, happy)).map((message) => message.id);
            const reply = await waitForText(gym, happy, "Here's how I'd start.");
            expect(order.indexOf(proposal.id)).toBeGreaterThan(order.indexOf(reply.id));

            // Nothing ticked starts nothing and moves on to New.
            const spacesBefore = (await gym.http.ok("GET", "/v0/spaces")) as {
                spaces: unknown[];
            };
            await press(gym, happy, proposal, { id: "onboarding.workAccept" }, []);
            const newStep = await waitForText(gym, happy, "New opens a fresh chat.");
            expect(told(gym, "workAccepted")).toEqual({
                kind: "workAccepted",
                started: [],
                failed: [],
            });
            const spacesAfter = (await gym.http.ok("GET", "/v0/spaces")) as {
                spaces: unknown[];
            };
            expect(spacesAfter.spaces).toHaveLength(spacesBefore.spaces.length);

            // Skipping New and the phone, then Done, finishes.
            await press(gym, happy, newStep, { id: "onboarding.newChatSkip" });
            const phone = await waitForText(gym, happy, "Want Happy on your phone too?");
            await press(gym, happy, phone, {
                id: "onboarding.phone",
                params: { choice: "later" },
                // The menu follows the app's download codes.
                block: 1,
            });
            const done = await waitForText(gym, happy, "You're ready, Ada.");
            expect(told(gym, "phoneAnswered")).toMatchObject({ started: [], placed: false });
            expect((await flowOf(gym)).step).toBe("guided");
            expect(await press(gym, happy, done, { id: "onboarding.finish" })).toBeNull();
            const flow = await flowOf(gym);
            expect(flow).toMatchObject({ step: "finished", completedVersion: 1 });
            // A finished onboarding answers no more of its actions.
            const late = await gym.http.request("POST", `/v0/agents/${happy}/chat-actions`, {
                messageId: done.id,
                blockIndex: 0,
                action: { id: "onboarding.finish", params: {} },
            });
            expect(late.status).toBe(409);
            expect(gym.errors).toEqual([]);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "opens a phone pairing, and tells Happy when the phone pairs through it",
        async () => {
            const { gym, happy } = await startGym(
                {
                    begin: say(PROFILE_STEP),
                    profileSaved: say(WORK_STEP),
                    workTellAsked: say(NEW_STEP),
                    newChatSkipped: say(PHONE_STEP),
                    phoneAnswered: say(
                        "Open Happy on your phone and scan this code.\n\n<figure data-phone-pair></figure>",
                    ),
                    phonePaired: say(
                        [
                            "Your phone is connected. You're ready, Ada.",
                            "",
                            "<menu>",
                            '  <button data-action="onboarding.finish" data-emphasis>Done</button>',
                            "</menu>",
                        ].join("\n"),
                    ),
                },
                { phone: "on" },
            );
            const work = await reachWork(gym, happy);
            // Straight to New, as a person who would rather not say yet.
            await press(gym, happy, work, { id: "onboarding.workTell" });
            const newStep = await waitForText(gym, happy, "New opens a fresh chat.");
            await press(gym, happy, newStep, { id: "onboarding.newChatSkip" });
            const phone = await waitForText(gym, happy, "Want Happy on your phone too?");
            await press(gym, happy, phone, {
                id: "onboarding.phone",
                params: { choice: "opened" },
                block: 1,
            });
            await waitForText(gym, happy, "<figure data-phone-pair></figure>");
            expect(told(gym, "phoneAnswered")).toMatchObject({ choice: "opened" });

            // The pairing onboarding opened is the computer's ordinary one.
            const { mobileConnector } = (await gym.http.ok("GET", "/v0/mobile-connector")) as {
                mobileConnector: { pairing: { id: string; status: string; qr: string | null } };
            };
            expect(mobileConnector.pairing.status).toBe("waiting");
            const session = await startPhonePairing(
                mobileConnector.pairing.qr!,
                httpPhoneTransport(`http://127.0.0.1:${String(PHONE_PORT)}`),
            );
            const confirming = session.confirm();
            await gym.waitUntil(async () => {
                const current = (await gym.http.ok("GET", "/v0/mobile-connector")) as {
                    mobileConnector: { pairing: { mobileConfirmed: boolean } };
                };
                return current.mobileConnector.pairing.mobileConfirmed ? true : undefined;
            }, "the phone to confirm the emoji");
            await gym.http.ok("POST", "/v0/mobile-connector/pairing/confirm", {
                pairingId: mobileConnector.pairing.id,
            });
            await confirming;

            const done = await waitForText(gym, happy, "Your phone is connected.");
            expect(told(gym, "phonePaired")).toMatchObject({
                name: "Ada Lovelace",
                started: [],
                placed: false,
            });
            await press(gym, happy, done, { id: "onboarding.finish" });
            expect((await flowOf(gym)).step).toBe("finished");
            expect(gym.errors).toEqual([]);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "says why the phone could not pair when phone connections are off, and moves on",
        async () => {
            const { gym, happy } = await startGym(
                {
                    begin: say(PROFILE_STEP),
                    profileSaved: say(WORK_STEP),
                    workTellAsked: say(NEW_STEP),
                    newChatSkipped: say(PHONE_STEP),
                    phoneAnswered: say(
                        [
                            "You're ready, Ada.",
                            "",
                            "<menu>",
                            '  <button data-action="onboarding.finish" data-emphasis>Done</button>',
                            "</menu>",
                        ].join("\n"),
                    ),
                },
                { phone: "off" },
            );
            const work = await reachWork(gym, happy);
            await press(gym, happy, work, { id: "onboarding.workTell" });
            const newStep = await waitForText(gym, happy, "New opens a fresh chat.");
            await press(gym, happy, newStep, { id: "onboarding.newChatSkip" });
            const phone = await waitForText(gym, happy, "Want Happy on your phone too?");
            await press(gym, happy, phone, {
                id: "onboarding.phone",
                params: { choice: "opened" },
                block: 1,
            });

            // Happy says what stopped it, then the model hears the step ended as Later.
            const failed = await waitForText(gym, happy, "I couldn't open a phone pairing");
            expect(textOf(failed)).toContain("turned off on this computer");
            await waitForText(gym, happy, "You're ready, Ada.");
            expect(told(gym, "phoneAnswered")).toMatchObject({ choice: "later" });
            const { mobileConnector } = (await gym.http.ok("GET", "/v0/mobile-connector")) as {
                mobileConnector: { status: string; pairing: unknown };
            };
            expect(mobileConnector).toMatchObject({ status: "disabled", pairing: null });
            expect(gym.errors).toEqual([]);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "proposes again after Adjust, from the findings and the change, and only the new proposal starts",
        async () => {
            const revised = {
                intro: "Here's the revised list.",
                rows: [
                    {
                        title: "Onboarding copy",
                        icon: "wip",
                        topic: "Product",
                        why: "You asked to split the redesign",
                        firstMessage: "Plan: review the onboarding copy and wait for me.",
                    },
                ],
            };
            const { gym, happy, project } = await startGym(
                {
                    begin: say(PROFILE_STEP),
                    profileSaved: say(WORK_STEP),
                    workChangeAsked: say("What should I change?"),
                    workAccepted: say(NEW_STEP),
                    "*": (request) => {
                        const last = JSON.stringify(request.messages.at(-1));
                        if (last.includes("Happy shows the proposal right below your reply")) {
                            return say("Here's the new version.")();
                        }
                        if (last.includes("Only the copy")) {
                            return {
                                content: [
                                    {
                                        type: "tool_call",
                                        name: "propose_work",
                                        arguments: {
                                            about: "Keep only the onboarding work, as its copy review.",
                                        },
                                    },
                                ],
                            };
                        }
                        return say("Done.")();
                    },
                },
                { proposals: [PROPOSAL, revised] },
            );
            const work = await reachWork(gym, happy);
            await press(gym, happy, work, { id: "onboarding.discover" });
            const first = await waitForText(gym, happy, PROPOSAL.intro);

            // Adjust is the form's other button; the model hears the proposal that was shown.
            await press(gym, happy, first, { id: "onboarding.workChange" });
            await waitForText(gym, happy, "What should I change?");
            expect(told(gym, "workChangeAsked")).toEqual({
                kind: "workChangeAsked",
                proposal: PROPOSAL.rows.map((row) => ({
                    title: row.title,
                    topic: row.topic,
                    ongoing: row.ongoing === true,
                    firstMessage: row.firstMessage,
                })),
            });
            await gym.send("Only the copy, please.", {
                wait: false,
                sessionId: happy,
                providerId: "codex",
                modelId: "gym-codex",
                effort: "medium",
            });
            const second = await waitForText(gym, happy, revised.intro);
            expect(textOf(second)).toContain('value="work-1" checked>Onboarding copy');
            expect(textOf(second)).not.toContain("Release check-in");
            // The second proposal starts from what discovery found, plus the change.
            const asked = gym.inference.requests.filter((request) =>
                request.sessionId.startsWith("focus-proposal:"),
            );
            expect(asked).toHaveLength(2);
            const findings = JSON.stringify(asked[1]?.messages);
            expect(findings).toContain("Keep only the onboarding work, as its copy review.");
            expect(findings).toContain(project);

            // The first proposal's form is spent; only the new one starts its chat.
            const stale = await gym.http.request("POST", `/v0/agents/${happy}/chat-actions`, {
                messageId: first.id,
                blockIndex: 0,
                action: { id: "onboarding.workAccept", params: {} },
                values: ["work-1"],
            });
            expect(stale.status).toBe(409);
            await press(gym, happy, second, { id: "onboarding.workAccept" }, ["work-1"]);
            await gym.waitUntil(async () => told(gym, "workAccepted"), "Looks right to finish");
            expect(told(gym, "workAccepted")).toMatchObject({
                started: [{ id: "work-1", title: "Onboarding copy", topic: "Product" }],
                failed: [],
            });
            expect(gym.errors).toEqual([]);
        },
        TEST_TIMEOUT_MS,
    );
});
