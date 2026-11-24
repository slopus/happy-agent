import { createAgentGym, type AgentGym, type GymAgentHistory } from "@slopus/happy-agent-gym";
import { describe, expect, it } from "vitest";

/**
 * Every harness starts agents on every other one, with real inference: a bot on one harness
 * creates a subtask (`create_subtask`) or a hidden collaborator (`create_agent`) on another, the
 * child answers, and its report reaches the bot, whose own model repeats it. Opt in with
 * HAPPY_ACP_LIVE=agents. Claude runs on HAPPY_ACP_CLAUDE_OAUTH_TOKEN, Codex on
 * HAPPY_ACP_CODEX_AUTH_FILE (a Codex `auth.json`, used in place), Happy's own loop on Grok with
 * HAPPY_ACP_XAI_API_KEY, and Antigravity on its own login. HAPPY_ACP_ANTIGRAVITY_MODEL picks another
 * Antigravity model, and HAPPY_AGENTS_LIVE_CASES (`tool:parent>child,…`) narrows the cases.
 */
const TURN_MS = 300_000;
const live = (process.env.HAPPY_ACP_LIVE ?? "").split(",").map((v) => v.trim());
const claudeToken = process.env.HAPPY_ACP_CLAUDE_OAUTH_TOKEN;
const codexAuthFile = process.env.HAPPY_ACP_CODEX_AUTH_FILE;
const xaiKey = process.env.HAPPY_ACP_XAI_API_KEY;

const SEATS = {
    antigravity: {
        providerId: "antigravity",
        modelId: process.env.HAPPY_ACP_ANTIGRAVITY_MODEL ?? "antigravity/gemini-4-carbon",
        effort: "low",
    },
    claude_code: { providerId: "live_claude", modelId: "claude-code/sonnet", effort: "low" },
    codex_cli: { providerId: "live_codex", modelId: "codex-cli/gpt-6.1-sol", effort: "low" },
    happy: { providerId: "live_grok", modelId: "xai/grok-4.7", effort: "low" },
} as const;
type Harness = keyof typeof SEATS;
type Tool = "create_subtask" | "create_agent";

/** Tool, parent harness, then the harness its child runs on. */
const PAIRS: readonly (readonly [Harness, Harness])[] = [
    ["antigravity", "antigravity"],
    ["claude_code", "claude_code"],
    ["codex_cli", "codex_cli"],
    ["happy", "happy"],
    ["antigravity", "claude_code"],
    ["claude_code", "antigravity"],
    ["codex_cli", "happy"],
    ["happy", "codex_cli"],
    ["happy", "antigravity"],
    ["antigravity", "happy"],
    ["codex_cli", "antigravity"],
    ["claude_code", "codex_cli"],
];
const ALL_CASES = (["create_subtask", "create_agent"] as const).flatMap((tool) =>
    PAIRS.map(([parent, child]) => [tool, parent, child] as const),
);
const only = process.env.HAPPY_AGENTS_LIVE_CASES?.split(",").map((value) => value.trim());
const CASES = ALL_CASES.filter(
    ([tool, parent, child]) => only === undefined || only.includes(`${tool}:${parent}>${child}`),
);

const CONFIG = [
    "[providers.live_claude]",
    'type = "claude"',
    "enabled = true",
    ...(claudeToken === undefined ? [] : [`oauth_token = "${claudeToken}"`]),
    "[providers.live_codex]",
    'type = "codex"',
    "enabled = true",
    ...(codexAuthFile === undefined ? [] : [`auth_file = "${codexAuthFile}"`]),
    "[providers.live_grok]",
    'type = "grok"',
    "enabled = true",
    ...(xaiKey === undefined ? [] : [`api_key = "${xaiKey}"`, 'base_url = "https://api.x.ai/v1"']),
    "[harnesses.claude_code]",
    'providers = ["live_claude"]',
    "[harnesses.codex_cli]",
    'providers = ["live_codex"]',
    "[harnesses.antigravity]",
    "",
].join("\n");

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

