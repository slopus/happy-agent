// Stands in for `agy acp` as Happy starts it: `--agent <name> --add-dir <folder> --log-file <file>`,
// with the agent file Happy wrote in that folder. An agent whose file keeps no tools of agy's own
// is Happy's permission reviewer: it lists the Happy tools it was given and answers every review
// with a denial naming them and its agent file's tools line. Any other agent runs "ESCALATE=<cmd>"
// with Happy's Bash outside the sandbox and replies `bash=<result>`; anything else is echoed.
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const args = process.argv.slice(2);
const flag = (name) => args[args.indexOf(name) + 1];
const agentFile = join(flag("--add-dir"), ".agents", "agents", flag("--agent"), "agent.md");
const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const servers = new Map();
const MODELS = {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "fixture",
    options: [{ value: "fixture", name: "Fixture" }],
};

const say = (sessionId, text) =>
    send({
        method: "session/update",
        params: {
            sessionId,
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
        },
    });

async function happy(sessionId) {
    const server = servers.get(sessionId).find((candidate) => candidate.name === "happy");
    const client = new Client({ name: "fake-agy", version: "1" });
    await client.connect(
        new StreamableHTTPClientTransport(new URL(server.url), {
            requestInit: {
                headers: Object.fromEntries(server.headers.map((header) => [header.name, header.value])),
            },
        }),
    );
    return client;
}

async function prompt(params) {
    const text = params.prompt.map((block) => (block.type === "text" ? block.text : "")).join("");
    const file = readFileSync(agentFile, "utf8");
    if (file.includes("tools: []")) {
        const client = await happy(params.sessionId);
        const { tools } = await client.listTools();
        await client.close();
        const names = tools.map((tool) => tool.name).join(",");
        say(
            params.sessionId,
            `<review><risk_level>high</risk_level><user_authorization>low</user_authorization><outcome>deny</outcome><rationale>agy reviewer; tools=${names}</rationale></review>`,
        );
        return { stopReason: "end_turn" };
    }
    const run = /ESCALATE=(.+)$/m.exec(text);
    if (run === null) {
        say(params.sessionId, `echo:${text}`);
        return { stopReason: "end_turn" };
    }
    const client = await happy(params.sessionId);
    const { tools } = await client.listTools();
    const bash = { command: run[1], dangerouslyDisableSandbox: true };
    const result = tools.some((tool) => tool.name === "Bash")
        ? await client.callTool({ name: "Bash", arguments: bash })
        : await client.callTool({ name: "call_tool", arguments: { name: "Bash", arguments: bash } });
    await client.close();
    say(
        params.sessionId,
        `bash=${result.isError === true ? "error:" : ""}${result.content.map((block) => block.text ?? "").join("")}`,
    );
    return { stopReason: "end_turn" };
}

createInterface({ input: process.stdin }).on("line", (line) => {
    if (line.trim().length === 0) return;
    const message = JSON.parse(line);
    if (message.method === undefined) return;
    const reply = (result) => send({ id: message.id, result });
    switch (message.method) {
        case "initialize":
            reply({ protocolVersion: 1, agentCapabilities: {} });
            return;
        case "session/new": {
            const sessionId = `s${Date.now()}${Math.random()}`;
            servers.set(sessionId, message.params.mcpServers);
            // Happy reads the log after a session opens to make sure its agent was loaded.
            appendFileSync(flag("--log-file"), `loaded ${flag("--agent")}\n`);
            reply({ sessionId, configOptions: [MODELS] });
            return;
        }
        case "session/set_config_option":
            reply({ configOptions: [MODELS] });
            return;
        case "session/prompt":
            void prompt(message.params).then(reply, (error) =>
                send({ id: message.id, error: { code: -32603, message: String(error) } }),
            );
            return;
        case "session/cancel":
            return;
        default:
            send({ id: message.id, error: { code: -32601, message: "Method not found" } });
    }
});
