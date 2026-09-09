import { Type } from "@sinclair/typebox";
import { createId } from "@paralleldrive/cuid2";
import type {
    SessionInputTool,
    SessionUserMessage,
    SessionToolCallBlock,
} from "@slopus/happy-providers";
import { afterCommit, createRootContext, type Context } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import {
    AgentBase,
    agentPermissionMode,
    defineAgentTool,
    type AgentBasePersistedEvent,
} from "../sources/index.js";
import { providersOf, queued, textTurn, user } from "./gym/fixtures.js";
import { InMemoryPersistence } from "./gym/InMemoryPersistence.js";
import { ScriptedProvider } from "./gym/ScriptedProvider.js";

const ctx = createRootContext().named("input-tool-test");
const request: SessionInputTool = {
    type: "tool_call_request",
    name: "load_skill",
    arguments: { name: "browser", arguments: "Open example.com" },
};

function input(tool: SessionInputTool = request): SessionUserMessage {
    return { role: "user", content: [tool, { type: "text", text: "/browser Open example.com" }] };
}

function loader(execute: () => void | Promise<void> = () => {}, durable = false) {
    return defineAgentTool({
        name: "load_skill",
        parameters: Type.Object({ name: Type.String(), arguments: Type.Optional(Type.String()) }),
        returnType: Type.Object({ content: Type.String() }),
        shouldReviewInAutoMode: () => true,
        durable,
        execute: async () => {
            await execute();
            return { content: "Complete skill instructions." };
        },
        toLLM: (result) => [{ type: "text", text: result.content }],
    });
}

async function snapshotOf(persistence: InMemoryPersistence, snapshotCtx: Context) {
    const snapshot = new InMemoryPersistence(structuredClone([...(await persistence.load())]));
    for (const { key, value } of await persistence.readValues(snapshotCtx, "")) {
        snapshot.values.set(key, structuredClone(value));
    }
    return snapshot;
}

function gate() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

