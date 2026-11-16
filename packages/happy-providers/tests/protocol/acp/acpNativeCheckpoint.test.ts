import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import { createRootContext } from "@steve.kite/stdlib";
import { expect, it } from "vitest";
import { AcpProvider } from "@/protocol/acp/AcpProvider.js";
import type { AcpAgentClient, AcpNativeCompaction } from "@/protocol/acp/AcpConnection.js";
import type { SessionContext } from "@/core/SessionContext.js";
import { SessionAssistantMessageAccumulator } from "@/core/SessionAssistantMessageAccumulator.js";

const checkpoint: AcpNativeCompaction = {
    checkpointId: "checkpoint",
    compaction: {
        role: "compaction",
        content: "native summary",
        encryptedContent: null,
    },
    preservedMessages: [],
    messages: [{ role: "compaction", content: "native summary", encryptedContent: null }],
    usage: {
        input: 700000,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 700000,
    },
};

it("acknowledges native replacement before forwarding later output and keeps the compacted account resume prefix", async () => {
    const directory = mkdtempSync(join(tmpdir(), "acp-native-checkpoint-"));
    const prompts: string[] = [];
    let newSessions = 0;
    let client!: AcpAgentClient;
    const provider = new AcpProvider({
        stateDirectory: join(directory, "state"),
        environment: () => ({ cwd: directory, permissionMode: "auto" }),
        connect: async (_cwd, value) => {
            client = value;
            return {
                conn: {
                    newSession: async () => ({ sessionId: `session-${++newSessions}` }),
                    resumeSession: async () => ({}),
                    loadSession: async () => ({}),
                    setSessionConfigOption: async () => ({ configOptions: [] }),
                    cancel: async () => {},
                    prompt: async (request) => {
                        prompts.push(JSON.stringify(request.prompt));
                        if (prompts.length === 1) {
                            await client.sessionUpdate({
                                sessionId: request.sessionId,
                                update: {
                                    sessionUpdate: "agent_message_chunk",
                                    content: { type: "text", text: "old output" },
                                },
                            });
                            await client.contextCompacted!({
                                sessionId: request.sessionId,
                                checkpoint,
                            });
                        }
                        await client.sessionUpdate({
                            sessionId: request.sessionId,
                            update: {
                                sessionUpdate: "agent_message_chunk",
                                content: { type: "text", text: "new output" },
                            },
                        });
                        if (prompts.length === 1) {
                            // A duplicate boundary must not clear the output just received.
                            await client.contextCompacted!({
                                sessionId: request.sessionId,
                                checkpoint,
                            });
                        }
                        return { stopReason: "end_turn" };
                    },
                },
                init: {
                    protocolVersion: 1,
                    agentCapabilities: { sessionCapabilities: { resume: {} } },
                } as acp.InitializeResponse,
                exited: new Promise<Error>(() => {}),
                stderr: () => "",
                processGroups: () => [],
                terminate: () => {},
            };
        },
    });
    const session = await provider.session("happy-agent", {
        instructions: "instructions",
        tools: [],
    });
    let context: SessionContext = {
        instructions: "instructions",
        messages: [{ role: "user", content: [{ type: "text", text: "old source" }] }],
    };
    const acc = new SessionAssistantMessageAccumulator();
    let adopted = false;
    for await (const event of session.run(createRootContext(), { context })) {
        if (event.type === "context_compacted") {
            context = event.result.context;
            adopted = true;
        }
        if (event.type === "text_delta" && event.delta === "new output") expect(adopted).toBe(true);
        acc.add(event);
        if (event.type === "done") break;
    }
    expect(acc.message()?.content).toEqual([{ type: "text", text: "new output" }]);
    context = {
        ...context,
        messages: [
            ...context.messages,
            acc.message()!,
            { role: "user", content: [{ type: "text", text: "follow up" }] },
        ],
    };
    for await (const event of session.run(createRootContext(), { context })) {
        if (event.type === "done") break;
    }
    expect(newSessions).toBe(1);
    expect(prompts[1]).toContain("follow up");
    expect(prompts[1]).not.toContain("old source");
    expect(prompts[1]).not.toContain("native summary");
    await session.destroy();
});

it("does not retry the original prompt when a native checkpoint precedes a rate-limit failure", async () => {
    const directory = mkdtempSync(join(tmpdir(), "acp-checkpoint-rate-limit-"));
    let prompts = 0;
    const provider = new AcpProvider({
        stateDirectory: join(directory, "state"),
        environment: () => ({ cwd: directory, permissionMode: "auto" }),
        connect: async (_cwd, client) => ({
            conn: {
                newSession: async () => ({ sessionId: "native-session" }),
                resumeSession: async () => ({}),
                loadSession: async () => ({}),
                setSessionConfigOption: async () => ({ configOptions: [] }),
                cancel: async () => {},
                prompt: async ({ sessionId }) => {
                    prompts++;
                    if (prompts === 1) {
                        await client.contextCompacted!({ sessionId, checkpoint });
                        throw new Error("429 Too many requests");
                    }
                    return { stopReason: "end_turn" };
                },
            },
            init: { protocolVersion: 1 } as acp.InitializeResponse,
            exited: new Promise<Error>(() => {}),
            stderr: () => "",
            processGroups: () => [],
            terminate: () => {},
        }),
    });
    const session = await provider.session("happy-agent", {
        instructions: "",
        tools: [],
    });
    const events = [];
    for await (const event of session.run(createRootContext(), {
        context: {
            instructions: "",
            messages: [
                {
                    role: "user",
                    content: [{ type: "text", text: "the original large prompt" }],
                },
            ],
        },
    })) {
        events.push(event);
        if (event.type === "done") break;
    }
    expect(prompts).toBe(1);
    expect(events.some((event) => event.type === "retrying")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "done", state: "error" });
    await session.destroy();
});

