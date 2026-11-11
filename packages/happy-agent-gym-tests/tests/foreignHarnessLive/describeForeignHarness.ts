import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import type { Question } from "@slopus/happy-agent-client";

import { createAgentGym, type AgentGym, type GymAgentHistory } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const run = promisify(execFile);

/**
 * Live scenarios for one foreign agent harness: real inference, everything else the product. Each
 * harness has its own test file, so the harnesses run in parallel. Opt in with
 * HAPPY_ACP_LIVE=claude-code,codex-cli,antigravity,opencode. Each harness uses its own login
 * unless given an account: HAPPY_ACP_CLAUDE_OAUTH_TOKEN for Claude Code,
 * HAPPY_ACP_CODEX_AUTH_FILE (a Codex `auth.json`) for Codex CLI, and HAPPY_ACP_XAI_API_KEY to
 * run OpenCode on xAI. HAPPY_ACP_ANTIGRAVITY_MODEL runs Antigravity on another of its models, such
 * as `antigravity/gemini-4-carbon`.
 *
 * Every harness keeps its own permission system. What it asks and the agent's mode leaves open
 * reaches the person as a permission question from that harness; these scenarios answer it the
 * way a person would and check the file system and the wire, never what the model says.
 */
export type HarnessKind = "claude-code" | "codex-cli" | "antigravity" | "opencode";

const TURN_MS = 240_000;

interface HarnessSetup {
    readonly config: readonly string[];
    readonly providerId: string;
    readonly model: string;
    readonly effort: string;
    /** Under `<agentHome>/foreign-agents`. */
    readonly stateDirectory: readonly string[];
    /**
     * False when its model cannot reach Happy's `create_agent`. Antigravity registers only small
     * MCP tools as functions; larger ones, `create_agent` among them, are left for the model to
     * load from a schema file, which it does not do.
     */
    readonly createsHappySubAgents?: false;
}

const claudeToken = process.env.HAPPY_ACP_CLAUDE_OAUTH_TOKEN;
const codexAuthFile = process.env.HAPPY_ACP_CODEX_AUTH_FILE;
const xaiKey = process.env.HAPPY_ACP_XAI_API_KEY;

const SETUPS: Readonly<Record<HarnessKind, HarnessSetup>> = {
    "claude-code": {
        config: [
            "[providers.live_claude]",
            'type = "claude"',
            "enabled = true",
            ...(claudeToken === undefined ? [] : [`oauth_token = "${claudeToken}"`]),
            "[harnesses.claude_code]",
            'providers = ["live_claude"]',
        ],
        providerId: "live_claude",
        model: "claude-code/sonnet",
        effort: "low",
        stateDirectory: ["claude_code", "live_claude"],
    },
    "codex-cli": {
        config: [
            "[providers.live_codex]",
            'type = "codex"',
            "enabled = true",
            ...(codexAuthFile === undefined ? [] : [`auth_file = "${codexAuthFile}"`]),
            "[harnesses.codex_cli]",
            'providers = ["live_codex"]',
        ],
        providerId: "live_codex",
        model: "codex-cli/gpt-6.1-sol",
        effort: "low",
        stateDirectory: ["codex_cli", "live_codex"],
    },
    antigravity: {
        config: ["[harnesses.antigravity]"],
        providerId: "antigravity",
        model: process.env.HAPPY_ACP_ANTIGRAVITY_MODEL ?? "antigravity/gemini-3.8-flash",
        effort: "low",
        stateDirectory: ["antigravity"],
        createsHappySubAgents: false,
    },
    opencode: {
        config: [
            "[harnesses.opencode]",
            ...(xaiKey === undefined ? [] : [`env = { XAI_API_KEY = "${xaiKey}" }`]),
        ],
        providerId: "opencode",
        model: xaiKey === undefined ? "opencode/openai/gpt-5.4-mini" : "opencode/xai/grok-4.6",
        effort: "medium",
        stateDirectory: ["opencode"],
    },
};

