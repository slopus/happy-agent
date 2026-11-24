import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { createAgentGym, type AgentGym, type GymAgentHistory } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Signed and encrypted reasoning through a real daemon restart, on each native vendor. Every
 * conversation thinks and runs a shell command, the daemon restarts on the same folder, and the
 * next turn must replay the stored history, reasoning included, to a fresh provider session and
 * still know what the first turn did. Opt in with HAPPY_REPLAY_LIVE=1 and any of
 * HAPPY_REPLAY_LIVE_CLAUDE_OAUTH_TOKEN, HAPPY_REPLAY_LIVE_CODEX_AUTH_FILE, and
 * HAPPY_REPLAY_LIVE_GROK_API_KEY; a vendor without its credential is skipped.
 */
const TURN_MS = 300_000;
const enabled = process.env.HAPPY_REPLAY_LIVE === "1";
const claudeToken = process.env.HAPPY_REPLAY_LIVE_CLAUDE_OAUTH_TOKEN;
const codexAuthFile = process.env.HAPPY_REPLAY_LIVE_CODEX_AUTH_FILE;
const grokApiKey = process.env.HAPPY_REPLAY_LIVE_GROK_API_KEY;

interface Vendor {
    readonly name: string;
    readonly config: string;
    readonly selection: { readonly providerId: string; readonly modelId: string; effort: string };
}

const vendors: Vendor[] = [
    ...(claudeToken === undefined
        ? []
        : [
              {
                  name: "claude",
                  config: `[providers.live_claude]\ntype = "claude"\nenabled = true\noauth_token = "${claudeToken}"\n`,
                  selection: {
                      providerId: "live_claude",
                      modelId: "anthropic/sonnet-5-5",
                      effort: "medium",
                  },
              },
          ]),
    ...(codexAuthFile === undefined
        ? []
        : [
              {
                  name: "codex",
                  config: `[providers.live_codex]\ntype = "codex"\nenabled = true\nauth_file = "${codexAuthFile}"\n`,
                  selection: {
                      providerId: "live_codex",
                      modelId: "openai/gpt-6.2-sol",
                      effort: "medium",
                  },
              },
          ]),
    ...(grokApiKey === undefined
        ? []
        : [
              {
                  name: "grok",
                  config: `[providers.live_grok]\ntype = "grok"\nenabled = true\napi_key = "${grokApiKey}"\nbase_url = "https://api.x.ai/v1"\n`,
                  selection: { providerId: "live_grok", modelId: "xai/grok-4.7", effort: "high" },
              },
          ]),
];

interface Block {
    readonly type: string;
    readonly text?: string;
}

function blocks(history: GymAgentHistory): Block[] {
    return history.runs.flatMap((run) =>
        run.messages.flatMap((message) =>
            message.role === "agent" ? (message.content as readonly Block[]) : [],
        ),
    );
}

function lastText(history: GymAgentHistory): string {
    return (
        blocks(history)
            .filter((block) => block.type === "text")
            .map((block) => block.text ?? "")
            .at(-1) ?? ""
    );
}

/** Every stored file under the installation, searched for opaque reasoning payloads. */
async function storedText(root: string): Promise<string> {
    const parts: string[] = [];
    for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile()) continue;
        if (!/\.(db|sqlite|db-wal|sqlite-wal)$/.test(entry.name)) continue;
        parts.push((await readFile(join(entry.parentPath, entry.name))).toString("latin1"));
    }
    return parts.join("\n");
}

describe.skipIf(!enabled || vendors.length === 0)(
    "reasoning replays after a daemon restart, live",
    () => {
        let gym: AgentGym | undefined;
        afterEach(async ({ task }) => {
            if (gym !== undefined && task.result?.state === "fail") {
                for (const session of await gym.listSessions().catch(() => [])) {
                    console.log(
                        `HISTORY restart ${session.id}`,
                        JSON.stringify(await gym.history(session.id).catch(String)),
                    );
                }
            }
            await gym?.dispose();
            gym = undefined;
        }, 60_000);

        it(
            "continues every vendor's conversation after the daemon restarts",
            async () => {
                gym = await createAgentGym({
                    config: vendors.map((vendor) => vendor.config).join("\n"),
                    liveProviders: vendors.map((vendor) => vendor.selection.providerId),
                    permissionMode: "full_access",
                    timeoutMs: TURN_MS,
                });
                const sessions = new Map<string, string>();
                for (const [index, vendor] of vendors.entries()) {
                    sessions.set(
                        vendor.name,
                        index === 0
                            ? gym.defaultSessionId
                            : (await gym.createSession({ title: vendor.name })).id,
                    );
                }

                await Promise.all(
                    vendors.map(async (vendor) => {
                        await gym!.send(
                            "Think carefully about which is larger, 37*43 or 39*41. Then run the shell " +
                                `command \`echo RESTART-${vendor.name.toUpperCase()}-$((6*7))\` with your ` +
                                "shell tool. Reply with one line: the larger product and the command output.",
                            { ...vendor.selection, sessionId: sessions.get(vendor.name)! },
                        );
                    }),
                );
                const before = new Map<string, number>();
                for (const vendor of vendors) {
                    const history = await gym.history(sessions.get(vendor.name)!);
                    console.log(`TURN1 ${vendor.name}: ${lastText(history)}`);
                    expect(blocks(history).some((block) => block.type === "tool_call")).toBe(true);
                    before.set(vendor.name, history.runs.length);
                }

                const stored = await storedText(gym.happyHome);
                console.log(
                    `STORED encrypted_content=${stored.split("encrypted_content").length - 1} ` +
                        `signature-like=${stored.split('"reasoning":"').length - 1}`,
                );

                await gym.restart();

                await Promise.all(
                    vendors.map(async (vendor) => {
                        await gym!.send(
                            "Without running any command, reply with one line: the exact output of the " +
                                "shell command you ran earlier in this conversation, and the larger product.",
                            { ...vendor.selection, sessionId: sessions.get(vendor.name)! },
                        );
                    }),
                );
                for (const vendor of vendors) {
                    const history = await gym.history(sessions.get(vendor.name)!);
                    const reply = lastText(history);
                    console.log(`TURN2 ${vendor.name}: ${reply}`);
                    expect(history.runs.length).toBeGreaterThan(before.get(vendor.name)!);
                    expect(reply).toContain(`RESTART-${vendor.name.toUpperCase()}-42`);
                    expect(reply).toContain("1599");
                }
                expect(gym.errors).toEqual([]);
            },
            TURN_MS * 3,
        );
    },
);
