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
 * The rest of onboarding once the profile is saved, led by Happy's own model: discovering the
 * person's work from their Codex sessions and Focus's proposal through Happy's tools, Looks right
 * opening the chats, Create, the phone, and finishing. Codex is a stand-in signed in by a fake auth
 * file in a throwaway home, its sessions are written by the test, and every model answer is the
 * gym's; nothing leaves this machine.
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
    "Your chats are making a plan. Create opens a fresh chat.",
    "",
    "<menu>",
    '  <button data-action="onboarding.newChat" data-emphasis>Try Create</button>',
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
    content: { type: string; text?: string; name?: string }[];
    mode?: { permissionMode?: string } | null;
    actionChoices?: Record<string, unknown>;
}

interface Accepted {
    value: string;
    spaceId: string;
    agentId: string;
    status: string;
}

type Answers = Record<string, (request: GymInferenceRequest) => GymTurn>;

/**
 * What a request answers: the label of the person's press, as `pressed:Label`, or the kind of the
 * hidden event its newest message carries.
 */
function eventIn(request: GymInferenceRequest): string | undefined {
    const pressed = /\[Pressed \\"([^"\\]+)\\"/u.exec(
        JSON.stringify(request.messages.at(-1) ?? {}),
    );
    if (pressed !== null) return `pressed:${pressed[1]!}`;
    const text = JSON.stringify(request.messages.at(-1) ?? {});
    return /\\"kind\\":\\"(\w+)\\"/u.exec(text)?.[1];
}

/** The hidden event of that kind the app told Happy's model, parsed. */
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

/** What Happy's model read for the person's press of `label`: the press, then its outcome. */
function pressRead(gym: AgentGym, label: string): string | undefined {
    for (const request of gym.inference.requests) {
        for (const message of request.messages) {
            if (message.role !== "user") continue;
            const text = message.content
                .map((block) => (block.type === "text" ? block.text : ""))
                .join("");
            if (text.startsWith(`[Pressed "${label}"`)) return text;
        }
    }
    return undefined;
}

function say(text: string): () => GymTurn {
    return () => ({ content: [{ text, type: "text" }] });
}

function call(name: string, args: object = {}): GymTurn {
    return { content: [{ type: "tool_call", name, arguments: args }] };
}

