import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type * as acp from "@agentclientprotocol/sdk";
import { createRootContext } from "@steve.kite/stdlib";
import { afterEach, expect, it, vi } from "vitest";

import type { SessionMessage } from "@/core/SessionContext.js";
import type { AcpConnection, AcpSideQuestionTurn } from "@/protocol/acp/AcpConnection.js";
import { AcpProvider } from "@/protocol/acp/AcpProvider.js";
import type { AcpSession } from "@/protocol/acp/AcpSession.js";
import { acpSessionRecordWrite } from "@/protocol/acp/impl/acpSessionStore.js";
import {
    claudeAgentConnect,
    claudeAgentStoredSideQuestion,
} from "@/vendors/claudeAgent/claudeAgentConnect.js";
import { claudeCodeAgent } from "@/vendors/foreignAgents/claudeCodeAgent.js";

/**
 * A Claude Code stream that answers each prompt, at once or, with `hold`, once `release` is
 * called, and answers every side question with what `answer` returns, after writing `stderr` to
 * its error output. With `starting`, setting the model waits until the query is closed, as while
 * Claude Code is still starting. It records every message handed to Claude Code, every side
 * question, every control call, and every query's options.
 */
const sdk = vi.hoisted(() => {
    const answer = (question: string): { response: string | null; synthetic?: boolean } | null => ({
        response: `About: ${question}`,
    });
    const state = {
        hold: false,
        release: (): void => undefined,
        answer,
        starting: false,
        stderr: "",
        inputs: [] as string[],
        asked: [] as { question: string; history: unknown; signal: unknown }[],
        options: [] as Record<string, unknown>[],
        calls: [] as string[],
        closed: 0,
    };
    const usage = {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
    };
    function query(params: {
        prompt: AsyncIterable<{ message: { content: { text?: string }[] } }>;
        options: Record<string, unknown>;
    }) {
        state.options.push(params.options);
        const prompts: string[] = [];
        const closing: (() => void)[] = [];
        let arrived: (() => void) | undefined;
        void (async () => {
            for await (const message of params.prompt) {
                const text = message.message.content.map((block) => block.text ?? "").join("");
                state.inputs.push(text);
                prompts.push(text);
                arrived?.();
            }
        })();
        async function* messages() {
            for (;;) {
                while (prompts.length === 0) {
                    await new Promise<void>((resolve) => (arrived = resolve));
                }
                prompts.shift();
                yield { type: "system", subtype: "init" };
                if (state.hold) await new Promise<void>((resolve) => (state.release = resolve));
                yield { type: "result", subtype: "success", is_error: false, result: "", usage };
            }
        }
        return Object.assign(messages(), {
            supportedModels: async () => [],
            setModel: async (model: string) => {
                state.calls.push(`setModel ${model}`);
                if (!state.starting) return;
                await new Promise<void>((_, reject) => {
                    closing.push(() => reject(new Error("Query closed before response received")));
                });
            },
            applyFlagSettings: async (settings: Record<string, unknown>) => {
                state.calls.push(`applyFlagSettings ${JSON.stringify(settings)}`);
            },
            setPermissionMode: async () => undefined,
            interrupt: async () => undefined,
            askSideQuestion: async (
                question: string,
                options: { history?: unknown; signal?: unknown },
            ) => {
                state.calls.push(`askSideQuestion ${question}`);
                state.asked.push({ question, history: options.history, signal: options.signal });
                if (state.stderr !== "") {
                    (params.options["stderr"] as (data: string) => void)(state.stderr);
                }
                return state.answer(question);
            },
            close: () => {
                state.closed++;
                for (const reject of closing.splice(0)) reject();
            },
        });
    }
    return { state, query, answer };
});

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: sdk.query }));

const connections: AcpConnection[] = [];
const sessions: AcpSession[] = [];
afterEach(() => {
    for (const connection of connections.splice(0)) connection.terminate();
    for (const session of sessions.splice(0)) session.destroy();
    sdk.state.hold = false;
    sdk.state.answer = sdk.answer;
    sdk.state.starting = false;
    sdk.state.stderr = "";
    sdk.state.closed = 0;
    for (const list of [sdk.state.inputs, sdk.state.asked, sdk.state.options, sdk.state.calls]) {
        list.splice(0);
    }
});

function sideQuestion(question: string, history: AcpSideQuestionTurn[] = []) {
    return { question, history, signal: new AbortController().signal };
}

const userMessage = (text: string): SessionMessage => ({
    role: "user",
    content: [{ type: "text", text }],
});

async function connect() {
    const directory = mkdtempSync(join(tmpdir(), "claude-side-question-"));
    const updates: unknown[] = [];
    const notifications: string[] = [];
    const connection = await claudeAgentConnect({})(directory, {
        requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
        sessionUpdate: async (params: unknown) => {
            updates.push(params);
        },
        extNotification: async (method: string) => {
            notifications.push(method);
        },
    } as acp.Client);
    connections.push(connection);
    const { sessionId } = await connection.conn.newSession({ cwd: directory, mcpServers: [] });
    return { connection, sessionId, updates, notifications };
}