/** The child the bot created: its subtask, or the collaborator its create_agent call names. */
async function childOf(gym: AgentGym, botId: string, tool: Tool): Promise<string | undefined> {
    if (tool === "create_subtask") {
        return (await gym.client.getAgent(botId)).agent.subtasks?.[0]?.id;
    }
    // A model may retry after a refused call; the call that created the collaborator names it.
    return agentBlocks(await gym.history(botId)).find(
        (block) =>
            block.type === "tool_call" &&
            block.name === tool &&
            block.presentation?.agentId !== undefined,
    )?.presentation?.agentId;
}

/** What every agent in the gym did, for a failed live scenario. */
async function dump(gym: AgentGym, label: string, childId: string | undefined): Promise<void> {
    for (const bot of (await gym.client.listBots().catch(() => ({ bots: [] }))).bots) {
        const history = await gym.history(bot.agent.id).catch(String);
        console.log(`HISTORY ${label} bot ${bot.agent.id}`, JSON.stringify(history));
    }
    if (childId !== undefined) {
        const history = await gym.history(childId).catch(String);
        console.log(`HISTORY ${label} child ${childId}`, JSON.stringify(history));
    }
}

describe.skipIf(!live.includes("agents"))("agents across harnesses, live", () => {
    it.concurrent.each(CASES)(
        "%s: a bot on %s starts an agent on %s and hears its report",
        async (tool, parentHarness, childHarness) => {
            const parent = SEATS[parentHarness];
            const child = SEATS[childHarness];
            const word = `PLUM-${tool.slice(7)}-${parentHarness}-${childHarness}`.toUpperCase();
            const gym = await createAgentGym({
                config: CONFIG,
                liveProviders: ["live_claude", "live_codex", "live_grok", "antigravity"],
                permissionMode: "full_access",
                timeoutMs: TURN_MS,
            });
            let childId: string | undefined;
            try {
                const bot = (await gym.client.createBot({ name: `Bot on ${parentHarness}` })).bot;
                await gym.send(
                    `Call the Happy tool ${tool} with model "${child.modelId}", effort ` +
                        `"${child.effort}", harness "${childHarness}", provider ` +
                        `"${child.providerId}", title "Plum probe", and text "Reply with only the ` +
                        `word ${word}." Do nothing else now and reply with only WAITING. Later, ` +
                        "when it reports back, reply with only the word it reported.",
                    { ...parent, sessionId: bot.agent.id, permissionMode: "full_access" },
                );
                childId = await gym.waitUntil(
                    () => childOf(gym, bot.agent.id, tool),
                    `the bot to call ${tool}`,
                );
                const created = childId;
                const mode = await gym.waitUntil(
                    async () => (await gym.client.getAgentMode(created)).mode ?? undefined,
                    "the child's mode",
                );
                expect({ providerId: mode.providerId, modelId: mode.modelId }).toEqual({
                    providerId: child.providerId,
                    modelId: child.modelId,
                });
                await gym.waitUntil(async () => {
                    const history = await gym.history(created).catch(() => undefined);
                    return history !== undefined && lastText(history).includes(word)
                        ? true
                        : undefined;
                }, "the child to answer");
                // The report reaches the bot, and the bot's own model reads and repeats it.
                await gym.waitUntil(async () => {
                    const history = await gym.history(bot.agent.id);
                    const reported = history.runs
                        .flatMap((r) => r.messages)
                        .some(
                            (message) =>
                                message.role === "agent" &&
                                message.metadata.senderAgentId === created,
                        );
                    return reported && lastText(history).includes(word) ? true : undefined;
                }, "the bot to repeat its child's report");
            } catch (error) {
                await dump(gym, `${tool}:${parentHarness}>${childHarness}`, childId);
                throw error;
            } finally {
                await gym.dispose();
            }
        },
        TURN_MS * 3,
    );
});