describe("AgentBase input tool requests", () => {
    it("publishes the requested call with one stable ID and no synthetic inference", async () => {
        const order: string[] = [];
        const events: AgentBasePersistedEvent[] = [];
        const provider = new ScriptedProvider([textTurn("done")]);
        const agent = await AgentBase.create(ctx, {
            id: "input-events",
            provider: "scripted",
            providers: providersOf(provider),
            persistence: new InMemoryPersistence(),
            initialState: {
                tools: [
                    loader(() => {
                        order.push("execute");
                    }),
                ],
            },
            hooks: {
                messageAcceptedTransact: () => {
                    order.push("accepted-transaction");
                },
                messageAccepted: () => {
                    order.push("accepted");
                },
                onEventTransact: (_ctx, event) => {
                    if (event.type === "toolcall_end") {
                        events.push(event);
                        order.push("call-transaction");
                    }
                },
                onEvent: (_ctx, event) => {
                    if (event.type.startsWith("toolcall_")) order.push(event.type);
                },
                beforeToolCallTransact: (_ctx, call) => {
                    expect(call.callId).toBe(
                        events[0]?.block.type === "tool_call" ? events[0].block.callId : undefined,
                    );
                    order.push("dispatch");
                },
                beforeInference: () => {
                    order.push("inference");
                },
            },
        });
        try {
            await agent.send(ctx, input());
            await agent.waitForIdle();
            expect(order).toEqual([
                "accepted-transaction",
                "call-transaction",
                "accepted",
                "toolcall_start",
                "toolcall_delta",
                "toolcall_end",
                "dispatch",
                "execute",
                "inference",
            ]);
            expect(events).toHaveLength(1);
        } finally {
            await agent.close();
        }
    });

    it("accepts steering after the requested tool result and before the next inference", async () => {
        const started = gate();
        const release = gate();
        const provider = new ScriptedProvider([textTurn("done"), textTurn("later")]);
        const persistence = new InMemoryPersistence();
        const agent = await AgentBase.create(ctx, {
            id: "delayed-input",
            provider: "scripted",
            providers: providersOf(provider),
            persistence,
            initialState: {
                tools: [
                    loader(async () => {
                        started.resolve();
                        await release.promise;
                    }),
                ],
            },
        });
        try {
            await agent.send(ctx, input());
            await started.promise;
            await agent.steer(ctx, user("later"));
            expect(provider.sessions).toHaveLength(0);
            expect(
                persistence.records.some(
                    (record) =>
                        record.type === "user" &&
                        record.message.content.some(
                            (block) => block.type === "text" && block.text === "later",
                        ),
                ),
            ).toBe(false);
            release.resolve();
            await agent.waitForIdle();
            const requests = provider.sessions[0]?.requests ?? [];
            expect(requests).toHaveLength(1);
            const messages = requests[0]?.context.messages ?? [];
            expect(messages.at(-1)).toEqual(user("later"));
            expect(messages.findIndex((message) => message.role === "tool")).toBeLessThan(
                messages.findIndex(
                    (message) => JSON.stringify(message) === JSON.stringify(user("later")),
                ),
            );
        } finally {
            release.resolve();
            await agent.close();
        }
    });

    it("does not start inference when cancelled during a requested tool", async () => {
        const started = gate();
        const release = gate();
        const provider = new ScriptedProvider([textTurn("must not run")]);
        const events: string[] = [];
        const persistence = new InMemoryPersistence();
        const agent = await AgentBase.create(ctx, {
            id: "cancelled-input-tool",
            provider: "scripted",
            providers: providersOf(provider),
            persistence,
            initialState: {
                tools: [
                    loader(async () => {
                        started.resolve();
                        await release.promise;
                    }),
                ],
            },
            hooks: {
                prepareInference: () => {
                    events.push("prepareInference");
                },
                beforeInferenceTransact: () => {
                    events.push("beforeInferenceTransact");
                },
                beforeInference: () => {
                    events.push("beforeInference");
                },
                onEvent: (_ctx, event) => {
                    if (event.type === "done") events.push(`done:${event.state}`);
                },
            },
        });
        try {
            await agent.send(ctx, input());
            await started.promise;
            const aborting = agent.abort(ctx);
            release.resolve();
            await aborting;
            await agent.waitForIdle();
            expect(events).toEqual(["done:cancelled"]);
            expect(provider.sessions).toHaveLength(0);
            expect(persistence.records.filter((record) => record.type === "tool")).toHaveLength(1);
        } finally {
            release.resolve();
            await agent.close();
        }
    });

    it("resumes a durable requested tool after dispatch with the same identity", async () => {
        const persistence = new InMemoryPersistence();
        let snapshot: InMemoryPersistence | undefined;
        let firstId: string | undefined;
        const first = await AgentBase.create(ctx, {
            id: "durable-input",
            provider: "scripted",
            providers: providersOf(new ScriptedProvider([textTurn("done")])),
            persistence,
            initialState: { tools: [loader(() => {}, true)] },
            hooks: {
                beforeToolCall: async (hookCtx, call) => {
                    firstId = call.callId;
                    snapshot = await snapshotOf(persistence, hookCtx);
                    return undefined;
                },
            },
        });
        try {
            await first.send(ctx, input());
            await first.waitForIdle();
        } finally {
            await first.close();
        }
        expect(snapshot).toBeDefined();
        let executions = 0;
        const provider = new ScriptedProvider([textTurn("done")]);
        const second = await AgentBase.create(ctx, {
            id: "durable-input",
            provider: "scripted",
            providers: providersOf(provider),
            persistence: snapshot!,
            initialState: {
                tools: [
                    loader(() => {
                        executions++;
                    }, true),
                ],
            },
        });
        try {
            await second.start();
            await second.waitForIdle();
            expect(executions).toBe(1);
            expect(provider.sessions[0]?.requests[0]?.context.messages.at(-1)).toMatchObject({
                role: "tool",
                callId: firstId,
            });
        } finally {
            await second.close();
        }
    });

    it.each([0, 1, 2])(
        "preserves text and images with a request at position %i",
        async (position) => {
            const provider = new ScriptedProvider([textTurn("done")]);
            const content: SessionUserMessage["content"] = [
                { type: "text", text: "Please inspect this" },
                { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
            ];
            const agent = await AgentBase.create(ctx, {
                id: "mixed-input",
                provider: "scripted",
                providers: providersOf(provider),
                persistence: new InMemoryPersistence(),
                initialState: { tools: [loader()] },
            });
            try {
                await agent.send(ctx, {
                    role: "user",
                    content: [...content.slice(0, position), request, ...content.slice(position)],
                });
                await agent.waitForIdle();
                expect(provider.sessions[0]?.requests[0]?.context.messages[0]).toEqual({
                    role: "user",
                    content,
                });
            } finally {
                await agent.close();
            }
        },
    );

    it("accepts a tool-only message without inventing user text", async () => {
        const provider = new ScriptedProvider([textTurn("done")]);
        let executions = 0;
        const agent = await AgentBase.create(ctx, {
            id: "only-tool",
            provider: "scripted",
            providers: providersOf(provider),
            persistence: new InMemoryPersistence(),
            initialState: {
                tools: [
                    loader(() => {
                        executions++;
                    }),
                ],
            },
        });
        try {
            await agent.send(ctx, { role: "user", content: [request] });
            await agent.waitForIdle();
            expect(executions).toBe(1);
            expect(
                provider.sessions[0]?.requests[0]?.context.messages.map((message) => message.role),
            ).toEqual(["assistant", "tool"]);
        } finally {
            await agent.close();
        }
    });

    it.each([
        { role: "user", content: [request, request] },
        { role: "system", content: [request] },
        {
            role: "agent",
            author: { id: "sender", description: "Another agent" },
            content: [request],
        },
        { role: "user", content: [{ ...request, name: "" }] },
        { role: "user", content: [{ ...request, arguments: "not an object" }] },
        { role: "user", content: [{ ...request, arguments: { bad: undefined } }] },
    ])("rejects invalid requests before queue admission: %j", async (message) => {
        const provider = new ScriptedProvider([]);
        const persistence = new InMemoryPersistence();
        const agent = await AgentBase.create(ctx, {
            id: "invalid-input",
            provider: "scripted",
            providers: providersOf(provider),
            persistence,
        });
        try {
            // Exercise the runtime boundary with deliberately invalid external input.
            await expect(agent.send(ctx, message as SessionUserMessage)).rejects.toThrow(
                /tool (call|request)/,
            );
            expect(await persistence.readValues(ctx, "send.")).toEqual([]);
            expect(persistence.records).toEqual([]);
            expect(provider.sessions).toEqual([]);
        } finally {
            await agent.close();
        }
    });

    it("does not execute a duplicate message ID twice", async () => {
        const provider = new ScriptedProvider([textTurn("done")]);
        let executions = 0;
        const agent = await AgentBase.create(ctx, {
            id: "duplicate-input",
            provider: "scripted",
            providers: providersOf(provider),
            persistence: new InMemoryPersistence(),
            initialState: {
                tools: [
                    loader(() => {
                        executions++;
                    }),
                ],
            },
        });
        const id = createId();
        try {
            await agent.send(ctx, input(), { id });
            await agent.waitForIdle();
            await agent.send(ctx, input(), { id });
            await agent.waitForIdle();
            expect(executions).toBe(1);
            expect(provider.sessions[0]?.requests).toHaveLength(1);
        } finally {
            await agent.close();
        }
    });

    it("records a denied call without executing it", async () => {
        const provider = new ScriptedProvider([textTurn("denied")]);
        let executions = 0;
        const agent = await AgentBase.create(ctx, {
            id: "denied-input",
            provider: "scripted",
            providers: providersOf(provider),
            persistence: new InMemoryPersistence(),
            initialState: {
                tools: [
                    loader(() => {
                        executions++;
                    }),
                ],
            },
            hooks: {
                beforeToolCall: () => ({
                    type: "answer",
                    isError: true,
                    content: [{ type: "text", text: "Permission denied" }],
                }),
            },
        });
        try {
            await agent.send(ctx, input(), { permissionMode: "auto" });
            await agent.waitForIdle();
            expect(executions).toBe(0);
            expect(provider.sessions[0]?.requests[0]?.context.messages.at(-1)).toMatchObject({
                role: "tool",
                isError: true,
                content: [{ type: "text", text: "Permission denied" }],
            });
        } finally {
            await agent.close();
        }
    });

    it.each(["message", "call"])(
        "rolls back acceptance when the %s projection fails",
        async (failure) => {
            const persistence = new InMemoryPersistence();
            let executions = 0;
            let snapshot: InMemoryPersistence | undefined;
            const fail = () => {
                throw new Error("Projection failed");
            };
            const agent = await AgentBase.create(ctx, {
                id: "rolled-back-input",
                provider: "scripted",
                providers: providersOf(new ScriptedProvider([])),
                persistence,
                initialState: {
                    tools: [
                        loader(() => {
                            executions++;
                        }),
                    ],
                },
                hooks:
                    failure === "message"
                        ? { messageAcceptedTransact: fail }
                        : { onEventTransact: fail },
            });
            try {
                await agent.send(ctx, input());
                await agent.waitForIdle();
                expect(executions).toBe(0);
                expect(
                    persistence.records.some(
                        (record) =>
                            record.type === "user" ||
                            record.type === "block" ||
                            record.type === "tool",
                    ),
                ).toBe(false);
                expect(await persistence.readValues(ctx, "send.")).toHaveLength(1);
                snapshot = await snapshotOf(persistence, ctx);
            } finally {
                await agent.close();
            }
            const restored = await AgentBase.create(ctx, {
                id: "rolled-back-input",
                provider: "scripted",
                providers: providersOf(new ScriptedProvider([textTurn("done")])),
                persistence: snapshot!,
                initialState: {
                    tools: [
                        loader(() => {
                            executions++;
                        }),
                    ],
                },
            });
            try {
                await restored.start();
                await restored.waitForIdle();
                expect(executions).toBe(1);
            } finally {
                await restored.close();
            }
        },
    );

    it.each(["dispatched", "completed"])(
        "does not replay a non-durable call after a crash once %s",
        async (phase) => {
            const persistence = new InMemoryPersistence();
            let snapshot: InMemoryPersistence | undefined;
            const capture = async (hookCtx: Context) => {
                snapshot = await snapshotOf(persistence, hookCtx);
            };
            const first = await AgentBase.create(ctx, {
                id: "recovery-input",
                provider: "scripted",
                providers: providersOf(new ScriptedProvider([textTurn("done")])),
                persistence,
                initialState: { tools: [loader()] },
                hooks:
                    phase === "dispatched"
                        ? {
                              beforeToolCall: async (hookCtx) => {
                                  await capture(hookCtx);
                                  return undefined;
                              },
                          }
                        : {
                              afterToolCallTransact: (hookCtx) => {
                                  afterCommit(hookCtx, () => capture(ctx));
                              },
                          },
            });
            try {
                await first.send(ctx, input());
                await first.waitForIdle();
            } finally {
                await first.close();
            }
            expect(snapshot).toBeDefined();
            let executions = 0;
            const provider = new ScriptedProvider([textTurn("recovered")]);
            const second = await AgentBase.create(ctx, {
                id: "recovery-input",
                provider: "scripted",
                providers: providersOf(provider),
                persistence: snapshot!,
                initialState: {
                    tools: [
                        loader(() => {
                            executions++;
                        }),
                    ],
                },
            });
            try {
                await second.start();
                await second.waitForIdle();
                expect(executions).toBe(0);
                expect(provider.sessions[0]?.requests[0]?.context.messages.at(-1)).toMatchObject({
                    role: "tool",
                    ...(phase === "dispatched"
                        ? { isError: true }
                        : { content: [{ type: "text", text: "Complete skill instructions." }] }),
                });
            } finally {
                await second.close();
            }
        },
    );

    it("executes the content block before inference and keeps the original accepted message", async () => {
        const provider = new ScriptedProvider([textTurn("done")]);
        const persistence = new InMemoryPersistence();
        const order: string[] = [];
        let accepted: unknown;
        let call: SessionToolCallBlock | undefined;
        const agent = await AgentBase.create(ctx, {
            id: "input-tool",
            provider: "scripted",
            providers: providersOf(provider),
            persistence,
            hooks: {
                messageAcceptedTransact: (_ctx, value) => {
                    accepted = value.message;
                },
                beforeToolCallTransact: (_ctx, value) => {
                    call = value;
                },
                beforeInference: () => {
                    order.push("inference");
                },
            },
            initialState: {
                tools: [
                    loader(() => {
                        expect(provider.sessions).toHaveLength(0);
                        order.push("tool");
                    }),
                ],
            },
        });
        try {
            await agent.send(ctx, input());
            await agent.waitForIdle();
            expect(order).toEqual(["tool", "inference"]);
            expect(accepted).toEqual(input());
            expect(call).toMatchObject({
                type: "tool_call",
                name: "load_skill",
                callId: expect.stringMatching(/^[a-z][a-z0-9]{1,31}$/),
            });
            expect(provider.sessions[0]?.requests[0]?.context.messages).toEqual([
                user("/browser Open example.com"),
                { role: "assistant", content: [call] },
                {
                    role: "tool",
                    callId: call?.callId,
                    content: [{ type: "text", text: "Complete skill instructions." }],
                },
            ]);
            expect(persistence.records[0]).toMatchObject({
                type: "user",
                message: user("/browser Open example.com"),
            });
            expect(persistence.records[1]).toMatchObject({
                type: "block",
                id: call?.callId,
                block: call,
            });
        } finally {
            await agent.close();
        }
    });

    it("defaults omitted arguments to an empty object", async () => {
        const provider = new ScriptedProvider([textTurn("done")]);
        const seen: unknown[] = [];
        const agent = await AgentBase.create(ctx, {
            id: "no-arguments",
            provider: "scripted",
            providers: providersOf(provider),
            persistence: new InMemoryPersistence(),
            initialState: {
                tools: [
                    defineAgentTool({
                        name: "refresh",
                        parameters: Type.Object({}),
                        returnType: Type.Object({}),
                        shouldReviewInAutoMode: () => false,
                        execute: async (_ctx, args) => {
                            seen.push(args);
                            return {};
                        },
                        toLLM: () => [],
                    }),
                ],
            },
        });
        try {
            await agent.send(ctx, input({ type: "tool_call_request", name: "refresh" }));
            await agent.waitForIdle();
            expect(seen).toEqual([{}]);
            expect(provider.sessions[0]?.requests[0]?.context.messages[1]).toMatchObject({
                role: "assistant",
                content: [{ arguments: "{}" }],
            });
        } finally {
            await agent.close();
        }
    });

    it.each(["unknown", "invalid", "throws"])(
        "records an ordinary error for %s tools before inference",
        async (kind) => {
            const provider = new ScriptedProvider([textTurn("explained")]);
            let executions = 0;
            const agent = await AgentBase.create(ctx, {
                id: `failed-${kind}`,
                provider: "scripted",
                providers: providersOf(provider),
                persistence: new InMemoryPersistence(),
                initialState: {
                    tools: [
                        loader(() => {
                            executions++;
                            throw new Error("Cannot load");
                        }),
                    ],
                },
            });
            try {
                await agent.send(
                    ctx,
                    input({
                        ...request,
                        name: kind === "unknown" ? "missing" : request.name,
                        arguments: kind === "invalid" ? { name: 42 } : request.arguments!,
                    }),
                );
                await agent.waitForIdle();
                expect(executions).toBe(kind === "throws" ? 1 : 0);
                expect(provider.sessions[0]?.requests).toHaveLength(1);
                expect(provider.sessions[0]?.requests[0]?.context.messages.at(-1)).toMatchObject({
                    role: "tool",
                    isError: true,
                });
            } finally {
                await agent.close();
            }
        },
    );

    it("honors the normal before-tool permission decision and restores the message mode", async () => {
        const provider = new ScriptedProvider([textTurn("done")]);
        const modes: string[] = [];
        const agent = await AgentBase.create(ctx, {
            id: "input-permissions",
            provider: "scripted",
            providers: providersOf(provider),
            persistence: new InMemoryPersistence(),
            hooks: {
                beforeToolCall: (hookCtx) => {
                    modes.push(agentPermissionMode(hookCtx));
                    return { type: "run", permissionMode: "full_access" };
                },
                beforeInference: (hookCtx) => {
                    modes.push(agentPermissionMode(hookCtx));
                },
            },
            initialState: {
                tools: [
                    defineAgentTool({
                        name: "refresh",
                        parameters: Type.Object({}),
                        returnType: Type.Object({}),
                        shouldReviewInAutoMode: () => true,
                        execute: async (toolCtx) => {
                            modes.push(agentPermissionMode(toolCtx));
                            return {};
                        },
                        toLLM: () => [],
                    }),
                ],
            },
        });
        try {
            await agent.send(ctx, input({ type: "tool_call_request", name: "refresh" }), {
                permissionMode: "auto",
            });
            await agent.waitForIdle();
            expect(modes).toEqual(["auto", "full_access", "auto"]);
        } finally {
            await agent.close();
        }
    });

    it.each(["send", "steer"] as const)(
        "stops an all-at-once %s batch after the requested call",
        async (delivery) => {
            const provider = new ScriptedProvider([textTurn("done"), textTurn("later")]);
            const persistence = new InMemoryPersistence();
            const prefix = delivery === "send" ? "send" : "steering";
            persistence.values.set(`${prefix}.0000`, queued(input()));
            persistence.values.set(`${prefix}.0001`, queued(user("later")));
            const agent = await AgentBase.create(ctx, {
                id: "queued-input-tool",
                provider: "scripted",
                providers: providersOf(provider),
                persistence,
                sendMode: "all",
                steeringMode: "all",
                initialState: { tools: [loader()] },
            });
            try {
                await agent.start();
                await agent.waitForIdle();
                const requests = provider.sessions[0]?.requests ?? [];
                if (delivery === "send") {
                    expect(requests).toHaveLength(2);
                    expect(requests[0]?.context.messages).not.toContainEqual(user("later"));
                    expect(requests[0]?.context.messages.at(-1)).toMatchObject({ role: "tool" });
                    expect(requests[1]?.context.messages.at(-1)).toEqual(user("later"));
                } else {
                    expect(requests).toHaveLength(1);
                    expect(requests[0]?.context.messages.at(-2)).toMatchObject({ role: "tool" });
                    expect(requests[0]?.context.messages.at(-1)).toEqual(user("later"));
                }
            } finally {
                await agent.close();
            }
        },
    );

    it("recovers the same unexecuted call ID after a crash between acceptance and dispatch", async () => {
        const persistence = new InMemoryPersistence();
        let snapshot: InMemoryPersistence | undefined;
        const firstProvider = new ScriptedProvider([textTurn("done")]);
        const first = await AgentBase.create(ctx, {
            id: "crashed-input",
            provider: "scripted",
            providers: providersOf(firstProvider),
            persistence,
            initialState: { tools: [loader()] },
            hooks: {
                messageAccepted: () => {
                    snapshot = new InMemoryPersistence(structuredClone(persistence.records));
                    for (const [key, value] of persistence.values)
                        snapshot.values.set(key, structuredClone(value));
                },
            },
        });
        try {
            await first.send(ctx, input());
            await first.waitForIdle();
        } finally {
            await first.close();
        }
        expect(snapshot).toBeDefined();
        let executions = 0;
        const provider = new ScriptedProvider([textTurn("recovered")]);
        const second = await AgentBase.create(ctx, {
            id: "crashed-input",
            provider: "scripted",
            providers: providersOf(provider),
            persistence: snapshot!,
            initialState: {
                tools: [
                    loader(() => {
                        executions++;
                    }),
                ],
            },
        });
        try {
            await second.start();
            await second.waitForIdle();
            expect(executions).toBe(1);
            expect(provider.sessions[0]?.requests[0]?.context.messages).toEqual(
                firstProvider.sessions[0]?.requests[0]?.context.messages,
            );
        } finally {
            await second.close();
        }
    });
});