it("answers a side question from the live session without a turn, an update or any input", async () => {
    const { connection, sessionId, updates, notifications } = await connect();
    await connection.conn.prompt({ sessionId, prompt: [{ type: "text", text: "go" }] });
    const before = { updates: updates.length, notifications: notifications.length };

    const answer = await connection.conn.askSideQuestion?.({
        sessionId,
        ...sideQuestion("What did you do?", [{ question: "Earlier?", response: "Yes." }]),
    });

    expect(answer).toEqual({ response: "About: What did you do?", synthetic: false });
    expect(sdk.state.asked).toEqual([
        {
            question: "What did you do?",
            history: [{ question: "Earlier?", response: "Yes." }],
            signal: expect.any(AbortSignal),
        },
    ]);
    // Nothing reached the conversation: no input, no update, no turn of its own.
    expect(sdk.state.inputs).toEqual(["go"]);
    expect(updates).toHaveLength(before.updates);
    expect(notifications).toHaveLength(before.notifications);
}, 30_000);

it("answers while a turn runs and leaves that turn running to its own end", async () => {
    sdk.state.hold = true;
    const { connection, sessionId } = await connect();
    let ended = false;
    const turn = connection.conn
        .prompt({ sessionId, prompt: [{ type: "text", text: "Long job." }] })
        .then((response) => {
            ended = true;
            return response;
        });
    await vi.waitFor(() => expect(sdk.state.inputs).toEqual(["Long job."]));

    expect(
        await connection.conn.askSideQuestion?.({ sessionId, ...sideQuestion("How far along?") }),
    ).toEqual({ response: "About: How far along?", synthetic: false });
    expect(ended).toBe(false);

    sdk.state.release();
    expect((await turn).stopReason).toBe("end_turn");
    expect(sdk.state.inputs).toEqual(["Long job."]);
}, 30_000);

it("tells no answer and a canned answer apart from an answer", async () => {
    const { connection, sessionId } = await connect();

    sdk.state.answer = () => null;
    expect(
        await connection.conn.askSideQuestion?.({ sessionId, ...sideQuestion("Anything?") }),
    ).toEqual({ response: null, synthetic: false });

    sdk.state.answer = () => ({ response: "I can't help with that.", synthetic: true });
    expect(
        await connection.conn.askSideQuestion?.({ sessionId, ...sideQuestion("Anything?") }),
    ).toEqual({ response: "I can't help with that.", synthetic: true });
}, 30_000);

it("has nothing to ask in a session that is not open here", async () => {
    const { connection } = await connect();

    expect(
        await connection.conn.askSideQuestion?.({
            sessionId: "elsewhere",
            ...sideQuestion("Anything?"),
        }),
    ).toBeUndefined();
}, 30_000);

it("asks the Happy session's live foreign session, and nothing once it is destroyed", async () => {
    const directory = mkdtempSync(join(tmpdir(), "claude-side-question-session-"));
    const opened: AcpSession[] = [];
    let forgotten = 0;
    const provider = new AcpProvider({
        connect: claudeAgentConnect({}),
        stateDirectory: join(directory, "state"),
        environment: () => ({ cwd: directory, permissionMode: "full_access" }),
        onSession: (session) => {
            opened.push(session);
            return () => forgotten++;
        },
    });
    const session = await provider.session("agent-1", { instructions: "Be Happy.", tools: [] });
    sessions.push(session);
    expect(opened).toEqual([session]);
    // No Claude Code runs for the conversation before its first turn.
    expect(await session.askSideQuestion(sideQuestion("Anything?"))).toBeUndefined();

    for await (const event of session.run(createRootContext().named("test"), {
        context: { instructions: "Be Happy.", messages: [userMessage("Go.")] },
    })) {
        if (event.type === "done") break;
    }
    expect(await session.askSideQuestion(sideQuestion("What now?"))).toEqual({
        response: "About: What now?",
        synthetic: false,
    });

    session.destroy();
    expect(forgotten).toBe(1);
    expect(await session.askSideQuestion(sideQuestion("Still there?"))).toBeUndefined();
    session.destroy();
    expect(forgotten).toBe(1);
}, 30_000);

it("answers about a stored session in a separate Claude Code that neither continues nor keeps it", async () => {
    const directory = mkdtempSync(join(tmpdir(), "claude-stored-side-question-"));

    const answer = await claudeAgentStoredSideQuestion(
        { CLAUDE_CONFIG_DIR: join(directory, "config") },
        {
            ...sideQuestion("What was decided?", [{ question: "Earlier?", response: "Yes." }]),
            sessionId: "stored-session",
            cwd: directory,
            options: [
                { configId: "model", value: "opus" },
                { configId: "effort", value: "high" },
            ],
        },
    );

    expect(answer).toEqual({ response: "About: What was decided?", synthetic: false });
    expect(sdk.state.options).toHaveLength(1);
    expect(sdk.state.options[0]).toMatchObject({
        cwd: directory,
        resume: "stored-session",
        forkSession: true,
        persistSession: false,
        strictMcpConfig: true,
        settings: { disableAllHooks: true },
    });
    expect(sdk.state.options[0]).not.toHaveProperty("mcpServers");
    // The session's model and effort, as a turn sets them, before the question.
    expect(sdk.state.calls).toEqual([
        "setModel opus",
        'applyFlagSettings {"effortLevel":"high"}',
        "askSideQuestion What was decided?",
    ]);
    expect(sdk.state.asked[0]?.history).toEqual([{ question: "Earlier?", response: "Yes." }]);
    expect(sdk.state.inputs).toEqual([]);
    expect(sdk.state.closed).toBe(1);
}, 30_000);

