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
    parseQr,
    startPhonePairing,
} from "../../happy-agent-modules/tests/mobileConnector/support/fakePhone.js";

/**
 * The rest of onboarding once the profile is saved, led by Happy's own model: Discover starting
 * Focus, Happy handing it the person's work with an ordinary agent message, Focus reading their
 * Codex sessions and proposing new chats, Good to go starting them, Create, the phone, and
 * finishing. Codex is a stand-in signed in by a fake auth file in a throwaway home, its sessions
 * are written by the test, and every model answer is the gym's; nothing leaves this machine.
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
const PLACEHOLDER = "Or just tell me in your own words…";

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
    "Your chats are drafting a plan. Press Create whenever you want to start something new.",
    "",
    "<menu>",
    '  <button data-action="onboarding.newChat" data-emphasis>Try Create</button>',
    '  <button data-action="onboarding.newChatSkip">Continue</button>',
    "</menu>",
].join("\n");

const PHONE_STEP = [
    "Want to follow your agents from your phone?",
    "",
    "<figure data-phone-app></figure>",
    "",
    "<menu>",
    '  <button data-action="onboarding.phone" data-choice="opened" data-emphasis>I\'ve downloaded and opened Happy</button>',
    '  <button data-action="onboarding.phone" data-choice="later">Later</button>',
    "</menu>",
].join("\n");

const INTRO = "Here's how Focus would organize it, most important first.";
const HANDING =
    "I'm handing this to Focus, my sub-agent that keeps your work organized and helps you stay on track. You'll rarely need to talk to Focus directly, and you can always ask me instead.";
const TASK = "Organize Ada's work from the places above, most important first.";

/** Happy's message for Focus's open proposal: the card, then Good to go. */
function showProposal(proposal: string): string {
    return [
        `${INTRO} Good to go places these in your sidebar and starts each chat on a read-only plan. To change anything, just tell me.`,
        "",
        `<figure data-sidebar-proposal="${proposal}"></figure>`,
        "",
        "<menu>",
        `  <button data-action="sidebar.proposalAccept" data-proposal="${proposal}" data-emphasis>Good to go</button>`,
        "</menu>",
    ].join("\n");
}

const REDESIGN = {
    id: "new-onboarding-redesign",
    title: "Onboarding redesign",
    icon: "wip",
    why: "Asked in Codex this week",
    firstMessage:
        "Plan: ship the onboarding redesign. List what's left and wait for me before changing anything.",
};

const line = (id: string) => `  <happy-space id="${id}"/>\n`;
const section = (id: string, label: string) => `  <happy-section id="${id}" label="${label}"/>\n`;

interface SidebarView {
    version: number;
    html: string;
    proposal: { artifactId: string; version: number; html: string } | null;
}

/** What Focus proposes for Happy's request, from what list_sidebar showed it. */
type Propose = (asked: string, view: SidebarView) => object;

/** A first proposal: one new chat under a new Product section at the end of the sidebar. */
const proposeRedesign: Propose = (_asked, view) => ({
    baseVersion: view.version,
    edits: [
        {
            oldText: "</nav>",
            newText: `${section("product", "Product")}${line(REDESIGN.id)}</nav>`,
        },
    ],
    newRows: [REDESIGN],
});

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
    content: {
        type: string;
        text?: string;
        name?: string;
        label?: string;
        ticked?: string[];
    }[];
    mode?: { permissionMode?: string } | null;
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

/** What a model read for the person's press of `label`: the press, then its outcome. */
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

let calls = 0;
function call(name: string, args: object, callId: string): GymTurn {
    calls += 1;
    return {
        content: [
            { type: "tool_call", name, arguments: args, callId: `${callId}-${String(calls)}` },
        ],
    };
}