/** The text of the tool result a request answers, when its newest message is one. */
function toolResultIn(request: GymInferenceRequest): string | undefined {
    const last = request.messages.at(-1);
    if (last?.role !== "tool") return undefined;
    return last.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

/**
 * Happy's model following the guide through its tools: Discover reads with discover_work, what
 * was found goes to propose_work, and the proposal is shown after Focus's introduction exactly as
 * the tool returned it.
 */
function followsTools(request: GymInferenceRequest): GymTurn | undefined {
    if (eventIn(request) === "pressed:Discover what I've been working on") {
        return call("discover_work");
    }
    const result = toolResultIn(request);
    if (result === undefined) return undefined;
    if (result.startsWith("What the person has been working on")) return call("propose_work");
    const form = result.indexOf("<form");
    if (form === -1) return say(`Sorry: ${result}`)();
    const intro = /own words: (.*)/u.exec(result)?.[1] ?? "Here's a proposal.";
    return say(`${intro}\n\n${result.slice(form)}`)();
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
            const led = followsTools(request);
            if (led !== undefined) return led;
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
    const response = await sendPress(gym, happy, message, action, values);
    expect(response.status, JSON.stringify(response.body)).toBe(202);
    return (response.body as { message: { content: { result: unknown }[] } }).message.content[0]!
        .result;
}

/** The person's press, sent as their own action message. */
async function sendPress(
    gym: AgentGym,
    happy: string,
    message: Message,
    action: { id: string; params?: Record<string, string>; block?: number },
    values?: string[],
) {
    return await gym.http.request("POST", `/v0/agents/${happy}/send`, {
        content: [
            {
                type: "action",
                messageId: message.id,
                blockIndex: action.block ?? 0,
                actionId: action.id,
                params: action.params ?? {},
                ...(values === undefined ? {} : { values }),
            },
        ],
    });
}

async function flowOf(gym: AgentGym): Promise<Flow & { accepted?: Accepted[] }> {
    return (
        (await gym.http.ok("GET", "/v0/onboarding/flow")) as {
            flow: Flow & { accepted?: Accepted[] };
        }
    ).flow;
}

/** The app's own Create, as Try Create runs it: a new chat under an ID the app chose. */
async function create(gym: AgentGym, id: string): Promise<void> {
    await gym.http.ok("POST", "/v0/spaces/stem-cells", { id });
}

/** Start onboarding, use the Codex Happy found, and confirm the profile it showed. */
async function reachWork(gym: AgentGym, happy: string): Promise<Message> {
    const opening = await waitForText(gym, happy, "Hi, I'm Happy");
    await press(gym, happy, opening, { id: "onboarding.start" });
    // The empty default headings went with the example, before anything was placed.
    const sidebar = (await gym.http.ok("GET", "/v0/spaces/sidebar")) as { html: string };
    expect(sidebar.html).not.toContain('label="Bots"');
    expect(sidebar.html).not.toContain('label="Tasks"');
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
        "proposes work from their Codex sessions through Happy's tools, opens the chats they kept, then finishes",
        async () => {
            const { gym, happy, project } = await startGym({
                begin: say(PROFILE_STEP),
                "pressed:That's me": say(WORK_STEP),
                "pressed:Looks right": say(NEW_STEP),
                "pressed:Try Create": say(PHONE_STEP),
                "pressed:Later": say(
                    [
                        "You're ready, Ada.",
                        "",
                        "<menu>",
                        '  <button data-action="onboarding.workOpen" data-item="p1-work-1" data-emphasis>Onboarding redesign</button>',
                        '  <button data-action="onboarding.finish">Stay here</button>',
                        "</menu>",
                    ].join("\n"),
                ),
            });
            const work = await reachWork(gym, happy);
            await press(gym, happy, work, { id: "onboarding.discover" });

            // Happy's model wrote the proposal with what its tools returned, below the last step.
            const proposal = await waitForText(gym, happy, PROPOSAL.intro);
            const shown = textOf(proposal);
            expect(shown).toContain('<form data-action="onboarding.workAccept" data-table>');
            expect(shown).toContain('value="p1-work-1" checked>Onboarding redesign');
            expect(shown).toContain('data-empty-label="Continue without these"');
            // An icon outside the library is drawn plain; the ongoing row says so.
            expect(shown).toContain('data-icon="wip"');
            expect(shown).toContain("data-ongoing");
            expect(shown).toContain(PROPOSAL.rows[0]!.firstMessage);
            const order = (await messages(gym, happy)).map((message) => message.id);
            expect(order.indexOf(proposal.id)).toBeGreaterThan(order.indexOf(work.id));
            // Focus read only what was disclosed: the session's project and what was asked.
            const asked = gym.inference.requests.find((request) =>
                request.sessionId.startsWith("focus-proposal:"),
            );
            const findings = JSON.stringify(asked?.messages);
            expect(findings).toContain(project);
            expect(findings).toContain(ASKED);
            expect(findings).not.toContain("environment_context");
            expect(asked?.providerId).toBe("codex");

            // Only the first row is kept. The press fixes its chat's IDs before anything exists.
            const result = (await press(gym, happy, proposal, { id: "onboarding.workAccept" }, [
                "p1-work-1",
            ])) as { started: { value: string; spaceId: string; agentId: string }[] };
            expect(result.started).toHaveLength(1);
            const kept = result.started[0]!;
            expect(kept.value).toBe("p1-work-1");
            expect((await flowOf(gym)).accepted).toEqual([{ ...kept, status: "started" }]);
            // Happy's model read the press as the person's turn, with what it started.
            const accepted = await gym.waitUntil(
                async () => pressRead(gym, "Looks right"),
                "Happy's model to read Looks right",
            );
            expect(accepted).toBe(
                [
                    '[Pressed "Looks right" with "Onboarding redesign" ticked in your message]',
                    "",
                    "Started 1 chat, each making a read-only plan and waiting for them before it changes anything:",
                    "- Onboarding redesign, under Product",
                    "Each is placed under its topic in the sidebar.",
                ].join("\n"),
            );
            // The press is the person's own message, with no hidden event beside it.
            const pressedMessage = (await messages(gym, happy)).find(
                (message) =>
                    message.role === "user" &&
                    JSON.stringify(message.content).includes('"onboarding.workAccept"'),
            );
            expect(pressedMessage?.content[0]).toMatchObject({
                type: "action",
                messageId: proposal.id,
                actionId: "onboarding.workAccept",
                label: "Looks right",
                values: ["p1-work-1"],
            });
            expect(
                gym.inference.requests.some((request) =>
                    JSON.stringify(request.messages.at(-1)).includes("workAccepted"),
                ),
            ).toBe(false);

            // Its topic is a new section at the end of the sidebar, with its row under it.
            const sidebar = (await gym.http.ok("GET", "/v0/spaces/sidebar")) as { html: string };
            const placedAt = sidebar.html.indexOf('label="Product"');
            expect(placedAt).toBeGreaterThan(sidebar.html.indexOf(happy));
            expect(sidebar.html).not.toContain('label="Releases"');
            expect(sidebar.html.indexOf(kept.spaceId)).toBeGreaterThan(placedAt);

            // Its chat got the first message exactly as shown, to run read-only.
            const first = await gym.waitUntil(
                async () =>
                    (await messages(gym, kept.agentId)).find(
                        (message) => textOf(message) === PROPOSAL.rows[0]!.firstMessage,
                    ),
                "the kept chat's first message",
            );
            expect(first.role).toBe("user");
            expect(first.mode?.permissionMode).toBe("read_only");
            // Its row has the proposal's name and icon from the start and keeps them: it is never
            // a stem cell that names itself or grows an icon later.
            const { spaces } = (await gym.http.ok("GET", "/v0/spaces")) as {
                spaces: { id: string; title: string; icon: unknown }[];
            };
            expect(spaces.find((space) => space.id === kept.spaceId)).toMatchObject({
                title: "Onboarding redesign",
                icon: { type: "library", slug: "wip" },
            });
            const published = (await gym.events())
                .map((event) => event as unknown as { type: string; payload: { space?: unknown } })
                .filter(
                    (event) =>
                        event.type.startsWith("space.") &&
                        (event.payload.space as { id?: string } | undefined)?.id === kept.spaceId,
                );
            expect(published.length).toBeGreaterThan(0);
            for (const event of published) {
                expect(event.payload.space).toMatchObject({
                    icon: { type: "library", slug: "wip" },
                });
            }

            // Try Create is the app's own Create; the press names the chat it made.
            const newStep = await waitForText(gym, happy, "Create opens a fresh chat.");
            const fresh = "s3k8m2q9w1e5r7y3u6i0o2p9";
            await create(gym, fresh);
            expect(
                await press(gym, happy, newStep, { id: "onboarding.newChat" }, [fresh]),
            ).toBeNull();

            const phone = await waitForText(gym, happy, "Want Happy on your phone too?");
            await press(gym, happy, phone, {
                id: "onboarding.phone",
                params: { choice: "later" },
                // The menu follows the app's download codes.
                block: 1,
            });
            const later = await gym.waitUntil(
                async () => pressRead(gym, "Later"),
                "Happy's model to read Later",
            );
            expect(later).toContain("Later, for the phone.");
            expect(later).toContain("Their name: Ada Lovelace.");
            expect(later).toContain("- p1-work-1: Onboarding redesign (Product)");

            const done = await waitForText(gym, happy, "You're ready, Ada.");
            const opened = await press(gym, happy, done, {
                id: "onboarding.workOpen",
                params: { item: "p1-work-1" },
            });
            expect(opened).toEqual({ agentId: kept.agentId, spaceId: kept.spaceId });
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
                "pressed:That's me": say(WORK_STEP),
                "pressed:I'll tell you instead": say("What are you working on right now?"),
                "pressed:Continue without these": say(NEW_STEP),
                "pressed:Maybe later": say(PHONE_STEP),
                "pressed:Later": say(
                    [
                        "You're ready, Ada.",
                        "",
                        "<menu>",
                        '  <button data-action="onboarding.finish" data-emphasis>Done</button>',
                        "</menu>",
                    ].join("\n"),
                ),
                "*": (request) =>
                    JSON.stringify(request.messages.at(-1)).includes("I write release notes")
                        ? call("propose_work", { about: "I write release notes for Happy." })
                        : say("Done.")(),
            });
            const work = await reachWork(gym, happy);
            const tools = gym.inference.requests.find(
                (request) => eventIn(request) === "pressed:That's me",
            )?.tools;
            expect(tools?.map((tool) => tool.name)).toEqual(
                expect.arrayContaining([
                    "save_profile",
                    "discover_work",
                    "propose_work",
                    "set_default_model",
                ]),
            );

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
            const proposal = await waitForText(gym, happy, PROPOSAL.intro);
            const asked = gym.inference.requests.find((request) =>
                request.sessionId.startsWith("focus-proposal:"),
            );
            expect(JSON.stringify(asked?.messages)).toContain("I write release notes for Happy.");

            // Nothing ticked starts nothing and moves on to Create.
            const spacesBefore = (await gym.http.ok("GET", "/v0/spaces")) as {
                spaces: unknown[];
            };
            expect(await press(gym, happy, proposal, { id: "onboarding.workAccept" }, [])).toEqual({
                started: [],
            });
            const newStep = await waitForText(gym, happy, "Create opens a fresh chat.");
            expect(pressRead(gym, "Continue without these")).toBe(
                '[Pressed "Continue without these" with nothing ticked in your message]\n\nNothing was ticked, so nothing started.',
            );
            const spacesAfter = (await gym.http.ok("GET", "/v0/spaces")) as {
                spaces: unknown[];
            };
            expect(spacesAfter.spaces).toHaveLength(spacesBefore.spaces.length);

            // Skipping Create and the phone, then Done, finishes.
            await press(gym, happy, newStep, { id: "onboarding.newChatSkip" });
            const phone = await waitForText(gym, happy, "Want Happy on your phone too?");
            await press(gym, happy, phone, {
                id: "onboarding.phone",
                params: { choice: "later" },
                // The menu follows the app's download codes.
                block: 1,
            });
            const done = await waitForText(gym, happy, "You're ready, Ada.");
            expect(pressRead(gym, "Later")).toContain("Onboarding started no chats.");
            expect((await flowOf(gym)).step).toBe("guided");
            expect(await press(gym, happy, done, { id: "onboarding.finish" })).toBeNull();
            const flow = await flowOf(gym);
            expect(flow).toMatchObject({ step: "finished", completedVersion: 1 });
            // A finished onboarding answers no more of its actions.
            const late = await sendPress(gym, happy, done, { id: "onboarding.finish" });
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
                    "pressed:That's me": say(WORK_STEP),
                    "pressed:I'll tell you instead": say(NEW_STEP),
                    "pressed:Maybe later": say(PHONE_STEP),
                    "pressed:I have the app": say(
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
            // Straight to Create, as a person who would rather not say yet.
            await press(gym, happy, work, { id: "onboarding.workTell" });
            const newStep = await waitForText(gym, happy, "Create opens a fresh chat.");
            await press(gym, happy, newStep, { id: "onboarding.newChatSkip" });
            const phone = await waitForText(gym, happy, "Want Happy on your phone too?");
            await press(gym, happy, phone, {
                id: "onboarding.phone",
                params: { choice: "opened" },
                block: 1,
            });
            await waitForText(gym, happy, "<figure data-phone-pair></figure>");
            expect(pressRead(gym, "I have the app")).toContain(
                "This computer's pairing code is open",
            );

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
        "tells Happy why the phone could not pair when phone connections are off, and moves on",
        async () => {
            const { gym, happy } = await startGym(
                {
                    begin: say(PROFILE_STEP),
                    "pressed:That's me": say(WORK_STEP),
                    "pressed:I'll tell you instead": say(NEW_STEP),
                    "pressed:Maybe later": say(PHONE_STEP),
                    "pressed:I have the app": say(
                        [
                            "The phone couldn't pair. You're ready, Ada.",
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
            const newStep = await waitForText(gym, happy, "Create opens a fresh chat.");
            await press(gym, happy, newStep, { id: "onboarding.newChatSkip" });
            const phone = await waitForText(gym, happy, "Want Happy on your phone too?");
            await press(gym, happy, phone, {
                id: "onboarding.phone",
                params: { choice: "opened" },
                block: 1,
            });

            // Happy's model hears what stopped it, and that the step ended as Later.
            await waitForText(gym, happy, "You're ready, Ada.");
            const answered = pressRead(gym, "I have the app");
            expect(answered).toContain("the phone pairing couldn't open");
            expect(answered).toContain("turned off on this computer");
            expect(answered).toContain("Treat it as Later.");
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
                    "pressed:That's me": say(WORK_STEP),
                    "pressed:Adjust": say("What should I change?"),
                    "pressed:Looks right": say(NEW_STEP),
                    "*": (request) =>
                        JSON.stringify(request.messages.at(-1)).includes("Only the copy")
                            ? call("propose_work", {
                                  about: "Keep only the onboarding work, as its copy review.",
                              })
                            : say("Done.")(),
                },
                { proposals: [PROPOSAL, revised] },
            );
            const work = await reachWork(gym, happy);
            await press(gym, happy, work, { id: "onboarding.discover" });
            const first = await waitForText(gym, happy, PROPOSAL.intro);

            // Adjust is the form's other button; the model hears the proposal that was shown.
            await press(gym, happy, first, { id: "onboarding.workChange" });
            await waitForText(gym, happy, "What should I change?");
            expect(pressRead(gym, "Adjust")).toBe(
                [
                    '[Pressed "Adjust" in your message]',
                    "",
                    "They want to change this proposal:",
                    ...PROPOSAL.rows.map(
                        (row) =>
                            `- ${row.title} (topic ${row.topic}${row.ongoing === true ? ", ongoing" : ""}); first message: ${row.firstMessage}`,
                    ),
                ].join("\n"),
            );
            await gym.send("Only the copy, please.", {
                wait: false,
                sessionId: happy,
                providerId: "codex",
                modelId: "gym-codex",
                effort: "medium",
            });
            const second = await waitForText(gym, happy, revised.intro);
            expect(textOf(second)).toContain('value="p2-work-1" checked>Onboarding copy');
            expect(textOf(second)).not.toContain("Release check-in");
            // The second proposal starts from what discovery found, plus the change.
            const asked = gym.inference.requests.filter((request) =>
                request.sessionId.startsWith("focus-proposal:"),
            );
            expect(asked).toHaveLength(2);
            const findings = JSON.stringify(asked[1]?.messages);
            expect(findings).toContain("Keep only the onboarding work, as its copy review.");
            expect(findings).toContain(project);

            // The first proposal is replaced; only the new one starts its chat.
            const stale = await sendPress(gym, happy, first, { id: "onboarding.workAccept" }, [
                "p1-work-1",
            ]);
            expect(stale.status).toBe(409);
            await press(gym, happy, second, { id: "onboarding.workAccept" }, ["p2-work-1"]);
            const accepted = await gym.waitUntil(
                async () => pressRead(gym, "Looks right"),
                "Happy's model to read Looks right",
            );
            expect(accepted).toContain("- Onboarding copy, under Product");
            expect(accepted).not.toContain("Onboarding redesign");
            expect(gym.errors).toEqual([]);
        },
        TEST_TIMEOUT_MS,
    );
});
