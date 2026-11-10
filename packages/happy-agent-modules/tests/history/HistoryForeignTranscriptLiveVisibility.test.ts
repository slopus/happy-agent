import { mkdtemp, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { createId } from "@paralleldrive/cuid2";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Type } from "@sinclair/typebox";
import {
    Agent,
    type AgentBaseAcceptedMessage,
    type AgentDatabase,
    type AgentModule,
    type AgentModuleHooks,
    type AgentModuleScope,
    AgentProviders,
    AgentStorage,
    type AnyAgentTool,
    defineAgentTool,
} from "@slopus/happy-agent-base";
import { AcpProvider } from "@slopus/happy-providers";
import { withLogger, type Context } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiModule } from "../../sources/api/ApiModule.js";
import { messageResource } from "../../sources/api/ApiMessageProjection.js";
import { EventsModule } from "../../sources/events/index.js";
import {
    type HistoryMessage,
    HistoryModule,
    MAX_HISTORY_BLOCKS_PER_MESSAGE,
    MAX_HISTORY_MESSAGE_JSON_BYTES,
    MAX_HISTORY_TEXT_LENGTH,
} from "../../sources/history/index.js";
import { USER_MESSAGE_ORIGIN_METADATA } from "../../sources/impl/messageOrigin.js";
import { providersOf } from "../support/fixtures.js";
import { moduleDatabase, type ModuleDatabase } from "../support/moduleDatabase.js";
import { resolveModuleHooks, resolveModuleRuntime } from "../support/moduleHooks.js";
import { ScriptedProvider } from "../support/ScriptedProvider.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
    );
});

interface Deferred<T = void> {
    readonly promise: Promise<T>;
    resolve(value: T): void;
}

