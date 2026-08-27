import type { SessionEvent, SessionMessage } from "@slopus/happy-providers";
import { Type } from "@sinclair/typebox";
import { createRootContext } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import {
    Agent,
    agentKV,
    defineAgentTool,
    withAgentDatabase,
    type AgentModuleAgent,
    type AgentModuleHooks,
    type AgentModuleRuntime,
} from "../sources/index.js";
import {
    providersOf,
    sharedKV,
    system,
    testAgentDatabase,
    textTurn,
    user,
} from "./gym/fixtures.js";
import { InMemoryPersistence } from "./gym/InMemoryPersistence.js";
import { ScriptedProvider, ScriptedSession } from "./gym/ScriptedProvider.js";

const ctx = withAgentDatabase(createRootContext().named("happy-agent-test"), testAgentDatabase());

function tool(name: string, capabilities?: readonly string[]) {
    return defineAgentTool({
        name,
        ...(capabilities === undefined ? {} : { capabilities }),
        returnType: Type.Object({}),
        shouldReviewInAutoMode: () => false,
        execute: () => Promise.resolve({}),
        toLLM: () => [{ type: "text", text: "ok" }],
    });
}

function module(spec: { name: string } & AgentModuleHooks): AgentModuleRuntime {
    const { name, ...hooks } = spec;
    return { name, module: { name }, hooks };
}

function toolCallTurn(callId: string, name: string, argumentsJson: string): SessionEvent[] {
    return [
        { type: "toolcall_start", callId, name },
        { type: "toolcall_end", callId, arguments: argumentsJson },
        { type: "done", state: "tool_call", tokens: { input: 1, output: 1 } },
    ];
}

