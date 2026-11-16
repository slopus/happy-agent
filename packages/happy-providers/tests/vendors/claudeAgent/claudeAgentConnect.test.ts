import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type * as acp from "@agentclientprotocol/sdk";
import * as claudeSdk from "@anthropic-ai/claude-agent-sdk";
import { Type } from "@sinclair/typebox";
import { afterEach, expect, it, vi } from "vitest";

import {
    ACP_APPROVED_TOOLS_META,
    ACP_BRIDGED_CALL_META,
    type AcpAgentClient,
    type AcpConnection,
    type AcpNativeCompaction,
} from "@/protocol/acp/AcpConnection.js";
import { AcpToolBridgeServer } from "@/protocol/acp/impl/AcpToolBridgeServer.js";
import {
    claudeAgentConnect,
    nativeClaudePermissionModes,
} from "@/vendors/claudeAgent/claudeAgentConnect.js";

vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => {
    const sdk = await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>();
    return { ...sdk, query: vi.fn(sdk.query) };
});

const SUMMARY = "SUMMARY OF EVERYTHING SO FAR";

const servers: Server[] = [];
const connections: AcpConnection[] = [];
const directories: string[] = [];
afterEach(async () => {
    for (const connection of connections.splice(0)) connection.terminate();
    for (const server of servers.splice(0)) server.close();
    vi.restoreAllMocks();
    await Promise.all(
        directories
            .splice(0)
            .map((directory) =>
                rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
            ),
    );
});
function fixtureDirectory(prefix: string): string {
    const directory = mkdtempSync(join(tmpdir(), prefix));
    directories.push(directory);
    return directory;
}

it("keeps root sessions within Claude Code's native permission modes", () => {
    expect(nativeClaudePermissionModes(0)).not.toContain("bypassPermissions");
    expect(nativeClaudePermissionModes(0)).toContain("default");
    expect(nativeClaudePermissionModes(501)).toContain("bypassPermissions");
});

it("reports a native startup failure before returning a dead session ID", async () => {
    vi.mocked(claudeSdk.query).mockImplementationOnce(({ options }) => {
        options?.stderr?.("fixture native startup refusal");
        let finish!: () => void;
        const ended = new Promise<void>((resolve) => {
            finish = resolve;
        });
        return {
            supportedModels: async () => {
                await ended;
                return [];
            },
            [Symbol.asyncIterator]() {
                return {
                    next: async () => {
                        finish();
                        return { done: true, value: undefined };
                    },
                };
            },
            close: () => {},
        } as unknown as claudeSdk.Query;
    });
    const connection = await claudeAgentConnect({})("/tmp", {
        requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
        sessionUpdate: async () => {},
    } as acp.Client);
    connections.push(connection);
    await expect(connection.conn.newSession({ cwd: "/tmp", mcpServers: [] })).rejects.toThrow(
        "fixture native startup refusal",
    );
});

/**
 * Anthropic's Messages API as far as Claude Code needs it. Every prompt is `cached()` tokens of
 * cache plus 10 uncached ones until Claude Code compacts it to 5k; past 200k it is refused as the
 * real API refuses it.
 */
