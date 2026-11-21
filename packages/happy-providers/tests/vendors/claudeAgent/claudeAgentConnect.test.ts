import { randomUUID } from "node:crypto";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type * as acp from "@agentclientprotocol/sdk";
import { Type } from "@sinclair/typebox";
import { afterEach, expect, it, vi } from "vitest";

import {
    ACP_APPROVED_TOOLS_META,
    ACP_BRIDGED_CALL_META,
    type AcpConnection,
} from "@/protocol/acp/AcpConnection.js";
import { AcpToolBridgeServer } from "@/protocol/acp/impl/AcpToolBridgeServer.js";
import {
    claudeAgentConnect,
    claudeAgentStoredSideQuestion,
} from "@/vendors/claudeAgent/claudeAgentConnect.js";

const SUMMARY = "SUMMARY OF EVERYTHING SO FAR";

const servers: Server[] = [];
const connections: AcpConnection[] = [];
afterEach(() => {
    for (const connection of connections.splice(0)) connection.terminate();
    for (const server of servers.splice(0)) server.close();
});

/**
 * Anthropic's Messages API as far as Claude Code needs it. Every prompt is `cached()` tokens of
 * cache plus 10 uncached ones until Claude Code compacts it to 5k; past 200k it is refused as the
 * real API refuses it.
 */
