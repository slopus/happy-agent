import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type * as acp from "@agentclientprotocol/sdk";
import { afterEach, expect, it, vi } from "vitest";

import {
    ACP_TURN_ENDED,
    ACP_TURN_STARTED,
    type AcpConnection,
} from "@/protocol/acp/AcpConnection.js";
import { claudeAgentConnect } from "@/vendors/claudeAgent/claudeAgentConnect.js";

/**
 * A Claude Code stream that answers the first prompt, then starts a turn of its own once
 * `startBackground` is called and keeps it running until it is released or interrupted. Every
 * message handed to Claude Code is recorded with its priority.
 */
const sdk = vi.hoisted(() => {
    const state = {
        inputs: [] as { priority?: string; text: string }[],
        interrupts: 0,
        startBackground: (): void => undefined,
        release: (_stop: "end" | "interrupt"): void => undefined,
    };
    const usage = {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
    };
    function query(params: {
        prompt: AsyncIterable<{ priority?: string; message: { content: { text?: string }[] } }>;
    }) {
        let first!: () => void;
        const firstInput = new Promise<void>((resolve) => (first = resolve));
        void (async () => {
            for await (const message of params.prompt) {
                state.inputs.push({
                    ...(message.priority === undefined ? {} : { priority: message.priority }),
                    text: message.message.content.map((block) => block.text ?? "").join(""),
                });
                first();
            }
        })();
        async function* messages() {
            await firstInput;
            yield { type: "system", subtype: "init" };
            yield { type: "result", subtype: "success", is_error: false, result: "", usage };
            await new Promise<void>((resolve) => (state.startBackground = resolve));
            yield { type: "system", subtype: "init" };
            yield {
                type: "stream_event",
                parent_tool_use_id: null,
                event: {
                    type: "content_block_delta",
                    index: 0,
                    delta: { type: "text_delta", text: "working" },
                },
            };
            await new Promise<void>((resolve) => (state.release = () => resolve()));
            yield { type: "result", subtype: "success", is_error: false, result: "", usage };
            await new Promise(() => undefined);
        }
        return Object.assign(messages(), {
            supportedModels: async () => [],
            setModel: async () => undefined,
            applyFlagSettings: async () => undefined,
            setPermissionMode: async () => undefined,
            interrupt: async () => {
                state.interrupts++;
                state.release("interrupt");
            },
            close: () => undefined,
        });
    }
    return { state, query };
});

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: sdk.query }));

const connections: AcpConnection[] = [];
afterEach(() => {
    for (const connection of connections.splice(0)) connection.terminate();
    sdk.state.inputs.splice(0);
    sdk.state.interrupts = 0;
});

async function connectWithBackgroundTurn() {
    const directory = mkdtempSync(join(tmpdir(), "claude-self-started-control-"));
    const notifications: { method: string; params: Record<string, unknown> }[] = [];
    const connection = await claudeAgentConnect({})(directory, {
        requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
        sessionUpdate: async () => {},
        extNotification: async (method: string, params: Record<string, unknown>) => {
            notifications.push({ method, params });
        },
    } as acp.Client);
    connections.push(connection);
    const { sessionId } = await connection.conn.newSession({ cwd: directory, mcpServers: [] });
    await connection.conn.prompt({ sessionId, prompt: [{ type: "text", text: "go" }] });
    sdk.state.startBackground();
    await vi.waitFor(() =>
        expect(notifications.map((entry) => entry.method)).toEqual([ACP_TURN_STARTED]),
    );
    return { connection, sessionId, notifications };
}

it("stops a turn Claude Code started by itself", async () => {
    const { connection, sessionId, notifications } = await connectWithBackgroundTurn();

    await connection.conn.cancel({ sessionId });

    expect(sdk.state.interrupts).toBe(1);
    await vi.waitFor(() =>
        expect(notifications.at(-1)).toMatchObject({
            method: ACP_TURN_ENDED,
            params: { sessionId, stopReason: "cancelled" },
        }),
    );
}, 30_000);

it("joins a prompt sent during Claude Code's own turn to that turn and answers it at its end", async () => {
    const { connection, sessionId, notifications } = await connectWithBackgroundTurn();

    let answered = false;
    const prompt = connection.conn
        .prompt({ sessionId, prompt: [{ type: "text", text: "and this" }] })
        .then((response) => {
            answered = true;
            return response;
        });
    await vi.waitFor(() =>
        expect(sdk.state.inputs.at(-1)).toEqual({ priority: "next", text: "and this" }),
    );
    expect(answered).toBe(false);

    sdk.state.release("end");
    expect((await prompt).stopReason).toBe("end_turn");
    expect(notifications.at(-1)).toMatchObject({
        method: ACP_TURN_ENDED,
        params: { sessionId, stopReason: "end_turn" },
    });
}, 30_000);