function deferred<T = void>(): Deferred<T> {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

interface AcpHttpServerHeader {
    readonly name: string;
    readonly value: string;
}

interface AcpHttpMcpServer {
    readonly type: "http";
    readonly name: string;
    readonly url: string;
    readonly headers: readonly AcpHttpServerHeader[];
}

interface AcpPromptContext {
    readonly sessionId: string;
    readonly mcpServers: readonly AcpHttpMcpServer[];
    update(update: Record<string, unknown>): Promise<void>;
}

async function createAcpWorld(options: {
    readonly name: string;
    readonly tools?: readonly AnyAgentTool[];
    readonly onBeforeResultEnd?: (
        callId: string,
        history: HistoryModule,
        database: ModuleDatabase,
        agentId: string,
    ) => Promise<void>;
    readonly onPrompt: (prompt: AcpPromptContext) => Promise<{ stopReason: "end_turn" }>;
}) {
    const directory = await mkdtemp(join(tmpdir(), `happy-acp-history-${options.name}-`));
    temporaryDirectories.push(directory);

    const database = moduleDatabase([], `acp-history-${options.name}`);
    await database.ready;
    const events = new EventsModule();
    const history = new HistoryModule(events);
    const storage = new AgentStorage<AgentDatabase>({
        acquireLock: () => Promise.resolve({ release: () => Promise.resolve() }),
        database: database.database,
    });
    await storage.migrate(database.context, [events, history]);

    let mcpServers: readonly AcpHttpMcpServer[] = [];
    const provider = new AcpProvider({
        stateDirectory: join(directory, "state"),
        environment: () => ({ cwd: directory, permissionMode: "auto" }),
        connect: async (_cwd, client) => ({
            init: {
                protocolVersion: 1,
                agentCapabilities: {
                    loadSession: true,
                    mcpCapabilities: { http: true, sse: false },
                },
            } as never,
            exited: new Promise<Error>(() => undefined),
            stderr: () => "",
            processGroups: () => [],
            terminate: () => undefined,
            conn: {
                newSession: async (params) => {
                    mcpServers = (params.mcpServers ?? []).flatMap((server) =>
                        "type" in server && server.type === "http" ? [server] : [],
                    );
                    return { sessionId: "foreign-session-1", configOptions: [] };
                },
                loadSession: async () => ({}),
                resumeSession: async () => ({}),
                setSessionConfigOption: async () => ({ configOptions: [] }),
                cancel: async () => undefined,
                prompt: async (params: { sessionId: string }) =>
                    await options.onPrompt({
                        sessionId: params.sessionId,
                        mcpServers,
                        update: async (update) => {
                            await client.sessionUpdate({
                                sessionId: params.sessionId,
                                update: update as never,
                            });
                        },
                    }),
            },
        }),
    });

    const providers = new AgentProviders();
    providers.add("acp", provider, "gym");

    const agentId = "agentforeignhistory";
    const observerModule: AgentModule | undefined =
        options.onBeforeResultEnd === undefined
            ? undefined
            : {
                  name: "observer",
                  migrations: [],
                  beforeStart: async () => ({
                      onEvent: async (_ctx, _scope, event) => {
                          if (event.type === "toolcall_result_start") {
                              await options.onBeforeResultEnd!(
                                  event.callId,
                                  history,
                                  database,
                                  agentId,
                              );
                          }
                      },
                  }),
              };

    const agent = await Agent.create(database.context, {
        id: agentId,
        initialState: { tools: [...(options.tools ?? [])] },
        modules: [
            await resolveModuleRuntime(database.context, events),
            ...(observerModule === undefined
                ? []
                : [await resolveModuleRuntime(database.context, observerModule)]),
            await resolveModuleRuntime(database.context, history),
        ],
        persistence: storage.persistence(agentId),
        provider: "acp",
        providers,
        sharedKV: storage.kv,
    });

    return {
        agent,
        agentId,
        database,
        events,
        history,
        sendUser: async (text: string) => {
            await agent.send(
                database.context,
                { role: "user", content: [{ type: "text", text }] },
                { metadata: { ...USER_MESSAGE_ORIGIN_METADATA } },
            );
        },
        close: async () => {
            await agent.close();
            database.close();
        },
    };
}

function createHookScope(): AgentModuleScope {
    const runValues = new Map<string, unknown>();
    const kvValues = new Map<string, unknown>();
    return {
        agent: {
            id: "agent-a",
            model: "antigravity",
            provider: "acp",
        },
        kv: {
            delete: async (_ctx, key) => {
                kvValues.delete(key);
            },
            read: async (_ctx, key) => kvValues.get(key),
            write: async (_ctx, key, value) => {
                kvValues.set(key, value);
            },
        },
        runKV: {
            delete: async (_ctx, key) => {
                runValues.delete(key);
            },
            read: async (_ctx, key) => runValues.get(key),
            write: async (_ctx, key, value) => {
                runValues.set(key, value);
            },
        },
    } as AgentModuleScope;
}

async function setupHookWorld(name: string): Promise<{
    database: ModuleDatabase;
    events: EventsModule;
    eventHooks: AgentModuleHooks;
    history: HistoryModule;
    historyHooks: AgentModuleHooks;
    scope: AgentModuleScope;
}> {
    const events = new EventsModule();
    const mode = {
        providerId: "acp",
        modelId: "antigravity",
        effort: "medium",
        serviceTier: null,
        permissionMode: "auto" as const,
    };
    const configStub = {
        beginExecutionObservation: () => undefined,
        endExecutionObservation: () => undefined,
        endAgentExecutionObservations: () => undefined,
        currentExecutionObservation: () => undefined,
        executionObservation: (_agentId: string, operationId: string) =>
            operationId.startsWith("inf-overflow") ? [{ mode, contextOverflow: true }] : undefined,
        unavailableCredentialFailure: () => undefined,
        routeSpent: async () => false,
        routeFailedAccount: async () => undefined,
        smartRouteAccounts: () => [],
        failureProvider: () => ({ id: "acp", label: "ACP" }),
        isProviderEnabled: () => true,
    };
    const history = new HistoryModule(events, undefined, configStub as never);
    const database = moduleDatabase([...events.migrations, ...history.migrations], name);
    await database.ready;
    const eventHooks = await resolveModuleHooks(database.context, events);
    const historyHooks = await resolveModuleHooks(database.context, history);
    const scope = createHookScope();
    await scope.kv.write(database.context, "execution_baseline", mode);
    return { database, events, eventHooks, history, historyHooks, scope };
}

function acceptedMessage(id: string, kind: "send" | "steering"): AgentBaseAcceptedMessage {
    return {
        id,
        kind,
        message: { role: "user", content: [{ type: "text", text: id }] },
        metadata: USER_MESSAGE_ORIGIN_METADATA,
        profile: null,
    };
}

async function acceptInWorld(
    world: Awaited<ReturnType<typeof setupHookWorld>>,
    message: AgentBaseAcceptedMessage,
): Promise<void> {
    await world.database.context.inTx(async (txCtx) => {
        await world.historyHooks.messageAcceptedTransact?.(txCtx, world.scope, message);
        await world.eventHooks.messageAcceptedTransact?.(txCtx, world.scope, message);
    });
}

describe("Foreign harness live transcript visibility", () => {
    it("materializes native edit and execute calls from running to completed/failed with stable message ID while the foreign prompt is still running", async () => {
        const afterEdit = deferred();
        const releaseExecute1 = deferred();
        const afterExecute1 = deferred();
        const releaseExecute2 = deferred();
        const afterExecute2 = deferred();
        const releasePromptEnd = deferred();
        const runningSnapshots: Array<{
            readonly messageId: string;
            readonly content: unknown;
        }> = [];

        const world = await createAcpWorld({
            name: "mid-turn-visibility",
            onBeforeResultEnd: async (_callId, history, database, agentId) => {
                const page = await history.runs(database.context, agentId);
                const message = page.runs[0]?.messages[1];
                if (message !== undefined) {
                    const projected = messageResource(message);
                    runningSnapshots.push({
                        messageId: message.recordId,
                        content: projected.content,
                    });
                }
            },
            onPrompt: async (prompt) => {
                await prompt.update({
                    sessionUpdate: "tool_call",
                    toolCallId: "native-edit-1",
                    kind: "edit",
                    status: "pending",
                    title: "Editing src/app.ts",
                    locations: [{ path: "src/app.ts" }],
                });
                await prompt.update({
                    sessionUpdate: "tool_call_update",
                    toolCallId: "native-edit-1",
                    status: "completed",
                    content: [
                        {
                            type: "diff",
                            path: "src/app.ts",
                            newText: "export const ready = true;",
                        },
                    ],
                });
                afterEdit.resolve();
                await releaseExecute1.promise;

                await prompt.update({
                    sessionUpdate: "tool_call",
                    toolCallId: "native-exec-1",
                    kind: "execute",
                    status: "in_progress",
                    title: "pnpm test",
                    rawInput: { command: "pnpm test" },
                });
                await prompt.update({
                    sessionUpdate: "tool_call_update",
                    toolCallId: "native-exec-1",
                    status: "completed",
                    rawOutput: "PASS src/app.test.ts",
                });
                afterExecute1.resolve();
                await releaseExecute2.promise;

                await prompt.update({
                    sessionUpdate: "tool_call",
                    toolCallId: "native-exec-2",
                    kind: "execute",
                    status: "in_progress",
                    title: "pnpm lint",
                    rawInput: { command: "pnpm lint" },
                });
                await prompt.update({
                    sessionUpdate: "tool_call_update",
                    toolCallId: "native-exec-2",
                    status: "failed",
                    rawOutput: "Error: lint failed",
                });
                afterExecute2.resolve();
                await releasePromptEnd.promise;

                await prompt.update({
                    sessionUpdate: "agent_message_chunk",
                    content: { type: "text", text: "Finished checks." },
                });
                return { stopReason: "end_turn" };
            },
        });

        try {
            await world.sendUser("Run checks and update app.ts");

            let liveMessageId = "";
            await afterEdit.promise;
            await vi.waitFor(async () => {
                const page = await world.history.runs(world.database.context, world.agentId);
                expect(page.runs).toHaveLength(1);
                expect(page.runs[0]?.status).toBe("running");
                expect(page.runs[0]?.messages).toHaveLength(2);
                const projected = messageResource(page.runs[0]!.messages[1]!);
                liveMessageId = page.runs[0]!.messages[1]!.recordId;
                expect(runningSnapshots[0]).toEqual({
                    messageId: liveMessageId,
                    content: [
                        {
                            type: "tool_call",
                            id: expect.any(String),
                            name: "edit",
                            status: "running",
                            arguments: {
                                title: "Editing src/app.ts",
                                description: "Editing src/app.ts",
                                paths: ["src/app.ts"],
                            },
                        },
                    ],
                });
                expect(projected.content).toEqual([
                    {
                        type: "tool_call",
                        id: expect.any(String),
                        name: "edit",
                        status: "completed",
                        arguments: {
                            title: "Editing src/app.ts",
                            description: "Editing src/app.ts",
                            paths: ["src/app.ts"],
                        },
                        result: {
                            output: "Edited src/app.ts\nexport const ready = true;",
                        },
                    },
                ]);
            });

            releaseExecute1.resolve();
            await afterExecute1.promise;
            await vi.waitFor(async () => {
                const page = await world.history.runs(world.database.context, world.agentId);
                expect(page.runs[0]?.status).toBe("running");
                const projected = messageResource(page.runs[0]!.messages[1]!);
                expect(projected.id).toBe(liveMessageId);
                expect(runningSnapshots[1]).toEqual({
                    messageId: liveMessageId,
                    content: [
                        expect.objectContaining({
                            type: "tool_call",
                            name: "edit",
                            status: "completed",
                        }),
                        {
                            type: "tool_call",
                            id: expect.any(String),
                            name: "execute",
                            status: "running",
                            arguments: {
                                title: "pnpm test",
                                description: "pnpm test",
                                input: { command: "pnpm test" },
                            },
                        },
                    ],
                });
                expect(projected.content).toEqual([
                    expect.objectContaining({
                        type: "tool_call",
                        name: "edit",
                        status: "completed",
                        result: { output: "Edited src/app.ts\nexport const ready = true;" },
                    }),
                    {
                        type: "tool_call",
                        id: expect.any(String),
                        name: "execute",
                        status: "completed",
                        arguments: {
                            title: "pnpm test",
                            description: "pnpm test",
                            input: { command: "pnpm test" },
                        },
                        result: {
                            output: "PASS src/app.test.ts",
                        },
                    },
                ]);
            });

            releaseExecute2.resolve();
            await afterExecute2.promise;
            await vi.waitFor(async () => {
                const page = await world.history.runs(world.database.context, world.agentId);
                expect(page.runs[0]?.status).toBe("running");
                const projected = messageResource(page.runs[0]!.messages[1]!);
                expect(projected.id).toBe(liveMessageId);
                expect(runningSnapshots[2]).toEqual({
                    messageId: liveMessageId,
                    content: [
                        expect.objectContaining({
                            type: "tool_call",
                            name: "edit",
                            status: "completed",
                        }),
                        expect.objectContaining({
                            type: "tool_call",
                            name: "execute",
                            status: "completed",
                        }),
                        {
                            type: "tool_call",
                            id: expect.any(String),
                            name: "execute",
                            status: "running",
                            arguments: {
                                title: "pnpm lint",
                                description: "pnpm lint",
                                input: { command: "pnpm lint" },
                            },
                        },
                    ],
                });
                expect(projected.content).toEqual([
                    expect.objectContaining({
                        type: "tool_call",
                        name: "edit",
                        status: "completed",
                    }),
                    expect.objectContaining({
                        type: "tool_call",
                        name: "execute",
                        status: "completed",
                    }),
                    {
                        type: "tool_call",
                        id: expect.any(String),
                        name: "execute",
                        status: "failed",
                        arguments: {
                            title: "pnpm lint",
                            description: "pnpm lint",
                            input: { command: "pnpm lint" },
                        },
                        result: {
                            output: "Error: lint failed",
                        },
                    },
                ]);
            });

            releasePromptEnd.resolve();
            await world.agent.waitForIdle();

            const finalPage = await world.history.runs(world.database.context, world.agentId);
            expect(finalPage.runs).toHaveLength(1);
            expect(finalPage.runs[0]?.status).toBe("completed");
            expect(finalPage.runs[0]?.messages).toHaveLength(2);
            const finalProjected = messageResource(finalPage.runs[0]!.messages[1]!);
            expect(finalProjected.id).toBe(liveMessageId);
            expect(finalProjected.content).toEqual([
                expect.objectContaining({
                    type: "tool_call",
                    name: "edit",
                    status: "completed",
                    result: { output: "Edited src/app.ts\nexport const ready = true;" },
                }),
                expect.objectContaining({
                    type: "tool_call",
                    name: "execute",
                    status: "completed",
                    result: { output: "PASS src/app.test.ts" },
                }),
                expect.objectContaining({
                    type: "tool_call",
                    name: "execute",
                    status: "failed",
                    result: { output: "Error: lint failed" },
                }),
                {
                    type: "text",
                    text: "Finished checks.",
                },
            ]);
        } finally {
            releaseExecute1.resolve();
            releaseExecute2.resolve();
            releasePromptEnd.resolve();
            await world.close();
        }
    });

    it("preserves live mid-turn visibility and ordering across native foreign calls and a bridged Happy MCP tool call", async () => {
        const lookupRunning = deferred();
        const releaseLookup = deferred();
        const lookupTool = defineAgentTool({
            name: "happy_lookup",
            description: "Look up a configuration value.",
            parameters: Type.Object({ key: Type.String() }),
            returnType: Type.Object({ value: Type.String() }),
            shouldReviewInAutoMode: () => false,
            execute: async (_ctx, args) => {
                lookupRunning.resolve();
                await releaseLookup.promise;
                return { value: `resolved:${args.key}` };
            },
            toLLM: (result) => [{ type: "text", text: result.value }],
        });

        const world = await createAcpWorld({
            name: "bridge-interleaved",
            tools: [lookupTool],
            onPrompt: async (prompt) => {
                await prompt.update({
                    sessionUpdate: "tool_call",
                    toolCallId: "pre-bridge-edit",
                    kind: "edit",
                    status: "completed",
                    title: "Prepare config",
                    content: [{ type: "diff", path: "config.ts", newText: "export default {};" }],
                });

                const server = prompt.mcpServers[0];
                if (server === undefined) {
                    throw new Error("Expected Happy MCP bridge server in newSession.");
                }
                const mcpClient = new Client({ name: "foreign-harness", version: "1.0.0" });
                await mcpClient.connect(
                    new StreamableHTTPClientTransport(new URL(server.url), {
                        requestInit: {
                            headers: Object.fromEntries(
                                server.headers.map((header) => [header.name, header.value]),
                            ),
                        },
                    }) as Parameters<typeof mcpClient.connect>[0],
                );
                const toolResult = await mcpClient.callTool({
                    name: "happy_lookup",
                    arguments: { key: "alpha" },
                });
                await mcpClient.close();
                const bridgedText =
                    (
                        toolResult.content as ReadonlyArray<{
                            readonly type: string;
                            readonly text?: string;
                        }>
                    )[0]?.text ?? "";

                await prompt.update({
                    sessionUpdate: "tool_call",
                    toolCallId: "post-bridge-exec",
                    kind: "execute",
                    status: "completed",
                    title: "Verify lookup",
                    rawOutput: `verified:${bridgedText}`,
                });
                await prompt.update({
                    sessionUpdate: "agent_message_chunk",
                    content: { type: "text", text: `Done with ${bridgedText}.` },
                });
                return { stopReason: "end_turn" };
            },
        });

        try {
            await world.sendUser("Prepare, look up alpha, and verify");

            await lookupRunning.promise;
            await vi.waitFor(async () => {
                const livePage = await world.history.runs(world.database.context, world.agentId);
                expect(livePage.runs[0]?.status).toBe("running");
                expect(livePage.runs[0]?.messages).toHaveLength(2);
                expect(messageResource(livePage.runs[0]!.messages[1]!).content).toEqual([
                    expect.objectContaining({
                        type: "tool_call",
                        name: "edit",
                        status: "completed",
                        result: { output: "Edited config.ts\nexport default {};" },
                    }),
                    expect.objectContaining({
                        type: "tool_call",
                        name: "happy_lookup",
                        status: "running",
                        arguments: { key: "alpha" },
                    }),
                ]);
            });

            releaseLookup.resolve();
            await world.agent.waitForIdle();

            const page = await world.history.runs(world.database.context, world.agentId);
            expect(page.runs).toHaveLength(1);
            expect(page.runs[0]?.status).toBe("completed");
            const projectedMessages = page.runs[0]!.messages.map((message) =>
                messageResource(message),
            );
            expect(projectedMessages.map((message) => message.role)).toEqual([
                "user",
                "agent",
                "agent",
            ]);
            expect(projectedMessages[1]?.content).toEqual([
                expect.objectContaining({
                    type: "tool_call",
                    name: "edit",
                    status: "completed",
                    result: { output: "Edited config.ts\nexport default {};" },
                }),
                expect.objectContaining({
                    type: "tool_call",
                    name: "happy_lookup",
                    status: "completed",
                    arguments: { key: "alpha" },
                    result: { output: "resolved:alpha" },
                }),
            ]);
            expect(projectedMessages[2]?.content).toEqual([
                expect.objectContaining({
                    type: "tool_call",
                    name: "execute",
                    status: "completed",
                    result: { output: "verified:resolved:alpha" },
                }),
                {
                    type: "text",
                    text: "Done with resolved:alpha.",
                },
            ]);
        } finally {
            releaseLookup.resolve();
            await world.close();
        }
    });

    it("splits a single foreign turn of 2x MAX_HISTORY_BLOCKS_PER_MESSAGE + 1 blocks across continuation messages in exact order", async () => {
        const nativeCallCount = MAX_HISTORY_BLOCKS_PER_MESSAGE;
        const world = await createAcpWorld({
            name: "long-turn-continuation",
            onPrompt: async (prompt) => {
                for (let index = 0; index < nativeCallCount; index += 1) {
                    await prompt.update({
                        sessionUpdate: "tool_call",
                        toolCallId: `step-${index}`,
                        kind: "execute",
                        status: "completed",
                        title: `Step ${index}`,
                        rawOutput: `ok-${index}`,
                    });
                }
                await prompt.update({
                    sessionUpdate: "agent_message_chunk",
                    content: { type: "text", text: "Completed long turn." },
                });
                return { stopReason: "end_turn" };
            },
        });

        try {
            await world.sendUser("Run a long turn");
            await world.agent.waitForIdle();

            const page = await world.history.runs(world.database.context, world.agentId);
            expect(page.runs).toHaveLength(1);
            expect(page.runs[0]?.status).toBe("completed");
            const assistantMessages = page.runs[0]!.messages.filter(
                (message) => message.role === "assistant",
            );
            expect(assistantMessages).toHaveLength(3);
            expect(assistantMessages.map((message) => message.blocks.length)).toEqual([
                MAX_HISTORY_BLOCKS_PER_MESSAGE,
                MAX_HISTORY_BLOCKS_PER_MESSAGE,
                1,
            ]);
            const totalBlocks = assistantMessages.reduce(
                (sum, message) => sum + message.blocks.length,
                0,
            );
            expect(totalBlocks).toBe(2 * MAX_HISTORY_BLOCKS_PER_MESSAGE + 1);

            const projectedContent = assistantMessages.flatMap(
                (message) => messageResource(message).content as Record<string, unknown>[],
            );
            const toolCalls = projectedContent.filter((block) => block.type === "tool_call");
            expect(toolCalls).toHaveLength(nativeCallCount);
            for (let index = 0; index < nativeCallCount; index += 1) {
                expect(toolCalls[index]).toMatchObject({
                    type: "tool_call",
                    name: "execute",
                    status: "completed",
                    arguments: { title: `Step ${index}` },
                    result: { output: `ok-${index}` },
                });
            }
            expect(projectedContent.at(-1)).toEqual({
                type: "text",
                text: "Completed long turn.",
            });
        } finally {
            await world.close();
        }
        // Inherently expensive: 2,048 tool calls in one inference. The Events module rewrites
        // the whole active run and journals a partial of every block produced so far for each
        // provider event, so this one turn costs time quadratic in its length (about 30 s on a
        // fast laptop, and over 120 s on a CI runner). History itself splits at 2,048 blocks.
    }, 600_000);

    it("splits an active inference onto a continuation assistant message when MAX_HISTORY_MESSAGE_JSON_BYTES would be exceeded", async () => {
        const world = await setupHookWorld("byte-cap-continuation");
        const inference = {
            inferenceId: "inference-byte-cap",
            loopId: "loop-byte-cap",
            turnId: "turn-byte-cap",
            contextTokens: undefined,
        };
        const callId = createId();
        const threeMegabyteUtf8Chunk = "\u2603".repeat(MAX_HISTORY_TEXT_LENGTH);

        try {
            await acceptInWorld(world, acceptedMessage("user-byte-cap", "send"));
            await world.eventHooks.beforeInferenceTransact?.(
                world.database.context,
                world.scope,
                inference,
            );
            await world.historyHooks.beforeInferenceTransact?.(
                world.database.context,
                world.scope,
                inference,
            );

            for (let index = 0; index < 23; index += 1) {
                await world.historyHooks.onEventTransact?.(world.database.context, world.scope, {
                    type: "text_end",
                    block: { type: "text", text: threeMegabyteUtf8Chunk },
                } as never);
            }

            await world.historyHooks.onEventTransact?.(world.database.context, world.scope, {
                type: "toolcall_end",
                block: {
                    type: "tool_call",
                    callId,
                    name: "execute",
                    arguments: JSON.stringify({ title: "post-split-exec" }),
                },
            } as never);
            await world.historyHooks.onEvent?.(world.database.context, world.scope, {
                type: "toolcall_result_start",
                callId,
            });
            await world.historyHooks.onEvent?.(world.database.context, world.scope, {
                type: "toolcall_result_end",
                callId,
                content: [{ type: "text", text: "byte-cap-result" }],
                isError: false,
            });
            await world.historyHooks.afterInferenceTransact?.(world.database.context, world.scope, {
                ...inference,
                state: "normal",
                tokens: { input: 1, output: 1 },
            });
            await world.historyHooks.afterTurnTransact?.(world.database.context, world.scope, {
                aborted: false,
                contextTokens: undefined,
                loopId: "loop-byte-cap",
                turnId: "turn-byte-cap",
            });

            const page = await world.history.runs(world.database.context, "agent-a");
            const assistantMessages = page.runs[0]!.messages.filter(
                (message) => message.role === "assistant",
            );
            expect(assistantMessages).toHaveLength(2);
            expect(assistantMessages[0]?.recordId).toBe(inference.inferenceId);
            expect(assistantMessages[0]?.blocks).toHaveLength(22);
            expect(assistantMessages[1]?.recordId).not.toBe(inference.inferenceId);
            expect(assistantMessages[1]?.blocks).toHaveLength(3);
            for (const message of assistantMessages) {
                expect(Buffer.byteLength(JSON.stringify(message), "utf8")).toBeLessThanOrEqual(
                    MAX_HISTORY_MESSAGE_JSON_BYTES,
                );
            }
            expect(messageResource(assistantMessages[1]!).content).toEqual([
                { type: "text", text: threeMegabyteUtf8Chunk },
                expect.objectContaining({
                    type: "tool_call",
                    name: "execute",
                    status: "completed",
                    result: { output: "byte-cap-result" },
                }),
            ]);
        } finally {
            world.database.close();
        }
    }, 60_000);

    it("preserves or resets live assistant rows across inference failure, mid-stream retry, abort, steering, and context-overflow reset", async () => {
        const world = await setupHookWorld("failure-retry-abort-steer-overflow");
        try {
            // 1. Mid-stream block_reset retry discards unpersisted fragments and keeps completed live blocks + results
            await acceptInWorld(world, acceptedMessage("run-retry", "send"));
            const retryInf = {
                inferenceId: "inf-retry",
                loopId: "loop-1",
                turnId: "turn-1",
                contextTokens: undefined,
            };
            await world.eventHooks.beforeInferenceTransact?.(
                world.database.context,
                world.scope,
                retryInf,
            );
            await world.historyHooks.beforeInferenceTransact?.(
                world.database.context,
                world.scope,
                retryInf,
            );
            const orphanCallId = createId();
            const recoveredCallId = createId();
            await world.historyHooks.onEvent?.(world.database.context, world.scope, {
                type: "toolcall_result_start",
                callId: orphanCallId,
            });
            await world.historyHooks.onEvent?.(world.database.context, world.scope, {
                type: "block_reset",
            });
            await world.historyHooks.onEventTransact?.(world.database.context, world.scope, {
                type: "toolcall_end",
                block: {
                    type: "tool_call",
                    callId: recoveredCallId,
                    name: "execute",
                    arguments: JSON.stringify({ title: "recovered" }),
                },
            } as never);
            await world.historyHooks.onEvent?.(world.database.context, world.scope, {
                type: "toolcall_result_start",
                callId: recoveredCallId,
            });
            await world.historyHooks.onEvent?.(world.database.context, world.scope, {
                type: "toolcall_result_end",
                callId: recoveredCallId,
                content: [{ type: "text", text: "recovered-ok" }],
            });
            await world.historyHooks.afterInferenceTransact?.(world.database.context, world.scope, {
                ...retryInf,
                state: "normal",
                tokens: { input: 1, output: 1 },
            });
            await world.historyHooks.afterAgentSettledTransact?.(
                world.database.context,
                world.scope,
                { loopId: "loop-1", settlementId: "settle-1" },
            );
            await world.eventHooks.afterAgentSettledTransact?.(
                world.database.context,
                world.scope,
                { loopId: "loop-1", settlementId: "settle-1" },
            );

            // 2. Failure after a live block keeps the live assistant row and appends an error row
            await acceptInWorld(world, acceptedMessage("run-failed", "send"));
            const failedInf = {
                inferenceId: "inf-failed",
                loopId: "loop-2",
                turnId: "turn-2",
                contextTokens: undefined,
            };
            await world.eventHooks.beforeInferenceTransact?.(
                world.database.context,
                world.scope,
                failedInf,
            );
            await world.historyHooks.beforeInferenceTransact?.(
                world.database.context,
                world.scope,
                failedInf,
            );
            await world.historyHooks.onEventTransact?.(world.database.context, world.scope, {
                type: "text_end",
                block: { type: "text", text: "Partial before error." },
            } as never);
            expect(
                (await world.history.runs(world.database.context, "agent-a")).runs
                    .at(-1)
                    ?.messages.map((m) => m.role),
            ).toEqual(["user", "assistant"]);
            await world.historyHooks.afterInferenceTransact?.(world.database.context, world.scope, {
                ...failedInf,
                state: "error",
                tokens: undefined,
                errorMessage: "provider boom after live block",
            });
            await world.historyHooks.afterAgentSettledTransact?.(
                world.database.context,
                world.scope,
                {
                    loopId: "loop-2",
                    settlementId: "settle-2",
                    error: "provider boom after live block",
                },
            );
            await world.eventHooks.afterAgentSettledTransact?.(
                world.database.context,
                world.scope,
                {
                    loopId: "loop-2",
                    settlementId: "settle-2",
                    error: "provider boom after live block",
                },
            );

            // 3. Abort after a live block keeps the live assistant row and finishes the run as aborted
            await acceptInWorld(world, acceptedMessage("run-aborted", "send"));
            const abortInf = {
                inferenceId: "inf-aborted",
                loopId: "loop-3",
                turnId: "turn-3",
                contextTokens: undefined,
            };
            await world.eventHooks.beforeInferenceTransact?.(
                world.database.context,
                world.scope,
                abortInf,
            );
            await world.historyHooks.beforeInferenceTransact?.(
                world.database.context,
                world.scope,
                abortInf,
            );
            await world.historyHooks.onEventTransact?.(world.database.context, world.scope, {
                type: "text_end",
                block: { type: "text", text: "Completed before abort." },
            } as never);
            await world.historyHooks.afterInferenceTransact?.(world.database.context, world.scope, {
                ...abortInf,
                state: "cancelled",
                tokens: undefined,
            });
            await world.historyHooks.afterTurnTransact?.(world.database.context, world.scope, {
                aborted: true,
                contextTokens: undefined,
                loopId: "loop-3",
                turnId: "turn-3",
            });
            await world.historyHooks.afterAgentSettledTransact?.(
                world.database.context,
                world.scope,
                { loopId: "loop-3", settlementId: "settle-3" },
            );
            await world.eventHooks.afterAgentSettledTransact?.(
                world.database.context,
                world.scope,
                { loopId: "loop-3", settlementId: "settle-3" },
            );

            // 4. Steer after a live block finalizes the previous run as aborted (reason: "steering") with its live row kept
            await acceptInWorld(world, acceptedMessage("run-pre-steer", "send"));
            const preSteerInf = {
                inferenceId: "inf-pre-steer",
                loopId: "loop-4",
                turnId: "turn-4",
                contextTokens: undefined,
            };
            await world.eventHooks.beforeInferenceTransact?.(
                world.database.context,
                world.scope,
                preSteerInf,
            );
            await world.historyHooks.beforeInferenceTransact?.(
                world.database.context,
                world.scope,
                preSteerInf,
            );
            await world.eventHooks.onEvent?.(world.database.context, world.scope, {
                type: "text_start",
            });
            await world.historyHooks.onEventTransact?.(world.database.context, world.scope, {
                type: "text_end",
                block: { type: "text", text: "First step before steer." },
            } as never);
            await world.historyHooks.afterInferenceTransact?.(world.database.context, world.scope, {
                ...preSteerInf,
                state: "normal",
                tokens: { input: 1, output: 1 },
            });
            await acceptInWorld(world, acceptedMessage("run-steered", "steering"));
            const steeredInf = {
                inferenceId: "inf-steered",
                loopId: "loop-4",
                turnId: "turn-4b",
                contextTokens: undefined,
            };
            await world.eventHooks.beforeInferenceTransact?.(
                world.database.context,
                world.scope,
                steeredInf,
            );
            await world.historyHooks.beforeInferenceTransact?.(
                world.database.context,
                world.scope,
                steeredInf,
            );
            await world.historyHooks.onEventTransact?.(world.database.context, world.scope, {
                type: "text_end",
                block: { type: "text", text: "Answered steer." },
            } as never);
            await world.historyHooks.afterInferenceTransact?.(world.database.context, world.scope, {
                ...steeredInf,
                state: "normal",
                tokens: { input: 1, output: 1 },
            });
            await world.historyHooks.afterAgentSettledTransact?.(
                world.database.context,
                world.scope,
                { loopId: "loop-4", settlementId: "settle-4" },
            );
            await world.eventHooks.afterAgentSettledTransact?.(
                world.database.context,
                world.scope,
                { loopId: "loop-4", settlementId: "settle-4" },
            );

            // 5. Context overflow with 0 materialized blocks suppresses the error row, emits Context reset, and retries
            await acceptInWorld(world, acceptedMessage("run-overflow-reset", "send"));
            const overflowEmptyInf = {
                inferenceId: "inf-overflow-empty",
                loopId: "loop-5",
                turnId: "turn-5",
                contextTokens: undefined,
            };
            await world.eventHooks.beforeInferenceTransact?.(
                world.database.context,
                world.scope,
                overflowEmptyInf,
            );
            await world.historyHooks.beforeInferenceTransact?.(
                world.database.context,
                world.scope,
                overflowEmptyInf,
            );
            await world.historyHooks.afterInferenceTransact?.(world.database.context, world.scope, {
                ...overflowEmptyInf,
                state: "error",
                tokens: undefined,
                errorMessage: "prompt is too long",
            });
            await world.historyHooks.modelChanged?.(world.database.context, world.scope, {
                previousProvider: "acp",
                previousModel: "antigravity",
                provider: "acp",
                model: "antigravity",
                providers: new AgentProviders(),
                reason: "context_overflow",
                wasReset: true,
            });
            const overflowRecoveredInf = {
                inferenceId: "inf-overflow-recovered",
                loopId: "loop-5",
                turnId: "turn-5",
                contextTokens: undefined,
            };
            await world.eventHooks.beforeInferenceTransact?.(
                world.database.context,
                world.scope,
                overflowRecoveredInf,
            );
            await world.historyHooks.beforeInferenceTransact?.(
                world.database.context,
                world.scope,
                overflowRecoveredInf,
            );
            await world.historyHooks.onEventTransact?.(world.database.context, world.scope, {
                type: "text_end",
                block: { type: "text", text: "Recovered after context reset." },
            } as never);
            await world.historyHooks.afterInferenceTransact?.(world.database.context, world.scope, {
                ...overflowRecoveredInf,
                state: "normal",
                tokens: { input: 1, output: 1 },
            });
            await world.historyHooks.afterAgentSettledTransact?.(
                world.database.context,
                world.scope,
                { loopId: "loop-5", settlementId: "settle-5" },
            );
            await world.eventHooks.afterAgentSettledTransact?.(
                world.database.context,
                world.scope,
                { loopId: "loop-5", settlementId: "settle-5" },
            );

            // 6. Context overflow AFTER a live block was materialized does NOT suppress the error row
            await acceptInWorld(world, acceptedMessage("run-overflow-after-live", "send"));
            const overflowLiveInf = {
                inferenceId: "inf-overflow-after-live",
                loopId: "loop-6",
                turnId: "turn-6",
                contextTokens: undefined,
            };
            await world.eventHooks.beforeInferenceTransact?.(
                world.database.context,
                world.scope,
                overflowLiveInf,
            );
            await world.historyHooks.beforeInferenceTransact?.(
                world.database.context,
                world.scope,
                overflowLiveInf,
            );
            await world.historyHooks.onEventTransact?.(world.database.context, world.scope, {
                type: "text_end",
                block: { type: "text", text: "Output before overflow." },
            } as never);
            await world.historyHooks.afterInferenceTransact?.(world.database.context, world.scope, {
                ...overflowLiveInf,
                state: "error",
                tokens: undefined,
                errorMessage: "context overflow mid-stream",
            });
            await world.historyHooks.afterAgentSettledTransact?.(
                world.database.context,
                world.scope,
                {
                    loopId: "loop-6",
                    settlementId: "settle-6",
                    error: "context overflow mid-stream",
                },
            );

            const page = await world.history.runs(world.database.context, "agent-a");
            expect(page.runs).toHaveLength(7);
            const [
                retryRun,
                failedRun,
                abortedRun,
                preSteerRun,
                steeredRun,
                overflowResetRun,
                overflowAfterLiveRun,
            ] = page.runs;

            expect(retryRun?.status).toBe("completed");
            expect(retryRun?.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
            expect(messageResource(retryRun!.messages[1]!).content).toEqual([
                expect.objectContaining({
                    type: "tool_call",
                    name: "execute",
                    status: "completed",
                    result: { output: "recovered-ok" },
                }),
            ]);

            expect(failedRun?.status).toBe("failed");
            expect(failedRun?.messages.map((m) => m.role)).toEqual(["user", "assistant", "error"]);
            expect(messageResource(failedRun!.messages[1]!).content).toEqual([
                { type: "text", text: "Partial before error." },
            ]);

            expect(abortedRun?.status).toBe("aborted");
            expect(abortedRun?.reason).toBe("abort");
            expect(abortedRun?.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
            expect(messageResource(abortedRun!.messages[1]!).content).toEqual([
                { type: "text", text: "Completed before abort." },
            ]);

            expect(preSteerRun?.status).toBe("aborted");
            expect(preSteerRun?.reason).toBe("steering");
            expect(preSteerRun?.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
            expect(messageResource(preSteerRun!.messages[1]!).content).toEqual([
                { type: "text", text: "First step before steer." },
            ]);

            expect(steeredRun?.status).toBe("completed");
            expect(steeredRun?.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
            expect(messageResource(steeredRun!.messages[1]!).content).toEqual([
                { type: "text", text: "Answered steer." },
            ]);

            expect(overflowResetRun?.status).toBe("completed");
            expect(overflowResetRun?.messages.map((m) => m.role)).toEqual([
                "user",
                "service",
                "assistant",
            ]);
            expect(messageResource(overflowResetRun!.messages[2]!).content).toEqual([
                { type: "text", text: "Recovered after context reset." },
            ]);

            expect(overflowAfterLiveRun?.status).toBe("failed");
            expect(overflowAfterLiveRun?.messages.map((m) => m.role)).toEqual([
                "user",
                "assistant",
                "error",
            ]);
            expect(messageResource(overflowAfterLiveRun!.messages[1]!).content).toEqual([
                { type: "text", text: "Output before overflow." },
            ]);
        } finally {
            world.database.close();
        }
    });

    it("records provider-local tool results on published @slopus/happy-agent-base@0.0.64 via onEvent while ignoring abandoned attempts and deduplicating by callId", async () => {
        const world = await setupHookWorld("onevent-0064-idempotency");
        const inference = {
            inferenceId: "inference-onevent",
            loopId: "loop-onevent",
            turnId: "turn-onevent",
            contextTokens: undefined,
        };
        const abandonedCallId = createId();
        const committedCallId = createId();

        try {
            await acceptInWorld(world, acceptedMessage("user-onevent", "send"));
            await world.eventHooks.beforeInferenceTransact?.(
                world.database.context,
                world.scope,
                inference,
            );
            await world.historyHooks.beforeInferenceTransact?.(
                world.database.context,
                world.scope,
                inference,
            );

            // Abandoned attempt starts a result then resets before persisting any tool_call
            await world.historyHooks.onEvent?.(world.database.context, world.scope, {
                type: "toolcall_result_start",
                callId: abandonedCallId,
            });
            await world.historyHooks.onEvent?.(world.database.context, world.scope, {
                type: "block_reset",
            });
            await world.historyHooks.onEvent?.(world.database.context, world.scope, {
                type: "toolcall_result_end",
                callId: abandonedCallId,
                content: [{ type: "text", text: "stale-abandoned-output" }],
                isError: false,
            });

            // Committed tool call persisted via onEventTransact
            await world.historyHooks.onEventTransact?.(world.database.context, world.scope, {
                type: "toolcall_end",
                block: {
                    type: "tool_call",
                    callId: committedCallId,
                    name: "execute",
                    arguments: JSON.stringify({ title: "pnpm check" }),
                },
            } as never);

            // Stray toolcall_result_end without a matching active toolcall_result_start is ignored
            await world.historyHooks.onEvent?.(world.database.context, world.scope, {
                type: "toolcall_result_end",
                callId: committedCallId,
                content: [{ type: "text", text: "unstarted-wrong-output" }],
                isError: false,
            });

            // Legitimate toolcall_result_start + toolcall_result_end on onEvent (0.0.64 path)
            await world.historyHooks.onEvent?.(world.database.context, world.scope, {
                type: "toolcall_result_start",
                callId: committedCallId,
            });
            await world.historyHooks.onEvent?.(world.database.context, world.scope, {
                type: "toolcall_result_end",
                callId: committedCallId,
                content: [{ type: "text", text: "authoritative-output" }],
                isError: false,
            });

            // Newer AgentBase also delivers toolcall_result_end via onEventTransact for the same callId
            await world.historyHooks.onEventTransact?.(world.database.context, world.scope, {
                type: "toolcall_result_end",
                callId: committedCallId,
                content: [{ type: "text", text: "duplicate-output" }],
                isError: false,
                block: {
                    type: "tool_result",
                    callId: committedCallId,
                    content: [{ type: "text", text: "duplicate-output" }],
                    isError: false,
                },
            } as never);
            await world.historyHooks.afterInferenceTransact?.(world.database.context, world.scope, {
                ...inference,
                state: "normal",
                tokens: { input: 1, output: 1 },
            });

            const page = await world.history.runs(world.database.context, "agent-a");
            const assistantMessage = page.runs[0]!.messages[1]!;
            expect(assistantMessage.blocks).toEqual([
                {
                    type: "tool_call",
                    callId: committedCallId,
                    name: "execute",
                    arguments: { title: "pnpm check" },
                },
                {
                    type: "tool_result",
                    callId: committedCallId,
                    toolName: "execute",
                    display: "Tool execute returned 20 characters.",
                    output: "authoritative-output",
                },
            ]);

            // R4: If #recordProviderToolResult throws on the onEvent path, warn with agentId and callId only (no output text)
            const warn = vi.fn();
            const loggedCtx = withLogger(world.database.context, {
                debug: vi.fn(),
                error: vi.fn(),
                fatal: vi.fn(),
                info: vi.fn(),
                trace: vi.fn(),
                warn,
            });
            const failingCallId = createId();
            await world.scope.runKV.write(loggedCtx, "pending_blocks", "corrupted-pending-blocks");
            await world.historyHooks.onEvent?.(loggedCtx, world.scope, {
                type: "toolcall_result_start",
                callId: failingCallId,
            });
            await expect(
                world.historyHooks.onEvent?.(loggedCtx, world.scope, {
                    type: "toolcall_result_end",
                    callId: failingCallId,
                    content: [{ type: "text", text: "sensitive-tool-output-sentinel" }],
                    isError: false,
                }),
            ).resolves.toBeUndefined();
            expect(warn).toHaveBeenCalledTimes(1);
            const serializedWarnCall = JSON.stringify(warn.mock.calls[0]);
            expect(serializedWarnCall).toContain("agent-a");
            expect(serializedWarnCall).toContain(failingCallId);
            expect(serializedWarnCall).not.toContain("sensitive-tool-output-sentinel");
        } finally {
            world.database.close();
        }
    });

    it("flushes reserved execution-configuration rows before the live assistant row exactly once across retries", async () => {
        const events = new EventsModule();
        const mode = {
            providerId: "acp",
            modelId: "antigravity",
            effort: "high",
            serviceTier: null,
            permissionMode: "auto" as const,
        };
        let finalizedAttempts: Array<{ readonly mode: typeof mode }> = [];
        let currentOrdinal = 1;
        const configStub = {
            beginExecutionObservation: () => undefined,
            endExecutionObservation: () => undefined,
            endAgentExecutionObservations: () => undefined,
            currentExecutionObservation: () => ({
                ordinal: currentOrdinal,
                attempt: { mode },
            }),
            executionObservation: () => finalizedAttempts,
        };
        const history = new HistoryModule(events, undefined, configStub as never);
        const database = moduleDatabase(
            [...events.migrations, ...history.migrations],
            "exec-config-before-live-assistant",
        );
        await database.ready;
        const eventHooks = await resolveModuleHooks(database.context, events);
        const historyHooks = await resolveModuleHooks(database.context, history);
        const scope = createHookScope();
        const inference = {
            inferenceId: "inference-exec-config",
            loopId: "loop-exec-config",
            turnId: "turn-exec-config",
            contextTokens: undefined,
        };

        try {
            await database.context.inTx(async (txCtx) => {
                const message = acceptedMessage("user-exec-config", "send");
                await historyHooks.messageAcceptedTransact?.(txCtx, scope, message);
                await eventHooks.messageAcceptedTransact?.(txCtx, scope, message);
            });
            await database.context.inTx(async (txCtx) => {
                await eventHooks.beforeInferenceTransact?.(txCtx, scope, inference);
                await historyHooks.beforeInferenceTransact?.(txCtx, scope, inference);
            });

            // Attempt 1 reserves an execution configuration at block_start, then retries into Attempt 2
            const firstReserved = history.pendingExecutionConfigurations(
                "agent-a",
                inference.inferenceId,
            );
            expect(firstReserved).toHaveLength(1);
            finalizedAttempts = [{ mode }];
            currentOrdinal = 2;
            const retryReserved = history.pendingExecutionConfigurations(
                "agent-a",
                inference.inferenceId,
            );
            expect(retryReserved).toHaveLength(0);

            // First completed block flushes the reserved configuration row ahead of the live assistant row
            await database.context.inTx(async (txCtx) => {
                await historyHooks.onEventTransact?.(txCtx, scope, {
                    type: "text_end",
                    block: { type: "text", text: "Live assistant text." },
                } as never);
            });

            const livePage = await history.runs(database.context, "agent-a");
            expect(livePage.runs[0]?.messages.map((m) => m.role)).toEqual([
                "user",
                "service",
                "assistant",
            ]);

            // Completing the inference does not duplicate either the configuration row or the assistant row
            await database.context.inTx(async (txCtx) => {
                await historyHooks.afterInferenceTransact?.(txCtx, scope, {
                    ...inference,
                    state: "normal",
                    tokens: { input: 1, output: 1 },
                });
                await historyHooks.afterAgentSettledTransact?.(txCtx, scope, {
                    loopId: "loop-exec-config",
                    settlementId: "settle-exec-config",
                });
            });

            const finalPage = await history.runs(database.context, "agent-a");
            expect(finalPage.runs[0]?.messages.map((m) => m.role)).toEqual([
                "user",
                "service",
                "assistant",
            ]);
            expect(finalPage.runs[0]?.messages[1]?.blocks).toEqual([
                {
                    type: "configuration",
                    before: null,
                    after: mode,
                    beforeMessageId: "user-exec-config",
                },
            ]);
            expect(finalPage.runs[0]?.messages[2]?.recordId).toBe(inference.inferenceId);
        } finally {
            database.close();
        }
    });

    it("notifies onAppend subscribers with the complete final blocks and tool results for a native local-tool turn and an ACP continuation turn", async () => {
        // 1. Native turn with a local tool call and its result on a real Agent
        const nativeDb = moduleDatabase([], "on-append-native-turn");
        await nativeDb.ready;
        const nativeEvents = new EventsModule();
        const nativeHistory = new HistoryModule(nativeEvents);
        const nativeStorage = new AgentStorage<AgentDatabase>({
            acquireLock: () => Promise.resolve({ release: () => Promise.resolve() }),
            database: nativeDb.database,
        });
        await nativeStorage.migrate(nativeDb.context, [nativeEvents, nativeHistory]);

        const nativeLastNotified = new Map<string, HistoryMessage>();
        nativeHistory.onAppend((_ctx, _agentId, messages) => {
            for (const message of messages) {
                nativeLastNotified.set(message.recordId, message);
            }
        });

        const localCallId = createId();
        const localEchoTool = defineAgentTool({
            name: "local_echo",
            description: "Echo a value locally.",
            parameters: Type.Object({ value: Type.String() }),
            returnType: Type.Object({ echoed: Type.String() }),
            shouldReviewInAutoMode: () => false,
            execute: async (_ctx, args) => ({ echoed: `local:${args.value}` }),
            toLLM: (result) => [{ type: "text", text: result.echoed }],
        });
        const nativeProvider = new ScriptedProvider([
            [
                { type: "block_start" },
                { type: "reasoning_start" },
                { type: "reasoning_delta", delta: "Planning local echo." },
                { type: "reasoning_end" },
                { type: "text_start" },
                { type: "text_delta", delta: "Calling local_echo." },
                { type: "text_end" },
                { type: "toolcall_start", callId: localCallId, name: "local_echo" },
                {
                    type: "toolcall_end",
                    callId: localCallId,
                    arguments: JSON.stringify({ value: "ping" }),
                },
                { type: "block_stop" },
                { type: "done", state: "tool_call", tokens: { input: 2, output: 3 } },
            ],
            [
                { type: "block_start" },
                { type: "text_start" },
                { type: "text_delta", delta: "Local echo finished." },
                { type: "text_end" },
                { type: "block_stop" },
                { type: "done", state: "normal", tokens: { input: 4, output: 2 } },
            ],
        ]);
        const nativeAgentId = "agentnativeonappend";
        const nativeAgent = await Agent.create(nativeDb.context, {
            id: nativeAgentId,
            initialState: { tools: [localEchoTool] },
            modules: [
                await resolveModuleRuntime(nativeDb.context, nativeHistory),
                await resolveModuleRuntime(nativeDb.context, nativeEvents),
            ],
            persistence: nativeStorage.persistence(nativeAgentId),
            provider: "scripted",
            providers: providersOf(nativeProvider),
            sharedKV: nativeStorage.kv,
        });

        try {
            await nativeAgent.send(
                nativeDb.context,
                { role: "user", content: [{ type: "text", text: "Run local_echo" }] },
                { metadata: { ...USER_MESSAGE_ORIGIN_METADATA } },
            );
            await nativeAgent.waitForIdle();

            const nativePage = await nativeHistory.read(nativeDb.context, nativeAgentId);
            expect(nativePage.messages).toHaveLength(3);
            await vi.waitFor(() => {
                for (const record of nativePage.messages) {
                    expect(nativeLastNotified.get(record.message.recordId)).toEqual(record.message);
                }
            });
            expect(
                nativeLastNotified
                    .get(nativePage.messages[1]!.message.recordId)
                    ?.blocks.map((block) => block.type),
            ).toEqual(["thinking", "text", "tool_call", "tool_result"]);
        } finally {
            await nativeAgent.close();
            nativeDb.close();
        }

        // 2. ACP turn with several blocks plus a continuation on a real Agent
        const acpLastNotified = new Map<string, HistoryMessage>();
        const acpNotificationCounts = new Map<string, number>();
        const acpWorld = await createAcpWorld({
            name: "on-append-acp-continuation",
            onPrompt: async (prompt) => {
                // 1023 completed tool calls (2046 blocks) + 1 thought + 1 text = 2048 blocks in chunk 1
                for (let index = 0; index < 1023; index += 1) {
                    await prompt.update({
                        sessionUpdate: "tool_call",
                        toolCallId: `acp-step-${index}`,
                        kind: "execute",
                        status: "completed",
                        title: `ACP step ${index}`,
                        rawOutput: `done-${index}`,
                    });
                }
                await prompt.update({
                    sessionUpdate: "agent_thought_chunk",
                    content: { type: "text", text: "Chunk 1 thought." },
                });
                await prompt.update({
                    sessionUpdate: "agent_message_chunk",
                    content: { type: "text", text: "Chunk 1 closing prose." },
                });
                // Chunk 2 (continuation): 1 completed tool call (2 blocks) + 1 final text block = 3 blocks
                await prompt.update({
                    sessionUpdate: "tool_call",
                    toolCallId: "acp-continuation-step",
                    kind: "edit",
                    status: "completed",
                    title: "Edit in continuation",
                    content: [{ type: "diff", path: "cont.ts", newText: "export const c = 1;" }],
                });
                await prompt.update({
                    sessionUpdate: "agent_message_chunk",
                    content: { type: "text", text: "Continuation finished." },
                });
                return { stopReason: "end_turn" };
            },
        });
        acpWorld.history.onAppend((_ctx, _agentId, messages) => {
            for (const message of messages) {
                acpLastNotified.set(message.recordId, message);
                acpNotificationCounts.set(
                    message.recordId,
                    (acpNotificationCounts.get(message.recordId) ?? 0) + 1,
                );
            }
        });

        try {
            await acpWorld.sendUser("Run ACP turn with continuation");
            await acpWorld.agent.waitForIdle();

            const acpPage = await acpWorld.history.read(
                acpWorld.database.context,
                acpWorld.agentId,
            );
            expect(acpPage.messages).toHaveLength(3);
            expect(acpPage.messages[1]?.message.blocks).toHaveLength(
                MAX_HISTORY_BLOCKS_PER_MESSAGE,
            );
            expect(acpPage.messages[2]?.message.blocks).toHaveLength(3);
            await vi.waitFor(() => {
                for (const record of acpPage.messages) {
                    expect(acpLastNotified.get(record.message.recordId)).toEqual(record.message);
                }
            });
            // Non-tool-result blocks do not re-notify on every intermediate block
            const firstChunkId = acpPage.messages[1]!.message.recordId;
            const secondChunkId = acpPage.messages[2]!.message.recordId;
            expect(acpNotificationCounts.get(firstChunkId)).toBe(1025);
            expect(acpNotificationCounts.get(secondChunkId)).toBe(3);
        } finally {
            await acpWorld.close();
        }
    }, 120_000);

    it("projects mid-inference GET messages and SSE message.created/message.updated without duplicate or reordered blocks during a native loop turn and matches the final GET", async () => {
        const directory = await mkdtemp(join(tmpdir(), "happy-native-api-projection-"));
        temporaryDirectories.push(directory);
        const token = "a".repeat(43);

        const database = moduleDatabase([], "native-api-projection");
        await database.ready;
        const events = new EventsModule();
        const history = new HistoryModule(events);
        const storage = new AgentStorage<AgentDatabase>({
            acquireLock: () => Promise.resolve({ release: () => Promise.resolve() }),
            database: database.database,
        });
        await storage.migrate(database.context, [events, history]);

        const agentId = "agentnativeapi";
        await events.record(database.context, {
            agentId,
            type: "agent.created",
            payload: { id: agentId },
        });
        const subscribe = () => () => undefined;
        const passive = new Proxy({}, { get: () => subscribe });
        const usage = {
            onEvent: subscribe,
            readRun: async (_ctx: Context, id: string, runId: string) => ({
                agentId: id,
                runId,
                usage: {},
                costUsd: null,
            }),
            readRuns: async (_ctx: Context, id: string, runIds: readonly string[]) =>
                runIds.map((runId) => ({
                    agentId: id,
                    runId,
                    usage: {},
                    costUsd: null,
                })),
        };
        const api = new ApiModule(
            passive as never,
            {
                onDefaultModelChanged: subscribe,
                onProviderServiceTiersChanged: subscribe,
                configuration: {
                    paths: { tokenPath: join(directory, "token"), agentHome: directory },
                    values: {
                        api: { token },
                        features: { workspaces: true },
                        defaults: {},
                        p2p: {},
                        settings: {},
                        providers: {},
                    },
                },
                models: [],
                offeredModels: [],
                catalog: [],
                mcpServers: {},
            } as never,
            events,
            { onUpdated: subscribe, status: () => ({}) } as never,
            passive as never,
            {
                onEvent: subscribe,
                list: async () => [],
                forAgent: async () => ({ id: "botone", workspaceId: "projectone" }),
            } as never,
            { onEvent: subscribe, list: async () => ({ projects: [] }) } as never,
            { onEvent: subscribe, workspaceForAgent: async () => "projectone" } as never,
            passive as never,
            passive as never,
            passive as never,
            history,
            passive as never,
            { onEvent: subscribe, listPage: async () => ({ requests: [] }) } as never,
            usage as never,
            passive as never,
            passive as never,
            { onIntegrationUpdated: subscribe, integration: async () => ({}) } as never,
            {
                onEvent: subscribe,
                get: async () => ({
                    name: "Test",
                    photo: null,
                    version: 1,
                    createdAt: 0,
                    updatedAt: 0,
                }),
                ensure: async () => ({
                    name: "Test",
                    photo: null,
                    version: 1,
                    createdAt: 0,
                    updatedAt: 0,
                }),
            } as never,
            { onProcessEvent: subscribe, listProcesses: async () => [] } as never,
            passive as never,
            passive as never,
            {
                enabled: false,
                onProfileUpdated: subscribe,
                onDraftUpdated: subscribe,
                authenticationMethods: () => [],
            } as never,
            passive as never,
            { onUpdated: subscribe, get: async () => ({}) } as never,
        );
        await api.beforeStart(database.context, {
            config: async (_ctx: Context, id: string) => (id === agentId ? {} : undefined),
            childOf: async () => [],
            parentOf: async () => null,
        } as never);
        await api.markReady();

        const apiGet = async <T>(path: string): Promise<T> => {
            const request = Readable.from([]) as IncomingMessage;
            Object.assign(request, {
                method: "GET",
                url: path,
                headers: { authorization: `Bearer ${token}` },
            });
            let status = 200;
            let body = "";
            const response = {
                setHeader() {},
                writeHead(code: number) {
                    status = code;
                    return this;
                },
                end(chunk?: string | Buffer) {
                    body = chunk?.toString() ?? "";
                },
            } as unknown as ServerResponse;
            await api.handleRequest(database.context, request, response);
            expect(status).toBe(200);
            return JSON.parse(body) as T;
        };

        const midStreamPaused = deferred();
        const releaseMidStream = deferred();
        const toolStarted = deferred();
        const releaseTool = deferred();
        const callId = createId();

        const localInspectTool = defineAgentTool({
            name: "local_inspect",
            description: "Inspect a path.",
            parameters: Type.Object({ target: Type.String() }),
            returnType: Type.Object({ summary: Type.String() }),
            shouldReviewInAutoMode: () => false,
            execute: async (_ctx, args) => {
                toolStarted.resolve();
                await releaseTool.promise;
                return { summary: `inspected:${args.target}` };
            },
            toLLM: (result) => [{ type: "text", text: result.summary }],
        });

        const provider = new ScriptedProvider([
            () =>
                (async function* () {
                    yield { type: "block_start" };
                    yield { type: "reasoning_start" };
                    yield { type: "reasoning_delta", delta: "Checking workspace." };
                    yield { type: "reasoning_end" };
                    yield { type: "text_start" };
                    yield { type: "text_delta", delta: "Running local_inspect." };
                    yield { type: "text_end" };
                    yield { type: "toolcall_start", callId, name: "local_inspect" };
                    yield {
                        type: "toolcall_delta",
                        callId,
                        delta: JSON.stringify({ target: "src" }),
                    };
                    midStreamPaused.resolve();
                    await releaseMidStream.promise;
                    yield {
                        type: "toolcall_end",
                        callId,
                        arguments: JSON.stringify({ target: "src" }),
                    };
                    yield { type: "block_stop" };
                    yield { type: "done", state: "tool_call", tokens: { input: 3, output: 4 } };
                })(),
            [
                { type: "block_start" },
                { type: "text_start" },
                { type: "text_delta", delta: "Inspection finished: inspected:src." },
                { type: "text_end" },
                { type: "block_stop" },
                { type: "done", state: "normal", tokens: { input: 5, output: 3 } },
            ],
        ]);

        const agent = await Agent.create(database.context, {
            id: agentId,
            initialState: { tools: [localInspectTool] },
            modules: [
                await resolveModuleRuntime(database.context, history),
                await resolveModuleRuntime(database.context, events),
            ],
            persistence: storage.persistence(agentId),
            provider: "scripted",
            providers: providersOf(provider),
            sharedKV: storage.kv,
        });

        type ApiMessagesResponse = {
            runs: Array<{
                id: string;
                status: string;
                messages: Array<{
                    id: string;
                    role: string;
                    content: Array<Record<string, unknown>>;
                }>;
            }>;
        };
        type ApiEventsResponse = {
            events: Array<{
                type: string;
                payload: Record<string, unknown>;
            }>;
        };

        try {
            await agent.send(
                database.context,
                { role: "user", content: [{ type: "text", text: "Inspect src" }] },
                { metadata: { ...USER_MESSAGE_ORIGIN_METADATA } },
            );

            // 1. Mid-inference while the streaming partial for the same inferenceId exists
            await midStreamPaused.promise;
            let firstInferenceId = "";
            await vi.waitFor(async () => {
                const midHistory = await history.runs(database.context, agentId);
                expect(midHistory.runs[0]?.messages).toHaveLength(2);
                const midGet = await apiGet<ApiMessagesResponse>(
                    `/v0/agents/${agentId}/messages?limit=100&omitToolData=false`,
                );
                expect(midGet.runs).toHaveLength(1);
                expect(midGet.runs[0]?.status).toBe("running");
                expect(midGet.runs[0]?.messages).toHaveLength(2);
                const assistant = midGet.runs[0]!.messages[1]!;
                firstInferenceId = assistant.id;
                expect(assistant.role).toBe("agent");
                expect(assistant.content).toEqual([
                    { type: "reasoning", text: "Checking workspace." },
                    { type: "text", text: "Running local_inspect." },
                ]);
            });

            // 2. While the local tool is running after toolcall_end
            releaseMidStream.resolve();
            await toolStarted.promise;
            let internalCallId = "";
            await vi.waitFor(async () => {
                const toolGet = await apiGet<ApiMessagesResponse>(
                    `/v0/agents/${agentId}/messages?limit=100&omitToolData=false`,
                );
                const assistant = toolGet.runs[0]!.messages[1]!;
                expect(assistant.id).toBe(firstInferenceId);
                internalCallId = assistant.content[2]?.["id"] as string;
                expect(typeof internalCallId).toBe("string");
                expect(assistant.content).toEqual([
                    { type: "reasoning", text: "Checking workspace." },
                    { type: "text", text: "Running local_inspect." },
                    {
                        type: "tool_call",
                        id: internalCallId,
                        name: "local_inspect",
                        status: "running",
                        arguments: { target: "src" },
                    },
                ]);
            });

            // 3. Final GET after the turn settles and SSE journal consistency
            releaseTool.resolve();
            await agent.waitForIdle();

            await vi.waitFor(async () => {
                const finalGet = await apiGet<ApiMessagesResponse>(
                    `/v0/agents/${agentId}/messages?limit=100&omitToolData=false`,
                );
                expect(finalGet.runs).toHaveLength(1);
                expect(finalGet.runs[0]?.status).toBe("completed");
                expect(finalGet.runs[0]?.messages.map((m) => m.role)).toEqual([
                    "user",
                    "agent",
                    "agent",
                ]);
                expect(finalGet.runs[0]?.messages[1]?.id).toBe(firstInferenceId);
                expect(finalGet.runs[0]?.messages[1]?.content).toEqual([
                    { type: "reasoning", text: "Checking workspace." },
                    { type: "text", text: "Running local_inspect." },
                    {
                        type: "tool_call",
                        id: internalCallId,
                        name: "local_inspect",
                        status: "completed",
                        arguments: { target: "src" },
                        result: { output: "inspected:src" },
                    },
                ]);
                expect(finalGet.runs[0]?.messages[2]?.content).toEqual([
                    { type: "text", text: "Inspection finished: inspected:src." },
                ]);

                const journal = await apiGet<ApiEventsResponse>("/v0/events?limit=1000");
                const createdForFirst = journal.events.filter(
                    (event) =>
                        event.type === "message.created" &&
                        (event.payload["message"] as Record<string, unknown> | undefined)?.[
                            "id"
                        ] === firstInferenceId,
                );
                expect(createdForFirst).toHaveLength(1);

                const updatedForFirst = journal.events
                    .filter(
                        (event) =>
                            event.type === "message.updated" &&
                            (event.payload["message"] as Record<string, unknown> | undefined)?.[
                                "id"
                            ] === firstInferenceId,
                    )
                    .map(
                        (event) =>
                            (
                                event.payload["message"] as {
                                    content: Array<Record<string, unknown>>;
                                }
                            ).content,
                    );
                expect(updatedForFirst.length).toBeGreaterThanOrEqual(4);
                expect(updatedForFirst.at(-1)).toEqual(finalGet.runs[0]?.messages[1]?.content);
                for (const snapshot of updatedForFirst) {
                    const types = snapshot.map((block) => block["type"]);
                    expect(types).toEqual(
                        ["reasoning", "text", "tool_call"].slice(0, types.length),
                    );
                }
            });
        } finally {
            releaseMidStream.resolve();
            releaseTool.resolve();
            await agent.close();
            await api.close();
            database.close();
        }
    });
});