it("asks about the foreign session stored for a Happy session, and nothing without one", async () => {
    const directory = mkdtempSync(join(tmpdir(), "claude-stored-record-"));
    const stateDirectory = join(directory, "state");
    await acpSessionRecordWrite(stateDirectory, "agent-1", {
        acpSessionId: "claude-session-1",
        cwd: join(directory, "work"),
        consumed: 2,
        fingerprint: "seen",
    });
    const provider = new AcpProvider({
        connect: claudeAgentConnect({}),
        stateDirectory,
        environment: () => ({ cwd: directory }),
        profile: claudeCodeAgent.profile,
        askStoredSideQuestion: claudeCodeAgent.askStoredSideQuestion!({ env: {} }),
    });

    const answer = await provider.askStoredSideQuestion("agent-1", {
        ...sideQuestion("What was decided?"),
        model: "claude-code/sonnet",
        effort: "max",
    });

    expect(answer).toEqual({ response: "About: What was decided?", synthetic: false });
    expect(sdk.state.options[0]).toMatchObject({
        resume: "claude-session-1",
        cwd: join(directory, "work"),
    });
    expect(sdk.state.calls.slice(0, 2)).toEqual([
        "setModel sonnet",
        'applyFlagSettings {"effortLevel":"max"}',
    ]);
    expect(
        await provider.askStoredSideQuestion("agent-2", sideQuestion("Anything?")),
    ).toBeUndefined();
    expect(sdk.state.options).toHaveLength(1);
}, 30_000);

it("says Claude Code could not answer without repeating its own words", async () => {
    const { connection, sessionId } = await connect();
    const failure = new Error(
        "ENOENT: no such file or directory, open '/home/alex/.config/secret'",
    );
    sdk.state.answer = () => {
        throw failure;
    };

    await expect(
        connection.conn.askSideQuestion?.({ sessionId, ...sideQuestion("Anything?") }),
    ).rejects.toMatchObject({
        message: "Claude Code could not answer this side question.",
        cause: failure,
    });
}, 30_000);

it("says when the separate Claude Code no longer has the stored conversation", async () => {
    const directory = mkdtempSync(join(tmpdir(), "claude-stored-side-question-gone-"));
    const stored = (question: string) =>
        claudeAgentStoredSideQuestion(
            { CLAUDE_CONFIG_DIR: join(directory, "config") },
            { ...sideQuestion(question), sessionId: "stored-session", cwd: directory, options: [] },
        );
    sdk.state.answer = () => {
        throw new Error("Claude Code process exited with code 1");
    };

    sdk.state.stderr = "No conversation found with session ID: stored-session\n";
    await expect(stored("Anything?")).rejects.toThrow(
        "Claude Code no longer has this conversation.",
    );
    sdk.state.stderr = "";
    await expect(stored("Anything else?")).rejects.toThrow(
        "Claude Code stopped before it answered.",
    );
}, 30_000);

it("ends the separate Claude Code as soon as the side question is stopped, also while it starts", async () => {
    const directory = mkdtempSync(join(tmpdir(), "claude-stored-side-question-stop-"));
    sdk.state.starting = true;
    const controller = new AbortController();
    const asking = claudeAgentStoredSideQuestion(
        { CLAUDE_CONFIG_DIR: join(directory, "config") },
        {
            question: "Anything?",
            history: [],
            signal: controller.signal,
            sessionId: "stored-session",
            cwd: directory,
            options: [{ configId: "model", value: "opus" }],
        },
    );
    await vi.waitFor(() => expect(sdk.state.calls).toEqual(["setModel opus"]));

    controller.abort();

    // Stopped on purpose, so the failure is not turned into a reason for a person.
    await expect(asking).rejects.toThrow("Query closed before response received");
    expect(sdk.state.closed).toBeGreaterThan(0);
    expect(sdk.state.asked).toEqual([]);
}, 30_000);

it("starts no Claude Code for a side question stopped before it is asked", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
        claudeAgentStoredSideQuestion(
            {},
            {
                question: "Anything?",
                history: [],
                signal: controller.signal,
                sessionId: "stored-session",
                cwd: tmpdir(),
                options: [],
            },
        ),
    ).rejects.toThrow("The side question was stopped.");
    expect(sdk.state.options).toEqual([]);
});
