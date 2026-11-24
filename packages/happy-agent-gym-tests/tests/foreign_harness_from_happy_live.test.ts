import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createAgentGym, type AgentGym, type GymAgentHistory } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Happy's own loop starting an Antigravity sub-agent: it reads its options, creates the
 * collaborator on the foreign harness without naming one, and hears when its options change. Opt
 * in with HAPPY_ACP_LIVE=from-happy and a Claude login in HAPPY_ACP_CLAUDE_OAUTH_TOKEN;
 * Antigravity uses its own login.
 */
const TURN_MS = 240_000;
const live = (process.env.HAPPY_ACP_LIVE ?? "").split(",").map((v) => v.trim());
const token = process.env.HAPPY_ACP_CLAUDE_OAUTH_TOKEN;

const onHappy = { providerId: "live_claude", modelId: "anthropic/sonnet-5-5", effort: "low" };

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

describe.skipIf(!live.includes("from-happy") || token === undefined)(
    "Happy starting foreign sub-agents, live",
    () => {
        let gym: AgentGym | undefined;
        afterEach(async ({ task }) => {
            if (gym !== undefined && task.result?.state === "fail") {
                for (const session of await gym.listSessions().catch(() => [])) {
                    const history = await gym.history(session.id).catch(String);
                    console.log(`HISTORY from-happy ${session.id}`, JSON.stringify(history));
                }
            }
            await gym?.dispose();
            gym = undefined;
        }, 60_000);

        it(
            "reads its options, starts an Antigravity collaborator, and hears when options change",
            async () => {
                gym = await createAgentGym({
                    config: [
                        "[providers.live_claude]",
                        'type = "claude"',
                        "enabled = true",
                        `oauth_token = "${token}"`,
                        "[harnesses.claude_code]",
                        "enabled = false",
                        'providers = ["live_claude"]',
                        "[harnesses.antigravity]",
                        "",
                    ].join("\n"),
                    liveProviders: ["live_claude", "antigravity"],
                    permissionMode: "full_access",
                    timeoutMs: TURN_MS,
                });

                await gym.send(
                    "Call the Happy tool agent_options with usage true. Then call create_agent with model " +
                        '"antigravity/gemini-3.8-flash", effort "low", title "Plum probe", and text ' +
                        '"Reply with only the word PLUM-SEVEN." Pass no harness and no provider. ' +
                        "Then reply with only the harness IDs agent_options listed, comma separated.",
                    onHappy,
                );
                const first = await gym.history();
                const calls = agentBlocks(first).filter((block) => block.type === "tool_call");
                expect(calls.map((call) => call.name)).toEqual(
                    expect.arrayContaining(["agent_options", "create_agent"]),
                );
                // Happy reaches every enabled harness, and only those.
                expect(lastText(first)).toContain("antigravity");
                expect(lastText(first)).not.toContain("claude_code");
                // Antigravity's own quota report, on request.
                expect(JSON.stringify(calls.find((call) => call.name === "agent_options"))).toMatch(
                    /antigravity: .*\d+%/u,
                );
                const childId = calls.find((call) => call.name === "create_agent")?.presentation
                    ?.agentId;
                expect(childId, "the collaborator was created").toBeDefined();
                await gym.waitUntil(
                    async () => {
                        const child = await gym!.history(childId).catch(() => undefined);
                        return child !== undefined && lastText(child).includes("PLUM-SEVEN")
                            ? child
                            : undefined;
                    },
                    "the Antigravity collaborator to answer",
                    TURN_MS,
                );
                // The foreign session is recorded once the collaborator's turn settles.
                const recordPath = join(
                    gym.happyHome,
                    "agent",
                    "foreign-agents",
                    "antigravity",
                    "sessions",
                    `${encodeURIComponent(childId!)}.json`,
                );
                const record = await gym.waitUntil(
                    async () =>
                        (await readFile(recordPath, "utf8")
                            .then((text) => JSON.parse(text) as { consumed: number })
                            .catch(() => undefined)) ?? undefined,
                    "the Antigravity session record",
                    TURN_MS,
                );
                expect(record.consumed).toBeGreaterThanOrEqual(1);

                // Turn Claude Code on; the agent hears it as a notice, not a tool change.
                const configPath = join(gym.publicHomePath, "Config", "happy.toml");
                await writeFile(
                    configPath,
                    (await readFile(configPath, "utf8")).replace(
                        "[harnesses.claude_code]\nenabled = false\n",
                        "[harnesses.claude_code]\n",
                    ),
                );
                await gym.restart();
                await gym.send(
                    "Without calling any tool, list the harness IDs you can create sub-agents on " +
                        "now, comma separated, and nothing else.",
                    onHappy,
                );
                const second = await gym.history();
                // The notice is hidden from the transcript, so the answer is the evidence: the
                // agent knew without asking again.
                expect(lastText(second)).toContain("claude_code");
                const latest = second.runs.at(-1)!;
                expect(
                    latest.messages
                        .flatMap((message) =>
                            message.role === "agent" ? (message.content as readonly Block[]) : [],
                        )
                        .filter((block) => block.type === "tool_call"),
                ).toEqual([]);
                expect(gym.errors).toEqual([]);
            },
            TURN_MS * 4,
        );
    },
);