/** What each harness's own permission system does, as observed against the pinned releases. */
interface HarnessPermissions {
    readonly harnessId: string;
    readonly harnessName: string;
    /**
     * In Auto, its reviewer hands an action it will not decide alone to the person instead of
     * deciding: Antigravity asks before writing outside its sandbox, while Claude Code's
     * classifier and Codex's reviewer decide by themselves.
     */
    readonly autoAsksPerson: boolean;
    /** Its permission system asks before Happy's own tools; Antigravity never gates MCP calls. */
    readonly gatesHappyTools: boolean;
    /** How to have it start one of its own sub-agents, when that sub-agent's asks reach Happy. */
    readonly ownSubagent?: string;
}

const PERMISSIONS: Partial<Readonly<Record<HarnessKind, HarnessPermissions>>> = {
    "claude-code": {
        harnessId: "claude_code",
        harnessName: "Claude Code",
        autoAsksPerson: false,
        gatesHappyTools: true,
        ownSubagent: "Use your Task tool to start exactly one subagent",
    },
    "codex-cli": {
        harnessId: "codex_cli",
        harnessName: "Codex CLI",
        autoAsksPerson: false,
        gatesHappyTools: true,
        ownSubagent: "Use your spawn_agent tool to start exactly one subagent",
    },
    // Antigravity's own sub-agents never send their asks to the client; they stall instead.
    antigravity: {
        harnessId: "antigravity",
        harnessName: "Antigravity",
        autoAsksPerson: true,
        gatesHappyTools: false,
    },
};

/** Outside the gym's workspace and its temporary folders, which some sandboxes leave writable. */
const OUTSIDE_ROOT = fileURLToPath(
    new URL("../../../../.context/harness-outside/", import.meta.url),
);

async function outsideFile(name: string): Promise<string> {
    const directory = join(OUTSIDE_ROOT, randomUUID());
    await mkdir(directory, { recursive: true });
    return join(directory, name);
}

function writeOutside(path: string, content: string): string {
    return (
        `Create the file ${path} containing exactly ${content}, using your own tools. It is ` +
        "outside your workspace on purpose. If your sandbox blocks it, request permission or " +
        "escalation for that same action. If permission is refused, do not try another way; " +
        "reply REFUSED. Otherwise reply DONE."
    );
}

interface Block {
    readonly type: string;
    readonly text?: string;
    readonly name?: string;
    readonly presentation?: { readonly agentId?: string };
}

function agentBlocks(history: GymAgentHistory): Block[] {
    return history.runs.flatMap((r) =>
        r.messages.flatMap((message) =>
            message.role === "agent" ? (message.content as readonly Block[]) : [],
        ),
    );
}

function lastText(history: GymAgentHistory): string {
    return (
        agentBlocks(history)
            .filter((block) => block.type === "text")
            .map((block) => block.text ?? "")
            .at(-1) ?? ""
    );
}

