// A scripted ACP agent for AcpSession tests. It speaks real ACP over stdio and calls Happy's
// tools through the real MCP bridge it is given. Every request it receives is appended to the
// JSON-lines file named by SCRIPTED_ACP_LOG so a test can assert what was sent.
//
// Prompt directives: "use happy" calls the bridged happy_secret tool and replies with its answer;
// "wait" holds the prompt open until cancelled or steered; "throttled" is refused as too many
// requests the first time it is sent, and "throttled late" only after reporting a tool call;
// "over quota" fails with a 429 that names a weekly limit; "stubborn" never ends its first prompt;
// "needs permission" asks the client before a command, and "needs permission for happy" before a
// bridged happy_secret call (with "only always", offering no one-time allow), then replies with
// the option it got; anything else is echoed back.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";

import * as acp from "@agentclientprotocol/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const log = (entry) =>
    appendFileSync(
        process.env.SCRIPTED_ACP_LOG,
        `${JSON.stringify({ ...entry, pid: process.pid })}\n`,
    );
const sessionsFile = `${process.env.SCRIPTED_ACP_LOG}.sessions`;
const stubbornFile = `${process.env.SCRIPTED_ACP_LOG}.stubborn`;
const failedFile = `${process.env.SCRIPTED_ACP_LOG}.failed`;
const known = () =>
    existsSync(sessionsFile) ? JSON.parse(readFileSync(sessionsFile, "utf8")) : {};

class ScriptedAgent {
    #conn;
    #servers = new Map();
    #cancelled = new Map();
    #throttled = false;

    constructor(conn) {
        this.#conn = conn;
    }

    async initialize() {
        return {
            protocolVersion: acp.PROTOCOL_VERSION,
            agentCapabilities: { loadSession: true, mcpCapabilities: { http: true, sse: false } },
        };
    }

