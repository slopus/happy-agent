// A minimal ACP agent with no tools of its own, standing in for Antigravity as Happy runs it: it
// works only through the Happy MCP server it is given. "RUN=<command>" runs the command with
// Happy's Bash and replies `tools=<names it was offered>` and `bash=<result>`; "ESCALATE=<command>"
// asks for that run outside the sandbox. A tool the server lists only through call_tool is run
// through call_tool, as Antigravity does. Anything else is echoed back.
import { createInterface } from "node:readline";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const servers = new Map();

const say = (sessionId, text) =>
    send({
        method: "session/update",
        params: {
            sessionId,
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
        },
    });

const MODELS = {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "m1",
    options: [{ value: "m1", name: "Model One" }],
};

async function happy(sessionId) {
    const server = servers.get(sessionId).find((candidate) => candidate.name === "happy");
    const client = new Client({ name: "happy-tools-only", version: "1" });
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
    const run = /(RUN|ESCALATE)=(.+)$/m.exec(text);
    if (run === null) {
        say(params.sessionId, `echo:${text}`);
        return { stopReason: "end_turn" };
    }
    const client = await happy(params.sessionId);
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    const callTool = tools.find((tool) => tool.name === "call_tool");
    const offered = [...names, ...(callTool === undefined ? [] : [callTool.description])].join(",");
    const args = { command: run[2], ...(run[1] === "ESCALATE" ? { dangerouslyDisableSandbox: true } : {}) };
    const result = names.includes("Bash")
        ? await client.callTool({ name: "Bash", arguments: args })
        : await client.callTool({ name: "call_tool", arguments: { name: "Bash", arguments: args } });
    await client.close();
    say(
        params.sessionId,
        `tools=${offered}\nbash=${result.isError === true ? "error:" : ""}${result.content.map((block) => block.text ?? "").join("")}`,
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
            reply({
                protocolVersion: 1,
                agentCapabilities: { mcpCapabilities: { http: true } },
            });
            return;
        case "session/new": {
            const sessionId = `s${Date.now()}`;
            servers.set(sessionId, message.params.mcpServers);
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