async function fakeMessagesApi(
    cached: () => number,
    summary = SUMMARY,
    countControl?: { started(): void; wait: Promise<void> },
    wireLimit?: number,
) {
    let summaries = 0;
    const requests: string[] = [];
    const admission: { summarizing: boolean; tokens: number; accepted: boolean }[] = [];
    const server = createServer((request, response) => {
        let body = "";
        request.on("data", (chunk) => (body += chunk));
        request.on("end", async () => {
            if (
                request.method === "POST" &&
                request.url?.split("?")[0] === "/v1/messages/count_tokens"
            ) {
                countControl?.started();
                await countControl?.wait;
                response
                    .writeHead(200, { "content-type": "application/json" })
                    .end(JSON.stringify({ input_tokens: Math.ceil(body.length / 4) }));
                return;
            }
            if (request.method !== "POST" || request.url?.split("?")[0] !== "/v1/messages") {
                response.writeHead(404).end();
                return;
            }
            requests.push(body);
            const summarizing = body.includes("Your task is to create a detailed summary");
            const prompt =
                wireLimit === undefined
                    ? summarizing || body.includes(SUMMARY)
                        ? 5_000
                        : cached()
                    : Math.ceil(Buffer.byteLength(body, "utf8") / 4);
            const accepted = prompt <= (wireLimit ?? 200_000);
            admission.push({ summarizing, tokens: prompt, accepted });
            if (!accepted) {
                response.writeHead(400, { "content-type": "application/json" }).end(
                    JSON.stringify({
                        type: "error",
                        error: {
                            type: "invalid_request_error",
                            message: `prompt is too long: ${prompt} tokens > ${wireLimit ?? 200_000} maximum`,
                        },
                    }),
                );
                return;
            }
            if (summarizing) summaries++;
            const text = summarizing ? `<summary>${summary}</summary>` : "ok";
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
        requests,
        admission,
    };
}

it("rebuilds an account's long working exchange as native messages with paired tools", async () => {
    const api = await fakeMessagesApi(() => 10_000);
    const directory = fixtureDirectory("claude-native-replay-");
    const connection = await claudeAgentConnect({
        ANTHROPIC_BASE_URL: api.url,
        ANTHROPIC_API_KEY: "sk-ant-test",
        CLAUDE_CONFIG_DIR: join(directory, "config"),
    })(directory, {
        requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
        sessionUpdate: async () => {},
    });
    connections.push(connection);
    const messages: import("@/core/SessionContext.js").SessionMessage[] = [
        {
            role: "user",
            content: [{ type: "text", text: "Keep the workspace and do not restart the daemon." }],
        },
    ];
    for (let i = 0; i < 25; i++) {
        messages.push(
            {
                role: "assistant",
                content: [
                    {
                        type: "tool_call",
                        callId: `call_${i}`,
                        name: i % 2 === 0 ? "Bash" : "execute",
                        arguments: JSON.stringify(
                            i % 2 === 0
                                ? { command: "pwd" }
                                : {
                                      title: "Read the working directory",
                                      description: "Read the working directory",
                                      input: { command: "pwd" },
                                      paths: [],
                                  },
                        ),
                    },
                ],
            },
            { role: "tool", callId: `call_${i}`, content: [{ type: "text", text: `result ${i}` }] },
        );
    }
    messages.push({
        role: "assistant",
        content: [
            {
                type: "text",
                text: "The commands completed; the decision is to preserve the changes.",
            },
        ],
    });
    messages.push({ role: "user", content: [{ type: "text", text: "Continue the work." }] });
    const original = structuredClone(messages);
    const replayed = await connection.conn.replaySession!(
        { cwd: directory, mcpServers: [] },
        {
            context: { instructions: "Honor the recorded permission decisions.", messages },
        },
    );
    await connection.conn.prompt({ sessionId: replayed.sessionId, prompt: [] });
    const request = JSON.parse(api.requests.at(-1)!) as {
        messages: Array<{ role: string; content: Array<{ type: string; text?: string }> }>;
    };
    expect(
        request.messages.filter((message) => message.role === "assistant").length,
    ).toBeGreaterThan(10);
    expect(JSON.stringify(request)).not.toContain("conversation-so-far");
    expect(JSON.stringify(request)).toContain("tool_use");
    expect(JSON.stringify(request)).toContain("tool_result");
    // Old ACP snapshots used a portable tool name and argument envelope. They remain
    // historical pairs and are never dispatched while importing the native session.
    expect(JSON.stringify(request)).toContain('"name":"execute"');
    expect(api.requests).toHaveLength(1);
    expect(messages).toEqual(original);
}, 120_000);

it("checks an existing native session's new oversized input before sending it", async () => {
    const api = await fakeMessagesApi(() => 10_000);
    const directory = fixtureDirectory("claude-later-input-");
    const checkpoints: AcpNativeCompaction[] = [];
    const connection = await claudeAgentConnect({
        ANTHROPIC_BASE_URL: api.url,
        ANTHROPIC_API_KEY: "sk-ant-test",
        CLAUDE_CONFIG_DIR: join(directory, "config"),
    })(directory, {
        requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
        sessionUpdate: async () => {},
        contextCompacted: async ({ checkpoint }) => {
            checkpoints.push(checkpoint);
        },
    });
    connections.push(connection);
    const { sessionId } = await connection.conn.newSession({ cwd: directory, mcpServers: [] });
    await connection.conn.prompt({ sessionId, prompt: [{ type: "text", text: "Start here." }] });
    await expect(
        connection.conn.prompt({
            sessionId,
            prompt: [{ type: "text", text: "large pending input ".repeat(80_000) }],
        }),
    ).rejects.toMatchObject({ code: "context_compaction_required" });
    expect(api.requests.every((body) => !body.includes("large pending input"))).toBe(true);
    expect(api.summaries()).toBe(0);
    expect(checkpoints).toHaveLength(0);
    await expect(connection.conn.prompt({ sessionId, prompt: [] })).rejects.toThrow(
        "No Claude session",
    );
}, 120_000);

it("returns a cancelled native compaction without starting work when already aborted", async () => {
    const connection = await claudeAgentConnect({})(process.cwd(), {
        requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
        sessionUpdate: async () => {},
    });
    connections.push(connection);
    const context = oversizedExchange();
    const controller = new AbortController();
    controller.abort();
    await expect(
        connection.conn.compactSession!(
            { cwd: process.cwd(), mcpServers: [] },
            { context },
            controller.signal,
        ),
    ).resolves.toEqual({ status: "cancelled", context });
});

it("does not send inference when cancellation arrives during the token preflight", async () => {
    let release!: () => void;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
        started = resolve;
    });
    const wait = new Promise<void>((resolve) => {
        release = resolve;
    });
    const api = await fakeMessagesApi(() => 10_000, SUMMARY, { started, wait });
    const directory = fixtureDirectory("claude-count-cancel-");
    const connection = await claudeAgentConnect({
        ANTHROPIC_BASE_URL: api.url,
        ANTHROPIC_API_KEY: "sk-ant-test",
        CLAUDE_CONFIG_DIR: join(directory, "config"),
    })(directory, {
        requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
        sessionUpdate: async () => {},
    });
    connections.push(connection);
    const { sessionId } = await connection.conn.newSession({ cwd: directory, mcpServers: [] });
    const response = connection.conn.prompt({
        sessionId,
        prompt: [{ type: "text", text: "Never send after cancel." }],
    });
    await startedPromise;
    await connection.conn.cancel({ sessionId });
    release();
    await expect(response).resolves.toMatchObject({ stopReason: "cancelled" });
    expect(api.requests).toHaveLength(0);
}, 120_000);

it("refuses to replay an outstanding tool call before starting a native session", async () => {
    const connection = await claudeAgentConnect({})(process.cwd(), {
        requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
        sessionUpdate: async () => {},
    });
    connections.push(connection);
    await expect(
        connection.conn.replaySession!(
            { cwd: process.cwd(), mcpServers: [] },
            {
                context: {
                    instructions: "",
                    messages: [
                        {
                            role: "assistant",
                            content: [
                                {
                                    type: "tool_call",
                                    callId: "pending",
                                    name: "Bash",
                                    arguments: "{}",
                                },
                            ],
                        },
                    ],
                },
            },
        ),
    ).rejects.toThrow("outstanding tool results");
});

it("refuses oversized fixed instructions across repeated Continue and new account sessions", async () => {
    const api = await fakeMessagesApi(() => 10_000);
    const directory = fixtureDirectory("claude-fixed-context-");
    const connect = () =>
        claudeAgentConnect({
            ANTHROPIC_BASE_URL: api.url,
            ANTHROPIC_API_KEY: "sk-ant-test",
            CLAUDE_CONFIG_DIR: join(directory, "config"),
        })(directory, {
            requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
            sessionUpdate: async () => {},
        });
    for (let attempt = 0; attempt < 2; attempt++) {
        const connection = await connect();
        connections.push(connection);
        const { sessionId } = await connection.conn.replaySession!(
            { cwd: directory, mcpServers: [] },
            {
                context: {
                    instructions: "irreducible instructions ".repeat(200_000),
                    messages: [{ role: "user", content: [{ type: "text", text: "Continue." }] }],
                },
            },
        );
        await expect(connection.conn.prompt({ sessionId, prompt: [] })).rejects.toMatchObject({
            code: "context_fixed_too_large",
            message: expect.stringContaining("fixed context cannot fit"),
        });
    }
    expect(api.requests).toHaveLength(0);
    expect(api.summaries()).toBe(0);
}, 120_000);

it("requires the outer loop to compact before continuing an oversized structured exchange", async () => {
    const api = await fakeMessagesApi(() => 10_000);
    const directory = fixtureDirectory("claude-replay-recovery-");
    const checkpoints: AcpNativeCompaction[] = [];
    const connection = await claudeAgentConnect({
        ANTHROPIC_BASE_URL: api.url,
        ANTHROPIC_API_KEY: "sk-ant-test",
        CLAUDE_CONFIG_DIR: join(directory, "config"),
    })(directory, {
        requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
        sessionUpdate: async () => {},
        contextCompacted: async ({ checkpoint }) => {
            checkpoints.push(checkpoint);
        },
    });
    connections.push(connection);
    const context = oversizedExchange();
    const original = structuredClone(context);
    const { sessionId } = await connection.conn.replaySession!(
        { cwd: directory, mcpServers: [] },
        { context },
    );
    await expect(connection.conn.prompt({ sessionId, prompt: [] })).rejects.toMatchObject({
        code: "context_compaction_required",
    });
    expect(api.requests).toHaveLength(0);
    const compacted = await connection.conn.compactSession!(
        { cwd: directory, mcpServers: [] },
        { context },
    );
    expect(compacted.status).toBe("completed");
    if (compacted.status !== "completed") throw new Error("Expected native compaction.");
    expect(compacted.compaction?.content).toContain(SUMMARY);
    const resumed = await connection.conn.replaySession!(
        { cwd: directory, mcpServers: [] },
        { context: compacted.context },
    );
    await connection.conn.prompt({ sessionId: resumed.sessionId, prompt: [] });
    expect(api.summaries()).toBe(1);
    expect(checkpoints).toHaveLength(0);
    expect(context).toEqual(original);
}, 120_000);

it("stops after a native compaction that does not shrink the assembled context", async () => {
    const api = await fakeMessagesApi(
        () => 10_000,
        `${SUMMARY} ${"unchanged work ".repeat(110_000)}`,
    );
    const directory = fixtureDirectory("claude-replay-no-progress-");
    const checkpoints: AcpNativeCompaction[] = [];
    const connection = await claudeAgentConnect({
        ANTHROPIC_BASE_URL: api.url,
        ANTHROPIC_API_KEY: "sk-ant-test",
        CLAUDE_CONFIG_DIR: join(directory, "config"),
    })(directory, {
        requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
        sessionUpdate: async () => {},
        contextCompacted: async ({ checkpoint }) => {
            checkpoints.push(checkpoint);
        },
    });
    connections.push(connection);
    const context = oversizedExchange();
    const original = structuredClone(context);
    const { sessionId } = await connection.conn.replaySession!(
        { cwd: directory, mcpServers: [] },
        { context },
    );
    await expect(connection.conn.prompt({ sessionId, prompt: [] })).rejects.toMatchObject({
        code: "context_compaction_required",
    });
    const compacted = await connection.conn.compactSession!(
        { cwd: directory, mcpServers: [] },
        { context },
    );
    expect(compacted).toMatchObject({
        status: "failed",
        kind: "invalid_summary",
        message: expect.stringContaining("did not make enough progress"),
    });
    expect(api.summaries()).toBe(1);
    expect(checkpoints).toHaveLength(0);
    expect(context).toEqual(original);
}, 120_000);

function oversizedExchange(): import("@/core/SessionContext.js").SessionContext {
    return {
        instructions: "Preserve workspace edits and the user's permission boundaries.",
        messages: [
            {
                role: "user",
                content: [{ type: "text", text: "Inspect the output and continue the task." }],
            },
            {
                role: "assistant",
                content: [
                    {
                        type: "tool_call",
                        callId: "large_result",
                        name: "Bash",
                        arguments: '{"command":"pwd"}',
                    },
                ],
            },
            {
                role: "tool",
                callId: "large_result",
                content: [{ type: "text", text: "historical output ".repeat(80_000) }],
            },
            {
                role: "assistant",
                content: [
                    {
                        type: "text",
                        text: "The command completed. I will preserve the result and continue.",
                    },
                ],
            },
            { role: "user", content: [{ type: "text", text: "Continue." }] },
        ],
    };
}

it("subjects native compaction to the same actual request limit as normal inference", async () => {
    const api = await fakeMessagesApi(() => 0, SUMMARY, undefined, 200_000);
    const directory = fixtureDirectory("claude-real-limit-");
    const checkpoints: AcpNativeCompaction[] = [];
    const connection = await claudeAgentConnect({
        ANTHROPIC_BASE_URL: api.url,
        ANTHROPIC_API_KEY: "sk-ant-test",
        CLAUDE_CONFIG_DIR: join(directory, "config"),
    })(directory, {
        requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
        sessionUpdate: async () => {},
        contextCompacted: async ({ checkpoint }) => {
            checkpoints.push(checkpoint);
        },
    });
    connections.push(connection);
    const context: import("@/core/SessionContext.js").SessionContext = {
        instructions: "Preserve the task, decisions, and workspace. No tools during compaction.",
        messages: [
            {
                role: "user",
                content: [
                    { type: "text", text: "Complete the work without restarting the daemon." },
                ],
            },
            ...Array.from(
                { length: 30 },
                (_, index): import("@/core/SessionContext.js").SessionMessage[] => [
                    {
                        role: "assistant",
                        content: [
                            {
                                type: "tool_call",
                                callId: `call-${index}`,
                                name: "Read",
                                arguments: JSON.stringify({
                                    file_path: `/workspace/source-${index}`,
                                }),
                            },
                        ],
                    },
                    {
                        role: "tool",
                        callId: `call-${index}`,
                        content: [{ type: "text", text: "data ".repeat(6_000) }],
                    },
                ],
            ).flat(),
            {
                role: "assistant",
                content: [
                    { type: "text", text: "The original decisions and permissions still apply." },
                ],
            },
            { role: "user", content: [{ type: "text", text: "Continue." }] },
        ],
    };
    const original = structuredClone(context);
    const { sessionId } = await connection.conn.replaySession!(
        { cwd: directory, mcpServers: [] },
        { context },
    );
    await expect(connection.conn.prompt({ sessionId, prompt: [] })).rejects.toMatchObject({
        code: "context_compaction_required",
    });
    expect(api.requests).toHaveLength(0);
    const compacted = await connection.conn.compactSession!(
        { cwd: directory, mcpServers: [] },
        { context },
    );
    expect(compacted.status).toBe("completed");
    if (compacted.status !== "completed") throw new Error("Expected native compaction.");
    const resumed = await connection.conn.replaySession!(
        { cwd: directory, mcpServers: [] },
        { context: compacted.context },
    );
    await connection.conn.prompt({ sessionId: resumed.sessionId, prompt: [] });
    expect(api.admission.some((request) => request.summarizing)).toBe(true);
    expect(
        api.admission
            .filter((request) => !request.summarizing)
            .every((request) => request.accepted),
    ).toBe(true);
    expect(checkpoints).toHaveLength(0);
    expect(api.admission.some((request) => request.summarizing && !request.accepted)).toBe(true);
    expect(api.admission.some((request) => request.summarizing && request.accepted)).toBe(true);
    expect(api.admission.filter((request) => !request.summarizing)).toHaveLength(1);
    const acceptedSummary =
        api.requests[
            api.admission.findIndex((request) => request.summarizing && request.accepted)
        ]!;
    expect(acceptedSummary.includes("Complete the work without restarting the daemon.")).toBe(true);
    expect(
        (acceptedSummary + JSON.stringify(compacted.compaction)).includes(
            "The original decisions and permissions still apply.",
        ),
    ).toBe(true);
    const wireMessages = (JSON.parse(acceptedSummary) as { messages: { content: unknown }[] })
        .messages;
    const calls = new Set<string>();
    const results = new Set<string>();
    for (const message of wireMessages) {
        if (!Array.isArray(message.content)) continue;
        for (const block of message.content) {
            if (block.type === "tool_use") calls.add(block.id);
            if (block.type === "tool_result") results.add(block.tool_use_id);
        }
    }
    expect(calls).toEqual(results);
    expect(context).toEqual(original);
}, 120_000);

it("reports an actionable terminal failure when actual inference exceeds the preflight estimate", async () => {
    const api = await fakeMessagesApi(() => 0, SUMMARY, undefined, 100);
    const directory = fixtureDirectory("claude-preflight-mismatch-");
    const connection = await claudeAgentConnect({
        ANTHROPIC_BASE_URL: api.url,
        ANTHROPIC_API_KEY: "sk-ant-test",
        CLAUDE_CONFIG_DIR: join(directory, "config"),
    })(directory, {
        requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
        sessionUpdate: async () => {},
    });
    connections.push(connection);
    const { sessionId } = await connection.conn.newSession({ cwd: directory, mcpServers: [] });
    await expect(
        connection.conn.prompt({
            sessionId,
            prompt: [{ type: "text", text: "Fit according to the native preflight." }],
        }),
    ).rejects.toMatchObject({
        code: "context_compaction_no_progress",
        message: expect.stringContaining("after preflight"),
    });
    expect(api.admission.some((request) => !request.summarizing && !request.accepted)).toBe(true);
}, 120_000);

it("lets Claude Code compact its own context and reports the context it fills", async () => {
    let cached = 30_000;
    const api = await fakeMessagesApi(() => cached);
    const directory = fixtureDirectory("claude-agent-connect-");
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
});

it("forwards the committed native checkpoint before post-compaction output", async () => {
    let cached = 30_000;
    const api = await fakeMessagesApi(() => cached);
    const directory = fixtureDirectory("claude-native-checkpoint-");
    const checkpoints: AcpNativeCompaction[] = [];
    const client: AcpAgentClient = {
        requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
        sessionUpdate: async () => {},
        contextCompacted: async ({ checkpoint }) => {
            checkpoints.push(checkpoint);
        },
    };
    const connection = await claudeAgentConnect({
        ANTHROPIC_BASE_URL: api.url,
        ANTHROPIC_API_KEY: "sk-ant-test",
        CLAUDE_CONFIG_DIR: join(directory, "config"),
    })(directory, client);
    connections.push(connection);
    const { sessionId } = await connection.conn.newSession({ cwd: directory, mcpServers: [] });
    await connection.conn.prompt({ sessionId, prompt: [{ type: "text", text: "first" }] });
    cached = 230_000;
    const response = await connection.conn.prompt({
        sessionId,
        prompt: [{ type: "text", text: "second" }],
    });
    expect(response.stopReason).toBe("end_turn");
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]!.compaction.content).toContain(SUMMARY);
    // Native pre_tokens describes the retained context before its rejected oversized
    // request, not the fake server's later refusal size. Exact values are covered by the reader.
    expect(checkpoints[0]!.usage.input).toBeGreaterThan(0);
    expect(checkpoints[0]!.compaction.vendor.messages.length).toBeGreaterThan(0);
}, 120_000);