async function fakeMessagesApi(cached: () => number) {
    let summaries = 0;
    const server = createServer((request, response) => {
        let body = "";
        request.on("data", (chunk) => (body += chunk));
        request.on("end", () => {
            if (request.method !== "POST" || request.url?.split("?")[0] !== "/v1/messages") {
                response.writeHead(404).end();
                return;
            }
            const summarizing = body.includes("Your task is to create a detailed summary");
            const prompt = summarizing || body.includes(SUMMARY) ? 5_000 : cached();
            if (prompt > 200_000) {
                response.writeHead(400, { "content-type": "application/json" }).end(
                    JSON.stringify({
                        type: "error",
                        error: { type: "invalid_request_error", message: "prompt is too long" },
                    }),
                );
                return;
            }
            if (summarizing) summaries++;
            const text = summarizing ? `<summary>${SUMMARY}</summary>` : "ok";
            const events = [
                {
                    type: "message_start",
                    message: {
                        id: `msg_${Math.random()}`,
                        type: "message",
                        role: "assistant",
                        model: "claude-sonnet-4-5",
                        content: [],
                        stop_reason: null,
                        usage: {
                            input_tokens: 10,
                            cache_read_input_tokens: prompt,
                            cache_creation_input_tokens: 0,
                            output_tokens: 1,
                        },
                    },
                },
                {
                    type: "content_block_start",
                    index: 0,
                    content_block: { type: "text", text: "" },
                },
                { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
                { type: "content_block_stop", index: 0 },
                {
                    type: "message_delta",
                    delta: { stop_reason: "end_turn" },
                    usage: { output_tokens: 7 },
                },
                { type: "message_stop" },
            ];
            response.writeHead(200, { "content-type": "text/event-stream" });
            for (const event of events) {
                response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
            }
            response.end();
        });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return {
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        summaries: () => summaries,
    };
}

it("lets Claude Code compact its own context and reports the context it fills", async () => {
    let cached = 30_000;
    const api = await fakeMessagesApi(() => cached);
    const directory = mkdtempSync(join(tmpdir(), "claude-agent-connect-"));
    const connection = await claudeAgentConnect({
        ANTHROPIC_BASE_URL: api.url,
        ANTHROPIC_API_KEY: "sk-ant-test",
        CLAUDE_CONFIG_DIR: join(directory, "config"),
    })(directory, {
        requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
        sessionUpdate: async () => {},
    } as acp.Client);
    connections.push(connection);
    const { sessionId } = await connection.conn.newSession({ cwd: directory, mcpServers: [] });
    const turn = async (text: string) =>
        (await connection.conn.prompt({ sessionId, prompt: [{ type: "text", text }] })).usage;

    expect((await turn("first"))?.inputTokens).toBe(30_010);
    cached = 230_000;
    expect((await turn("second"))?.inputTokens).toBe(5_010);
    expect(api.summaries()).toBe(1);
}, 120_000);

/** The Messages API, calling `list_projects` and then `delete_artifact` before it answers. */
async function toolCallingMessagesApi() {
    const server = createServer((request, response) => {
        let body = "";
        request.on("data", (chunk) => (body += chunk));
        request.on("end", () => {
            if (request.method !== "POST" || request.url?.split("?")[0] !== "/v1/messages") {
                response.writeHead(404).end();
                return;
            }
            const loop = body.includes("mcp__happy__delete_artifact");
            const next = !loop
                ? undefined
                : !body.includes('"tool_use_id":"tu_list"')
                  ? { id: "tu_list", name: "mcp__happy__list_projects" }
                  : !body.includes('"tool_use_id":"tu_delete"')
                    ? { id: "tu_delete", name: "mcp__happy__delete_artifact" }
                    : undefined;
            const block =
                next === undefined
                    ? [
                          {
                              type: "content_block_start",
                              index: 0,
                              content_block: { type: "text", text: "" },
                          },
                          {
                              type: "content_block_delta",
                              index: 0,
                              delta: { type: "text_delta", text: "done" },
                          },
                      ]
                    : [
                          {
                              type: "content_block_start",
                              index: 0,
                              content_block: {
                                  type: "tool_use",
                                  id: next.id,
                                  name: next.name,
                                  input: {},
                              },
                          },
                          {
                              type: "content_block_delta",
                              index: 0,
                              delta: { type: "input_json_delta", partial_json: "{}" },
                          },
                      ];
            const events = [
                {
                    type: "message_start",
                    message: {
                        id: `msg_${Math.random()}`,
                        type: "message",
                        role: "assistant",
                        model: "claude-sonnet-4-5",
                        content: [],
                        stop_reason: null,
                        usage: { input_tokens: 10, output_tokens: 1 },
                    },
                },
                ...block,
                { type: "content_block_stop", index: 0 },
                {
                    type: "message_delta",
                    delta: { stop_reason: next === undefined ? "end_turn" : "tool_use" },
                    usage: { output_tokens: 7 },
                },
                { type: "message_stop" },
            ];
            response.writeHead(200, { "content-type": "text/event-stream" });
            for (const event of events) {
                response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
            }
            response.end();
        });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

it("runs Happy's approved tools without asking and marks an ask about another as Happy's", async () => {
    const url = await toolCallingMessagesApi();
    const ran: string[] = [];
    const parameters = Type.Object({});
    const bridge = await AcpToolBridgeServer.start(
        [
            { name: "list_projects", parameters, autoReview: "never" },
            { name: "delete_artifact", parameters },
        ],
        (call) => {
            ran.push(call.tool.name);
            call.resolve({ content: [{ type: "text", text: "ok" }] });
        },
    );
    try {
        const directory = mkdtempSync(join(tmpdir(), "claude-agent-connect-"));
        const asks: acp.RequestPermissionRequest[] = [];
        const connection = await claudeAgentConnect({
            ANTHROPIC_BASE_URL: url,
            ANTHROPIC_API_KEY: "sk-ant-test",
            CLAUDE_CONFIG_DIR: join(directory, "config"),
        })(directory, {
            requestPermission: async (params) => {
                asks.push(params);
                return { outcome: { outcome: "selected", optionId: "allow" } };
            },
            sessionUpdate: async () => {},
        } as acp.Client);
        connections.push(connection);
        const { sessionId } = await connection.conn.newSession({
            cwd: directory,
            mcpServers: [
                {
                    type: "http",
                    name: "happy",
                    url: bridge.url,
                    headers: Object.entries(bridge.headers).map(([name, value]) => ({
                        name,
                        value,
                    })),
                },
            ],
            _meta: { [ACP_APPROVED_TOOLS_META]: ["list_projects"] },
        });
        await connection.conn.prompt({ sessionId, prompt: [{ type: "text", text: "go" }] });

        expect(ran).toEqual(["list_projects", "delete_artifact"]);
        expect(asks).toHaveLength(1);
        expect(asks[0]!.toolCall._meta).toEqual({
            [ACP_BRIDGED_CALL_META]: { name: "delete_artifact", arguments: {} },
        });
    } finally {
        bridge.close();
    }
}, 120_000);

const SIDE_MARK = "SIDE-QUESTION-7F3A";
const SIDE_ANSWER = "SIDE-ANSWER-2C9E";

/** A response the Messages API really sent, kept under `tests/vendors/fixtures/`. */
interface RecordedResponse {
    readonly status: number;
    readonly headers: Record<string, string>;
    readonly body: unknown;
}

/**
 * The Messages API answering a side question — any request carrying `SIDE_MARK` — with
 * `SIDE_ANSWER` at once, or with `sideFailure` when given, and any other request with "ok", held
 * until `release` while `hold` is set. Every request body is kept, in order.
 */
async function sideQuestionMessagesApi(sideFailure?: RecordedResponse) {
    const bodies: string[] = [];
    const held: (() => void)[] = [];
    let hold = false;
    const server = createServer((request, response) => {
        let body = "";
        request.on("data", (chunk) => (body += chunk));
        request.on("end", () => {
            if (request.method !== "POST" || request.url?.split("?")[0] !== "/v1/messages") {
                response.writeHead(404).end();
                return;
            }
            bodies.push(body);
            const side = body.includes(SIDE_MARK);
            if (side && sideFailure !== undefined) {
                response
                    .writeHead(sideFailure.status, sideFailure.headers)
                    .end(JSON.stringify(sideFailure.body));
                return;
            }
            const answer = (): void => {
                const events = [
                    {
                        type: "message_start",
                        message: {
                            id: `msg_${Math.random()}`,
                            type: "message",
                            role: "assistant",
                            model: "claude-sonnet-4-5",
                            content: [],
                            stop_reason: null,
                            usage: { input_tokens: 10, output_tokens: 1 },
                        },
                    },
                    {
                        type: "content_block_start",
                        index: 0,
                        content_block: { type: "text", text: "" },
                    },
                    {
                        type: "content_block_delta",
                        index: 0,
                        delta: { type: "text_delta", text: side ? SIDE_ANSWER : "ok" },
                    },
                    { type: "content_block_stop", index: 0 },
                    {
                        type: "message_delta",
                        delta: { stop_reason: "end_turn" },
                        usage: { output_tokens: 7 },
                    },
                    { type: "message_stop" },
                ];
                response.writeHead(200, { "content-type": "text/event-stream" });
                for (const event of events) {
                    response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
                }
                response.end();
            };
            if (hold && !side) held.push(answer);
            else answer();
        });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return {
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        bodies,
        hold: () => {
            hold = true;
        },
        release: () => {
            hold = false;
            for (const answer of held.splice(0)) answer();
        },
    };
}

/** Every file under `directory` with its bytes, by path. */
function filesUnder(directory: string): Map<string, string> {
    const files = new Map<string, string>();
    if (!existsSync(directory)) return files;
    for (const entry of readdirSync(directory, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const path = join(entry.parentPath, entry.name);
        files.set(path, readFileSync(path, "base64"));
    }
    return files;
}

/**
 * Real Claude Code against `api`, with its own configuration folder whose `SessionStart` hook
 * appends a line to `hook.log`, and a client that records everything Claude Code sends it.
 */
async function sideQuestionConnection(api: { readonly url: string }) {
    const directory = mkdtempSync(join(tmpdir(), "claude-agent-side-question-"));
    const config = join(directory, "config");
    const hookLog = join(directory, "hook.log");
    mkdirSync(config, { recursive: true });
    writeFileSync(
        join(config, "settings.json"),
        JSON.stringify({
            hooks: {
                SessionStart: [
                    { hooks: [{ type: "command", command: `echo started >> '${hookLog}'` }] },
                ],
            },
        }),
    );
    const environment = {
        ANTHROPIC_BASE_URL: api.url,
        ANTHROPIC_API_KEY: "sk-ant-test",
        CLAUDE_CONFIG_DIR: config,
    };
    const sent: string[] = [];
    const connection = await claudeAgentConnect(environment)(directory, {
        requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
        sessionUpdate: async (params) => {
            sent.push(params.update.sessionUpdate);
        },
        extNotification: async (method: string) => {
            sent.push(method);
        },
    } as acp.Client);
    connections.push(connection);
    const { sessionId } = await connection.conn.newSession({ cwd: directory, mcpServers: [] });
    const ask = async (question: string) =>
        await connection.conn.askSideQuestion?.({
            sessionId,
            question,
            history: [],
            signal: new AbortController().signal,
        });
    const hookRuns = (): number =>
        existsSync(hookLog) ? readFileSync(hookLog, "utf8").split("\n").filter(Boolean).length : 0;
    return { directory, config, environment, connection, sessionId, sent, ask, hookRuns };
}

it("answers a side question beside the conversation, which never sees it", async () => {
    const api = await sideQuestionMessagesApi();
    const { config, connection, sessionId, sent, ask } = await sideQuestionConnection(api);
    await connection.conn.prompt({ sessionId, prompt: [{ type: "text", text: "FIRST-PROMPT" }] });
    const transcript = filesUnder(join(config, "projects"));
    const reported = sent.length;

    const answer = await ask(`${SIDE_MARK} What did I ask you?`);

    expect(answer).toEqual({ response: SIDE_ANSWER, synthetic: false });
    // Claude Code answered from the conversation as it stood.
    expect(api.bodies.at(-1)).toContain("FIRST-PROMPT");
    // Nothing of it reached the client, the transcript, or the next turn.
    expect(sent).toHaveLength(reported);
    expect(filesUnder(join(config, "projects"))).toEqual(transcript);
    await connection.conn.prompt({ sessionId, prompt: [{ type: "text", text: "SECOND-PROMPT" }] });
    const next = api.bodies.at(-1)!;
    expect(next).toContain("SECOND-PROMPT");
    expect(next).not.toContain(SIDE_MARK);
    expect(next).not.toContain(SIDE_ANSWER);
}, 120_000);

it("answers a side question while a turn runs, which goes on undisturbed", async () => {
    const api = await sideQuestionMessagesApi();
    const { connection, sessionId, ask } = await sideQuestionConnection(api);
    await connection.conn.prompt({ sessionId, prompt: [{ type: "text", text: "FIRST-PROMPT" }] });
    api.hold();
    const turn = connection.conn.prompt({
        sessionId,
        prompt: [{ type: "text", text: "LONG-JOB" }],
    });
    await vi.waitFor(() => expect(api.bodies.at(-1)).toContain("LONG-JOB"), { timeout: 60_000 });

    expect(await ask(`${SIDE_MARK} How far along are you?`)).toEqual({
        response: SIDE_ANSWER,
        synthetic: false,
    });

    api.release();
    expect((await turn).stopReason).toBe("end_turn");
}, 120_000);

it("answers about a stored session in a separate Claude Code that neither continues, keeps nor hooks it", async () => {
    const api = await sideQuestionMessagesApi();
    const { directory, config, environment, connection, sessionId, hookRuns } =
        await sideQuestionConnection(api);
    await connection.conn.prompt({ sessionId, prompt: [{ type: "text", text: "FIRST-PROMPT" }] });
    connection.terminate();
    // Its process is gone before anything is compared, so nothing it writes on the way out counts.
    await vi.waitFor(() => expect(connection.processGroups()).toEqual([]), { timeout: 60_000 });
    // The person's hook runs for their own session, so it would run for this one if it could.
    const hooked = hookRuns();
    expect(hooked).toBeGreaterThan(0);
    const stored = filesUnder(join(config, "projects"));

    const answer = await claudeAgentStoredSideQuestion(environment, {
        sessionId,
        cwd: directory,
        question: `${SIDE_MARK} What did I ask you?`,
        history: [],
        signal: new AbortController().signal,
        options: [],
    });

    expect(answer).toEqual({ response: SIDE_ANSWER, synthetic: false });
    expect(api.bodies.at(-1)).toContain("FIRST-PROMPT");
    expect(filesUnder(join(config, "projects"))).toEqual(stored);
    expect(hookRuns()).toBe(hooked);
}, 120_000);

it("answers a side question the Messages API refuses with Claude Code's canned reply saying so", async () => {
    const recorded = JSON.parse(
        readFileSync(
            new URL("../fixtures/claude-usage-rate-limit-429.json", import.meta.url),
            "utf8",
        ),
    ) as RecordedResponse;
    const api = await sideQuestionMessagesApi(recorded);
    const { connection, sessionId, ask } = await sideQuestionConnection(api);
    await connection.conn.prompt({ sessionId, prompt: [{ type: "text", text: "FIRST-PROMPT" }] });

    // Not a failure: Claude Code turns the refusal into a reply of its own, at once, which
    // carries the API's message ("(API error: Request rejected (429)  Rate limited.)").
    expect(await ask(`${SIDE_MARK} Anything?`)).toEqual({
        response: expect.stringContaining("Rate limited."),
        synthetic: true,
    });
    expect(api.bodies.filter((body) => body.includes(SIDE_MARK))).toHaveLength(1);
}, 120_000);

it("fails a side question about a session Claude Code does not have", async () => {
    const api = await sideQuestionMessagesApi();
    const { directory, environment } = await sideQuestionConnection(api);

    await expect(
        claudeAgentStoredSideQuestion(environment, {
            sessionId: randomUUID(),
            cwd: directory,
            question: `${SIDE_MARK} Anything?`,
            history: [],
            signal: new AbortController().signal,
            options: [],
        }),
    ).rejects.toThrow("Claude Code no longer has this conversation.");
}, 120_000);