it("keeps native retained input through compaction and replays it after reconnecting", async () => {
    const directory = mkdtempSync(join(tmpdir(), "acp-unsent-compaction-"));
    const replays: SessionContext[] = [];
    let prompts = 0;
    let opened = 0;
    let restores = 0;
    const provider = new AcpProvider({
        stateDirectory: join(directory, "state"),
        environment: () => ({ cwd: directory, permissionMode: "auto" }),
        connect: async (_cwd, client) => ({
            conn: {
                newSession: async () => ({ sessionId: `session-${++opened}` }),
                replaySession: async (_params, request) => {
                    replays.push(structuredClone(request.context));
                    return { sessionId: `session-${++opened}` };
                },
                resumeSession: async () => {
                    restores++;
                    return {};
                },
                loadSession: async () => ({}),
                setSessionConfigOption: async () => ({ configOptions: [] }),
                cancel: async () => {},
                prompt: async ({ sessionId }) => {
                    if (++prompts === 2) {
                        await client.contextCompacted!({
                            sessionId,
                            checkpoint: {
                                ...checkpoint,
                                messages: [
                                    ...checkpoint.messages,
                                    {
                                        role: "user",
                                        content: [
                                            {
                                                type: "text",
                                                text: "Keep this newly arrived decision.",
                                            },
                                        ],
                                    },
                                ],
                                preservedMessages: [
                                    {
                                        role: "user",
                                        content: [
                                            {
                                                type: "text",
                                                text: "Keep this newly arrived decision.",
                                            },
                                        ],
                                    },
                                ],
                            },
                        });
                    }
                    await client.sessionUpdate({
                        sessionId,
                        update: {
                            sessionUpdate: "agent_message_chunk",
                            content: { type: "text", text: "done" },
                        },
                    });
                    return { stopReason: "end_turn" };
                },
            },
            init: { protocolVersion: 1 } as acp.InitializeResponse,
            exited: new Promise<Error>(() => {}),
            stderr: () => "",
            processGroups: () => [],
            terminate: () => {},
        }),
    });
    let session = await provider.session("happy-agent", { instructions: "", tools: [] });
    let context: SessionContext = {
        instructions: "",
        messages: [{ role: "user", content: [{ type: "text", text: "Original task" }] }],
    };
    for await (const _event of session.run(createRootContext(), { context })) {
    }
    context = {
        instructions: "",
        messages: [
            ...context.messages,
            { role: "assistant", content: [{ type: "text", text: "done" }] },
            {
                role: "user",
                content: [{ type: "text", text: "Keep this newly arrived decision." }],
            },
        ],
    };
    for await (const event of session.run(createRootContext(), { context })) {
        if (event.type === "context_compacted") context = event.result.context;
    }
    expect(context.messages).toEqual([
        ...checkpoint.messages,
        { role: "user", content: [{ type: "text", text: "Keep this newly arrived decision." }] },
    ]);
    session.destroy();
    session = await provider.session("happy-agent", { instructions: "", tools: [] });
    for await (const _event of session.run(createRootContext(), { context })) {
    }
    expect(restores).toBe(0);
    expect(replays.at(-1)!.messages).toEqual(context.messages);
    session.destroy();
});

it("invalidates a discarded native session so a later Continue can rebuild it", async () => {
    const directory = mkdtempSync(join(tmpdir(), "acp-discarded-replay-"));
    let opened = 0;
    let prompts = 0;
    const provider = new AcpProvider({
        stateDirectory: join(directory, "state"),
        environment: () => ({ cwd: directory }),
        connect: async () => ({
            conn: {
                newSession: async () => ({ sessionId: `session-${++opened}` }),
                replaySession: async () => ({ sessionId: `session-${++opened}` }),
                resumeSession: async () => ({}),
                loadSession: async () => ({}),
                setSessionConfigOption: async () => ({ configOptions: [] }),
                cancel: async () => {},
                prompt: async () => {
                    if (++prompts === 2)
                        throw new Error("The native preflight discarded this session.");
                    return { stopReason: "end_turn" };
                },
            },
            init: { protocolVersion: 1 } as acp.InitializeResponse,
            exited: new Promise<Error>(() => {}),
            stderr: () => "",
            processGroups: () => [],
            terminate: () => {},
        }),
    });
    const session = await provider.session("happy-agent", { instructions: "", tools: [] });
    const context: SessionContext = {
        instructions: "",
        messages: [{ role: "user", content: [{ type: "text", text: "Continue." }] }],
    };
    for (let attempt = 0; attempt < 3; attempt++) {
        for await (const _event of session.run(createRootContext(), { context })) {
        }
    }
    expect(opened).toBe(2);
    expect(prompts).toBe(3);
    session.destroy();
});
