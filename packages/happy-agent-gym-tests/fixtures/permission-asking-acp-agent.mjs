// A minimal ACP agent with a permission system of its own, speaking JSON-RPC over stdio without
// any SDK. A prompt naming "granted.txt" asks the client before writing that file in the session's
// folder, writes it with the chosen option when allowed, and replies `permission=<option>`; a
// cancelled ask is recorded in `cancelled.txt` instead. "PRESENT=<path>" asks before calling Happy's
// present_files on that path and replies `permission=<option>`. Anything else is echoed back.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const sessions = new Map();
const waiting = new Map();
let nextId = 1;

const request = (method, params) =>
    new Promise((resolve) => {
        const id = `agent-${nextId++}`;
        waiting.set(id, resolve);
        send({ id, method, params });
    });

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

async function prompt(params) {
    const cwd = sessions.get(params.sessionId);
    const text = params.prompt.map((block) => (block.type === "text" ? block.text : "")).join("");
    const presented = /PRESENT=(\S+)/.exec(text)?.[1];
    if (presented !== undefined) {
        const filepaths = [presented];
        const answer = await request("session/request_permission", {
            sessionId: params.sessionId,
            toolCall: {
                toolCallId: `present-${nextId}`,
                title: "Call present_files",
                kind: "other",
                rawInput: { filepaths },
                _meta: { "happy/bridgedCall": { name: "present_files", arguments: { filepaths } } },
            },
            options: [
                { optionId: "once", name: "Allow", kind: "allow_once" },
                { optionId: "no", name: "Reject", kind: "reject_once" },
            ],
        });
        const outcome = answer.outcome;
        say(
            params.sessionId,
            `permission=${outcome.outcome === "selected" ? outcome.optionId : "cancelled"}`,
        );
        return { stopReason: "end_turn" };
    }
    if (!text.includes("granted.txt")) {
        say(params.sessionId, `echo:${text}`);
        return { stopReason: "end_turn" };
    }
    const answer = await request("session/request_permission", {
        sessionId: params.sessionId,
        toolCall: {
            toolCallId: `write-${nextId}`,
            title: "Write granted.txt",
            kind: "edit",
            rawInput: { path: "granted.txt" },
        },
        options: [
            { optionId: "once", name: "Allow", kind: "allow_once" },
            { optionId: "always", name: "Always allow", kind: "allow_always" },
            { optionId: "no", name: "Reject", kind: "reject_once" },
        ],
    });
    const outcome = answer.outcome;
    if (outcome.outcome === "cancelled") {
        writeFileSync(join(cwd, "cancelled.txt"), "cancelled");
        return { stopReason: "cancelled" };
    }
    if (outcome.optionId !== "no") writeFileSync(join(cwd, "granted.txt"), outcome.optionId);
    say(params.sessionId, `permission=${outcome.optionId}`);
    return { stopReason: "end_turn" };
}

async function handle(message) {
    switch (message.method) {
        case "initialize":
            return {
                protocolVersion: 1,
                agentCapabilities: { loadSession: false, mcpCapabilities: { http: true } },
            };
        case "session/new": {
            const sessionId = `s-${nextId++}`;
            sessions.set(sessionId, message.params.cwd);
            return { sessionId, configOptions: [MODELS] };
        }
        case "session/set_config_option":
            return { configOptions: [MODELS] };
        case "session/prompt":
            return await prompt(message.params);
        default:
            throw new Error(`Unhandled ${message.method}`);
    }
}

createInterface({ input: process.stdin }).on("line", (line) => {
    const message = JSON.parse(line);
    if (message.method === undefined) {
        waiting.get(message.id)?.(message.result ?? { outcome: { outcome: "cancelled" } });
        waiting.delete(message.id);
        return;
    }
    // Notifications such as session/cancel need no answer; the client cancels its own asks.
    if (message.id === undefined) return;
    handle(message).then(
        (result) => send({ id: message.id, result }),
        (error) => send({ id: message.id, error: { code: -32601, message: String(error) } }),
    );
});
