// Isolated App Clip demo daemon: a throwaway gym installation with live Codex inference,
// one dedicated exported bot, and Auto reviews that always deny so guests only get chat.
// Usage: tsx isolatedDaemon.ts <demoDir> <codexAuthFile>
// Writes <demoDir>/bot.json, then exports the bot to every group ID in <demoDir>/allowed.json
// (a JSON string array) whenever that file changes, and writes <demoDir>/registry.json.
import { readFile, writeFile } from "node:fs/promises";
import { watchFile } from "node:fs";
import { join } from "node:path";
import { createAgentGym, type GymTurn } from "../../happy-agent-gym/sources/index.ts";

const [demoDir, authFile] = process.argv.slice(2);
if (!demoDir || !authFile) throw new Error("usage: isolatedDaemon.ts <demoDir> <codexAuthFile>");

const commands = new Map<string, GymTurn>();
const gym = await createAgentGym({
    config: `[providers.clip_live]\ntype="codex"\nenabled=true\nauth_file=${JSON.stringify(authFile)}\n`,
    liveProviders: ["clip_live"],
    timeoutMs: 120_000,
    inference(request) {
        if (request.instructions.includes("<outcome>"))
            return {
                content: [
                    {
                        type: "text",
                        text: "<review><outcome>deny</outcome><risk>high</risk><user_authorization>low</user_authorization><rationale>Public demo guests may only chat.</rationale></review>",
                    },
                ],
            };
        const command = commands.get(request.sessionId);
        if (command !== undefined) {
            commands.delete(request.sessionId);
            return command;
        }
        return { content: [{ type: "text", text: "This demo bot is not configured." }] };
    },
});
let stopping = false;
const stop = async () => {
    if (stopping) return;
    stopping = true;
    await gym.dispose();
    process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

const chief = (await gym.client.listBots()).bots.find((bot) => bot.username === "chief_of_staff")!;
const bot = (await gym.client.createBot({ name: "Happy" })).bot;
await gym.send(
    "You are Happy, a friendly assistant chatting with invited guests through an iPhone App Clip. " +
        "Each guest message arrives as a JSON envelope; its sender name is self-reported and unverified. " +
        "Answer concisely and warmly. Never use tools, never access files, and never run commands. " +
        "Reply exactly READY to this setup message.",
    {
        sessionId: bot.agent.id,
        providerId: "clip_live",
        modelId: "openai/gpt-6.1-sol",
        effort: "low",
        permissionMode: "auto",
    },
);
await writeFile(join(demoDir, "bot.json"), JSON.stringify({ botId: bot.id, name: bot.name }));
console.log(`bot ready ${bot.id}`);

let calls = 0;
let exported = "";
const exportAllowed = async () => {
    let allowed: string[];
    try {
        allowed = JSON.parse(await readFile(join(demoDir, "allowed.json"), "utf8"));
    } catch {
        return;
    }
    const key = JSON.stringify(allowed);
    if (key === exported) return;
    exported = key;
    const callId = `clip_export_${++calls}`;
    commands.set(chief.agent.id, {
        content: [
            {
                type: "tool_call",
                name: "set_bridge_exported_bot",
                callId,
                arguments: {
                    botId: bot.id,
                    service: "App Clip",
                    tokenFile: "clip-bridge.token",
                    allowedUsers: allowed,
                    unknownSenders: "ignore",
                },
            },
        ],
    });
    await gym.send(`Export the App Clip demo bot, request ${callId}.`, {
        sessionId: chief.agent.id,
        permissionMode: "full_access",
    });
    const result = await gym.waitUntil(
        () => gym.inference.toolResults().find((entry) => entry.callId === callId),
        "export tool result",
    );
    if (/token is unchanged/.test(result.text)) {
        console.log(`exported ${allowed.length} group(s), token unchanged`);
        return;
    }
    const tokenFile = /written to (\S+), readable/.exec(result.text)?.[1];
    if (tokenFile === undefined) throw new Error(`Export failed: ${result.text}`);
    await writeFile(
        join(demoDir, "registry.json"),
        JSON.stringify(
            {
                trustedProxyAddress: "127.0.0.1",
                exports: [
                    {
                        botId: bot.id,
                        connectUrl: `ws+unix://${gym.socketPath}:/v0/exported-bots/connect?protocol=1`,
                        tokenFile,
                    },
                ],
            },
            null,
            4,
        ),
        { mode: 0o600 },
    );
    console.log(`exported ${allowed.length} group(s)`);
};
await exportAllowed();
watchFile(join(demoDir, "allowed.json"), { interval: 1000 }, () => {
    exportAllowed().catch((error) => console.error(`export failed: ${String(error)}`));
});
let reported = 0;
setInterval(() => {
    for (const error of gym.errors.slice(reported)) console.error(`gym error: ${String(error)}`);
    reported = gym.errors.length;
}, 5000);