function resultText(request: GymInferenceRequest): string {
    const last = request.messages.at(-1);
    if (last?.role !== "tool") return "";
    return last.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

/** The newest message another agent sent this conversation, as its model read it. */
function lastAgentMessage(request: GymInferenceRequest): string {
    for (const message of [...request.messages].reverse()) {
        const text = JSON.stringify(message);
        if (message.role !== "tool" && (text.includes("Message from agent") || text.includes(TASK)))
            return text;
    }
    return "";
}

/**
 * Focus as its prompt asks: on Happy's message it reads what it may, reads the sidebar, proposes,
 * and answers in one sentence with Good to go. Anything else it was woken for is quiet.
 */
function focusTurn(request: GymInferenceRequest, propose: Propose): GymTurn {
    const last = request.messages.at(-1);
    if (last?.role === "tool") {
        const text = resultText(request);
        if (last.callId.startsWith("focus-discover")) return call("list_sidebar", {}, "focus-list");
        if (last.callId.startsWith("focus-list")) {
            const view = JSON.parse(text) as SidebarView;
            return call(
                "propose_sidebar",
                propose(lastAgentMessage(request), view),
                "focus-propose",
            );
        }
        if (last.callId.startsWith("focus-propose")) {
            const proposal = /^Proposal ([a-z0-9]+) /u.exec(text)?.[1];
            if (proposal === undefined) return say(`Sorry: ${text}`)();
            return say(
                [
                    "I'd start with the onboarding work.",
                    "",
                    "<menu>",
                    `  <button data-action="sidebar.proposalAccept" data-proposal="${proposal}" data-emphasis>Good to go</button>`,
                    "</menu>",
                ].join("\n"),
            )();
        }
        return say("Ready.")();
    }
    const asked = JSON.stringify(last ?? {});
    if (asked.includes("Message from agent") || asked.includes(TASK)) {
        return request.tools.some((tool) => tool.name === "discover_work")
            ? call("discover_work", {}, "focus-discover")
            : call("list_sidebar", {}, "focus-list");
    }
    return say("Ready.")();
}

/** Focus's agent ID, from the press outcome that started it. */
function focusIdIn(request: GymInferenceRequest): string | undefined {
    return /Focus's agent ID is ([a-z0-9]{24})/u.exec(JSON.stringify(request.messages))?.[1];
}

/**
 * Happy's model following the guide: Discover hands Focus the work, and the proposal Focus names
 * is shown as its card with Good to go.
 */
function happyLeads(request: GymInferenceRequest): GymTurn | undefined {
    const last = request.messages.at(-1);
    if (last?.role === "tool" && last.callId.startsWith("happy-send")) return { content: [] };
    const proposal = /Focus finished\. Its open proposal is ([a-z0-9]+)\./u.exec(
        JSON.stringify(last ?? {}),
    )?.[1];
    if (proposal !== undefined) return say(showProposal(proposal))();
    if (eventIn(request) === "pressed:Discover what I've been working on") return say(HANDING)();
    return undefined;
}

/** Happy hands what the person typed to Focus. */
function relay(request: GymInferenceRequest, words: string): GymTurn {
    return call(
        "send_agent_message",
        { toAgentId: focusIdIn(request), explanation: "Organize Ada's work", text: words },
        "happy-send",
    );
}

/** The phone connector's configured port, which only names it in the QR code. */
const PHONE_PORT = 24_879;
/** Where the fake Tailcat accepts the phone's connections, standing in for the tailnet. */
const TAILNET_PORT = 24_880;

/**
 * Only the Tailcat binary is fake. Like `serve exec -- <command>`, it runs the command for each
 * connection with the connection as its stdin and stdout, and publishes an address once it
 * accepts them. The command and everything behind it are the daemon's own.
 */
async function fakeTailcat(root: string): Promise<void> {
    const executable = join(root, "tailcat");
    await writeFile(
        executable,
        `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createServer } from "node:net";
const args = process.argv.slice(2);
if (args[0] === "genkey") {
    writeFileSync(args.find((value) => value.startsWith("--key=")).slice(6), "key\\n", { mode: 0o600 });
    process.exit(0);
}
if (args.slice(1, 4).join(" ") !== "serve exec --") process.exit(2);
const [command, ...commandArguments] = args.slice(4);
const server = createServer((connection) => {
    const child = spawn(command, commandArguments, { stdio: ["pipe", "pipe", "inherit"] });
    connection.pipe(child.stdin);
    child.stdout.pipe(connection);
    connection.on("error", () => child.kill());
    child.stdin.on("error", () => connection.destroy());
});
server.listen(${String(TAILNET_PORT)}, "127.0.0.1", () => {
    writeFileSync(process.env.TAILCAT_ADDR_FILE, "tcGymOnboardingPhone\\n", { mode: 0o600 });
});
process.on("SIGTERM", () => process.exit(0));
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
        /** What Focus proposes for each of Happy's requests. */
        propose?: Propose;
    } = {},
) {
    const propose = options.propose ?? proposeRedesign;
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
            if (request.instructions.includes("You are the Focus Agent"))
                return focusTurn(request, propose);
            const led = happyLeads(request);
            if (led !== undefined) return led;
            const answer = answers[eventIn(request) ?? ""] ?? answers["*"];
            if (answer === undefined) return { content: [{ text: "Done.", type: "text" }] };
            return answer(request);
        },
        timeoutMs: 20_000,
    });
    running.add(gym);
    // Focus is part of the stem-cell sidebar.
    await gym.client.saveUserSetting("happy-desktop.experiments.stemCells", { value: true });
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
    agentId: string,
    message: Message,
    action: { id: string; params?: Record<string, string>; block?: number },
    values?: string[],
): Promise<unknown> {
    const response = await sendPress(gym, agentId, message, action, values);
    expect(response.status, JSON.stringify(response.body)).toBe(202);
    return (response.body as { message: { content: { result: unknown }[] } }).message.content[0]!
        .result;
}

/** The person's press, sent as their own action message. */
async function sendPress(
    gym: AgentGym,
    agentId: string,
    message: Message,
    action: { id: string; params?: Record<string, string>; block?: number },
    values?: string[],
) {
    return await gym.http.request("POST", `/v0/agents/${agentId}/send`, {
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

async function flowOf(gym: AgentGym): Promise<Flow> {
    return ((await gym.http.ok("GET", "/v0/onboarding/flow")) as { flow: Flow }).flow;
}

async function placeholderOf(gym: AgentGym, agentId: string): Promise<string | null | undefined> {
    return (
        (await gym.http.ok("GET", `/v0/agents/${agentId}`)) as {
            agent: { composerPlaceholder?: string | null };
        }
    ).agent.composerPlaceholder;
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
    const routes = await waitForText(gym, happy, "I found these on this");
    await press(gym, happy, routes, { id: "onboarding.routesUse" }, ["codex"]);
    const profile = await waitForText(gym, happy, "**Ada Lovelace** · ada@example.com");
    await gym.waitUntil(
        async () => ((await flowOf(gym)).step === "guided" ? true : undefined),
        "Codex to be verified",
    );
    await press(gym, happy, profile, { id: "onboarding.profileConfirm" });
    return await waitForText(gym, happy, "Want me to look at what you've been working on?");
}

/** Focus's conversation, once a press has started it. */
async function focusOf(gym: AgentGym): Promise<string> {
    return await gym.waitUntil(
        () =>
            gym.inference.requests
                .map((request) => focusIdIn(request))
                .find((id) => id !== undefined),
        "Focus to be started",
    );
}

describe("onboarding the person's work", () => {
    it(
        "hands Discover to Focus, shows its proposal with Good to go, starts the new chat read-only, then finishes",
        async () => {
            const { gym, happy, project } = await startGym({
                begin: say(PROFILE_STEP),
                "pressed:That's me": say(WORK_STEP),
                "pressed:Good to go": say(NEW_STEP),
                "pressed:Try Create": say(PHONE_STEP),
                "pressed:Later": (request) => {
                    const item = /- ([a-z0-9]{24}): Onboarding redesign/u.exec(
                        JSON.stringify(request.messages.at(-1)),
                    )?.[1];
                    return say(
                        [
                            "You're ready, Ada.",
                            "",
                            "<menu>",
                            `  <button data-action="onboarding.workOpen" data-item="${item ?? "missing"}" data-emphasis>Onboarding redesign</button>`,
                            '  <button data-action="onboarding.finish">Stay here</button>',
                            "</menu>",
                        ].join("\n"),
                    )();
                },
            });
            const work = await reachWork(gym, happy);
            // The composer invites typing while onboarding runs.
            expect(await placeholderOf(gym, happy)).toBe(PLACEHOLDER);
            // The person's press of Use selected is their own bubble, with what they ticked.
            const used = (await messages(gym, happy)).find(
                (message) =>
                    message.role === "user" &&
                    JSON.stringify(message.content).includes('"onboarding.routesUse"'),
            );
            expect(used?.content[0]).toMatchObject({
                type: "action",
                ticked: [expect.stringContaining("Codex")],
            });

            await press(gym, happy, work, { id: "onboarding.discover" });
            const focus = await focusOf(gym);
            expect(pressRead(gym, "Discover what I've been working on")).toContain(
                `Focus's agent ID is ${focus}.`,
            );
            const { agent: focusAgent } = (await gym.http.ok("GET", `/v0/agents/${focus}`)) as {
                agent: { title: string };
            };
            expect(focusAgent.title).toBe("Focus Agent");

            // The daemon showed Focus in Happy's chat as its sub-agent, right after the press:
            // the finished creation row any sub-agent gets, with Focus's ID, model, and task.
            const spawned = await gym.waitUntil(async () => {
                const all = await messages(gym, happy);
                const at = all.findIndex((message) =>
                    message.content.some((block) => block.type === "tool_call"),
                );
                return at === -1 ? undefined : { all, at };
            }, "Focus's sub-agent row");
            const pressAt = spawned.all.findIndex(
                (message) =>
                    message.role === "user" &&
                    JSON.stringify(message.content).includes('"onboarding.discover"'),
            );
            expect(spawned.at).toBe(pressAt + 1);
            expect(spawned.all[spawned.at]!.role).toBe("agent");
            expect(spawned.all[spawned.at]!.content[0]).toMatchObject({
                type: "tool_call",
                name: "create_agent",
                status: "completed",
                arguments: { title: TASK, text: TASK },
                presentation: {
                    type: "agent_spawn",
                    agentId: focus,
                    model: { modelId: expect.any(String), name: expect.any(String) },
                },
            });
            // Focus's own chat opens with that task, from Happy.
            const opening = await gym.waitUntil(
                async () =>
                    (await messages(gym, focus)).find((message) => textOf(message).includes(TASK)),
                "Focus's task",
            );
            expect(opening.role).not.toBe("assistant");
            // Its own row has its target icon from the start, right after Happy's in the sidebar.
            const { spaces: rows } = (await gym.http.ok("GET", "/v0/spaces")) as {
                spaces: { id: string; title: string; icon: unknown }[];
            };
            const focusRow = rows.find((row) => row.title === "Focus Agent");
            expect(focusRow).toMatchObject({ icon: { type: "library", slug: "goals" } });
            const shownAt = (await gym.http.ok("GET", "/v0/spaces/sidebar")) as { html: string };
            const happyRow = rows.find((row) => row.title === "Happy")!;
            expect(shownAt.html).toMatch(
                new RegExp(
                    `<happy-space id="${happyRow.id}"[^>]*(?:/>|>[\\s\\S]*?</happy-space>)\\s*<happy-space id="${focusRow!.id}"`,
                    "u",
                ),
            );
            await waitForText(gym, happy, HANDING);
            // Happy's model only introduced Focus: it never created or messaged it.
            expect(
                gym.inference
                    .toolResults()
                    .some((result) => result.callId.startsWith("happy-send")),
            ).toBe(false);

            // Happy wrote the card and Good to go once Focus's message named the proposal.
            const shown = await waitForText(gym, happy, INTRO);
            const proposal = /data-sidebar-proposal="([a-z0-9]+)"/u.exec(textOf(shown))![1]!;
            const heard = gym.inference.requests.find(
                (request) =>
                    !request.instructions.includes("You are the Focus Agent") &&
                    JSON.stringify(request.messages.at(-1)).includes(
                        `Focus finished. Its open proposal is ${proposal}.`,
                    ),
            );
            expect(JSON.stringify(heard?.messages.at(-1))).toContain(
                "Focus said: I'd start with the onboarding work.",
            );
            // Focus's own Good to go stays in its chat: Happy's chat offers it once, from Happy.
            expect(JSON.stringify(heard?.messages.at(-1))).not.toContain("<menu");
            const order = (await messages(gym, happy)).map((message) => message.id);
            expect(order.indexOf(shown.id)).toBeGreaterThan(order.indexOf(work.id));
            // Focus read only what was disclosed: the session's project and what was asked.
            const findings = gym.inference
                .toolResults()
                .find((result) => result.callId.startsWith("focus-discover"))?.text;
            expect(findings).toContain(project);
            expect(findings).toContain(ASKED);
            expect(findings).not.toContain("environment_context");

            // Good to go accepts the proposal and starts its new chat under the reserved ID.
            const result = (await press(gym, happy, shown, {
                id: "sidebar.proposalAccept",
                params: { proposal },
                block: 1,
            })) as { proposal: string; started: { spaceId: string; agentId: string }[] };
            expect(result.proposal).toBe(proposal);
            expect(result.started).toHaveLength(1);
            const kept = result.started[0]!;
            const accepted = await gym.waitUntil(
                async () => pressRead(gym, "Good to go"),
                "Happy's model to read Good to go",
            );
            expect(accepted).toBe(
                [
                    '[Pressed "Good to go" in your message]',
                    "",
                    "Focus's proposal is accepted, and the sidebar now follows it.",
                    "Started 1 chat, each making a read-only plan and waiting for them before it changes anything:",
                    `- Onboarding redesign, under Product (data-item ${kept.spaceId})`,
                ].join("\n"),
            );
            // The press is the person's own message, labelled as they saw it.
            const pressedMessage = (await messages(gym, happy)).find(
                (message) =>
                    message.role === "user" &&
                    JSON.stringify(message.content).includes('"sidebar.proposalAccept"'),
            );
            expect(pressedMessage?.content[0]).toMatchObject({
                type: "action",
                messageId: shown.id,
                actionId: "sidebar.proposalAccept",
                label: "Good to go",
            });
            const { proposal: decided } = (await gym.http.ok(
                "GET",
                `/v0/spaces/sidebar/proposals/${proposal}`,
            )) as { proposal: { status: string; started?: unknown } };
            expect(decided).toMatchObject({ status: "accepted", started: [kept] });

            // Its section is new, after Happy, with its row under it.
            const sidebar = (await gym.http.ok("GET", "/v0/spaces/sidebar")) as { html: string };
            const placedAt = sidebar.html.indexOf('label="Product"');
            expect(placedAt).toBeGreaterThan(sidebar.html.indexOf(happy));
            expect(sidebar.html.indexOf(kept.spaceId)).toBeGreaterThan(placedAt);

            // Its chat got the first message exactly as proposed, to run read-only.
            const first = await gym.waitUntil(
                async () =>
                    (await messages(gym, kept.agentId)).find(
                        (message) => textOf(message) === REDESIGN.firstMessage,
                    ),
                "the new chat's first message",
            );
            expect(first.role).toBe("user");
            expect(first.mode?.permissionMode).toBe("read_only");
            // Its row has the proposal's name and icon from the start and keeps them.
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
            const newStep = await waitForText(
                gym,
                happy,
                "Press Create whenever you want to start something new.",
            );
            const fresh = "s3k8m2q9w1e5r7y3u6i0o2p9";
            await create(gym, fresh);
            expect(
                await press(gym, happy, newStep, { id: "onboarding.newChat" }, [fresh]),
            ).toBeNull();

            const phone = await waitForText(
                gym,
                happy,
                "Want to follow your agents from your phone?",
            );
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
            expect(later).toContain(`- ${kept.spaceId}: Onboarding redesign (Product)`);

            const done = await waitForText(gym, happy, "You're ready, Ada.");
            const opened = await press(gym, happy, done, {
                id: "onboarding.workOpen",
                params: { item: kept.spaceId },
            });
            expect(opened).toEqual({ agentId: kept.agentId, spaceId: kept.spaceId });
            expect((await flowOf(gym)).step).toBe("finished");
            expect(await placeholderOf(gym, happy)).toBeNull();
            expect(gym.errors).toEqual([]);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "hands what the person typed to Focus, revises it from a typed change, and accepts it in Focus's own chat",
        async () => {
            const revise: Propose = (asked, view) => {
                if (view.proposal === null) return proposeRedesign(asked, view);
                // The reserved row is replaced by the narrower one the person asked for.
                const reserved = /<happy-space id="([a-z0-9]{24})"\/>/u.exec(
                    view.proposal.html.slice(view.proposal.html.indexOf('label="Product"')),
                )![1]!;
                return {
                    baseVersion: view.proposal.version,
                    edits: [
                        {
                            oldText: `<happy-space id="${reserved}"/>`,
                            newText: '<happy-space id="new-onboarding-copy"/>',
                        },
                    ],
                    newRows: [
                        {
                            id: "new-onboarding-copy",
                            title: "Onboarding copy",
                            icon: "wip",
                            firstMessage: "Plan: review the onboarding copy and wait for me.",
                        },
                    ],
                };
            };
            const { gym, happy } = await startGym(
                {
                    begin: say(PROFILE_STEP),
                    "pressed:That's me": say(WORK_STEP),
                    "pressed:I'll tell you instead": say("What are you working on right now?"),
                    "pressed:Continue": say(PHONE_STEP),
                    "pressed:Later": say(
                        [
                            "You're ready, Ada.",
                            "",
                            "<menu>",
                            '  <button data-action="onboarding.finish" data-emphasis>Done</button>',
                            "</menu>",
                        ].join("\n"),
                    ),
                    "*": (request) => {
                        const said = JSON.stringify(request.messages.at(-1));
                        if (said.includes("I write release notes"))
                            return relay(request, "Ada said: I write release notes every week.");
                        if (said.includes("Only the copy"))
                            return relay(request, "Ada asked to keep only the onboarding copy.");
                        if (said.includes("Accepted in Focus")) return say(NEW_STEP)();
                        return say("Done.")();
                    },
                },
                { propose: revise },
            );
            const work = await reachWork(gym, happy);
            const tools = gym.inference.requests.find(
                (request) => eventIn(request) === "pressed:That's me",
            )?.tools;
            expect(tools?.map((tool) => tool.name)).toEqual(
                expect.arrayContaining(["save_profile", "set_default_model", "send_agent_message"]),
            );
            expect(tools?.map((tool) => tool.name)).not.toContain("discover_work");

            expect(await press(gym, happy, work, { id: "onboarding.workTell" })).toBeNull();
            const focus = await focusOf(gym);
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
            const first = await waitForText(gym, happy, INTRO);
            const proposal = /data-sidebar-proposal="([a-z0-9]+)"/u.exec(textOf(first))![1]!;
            // Without Discover, Focus was never offered discover_work.
            const focusTools = gym.inference.requests.find((request) =>
                request.instructions.includes("You are the Focus Agent"),
            )?.tools;
            expect(focusTools?.map((tool) => tool.name)).not.toContain("discover_work");
            expect(
                gym.inference
                    .toolResults()
                    .some((result) => result.callId.startsWith("focus-discover")),
            ).toBe(false);

            // A change is typed, not pressed: Focus revises the same proposal.
            await gym.send("Only the copy, please.", {
                wait: false,
                sessionId: happy,
                providerId: "codex",
                modelId: "gym-codex",
                effort: "medium",
            });
            await gym.waitUntil(async () => {
                const shown = (await messages(gym, happy)).filter((message) =>
                    textOf(message).includes(INTRO),
                );
                return shown.length >= 2 ? true : undefined;
            }, "the revised proposal to be shown");
            const { html } = (await gym.http.ok(
                "GET",
                `/v0/spaces/sidebar/proposals/${proposal}`,
            )) as { html: string };
            expect(html).not.toContain("new-onboarding-copy");

            // Good to go in Focus's own chat accepts it the same way, from its newest offer.
            const offers = await gym.waitUntil(async () => {
                const found = (await messages(gym, focus)).filter((message) =>
                    textOf(message).includes("I'd start with the onboarding work."),
                );
                return found.length >= 2 ? found : undefined;
            }, "Focus's second offer");
            const offered = offers.at(-1)!;
            const result = (await press(gym, focus, offered, {
                id: "sidebar.proposalAccept",
                params: { proposal },
            })) as { started: { spaceId: string; agentId: string }[] };
            expect(result.started).toHaveLength(1);
            const kept = result.started[0]!;
            const { spaces } = (await gym.http.ok("GET", "/v0/spaces")) as {
                spaces: { id: string; title: string }[];
            };
            expect(spaces.find((space) => space.id === kept.spaceId)?.title).toBe(
                "Onboarding copy",
            );
            expect(spaces.some((space) => space.title === "Onboarding redesign")).toBe(false);
            // An accepted proposal is no longer open: Happy's newest card is a conflict now.
            const cards = (await messages(gym, happy)).filter((message) =>
                textOf(message).includes(INTRO),
            );
            expect(cards[0]!.id).toBe(first.id);
            const again = await sendPress(gym, happy, cards.at(-1)!, {
                id: "sidebar.proposalAccept",
                params: { proposal },
                block: 1,
            });
            expect(again.status).toBe(409);

            // The rest goes on in Happy's chat: Create skipped, the phone later, then Done.
            await gym.send("Accepted in Focus.", {
                wait: false,
                sessionId: happy,
                providerId: "codex",
                modelId: "gym-codex",
                effort: "medium",
            });
            const newStep = await waitForText(
                gym,
                happy,
                "Press Create whenever you want to start something new.",
            );
            await press(gym, happy, newStep, { id: "onboarding.newChatSkip" });
            const phone = await waitForText(
                gym,
                happy,
                "Want to follow your agents from your phone?",
            );
            await press(gym, happy, phone, {
                id: "onboarding.phone",
                params: { choice: "later" },
                block: 1,
            });
            const done = await waitForText(gym, happy, "You're ready, Ada.");
            expect(pressRead(gym, "Later")).toContain(`- ${kept.spaceId}: Onboarding copy`);
            expect(await press(gym, happy, done, { id: "onboarding.finish" })).toBeNull();
            expect(await flowOf(gym)).toMatchObject({ step: "finished", completedVersion: 1 });
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
                    "pressed:Continue": say(PHONE_STEP),
                    "pressed:I've downloaded and opened Happy": say(
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
            const newStep = await waitForText(
                gym,
                happy,
                "Press Create whenever you want to start something new.",
            );
            await press(gym, happy, newStep, { id: "onboarding.newChatSkip" });
            const phone = await waitForText(
                gym,
                happy,
                "Want to follow your agents from your phone?",
            );
            await press(gym, happy, phone, {
                id: "onboarding.phone",
                params: { choice: "opened" },
                block: 1,
            });
            await waitForText(gym, happy, "<figure data-phone-pair></figure>");
            expect(pressRead(gym, "I've downloaded and opened Happy")).toContain(
                "This computer's pairing code is open",
            );

            // The pairing onboarding opened is the computer's ordinary one.
            const { mobileConnector } = (await gym.http.ok("GET", "/v0/mobile-connector")) as {
                mobileConnector: { pairing: { id: string; status: string; qr: string | null } };
            };
            expect(mobileConnector.pairing.status).toBe("waiting");
            // The code names the stand-in Tailcat's address, and only the stand-in listens where
            // the phone dials, so pairing never leaves this computer.
            expect(parseQr(mobileConnector.pairing.qr!).a).toBe("tcGymOnboardingPhone");
            const session = await startPhonePairing(
                mobileConnector.pairing.qr!,
                httpPhoneTransport(`http://127.0.0.1:${String(TAILNET_PORT)}`),
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
                    "pressed:Continue": say(PHONE_STEP),
                    "pressed:I've downloaded and opened Happy": say(
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
            const newStep = await waitForText(
                gym,
                happy,
                "Press Create whenever you want to start something new.",
            );
            await press(gym, happy, newStep, { id: "onboarding.newChatSkip" });
            const phone = await waitForText(
                gym,
                happy,
                "Want to follow your agents from your phone?",
            );
            await press(gym, happy, phone, {
                id: "onboarding.phone",
                params: { choice: "opened" },
                block: 1,
            });

            // Happy's model hears what stopped it, and that the step ended as Later.
            await waitForText(gym, happy, "You're ready, Ada.");
            const answered = pressRead(gym, "I've downloaded and opened Happy");
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
});