describe("Agent", () => {
    it("preserves each tool's Auto review and Full-access policy through module assembly", async () => {
        const provider = new ScriptedProvider([textTurn("answer")]);
        const reviewedTool = defineAgentTool({
            name: "publish",
            parameters: Type.Object({ target: Type.String() }),
            returnType: Type.Object({}),
            autoPermissionInstructions:
                "In Auto mode, describe why publishing this target is necessary.",
            describeAutoPermissionAction: ({ target }) => `publish ${JSON.stringify(target)}`,
            requiresAutoOrFullAccess: true,
            shouldReviewInAutoMode: ({ target }) => target === "production",
            shouldRunInFullAccessInAutoMode: async ({ target }) => target === "production",
            execute: () => Promise.resolve({}),
            toLLM: () => [{ type: "text", text: "ok" }],
        });
        const agent = await Agent.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            sharedKV: sharedKV(),
            modules: [module({ name: "publishing", tools: () => [reviewedTool] })],
        });

        await agent.send(ctx, user("go"));
        await agent.waitForIdle();

        const assembled = provider.sessions[0]?.options.tools?.[0];
        expect(assembled).toBe(reviewedTool);
        expect(reviewedTool.autoPermissionInstructions).toContain("why publishing");
        expect(reviewedTool.requiresAutoOrFullAccess).toBe(true);
        expect(await reviewedTool.shouldReviewInAutoMode?.({ target: "production" }, ctx)).toBe(
            true,
        );
        expect(
            await reviewedTool.shouldRunInFullAccessInAutoMode?.({ target: "production" }, ctx),
        ).toBe(true);
        expect(reviewedTool.describeAutoPermissionAction?.({ target: "production" }, ctx)).toBe(
            'publish "production"',
        );
        await agent.close();
    });

    it("merges instructions and tools from every module in order", async () => {
        const searchTool = tool("search");
        const editTool = tool("edit");
        const provider = new ScriptedProvider([textTurn("answer")]);
        const searchModule = module({
            name: "search",
            instructions: () => "You can search.",
            tools: () => [searchTool],
        });
        const editModule = module({
            name: "edit",
            instructions: () => "You can edit.",
            tools: () => [editTool],
        });
        const agent = await Agent.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            sharedKV: sharedKV(),
            modules: [searchModule, editModule],
        });

        await agent.send(ctx, user("go"));
        await agent.waitForIdle();

        const session = provider.sessions[0];
        expect(session?.options.instructions).toBe("You can search.\n\nYou can edit.");
        expect(session?.options.tools).toEqual([searchTool, editTool]);
        expect(session?.requests[0]?.context.instructions).toBe("You can search.\n\nYou can edit.");
        await agent.close();
    });

    it("attributes contributions and chains complete instruction and tool overrides", async () => {
        const stateTool = tool("state");
        const contributedTool = tool("contributed");
        const firstTool = tool("first-final");
        const secondTool = tool("second-final", ["Run isolated Python."]);
        const provider = new ScriptedProvider([textTurn("answer")]);
        const instructionInputs: unknown[] = [];
        const toolInputs: unknown[] = [];
        const hookOrder: string[] = [];
        const agent = await Agent.create(ctx, {
            id: "override-agent",
            providers: providersOf(provider),
            provider: "scripted",
            model: "gym/small",
            effort: "high",
            serviceTier: "priority",
            persistence: new InMemoryPersistence(),
            sharedKV: sharedKV(),
            initialState: { instructions: "State prompt.", tools: [stateTool] },
            modules: [
                module({
                    name: "contributor",
                    instructions: () => {
                        hookOrder.push("instructions");
                        return "Module prompt.";
                    },
                    tools: () => {
                        hookOrder.push("tools");
                        return [contributedTool];
                    },
                }),
                module({
                    name: "first-override",
                    overrideInstructions: (_hookCtx, _scope, input) => {
                        hookOrder.push("first overrideInstructions");
                        instructionInputs.push(input);
                        return `first(${input.instructions})`;
                    },
                    overrideTools: (_hookCtx, _scope, input) => {
                        hookOrder.push("first overrideTools");
                        toolInputs.push(input);
                        return [firstTool];
                    },
                }),
                module({
                    name: "second-override",
                    overrideInstructions: (_hookCtx, _scope, input) => {
                        hookOrder.push("second overrideInstructions");
                        instructionInputs.push(input);
                        return `second(${input.instructions})`;
                    },
                    overrideTools: (_hookCtx, _scope, input) => {
                        hookOrder.push("second overrideTools");
                        toolInputs.push(input);
                        return [secondTool];
                    },
                }),
            ],
        });

        await agent.send(ctx, user("go"));
        await agent.waitForIdle();

        expect(provider.sessions[0]?.options.instructions).toBe(
            "second(first(State prompt.\n\nModule prompt.\n\nTool capabilities:\n- Run isolated Python.))",
        );
        expect(provider.sessions[0]?.options.tools).toEqual([secondTool]);
        expect(hookOrder).toEqual([
            "instructions",
            "tools",
            "first overrideTools",
            "second overrideTools",
            "first overrideInstructions",
            "second overrideInstructions",
        ]);
        expect(instructionInputs).toHaveLength(2);
        expect(instructionInputs[0]).toMatchObject({
            selection: {
                provider: "scripted",
                providerKind: "gym",
                model: "gym/small",
                effort: "high",
                tier: "priority",
            },
            contributions: [
                {
                    contributor: { type: "agent", id: "override-agent" },
                    instructions: "State prompt.",
                },
                {
                    contributor: { type: "module", id: "contributor" },
                    instructions: "Module prompt.",
                },
                {
                    contributor: { type: "base", id: "tool-capabilities" },
                    instructions: "Tool capabilities:\n- Run isolated Python.",
                },
            ],
            instructions:
                "State prompt.\n\nModule prompt.\n\nTool capabilities:\n- Run isolated Python.",
        });
        expect(instructionInputs[1]).toMatchObject({
            instructions:
                "first(State prompt.\n\nModule prompt.\n\nTool capabilities:\n- Run isolated Python.)",
        });
        expect(toolInputs).toHaveLength(2);
        expect(toolInputs[0]).toMatchObject({
            contributions: [
                { contributor: { type: "agent", id: "override-agent" }, tools: [stateTool] },
                {
                    contributor: { type: "module", id: "contributor" },
                    tools: [contributedTool],
                },
            ],
            tools: [stateTool, contributedTool],
        });
        expect(toolInputs[1]).toMatchObject({ tools: [firstTool] });
        await agent.close();
    });

    it("fails on ordinary module instructions before consulting module tools", async () => {
        const provider = new ScriptedProvider([textTurn("unused")]);
        const events: SessionEvent[] = [];
        let toolsCalled = false;
        const agent = await Agent.create(ctx, {
            id: "instruction-failure-order-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            sharedKV: sharedKV(),
            modules: [
                module({
                    name: "broken-instructions",
                    instructions: () => {
                        throw new Error("instruction assembly broke");
                    },
                    tools: () => {
                        toolsCalled = true;
                        return [];
                    },
                    onEvent: (_hookCtx, _scope, event) => events.push(event),
                }),
            ],
        });

        await agent.send(ctx, user("go"));
        await agent.waitForIdle();

        expect(toolsCalled).toBe(false);
        expect(provider.sessions).toHaveLength(0);
        expect(events.at(-1)).toEqual({
            type: "done",
            state: "error",
            kind: "internal_error",
            message: "instruction assembly broke",
        });
        await agent.close();
    });

    it("lets each module amend the call the next one decides about", async () => {
        const provider = new ScriptedProvider([
            toolCallTurn("call-1", "mutate", '{"text":"a"}'),
            textTurn("done"),
        ]);
        const order: string[] = [];
        let executions = 0;
        const mutate = defineAgentTool({
            name: "mutate",
            parameters: Type.Object({ text: Type.String() }, { additionalProperties: false }),
            returnType: Type.Object({ value: Type.String() }),
            shouldReviewInAutoMode: () => false,
            execute: async (_toolCtx, { text }) => {
                executions += 1;
                order.push(`tool:${text}`);
                return { value: text };
            },
            toLLM: ({ value }) => [{ type: "text", text: value }],
        });
        const amend = (name: string, suffix: string): AgentModuleRuntime =>
            module({
                name,
                beforeToolCall: (_hookCtx, _scope, call) => {
                    const { text } = call.arguments as { text: string };
                    order.push(`${name}:before:${text}`);
                    return { type: "run", arguments: { text: text + suffix } };
                },
                afterToolCall: (_hookCtx, _scope, outcome) => {
                    order.push(`${name}:after:${(outcome.result as { value: string }).value}`);
                },
            });
        const agent = await Agent.create(ctx, {
            id: "middleware-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            sharedKV: sharedKV(),
            modules: [
                amend("outer", "b"),
                amend("inner", "c"),
                module({ name: "tools", tools: () => [mutate] }),
            ],
        });

        await agent.send(ctx, user("mutate"));
        await agent.waitForIdle();

        expect(executions).toBe(1);
        expect(order).toEqual([
            "outer:before:a",
            "inner:before:ab",
            "tool:abc",
            "outer:after:abc",
            "inner:after:abc",
        ]);
        expect(provider.sessions[0]?.requests[1]?.context.messages.at(-1)).toEqual({
            role: "tool",
            callId: "call-1",
            content: [{ type: "text", text: "abc" }],
        });
        await agent.close();
    });

    it("lets a module answer a call itself, so the tool never runs", async () => {
        const provider = new ScriptedProvider([
            toolCallTurn("call-1", "mutate", "{}"),
            textTurn("done"),
        ]);
        let executions = 0;
        const outcomes: string[] = [];
        const mutate = defineAgentTool({
            name: "mutate",
            parameters: Type.Object({}, { additionalProperties: false }),
            returnType: Type.Null(),
            shouldReviewInAutoMode: () => false,
            execute: async () => {
                executions += 1;
                return null;
            },
            toLLM: () => [],
        });
        const agent = await Agent.create(ctx, {
            id: "answering-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            sharedKV: sharedKV(),
            modules: [
                module({
                    name: "refuse",
                    beforeToolCall: () => ({
                        type: "answer",
                        content: [{ type: "text", text: "not allowed" }],
                        isError: true,
                    }),
                }),
                module({
                    name: "later",
                    beforeToolCall: () => {
                        throw new Error("a settled call must not reach the next module");
                    },
                    afterToolCall: (_hookCtx, _scope, outcome) => {
                        // A hook answered the call, so there is no structured result to see.
                        outcomes.push(`${String(outcome.isError)}:${String("result" in outcome)}`);
                    },
                }),
                module({ name: "tools", tools: () => [mutate] }),
            ],
        });

        await agent.send(ctx, user("mutate"));
        await agent.waitForIdle();

        expect(executions).toBe(0);
        expect(outcomes).toEqual(["true:false"]);
        expect(provider.sessions[0]?.requests[1]?.context.messages.at(-1)).toEqual({
            role: "tool",
            callId: "call-1",
            content: [{ type: "text", text: "not allowed" }],
            isError: true,
        });
        await agent.close();
    });

    it("fans events out to every module in order", async () => {
        const seen: string[] = [];
        const observe = (name: string): AgentModuleRuntime =>
            module({
                name,
                onEvent: (_hookCtx, _scope, event) => {
                    if (event.type === "done") seen.push(name);
                },
            });
        const provider = new ScriptedProvider([textTurn("answer")]);
        const agent = await Agent.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            sharedKV: sharedKV(),
            modules: [observe("first"), observe("second")],
        });

        await agent.send(ctx, user("go"));
        await agent.waitForIdle();

        expect(seen).toEqual(["first", "second"]);
        await agent.close();
    });

    it("chains transactional event modules in order and rolls them back together", async () => {
        const order: string[] = [];
        const persistence = new InMemoryPersistence();
        const provider = new ScriptedProvider([textTurn("answer")]);
        const agent = await Agent.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            sharedKV: sharedKV(),
            modules: [
                module({
                    name: "first",
                    onEventTransact: async (hookCtx, scope, event) => {
                        order.push(`first:${event.type}`);
                        await scope.kv.write(hookCtx, "seen", true);
                    },
                }),
                module({
                    name: "second",
                    onEventTransact: async (hookCtx, scope, event) => {
                        order.push(`second:${event.type}`);
                        await scope.kv.write(hookCtx, "seen", true);
                        throw new Error("transactional observer failed");
                    },
                }),
                module({
                    name: "third",
                    onEventTransact: () => {
                        order.push("third");
                    },
                }),
            ],
        });

        await agent.send(ctx, user("go"));
        await agent.waitForIdle();

        expect(order).toEqual(["first:text_end", "second:text_end"]);
        expect(persistence.values.has("kv.test-agent.module.first.seen")).toBe(false);
        expect(persistence.values.has("kv.test-agent.module.second.seen")).toBe(false);
        expect(persistence.records.some((record) => record.type === "block")).toBe(false);
        await agent.close();
    });

    it("concatenates lifecycle actions from every module", async () => {
        const provider = new ScriptedProvider([textTurn("first"), textTurn("second")]);
        let done = false;
        const followUp = (text: string): AgentModuleRuntime =>
            module({
                name: `follow-up-${text.replaceAll(" ", "-")}`,
                afterTurn: () => {
                    if (done) return undefined;
                    return [{ type: "send", message: user(text) }];
                },
            });
        const stop = module({
            name: "stop",
            afterTurn: () => {
                done = true;
                return undefined;
            },
        });
        const agent = await Agent.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            sharedKV: sharedKV(),
            sendMode: "all",
            modules: [followUp("from first"), followUp("from second"), stop],
        });

        await agent.send(ctx, user("go"));
        await agent.waitForIdle();

        // Both modules' actions were applied together and drained into one follow-up turn.
        const requests = provider.sessions[0]?.requests ?? [];
        expect(requests).toHaveLength(2);
        expect(requests[1]?.context.messages.slice(-2)).toEqual([
            user("from first"),
            user("from second"),
        ]);
        await agent.close();
    });

    it("lets the first answering module win the reset injection while all observe the change", async () => {
        const provider = new ScriptedProvider([textTurn("claude"), textTurn("gpt")]);
        const observed: boolean[] = [];
        const silent = module({
            name: "silent",
            modelChanged: (_hookCtx, _scope, change) => {
                observed.push(change.wasReset);
                return undefined;
            },
        });
        const summarizer = module({
            name: "summarizer",
            modelChanged: () => system("summary"),
        });
        const late = module({
            name: "late",
            modelChanged: (_hookCtx, _scope, change) => {
                observed.push(change.wasReset);
                return system("should lose");
            },
        });
        const agent = await Agent.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            sharedKV: sharedKV(),
            model: "anthropic/claude",
            modules: [silent, summarizer, late],
        });

        await agent.send(ctx, user("hello"));
        await agent.waitForIdle();
        await agent.send(ctx, user("switch"), { model: "openai/gpt" });
        await agent.waitForIdle();

        expect(observed).toEqual([true, true]);
        expect(provider.sessions[1]?.requests[0]?.context.messages).toEqual([
            system("summary"),
            user("switch"),
        ]);
        await agent.close();
    });

    it("isolates a throwing observer so later modules still see everything", async () => {
        const seen: string[] = [];
        const provider = new ScriptedProvider([textTurn("first"), textTurn("second")]);
        let done = false;
        const broken = module({
            name: "broken",
            onEvent: () => {
                throw new Error("observer broke");
            },
            beforeTurn: () => {
                throw new Error("lifecycle broke");
            },
            afterTurn: () => {
                throw new Error("actions broke");
            },
        });
        const working = module({
            name: "working",
            onEvent: (_hookCtx, _scope, event) => {
                if (event.type === "done") seen.push("event");
            },
            beforeTurn: () => void seen.push("turn"),
            afterTurn: () => {
                if (done) return undefined;
                done = true;
                return [{ type: "send", message: user("follow up") }];
            },
        });
        const agent = await Agent.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            sharedKV: sharedKV(),
            modules: [broken, working],
        });

        await agent.send(ctx, user("go"));
        await agent.waitForIdle();

        // The broken module silenced nothing: the working module observed both turns and
        // its follow-up action survived the broken module's afterTurn failure.
        const requests = provider.sessions[0]?.requests ?? [];
        expect(requests).toHaveLength(2);
        expect(requests[1]?.context.messages.at(-1)).toEqual(user("follow up"));
        expect(seen).toEqual(["turn", "event", "turn", "event"]);
        await agent.close();
    });

    it("supports asynchronous module hooks", async () => {
        const asyncTool = tool("async_tool");
        const provider = new ScriptedProvider([textTurn("answer")]);
        const agent = await Agent.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            sharedKV: sharedKV(),
            modules: [
                module({
                    name: "async",
                    instructions: () => Promise.resolve("async instructions"),
                    tools: () => Promise.resolve([asyncTool]),
                }),
            ],
        });

        await agent.send(ctx, user("go"));
        await agent.waitForIdle();

        expect(provider.sessions[0]?.options.instructions).toBe("async instructions");
        expect(provider.sessions[0]?.options.tools).toEqual([asyncTool]);
        await agent.close();
    });

    it("rejects an incompatible switch when a model-change module fails", async () => {
        const provider = new ScriptedProvider([textTurn("first"), textTurn("second")]);
        const persistence = new InMemoryPersistence();
        const broken = module({
            name: "broken",
            modelChanged: () => {
                throw new Error("handoff broke");
            },
        });
        const agent = await Agent.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            sharedKV: sharedKV(),
            model: "anthropic/claude",
            modules: [broken],
        });

        await agent.send(ctx, user("hello"));
        await agent.waitForIdle();
        await agent.send(ctx, user("switch"), { model: "openai/gpt" });
        await agent.waitForIdle();

        // The failed handoff rejected the switch: the history survived and the previous
        // model stayed effective.
        expect(provider.sessions).toHaveLength(1);
        expect(provider.sessions[0]?.destroyed).toBe(false);
        expect(provider.sessions[0]?.requests[1]?.context.messages).toEqual([
            user("hello"),
            { role: "assistant", content: [{ type: "text", text: "first" }] },
            user("switch"),
        ]);
        expect(provider.sessions[0]?.requests[1]).toMatchObject({
            model: "anthropic/claude",
        });
        await agent.close();
    });

    it("fails the turn when two modules register the same tool", async () => {
        const provider = new ScriptedProvider([textTurn("answer")]);
        const events: string[] = [];
        const agent = await Agent.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            sharedKV: sharedKV(),
            modules: [
                module({ name: "first-bash", tools: () => [tool("bash")] }),
                module({ name: "second-bash", tools: () => [tool("bash")] }),
                module({
                    name: "observer",
                    onEvent: (_hookCtx, _scope, event) => {
                        if (event.type === "done" && event.state === "error") {
                            events.push(event.message);
                        }
                    },
                }),
            ],
        });

        await agent.send(ctx, user("go"));
        await agent.waitForIdle();

        expect(provider.sessions).toHaveLength(0);
        expect(events).toEqual(['Two tools are registered as "bash".']);
        await agent.close();
    });

    it("keeps the base fallbacks when no module implements a hook", async () => {
        const provider = new ScriptedProvider([textTurn("answer")]);
        const events: SessionEvent[] = [];
        const agent = await Agent.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            sharedKV: sharedKV(),
            initialState: { instructions: "state instructions" },
            modules: [
                module({
                    name: "observer",
                    onEvent: (_hookCtx, _scope, event) => events.push(event),
                }),
            ],
        });

        await agent.send(ctx, user("go"));
        await agent.waitForIdle();

        // No module implements instructions, so the mutable state answers as usual.
        expect(provider.sessions[0]?.requests[0]?.context.instructions).toBe("state instructions");
        expect(events.at(-1)).toMatchObject({ type: "done", state: "normal" });
        await agent.close();
    });

    it("scopes each module's store to the module's name", async () => {
        const provider = new ScriptedProvider([textTurn("answer")]);
        const persistence = new InMemoryPersistence();
        const listed: unknown[] = [];
        const memory = module({
            name: "memory",
            afterTurn: async (hookCtx) => {
                const kv = agentKV(hookCtx);
                if (kv === undefined) throw new Error("No store on the context.");
                await kv.write(hookCtx, "note", "remembered");
                listed.push(await kv.list(hookCtx));
                return undefined;
            },
        });
        const other = module({
            name: "other",
            afterTurn: async (hookCtx) => {
                const kv = agentKV(hookCtx);
                if (kv === undefined) throw new Error("No store on the context.");
                // A module sees only its own scope, never a sibling's entries.
                listed.push(await kv.list(hookCtx));
                return undefined;
            },
        });
        const agent = await Agent.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            sharedKV: sharedKV(),
            modules: [memory, other],
        });

        await agent.send(ctx, user("go"));
        await agent.waitForIdle();

        expect(persistence.values.get("kv.test-agent.module.memory.note")).toBe("remembered");
        expect(listed).toEqual([[{ key: "note", value: "remembered" }], []]);
        await agent.close();
    });
    it("tells every hook which agent it is serving, and what it is running on", async () => {
        const provider = new ScriptedProvider([textTurn("answer")]);
        const seen: AgentModuleAgent[] = [];
        const agent = await Agent.create(ctx, {
            id: "identified-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            sharedKV: sharedKV(),
            model: "gym/small",
            effort: "high",
            serviceTier: "priority",
            modules: [
                module({
                    name: "identity",
                    instructions: (_hookCtx, scope) => {
                        seen.push(scope.agent);
                        return "";
                    },
                }),
            ],
        });

        await agent.send(ctx, user("go"));
        await agent.waitForIdle();

        expect(seen[0]).toEqual({
            id: "identified-agent",
            provider: "scripted",
            providerKind: "gym",
            model: "gym/small",
            effort: "high",
            tier: "priority",
            permissionMode: "auto",
        });
        await agent.close();
    });

    it("lends each module a run store that the settling transaction erases", async () => {
        const provider = new ScriptedProvider([textTurn("first"), textTurn("second")]);
        const persistence = new InMemoryPersistence();
        const withinRun: unknown[] = [];
        const whileSettling: unknown[] = [];
        const acrossRuns: unknown[] = [];
        let runs = 0;
        const notes = module({
            name: "notes",
            beforeTurn: async (hookCtx, scope) => {
                runs += 1;
                // What an earlier run wrote about itself must not be here.
                acrossRuns.push(await scope.runKV.read(hookCtx, "note"));
                await scope.runKV.write(hookCtx, "note", `run ${runs}`);
                return undefined;
            },
            afterTurn: async (hookCtx, scope) => {
                withinRun.push(await scope.runKV.read(hookCtx, "note"));
                return undefined;
            },
            afterAgentSettledTransact: async (hookCtx, scope) => {
                // The run's notes are still readable here, and are gone once this commits.
                whileSettling.push(await scope.runKV.read(hookCtx, "note"));
            },
        });
        const agent = await Agent.create(ctx, {
            id: "run-store-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            sharedKV: sharedKV(),
            modules: [notes],
        });

        await agent.send(ctx, user("first"));
        await agent.waitForIdle();
        await agent.send(ctx, user("second"));
        await agent.waitForIdle();

        expect(withinRun).toEqual(["run 1", "run 2"]);
        expect(whileSettling).toEqual(["run 1", "run 2"]);
        expect(acrossRuns).toEqual([undefined, undefined]);
        // Nothing the runs wrote about themselves outlives them.
        expect([...persistence.values.keys()].filter((key) => key.includes(".run."))).toEqual([]);
        await agent.close();
    });

    it("scopes the history-lifetime store independently for each module", async () => {
        const provider = new ScriptedProvider([textTurn("answer")]);
        const persistence = new InMemoryPersistence();
        const observed: unknown[] = [];
        const first = module({
            name: "first",
            beforeTurn: async (hookCtx, scope) => {
                observed.push(await scope.historyKV.read(hookCtx, "marker"));
                await scope.historyKV.write(hookCtx, "marker", "first");
                return undefined;
            },
        });
        const second = module({
            name: "second",
            beforeTurn: async (hookCtx, scope) => {
                observed.push(await scope.historyKV.read(hookCtx, "marker"));
                await scope.historyKV.write(hookCtx, "marker", "second");
                return undefined;
            },
        });
        const agent = await Agent.create(ctx, {
            id: "compaction-store-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            sharedKV: sharedKV(),
            modules: [first, second],
        });

        await agent.send(ctx, user("go"));
        await agent.waitForIdle();

        expect(observed).toEqual([undefined, undefined]);
        expect(
            [...persistence.values.entries()].filter(([key]) => key.includes(".history.")),
        ).toEqual([
            ["kv.compaction-store-agent.history.module.first.marker", "first"],
            ["kv.compaction-store-agent.history.module.second.marker", "second"],
        ]);
        await agent.close();
    });

    it("merges compaction lifecycle hooks across modules in order", async () => {
        const replacement: SessionMessage = {
            role: "compaction",
            content: "summary",
            encryptedContent: null,
        };
        const provider = new ScriptedProvider([]);
        const session = provider.session.bind(provider);
        provider.session = async (id, options) => {
            const created = await session(id, options);
            (created as ScriptedSession).compactionResults = [
                {
                    status: "completed",
                    preservedMessages: [],
                    usage: {
                        input: 10,
                        output: 5,
                        cacheRead: 0,
                        cacheWrite: 0,
                        totalTokens: 15,
                    },
                    context: { instructions: "", messages: [replacement] },
                },
            ];
            return created;
        };
        const order: string[] = [];
        const lifecycle = (name: string) =>
            module({
                name,
                beforeCompaction: () => void order.push(`${name}:before`),
                historyErasedTransact: () => void order.push(`${name}:erased`),
                afterCompaction: () => void order.push(`${name}:after`),
            });
        const agent = await Agent.create(ctx, {
            id: "compaction-hooks-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            sharedKV: sharedKV(),
            modules: [lifecycle("first"), lifecycle("second")],
        });

        await agent.compact(ctx);
        await agent.waitForIdle();

        expect(order).toEqual([
            "first:before",
            "second:before",
            "first:erased",
            "second:erased",
            "first:after",
            "second:after",
        ]);
        await agent.close();
    });

    it("merges inference preparation compaction actions from modules", async () => {
        const replacement: SessionMessage = {
            role: "compaction",
            content: "summary",
            encryptedContent: null,
        };
        const provider = new ScriptedProvider([
            [{ type: "done", state: "normal", tokens: { input: 500, output: 40 } }],
            textTurn("after compaction"),
        ]);
        const session = provider.session.bind(provider);
        provider.session = async (id, options) => {
            const created = await session(id, options);
            (created as ScriptedSession).compactionResults = [
                {
                    status: "completed",
                    preservedMessages: [],
                    usage: {
                        input: 540,
                        output: 5,
                        cacheRead: 0,
                        cacheWrite: 0,
                        totalTokens: 545,
                    },
                    context: { instructions: "", messages: [replacement, user("more")] },
                },
            ];
            return created;
        };
        const agent = await Agent.create(ctx, {
            id: "preparation-compaction-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            sharedKV: sharedKV(),
            modules: [
                module({
                    name: "context-window",
                    prepareInference: (_hookCtx, _scope, preparation) =>
                        preparation.contextTokens === undefined || preparation.contextTokens < 540
                            ? undefined
                            : [{ type: "compact" }],
                }),
            ],
        });

        await agent.send(ctx, user("first"));
        await agent.waitForIdle();
        await agent.send(ctx, user("more"));
        await agent.waitForIdle();

        expect(provider.sessions[0]?.compactions).toHaveLength(1);
        expect(provider.sessions[0]?.requests[1]?.context.messages).toEqual([
            replacement,
            user("more"),
        ]);
        await agent.close();
    });
});