    async newSession(params) {
        const sessionId = `s${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
        this.#servers.set(sessionId, params.mcpServers);
        writeFileSync(sessionsFile, JSON.stringify({ ...known(), [sessionId]: true }));
        log({
            method: "newSession",
            sessionId,
            mcpServers: params.mcpServers.length,
            approvedTools: params._meta?.["happy/approvedTools"],
        });
        return {
            sessionId,
            configOptions: [
                {
                    id: "model",
                    name: "Model",
                    category: "model",
                    type: "select",
                    currentValue: "m1",
                    options: [
                        { value: "m1", name: "Model One" },
                        {
                            group: "more",
                            name: "More",
                            options: [{ value: "m2-high", name: "Model Two (High)" }],
                        },
                    ],
                },
            ],
        };
    }

    async loadSession(params) {
        if (known()[params.sessionId] !== true)
            throw acp.RequestError.resourceNotFound(params.sessionId);
        this.#servers.set(params.sessionId, params.mcpServers);
        log({ method: "loadSession", sessionId: params.sessionId });
        // A real agent replays history here; the client must ignore it.
        await this.#say(params.sessionId, "REPLAYED-HISTORY");
        return {};
    }

    async setSessionConfigOption(params) {
        log({ method: "setSessionConfigOption", configId: params.configId, value: params.value });
        return { configOptions: [] };
    }

    async authenticate() {
        return {};
    }

    // "_happy/steer" hands text to a waiting prompt, standing in for a vendor's mid-turn input.
    async extMethod(method, params) {
        log({ method, sessionId: params.sessionId, text: params.text });
        const waiting = this.#cancelled.get(params.sessionId);
        this.#cancelled.delete(params.sessionId);
        waiting?.(params.text);
        return { taken: waiting !== undefined };
    }

    async prompt(params) {
        const text = params.prompt
            .map((block) => (block.type === "text" ? block.text : ""))
            .join("\n");
        log({ method: "prompt", sessionId: params.sessionId, text });
        if (text.includes("over quota")) {
            throw new Error(
                "exceeded retry limit, last status: 429 Too Many Requests: usage_limit_reached, You've hit your weekly limit · resets Oct 21 at 6pm",
            );
        }
        if (text.includes("throttled") && !text.includes("late") && !this.#throttled) {
            this.#throttled = true;
            throw new Error("exceeded retry limit, last status: 429 Too Many Requests");
        }
        await this.#conn.sessionUpdate({
            sessionId: params.sessionId,
            update: {
                sessionUpdate: "tool_call",
                toolCallId: `own-${Date.now()}`,
                title: "Read README.md",
                kind: "read",
                status: "completed",
                content: [{ type: "content", content: { type: "text", text: "# readme" } }],
            },
        });
        if (text.includes("throttled late")) {
            throw new Error("exceeded retry limit, last status: 429 Too Many Requests");
        }
        if (text.includes("fail late") && !existsSync(failedFile)) {
            writeFileSync(failedFile, "");
            throw new Error("internal agent error after update");
        }
        // "stubborn" holds the first such prompt open and ignores cancellation, as an agent that
        // saves a new session only when its prompt ends can be stopped before saving it.
        if (text.includes("stubborn") && !existsSync(stubbornFile)) {
            writeFileSync(stubbornFile, "");
            await new Promise(() => undefined);
        }
        if (text.includes("needs permission")) {
            const happy = text.includes("for happy");
            const answer = await this.#conn.requestPermission({
                sessionId: params.sessionId,
                toolCall: {
                    toolCallId: `ask-${Date.now()}`,
                    title: happy ? "Call happy_secret" : "rm -rf build",
                    kind: happy ? "other" : "execute",
                    rawInput: happy ? { why: "test" } : { command: "rm -rf build" },
                    ...(happy
                        ? {
                              _meta: {
                                  "happy/bridgedCall": {
                                      name: "happy_secret",
                                      arguments: { why: "test" },
                                  },
                              },
                          }
                        : {}),
                },
                options: [
                    ...(text.includes("only always")
                        ? []
                        : [{ optionId: "yes", name: "Allow", kind: "allow_once" }]),
                    { optionId: "always", name: "Always allow", kind: "allow_always" },
                    { optionId: "no", name: "Deny", kind: "reject_once" },
                ],
            });
            const chosen =
                answer.outcome.outcome === "selected" ? answer.outcome.optionId : "cancelled";
            log({ method: "permission", chosen });
            await this.#say(params.sessionId, `permission=${chosen}`);
            return { stopReason: "end_turn" };
        }
        if (text.includes("wait")) {
            const steered = await new Promise((resolve) =>
                this.#cancelled.set(params.sessionId, resolve),
            );
            if (typeof steered !== "string") return { stopReason: "cancelled" };
            await this.#say(params.sessionId, `steered:${steered}`);
            return { stopReason: "end_turn" };
        }
        if (text.includes("use happy")) {
            const server = this.#servers.get(params.sessionId)?.[0];
            const client = new Client({ name: "scripted", version: "1" });
            await client.connect(
                new StreamableHTTPClientTransport(new URL(server.url), {
                    requestInit: {
                        headers: Object.fromEntries(server.headers.map((h) => [h.name, h.value])),
                    },
                }),
            );
            const tools = await client.listTools();
            log({
                method: "mcp.listTools",
                names: tools.tools.map((tool) => tool.name),
                schemas: tools.tools.map((tool) => tool.inputSchema),
            });
            const result = await client.callTool({
                name: "happy_secret",
                arguments: { why: "test" },
            });
            await client.close();
            await this.#say(params.sessionId, `secret=${result.content[0].text}`);
            return { stopReason: "end_turn" };
        }
        await this.#say(params.sessionId, `echo:${text}`);
        return {
            stopReason: "end_turn",
            usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 },
        };
    }

    async cancel(params) {
        log({ method: "cancel", sessionId: params.sessionId });
        this.#cancelled.get(params.sessionId)?.();
    }

    async #say(sessionId, text) {
        await this.#conn.sessionUpdate({
            sessionId,
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
        });
    }
}

const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
new acp.AgentSideConnection((conn) => new ScriptedAgent(conn), stream);