function toolNames(history: GymAgentHistory): string[] {
    return agentBlocks(history)
        .filter((block) => block.type === "tool_call")
        .map((block) => block.name ?? "");
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Whether a foreign harness's own permission system asked `question`. */
function fromHarness(question: Question): boolean {
    return question.permissionRequest?.source === "harness";
}

/** The harness's permission question pending on `agentId`, if any. */
async function harnessQuestion(gym: AgentGym, agentId: string): Promise<Question | undefined> {
    const { question } = await gym.client.getPendingQuestion(agentId);
    return question?.status === "pending" && fromHarness(question) ? question : undefined;
}

/** Every permission question a harness put to the person in this gym. */
async function harnessQuestionsAsked(gym: AgentGym): Promise<Question[]> {
    return (await gym.events()).flatMap((event) =>
        event.type === "question.created" && fromHarness(event.payload.question)
            ? [event.payload.question]
            : [],
    );
}

async function answerQuestion(
    gym: AgentGym,
    agentId: string,
    question: Question,
    label: string,
): Promise<void> {
    await gym.client.answerQuestion(agentId, question.id, {
        answers: { [question.questions[0]!.id]: [label] },
        mutationId: randomUUID(),
    });
}

/**
 * Answer every permission question the harness asks on `agentId` with `label` until `until`
 * settles, the way a person at the screen would. Returns the questions it answered.
 */
async function answerEvery(
    gym: AgentGym,
    agentId: string,
    label: string,
    until: Promise<unknown>,
): Promise<Question[]> {
    let settled = false;
    const done = until.finally(() => {
        settled = true;
    });
    const answered: Question[] = [];
    while (!settled) {
        const question = await harnessQuestion(gym, agentId);
        if (question !== undefined && !answered.some((seen) => seen.id === question.id)) {
            answered.push(question);
            await answerQuestion(gym, agentId, question, label);
        }
        await Promise.race([done, pause(500)]);
    }
    await done;
    return answered;
}

export function describeForeignHarness(kind: HarnessKind): void {
    const live = (process.env.HAPPY_ACP_LIVE ?? "").split(",").map((v) => v.trim());
    const setup = SETUPS[kind];
    const select = { providerId: setup.providerId, modelId: setup.model, effort: setup.effort };
    const running = new Set<AgentGym>();
    afterEach(async ({ task }) => {
        // A failed live scenario is only worth something with what each agent actually did.
        if (task.result?.state === "fail") {
            for (const gym of running) {
                const ids = new Set((await gym.listSessions().catch(() => [])).map((s) => s.id));
                for (const id of ids) {
                    const history = await gym.history(id).catch(() => undefined);
                    console.log(`HISTORY ${kind} ${id}`, JSON.stringify(history ?? null));
                    // Sub-agents are not listed with the project; reach them through their spawn.
                    for (const block of history === undefined ? [] : agentBlocks(history)) {
                        const child = block.presentation?.agentId;
                        if (child === undefined || ids.has(child)) continue;
                        const childHistory = await gym.history(child).catch(() => null);
                        console.log(`HISTORY ${kind} ${child}`, JSON.stringify(childHistory));
                    }
                }
            }
        }
        await Promise.all([...running].map((gym) => gym.dispose()));
        running.clear();
    }, 60_000);

    async function gymFor(): Promise<AgentGym> {
        const gym = await createAgentGym({
            config: [...setup.config, ""].join("\n"),
            liveProviders: [setup.providerId],
            permissionMode: "full_access",
            timeoutMs: TURN_MS,
        });
        running.add(gym);
        if (kind === "opencode") {
            // OpenCode has no built-in model list; give the daemon the one `opencode` reports.
            const { stdout } = await run("opencode", ["models"], {
                env: { ...process.env, ...(xaiKey === undefined ? {} : { XAI_API_KEY: xaiKey }) },
            });
            const models = stdout
                .split("\n")
                .map((line) => line.trim())
                .filter((line) => line.includes("/"))
                .map((value) => ({
                    id: `opencode/${value}`,
                    name: `OpenCode · ${value}`,
                    effortLevels: ["medium"],
                    defaultEffort: "medium",
                    contextWindow: 400_000,
                }));
            const directory = join(gym.happyHome, "agent", "foreign-agents", "opencode");
            await mkdir(directory, { recursive: true });
            await writeFile(join(directory, "models.json"), JSON.stringify(models));
            await gym.restart();
        }
        return gym;
    }

    async function record(gym: AgentGym, agentId: string) {
        return JSON.parse(
            await readFile(
                join(
                    gym.happyHome,
                    "agent",
                    "foreign-agents",
                    ...setup.stateDirectory,
                    "sessions",
                    `${encodeURIComponent(agentId)}.json`,
                ),
                "utf8",
            ),
        ) as { acpSessionId: string; consumed: number };
    }

    describe.skipIf(!live.includes(kind))(`${kind} harness, live`, () => {
        it(
            "uses its own tools and Happy's, and keeps its session across a daemon restart",
            async () => {
                const gym = await gymFor();
                await gym.send(
                    `Using your own file or shell tools, create note.txt containing exactly ${kind}-ok. ` +
                        "Then call the Happy tool list_projects and reply with the folder of the " +
                        "project it lists.",
                    select,
                );
                expect((await gym.readFile("note.txt")).trim()).toBe(`${kind}-ok`);
                const first = await gym.history();
                expect(toolNames(first)).toContain("list_projects");
                expect(lastText(first)).toContain(gym.workspacePath.split("/").at(-1)!);
                const before = await record(gym, gym.defaultSessionId);

                await gym.restart();
                await gym.send(
                    "Which file did you create earlier in this conversation? Reply with only its name.",
                    select,
                );
                expect(lastText(await gym.history())).toContain("note.txt");
                const after = await record(gym, gym.defaultSessionId);
                expect(after.acpSessionId).toBe(before.acpSessionId);
                expect(after.consumed).toBeGreaterThan(before.consumed);
                expect(gym.errors).toEqual([]);
            },
            TURN_MS * 3,
        );

        it(
            "fixes a real bug and proves it with the project's own test",
            async () => {
                const gym = await gymFor();
                await gym.writeFile("package.json", '{ "type": "module" }\n');
                await gym.writeFile(
                    "cart.js",
                    [
                        "export function total(items) {",
                        "    let sum = 0;",
                        "    for (let i = 1; i < items.length; i++) sum += items[i].price * items[i].qty;",
                        "    return sum;",
                        "}",
                        "",
                    ].join("\n"),
                );
                const test = [
                    'import assert from "node:assert";',
                    'import { total } from "./cart.js";',
                    "assert.strictEqual(total([{ price: 2, qty: 3 }, { price: 5, qty: 1 }]), 11);",
                    "assert.strictEqual(total([]), 0);",
                    'console.log("ok");',
                    "",
                ].join("\n");
                await gym.writeFile("cart.test.js", test);
                await gym.send(
                    "`node cart.test.js` fails. Fix the bug in cart.js without editing cart.test.js, " +
                        "run `node cart.test.js` to confirm it prints ok, and reply FIXED.",
                    select,
                );
                expect(await gym.readFile("cart.test.js")).toBe(test);
                const { stdout } = await run("node", ["cart.test.js"], { cwd: gym.workspacePath });
                expect(stdout.trim()).toBe("ok");
            },
            TURN_MS * 2,
        );

        it(
            "keeps two concurrent conversations apart",
            async () => {
                const gym = await gymFor();
                const other = await gym.createSession({ title: "Other" });
                const [a, b] = await Promise.all([
                    gym.send(
                        "This conversation is about the project named ALPHA-7. Create alpha.txt containing ALPHA-7 with your " +
                            "own tools and reply OK.",
                        { ...select, wait: false },
                    ),
                    gym.send(
                        "This conversation is about the project named BRAVO-9. Create bravo.txt containing BRAVO-9 with your " +
                            "own tools and reply OK.",
                        { ...select, sessionId: other.id, wait: false },
                    ),
                ]);
                await Promise.all([gym.waitForRun(a.runId), gym.waitForRun(b.runId)]);
                const ask = "Which project is this conversation about? Reply with only its name.";
                const [c, d] = await Promise.all([
                    gym.send(ask, { ...select, wait: false }),
                    gym.send(ask, { ...select, sessionId: other.id, wait: false }),
                ]);
                await Promise.all([gym.waitForRun(c.runId), gym.waitForRun(d.runId)]);
                const mine = lastText(await gym.history());
                const theirs = lastText(await gym.history(other.id));
                expect(mine).toContain("ALPHA-7");
                expect(mine).not.toContain("BRAVO-9");
                expect(theirs).toContain("BRAVO-9");
                expect(theirs).not.toContain("ALPHA-7");
                expect((await gym.readFile("alpha.txt")).trim()).toBe("ALPHA-7");
                expect((await gym.readFile("bravo.txt")).trim()).toBe("BRAVO-9");
                const [one, two] = await Promise.all([
                    record(gym, gym.defaultSessionId),
                    record(gym, other.id),
                ]);
                expect(one.acpSessionId).not.toBe(two.acpSessionId);
            },
            TURN_MS * 3,
        );

        it(
            "cannot write in read-only mode",
            async () => {
                const gym = await gymFor();
                await gym.send(
                    "Create the file blocked.txt containing x using your own tools. If you are not " +
                        "allowed to, do not try another way; reply BLOCKED.",
                    { ...select, permissionMode: "read_only" },
                );
                expect(await gym.exists("blocked.txt")).toBe(false);
                // Read only refuses whatever the harness asks, without asking the person.
                expect(await harnessQuestionsAsked(gym)).toEqual([]);
            },
            TURN_MS,
        );

        it(
            "stops mid-turn, ending the command it was running",
            async () => {
                const gym = await gymFor();
                const startedAt = Date.now();
                const started = await gym.send(
                    "Run this exact shell command with your own shell tool and wait for it: " +
                        "`echo started > started.txt && sleep 25 && echo late > late.txt`. Then reply DONE.",
                    { ...select, wait: false },
                );
                await gym.waitUntil(
                    async () => ((await gym.exists("started.txt")) ? true : undefined),
                    "the agent to start its shell call",
                );
                await gym.abort();
                await gym.waitForRun(started.runId);
                await gym.send("Reply with only the word AGAIN.", select);
                expect(lastText(await gym.history())).toContain("AGAIN");
                await pause(Math.max(0, startedAt + 30_000 - Date.now()));
                expect(await gym.exists("late.txt")).toBe(false);
            },
            TURN_MS * 2,
        );

        it(
            "takes steering mid-turn",
            async () => {
                const gym = await gymFor();
                await gym.send(
                    "Run these three shell commands one at a time, each as its own separate tool " +
                        "call, waiting for each: `sleep 8 && echo one > a.txt`, then " +
                        "`sleep 8 && echo two > b.txt`, then `sleep 8 && echo three > c.txt`. " +
                        "Then reply DONE.",
                    { ...select, wait: false },
                );
                await gym.waitUntil(
                    async () => ((await gym.exists("a.txt")) ? true : undefined),
                    "the agent to finish its first command",
                );
                const steered = await gym.steer(
                    "STOP. Do not run any more commands and do not create c.txt. " +
                        "Reply with only the word STEERED.",
                    select,
                );
                await gym.waitForRun(steered.runId);
                expect(lastText(await gym.history())).toContain("STEERED");
                await pause(12_000);
                expect(await gym.exists("c.txt")).toBe(false);
            },
            TURN_MS * 2,
        );

        it.skipIf(setup.createsHappySubAgents === false)(
            "creates a Happy sub-agent on its own harness and receives its report",
            async () => {
                const gym = await gymFor();
                await gym.send(
                    `Call the Happy tool create_agent with provider "${setup.providerId}", model ` +
                        `"${setup.model}", effort "${setup.effort}", title "Plum probe", and text "Reply with ` +
                        'only the word PLUM-SEVEN." Do nothing else, and reply with only WAITING.',
                    select,
                );
                const spawn = agentBlocks(await gym.history()).find(
                    (block) => block.type === "tool_call" && block.name === "create_agent",
                );
                const childId = spawn?.presentation?.agentId;
                expect(childId, "the parent calls create_agent").toBeDefined();
                await gym.waitUntil(
                    async () => {
                        const child = await gym.history(childId).catch(() => undefined);
                        return child !== undefined && lastText(child).includes("PLUM-SEVEN")
                            ? child
                            : undefined;
                    },
                    "the collaborator to answer",
                    TURN_MS,
                );
                await gym.waitUntil(
                    async () =>
                        (await gym.history()).runs
                            .flatMap((r) => r.messages)
                            .find(
                                (message) =>
                                    message.role === "agent" &&
                                    message.metadata.senderAgentId === childId,
                            ),
                    "the collaborator's report to reach the parent",
                    TURN_MS,
                );
                expect((await record(gym, childId!)).consumed).toBeGreaterThanOrEqual(1);
            },
            TURN_MS * 3,
        );
    });

    const permissions = PERMISSIONS[kind];
    describe.skipIf(!live.includes(kind) || permissions === undefined)(
        `${kind} harness permissions, live`,
        () => {
            const traits = permissions!;
            const askedBy = {
                source: "harness",
                server: traits.harnessId,
                serverTitle: traits.harnessName,
            };

            it(
                "asks the person before writing outside the workspace in Workspace write, and writes once allowed",
                async () => {
                    const gym = await gymFor();
                    const path = await outsideFile("allowed.txt");
                    const run = await gym.send(writeOutside(path, "ALLOWED-1"), {
                        ...select,
                        permissionMode: "workspace_write",
                        wait: false,
                    });
                    const asked = await answerEvery(
                        gym,
                        gym.defaultSessionId,
                        "Allow once",
                        gym.waitForRun(run.runId),
                    );
                    expect(asked.length).toBeGreaterThan(0);
                    expect(asked[0]!.permissionRequest).toEqual(askedBy);
                    expect(asked[0]!.questions[0]!.options.map((option) => option.label)).toContain(
                        "Deny",
                    );
                    expect((await readFile(path, "utf8")).trim()).toBe("ALLOWED-1");
                },
                TURN_MS * 2,
            );

            it(
                "leaves the file unwritten when the person denies",
                async () => {
                    const gym = await gymFor();
                    const path = await outsideFile("denied.txt");
                    const run = await gym.send(writeOutside(path, "DENIED-1"), {
                        ...select,
                        permissionMode: "workspace_write",
                        wait: false,
                    });
                    const asked = await answerEvery(
                        gym,
                        gym.defaultSessionId,
                        "Deny",
                        gym.waitForRun(run.runId),
                    );
                    expect(asked.length).toBeGreaterThan(0);
                    expect(existsSync(path)).toBe(false);
                },
                TURN_MS * 2,
            );

            it(
                "withdraws a pending question when the turn is stopped, and the harness never acts",
                async () => {
                    const gym = await gymFor();
                    const path = await outsideFile("stopped.txt");
                    const run = await gym.send(writeOutside(path, "STOPPED-1"), {
                        ...select,
                        permissionMode: "workspace_write",
                        wait: false,
                    });
                    const question = await gym.waitUntil(
                        () => harnessQuestion(gym, gym.defaultSessionId),
                        "the harness's permission question",
                        TURN_MS,
                    );
                    await gym.abort();
                    await gym.waitForRun(run.runId);
                    expect(await harnessQuestion(gym, gym.defaultSessionId)).toBeUndefined();
                    await gym.waitForEvent(
                        (event) =>
                            event.type === "question.updated" &&
                            event.payload.questionId === question.id &&
                            event.payload.changes.status === "canceled",
                        "the withdrawn question",
                    );
                    await pause(5_000);
                    expect(existsSync(path)).toBe(false);
                    // The conversation goes on.
                    await gym.send("Reply with only the word AGAIN.", {
                        ...select,
                        permissionMode: "workspace_write",
                    });
                    expect(lastText(await gym.history())).toContain("AGAIN");
                },
                TURN_MS * 2,
            );

            it(
                "writes outside without asking anyone in Full access",
                async () => {
                    const gym = await gymFor();
                    const path = await outsideFile("full.txt");
                    await gym.send(writeOutside(path, "FULL-1"), {
                        ...select,
                        permissionMode: "full_access",
                    });
                    expect((await readFile(path, "utf8")).trim()).toBe("FULL-1");
                    expect(await harnessQuestionsAsked(gym)).toEqual([]);
                },
                TURN_MS,
            );

            it(
                traits.autoAsksPerson
                    ? "hands an outside write its reviewer will not decide to the person in Auto"
                    : "lets its own reviewer decide an outside write the person asked for in Auto, without asking",
                async () => {
                    const gym = await gymFor();
                    // Inside the workspace, nothing is asked.
                    await gym.send(
                        "Create inside.txt in your workspace containing exactly INSIDE-1 using your own tools, then reply DONE.",
                        { ...select, permissionMode: "auto" },
                    );
                    expect((await gym.readFile("inside.txt")).trim()).toBe("INSIDE-1");
                    expect(await harnessQuestionsAsked(gym)).toEqual([]);

                    const path = await outsideFile("auto.txt");
                    const run = await gym.send(writeOutside(path, "AUTO-1"), {
                        ...select,
                        permissionMode: "auto",
                        wait: false,
                    });
                    const asked = await answerEvery(
                        gym,
                        gym.defaultSessionId,
                        "Allow once",
                        gym.waitForRun(run.runId),
                    );
                    if (traits.autoAsksPerson) expect(asked.length).toBeGreaterThan(0);
                    else expect(asked).toEqual([]);
                    expect((await readFile(path, "utf8")).trim()).toBe("AUTO-1");
                },
                TURN_MS * 2,
            );

            it(
                traits.gatesHappyTools
                    ? "runs Happy's never-reviewed tools freely and asks before one that needs review in Workspace write"
                    : "runs Happy's tools without asking, since it never gates MCP calls",
                async () => {
                    const gym = await gymFor();
                    const run = await gym.send(
                        "Call the Happy tool list_projects once. Then call the Happy tool " +
                            'delete_artifact once with artifactId "art_missing_1". If a call is refused, do not ' +
                            "retry it. Reply DONE.",
                        { ...select, permissionMode: "workspace_write", wait: false },
                    );
                    const asked = await answerEvery(
                        gym,
                        gym.defaultSessionId,
                        "Allow once",
                        gym.waitForRun(run.runId),
                    );
                    const calls = toolNames(await gym.history());
                    expect(calls).toContain("list_projects");
                    // Allowed, the call reaches Happy, which runs it.
                    expect(calls).toContain("delete_artifact");
                    if (traits.gatesHappyTools) {
                        expect(asked.length).toBeGreaterThan(0);
                        expect(
                            asked.every((question) => !question.context?.includes("list_projects")),
                        ).toBe(true);
                        expect(
                            asked.some((question) => question.context?.includes("delete_artifact")),
                        ).toBe(true);
                    } else {
                        expect(asked).toEqual([]);
                    }
                },
                TURN_MS * 2,
            );

            it.skipIf(!traits.gatesHappyTools)(
                "keeps Happy's tool unrun when the person denies it",
                async () => {
                    const gym = await gymFor();
                    const run = await gym.send(
                        'Call the Happy tool delete_artifact once with artifactId "art_missing_2". If it ' +
                            "is refused, do not retry it. Reply DONE.",
                        { ...select, permissionMode: "workspace_write", wait: false },
                    );
                    const asked = await answerEvery(
                        gym,
                        gym.defaultSessionId,
                        "Deny",
                        gym.waitForRun(run.runId),
                    );
                    expect(asked.length).toBeGreaterThan(0);
                    // Refused by the harness, the call never reaches Happy.
                    expect(toolNames(await gym.history())).not.toContain("delete_artifact");
                },
                TURN_MS * 2,
            );

            it.skipIf(traits.ownSubagent === undefined)(
                "brings its own sub-agent's ask to the person on the same agent",
                async () => {
                    const gym = await gymFor();
                    const path = await outsideFile("subagent.txt");
                    const run = await gym.send(
                        `${traits.ownSubagent} and tell it to do exactly this: ${writeOutside(path, "SUB-1")} ` +
                            "Do not do it yourself. Wait for the subagent and reply with what it reports.",
                        { ...select, permissionMode: "workspace_write", wait: false },
                    );
                    const asked = await answerEvery(
                        gym,
                        gym.defaultSessionId,
                        "Allow once",
                        gym.waitForRun(run.runId),
                    );
                    expect(asked.length).toBeGreaterThan(0);
                    expect((await readFile(path, "utf8")).trim()).toBe("SUB-1");
                },
                TURN_MS * 3,
            );

            it.skipIf(setup.createsHappySubAgents === false)(
                "asks the person on a Happy sub-agent running on the same harness",
                async () => {
                    const gym = await gymFor();
                    const path = await outsideFile("collaborator.txt");
                    const parent = await gym.send(
                        `Call the Happy MCP tool create_agent (not a sub-agent tool of your own) with provider "${setup.providerId}", model ` +
                            `"${setup.model}", effort "${setup.effort}", title "Writer", and text ` +
                            `${JSON.stringify(
                                `Create the file ${path} containing exactly CHILD-1 with your own tools. ` +
                                    "If you are asked to wait for permission, wait; if it is refused, reply REFUSED. Otherwise reply DONE.",
                            )}. Do nothing else, and reply with only WAITING.`,
                        { ...select, permissionMode: "workspace_write", wait: false },
                    );
                    // Only the collaborator is meant to act; whatever the parent asks is refused.
                    await answerEvery(
                        gym,
                        gym.defaultSessionId,
                        "Deny",
                        gym.waitForRun(parent.runId),
                    );
                    const spawn = agentBlocks(await gym.history()).find(
                        (block) => block.type === "tool_call" && block.name === "create_agent",
                    );
                    const childId = spawn?.presentation?.agentId;
                    expect(childId, "the parent calls create_agent").toBeDefined();
                    const asked = await answerEvery(
                        gym,
                        childId!,
                        "Allow once",
                        gym.waitUntil(
                            () => (existsSync(path) ? true : undefined),
                            "the collaborator to write its file",
                            TURN_MS,
                        ),
                    );
                    expect(asked.length).toBeGreaterThan(0);
                    expect(asked[0]!.agentId).toBe(childId);
                    expect(asked[0]!.permissionRequest).toEqual(askedBy);
                    expect((await readFile(path, "utf8")).trim()).toBe("CHILD-1");
                },
                TURN_MS * 3,
            );
        },
    );
}
