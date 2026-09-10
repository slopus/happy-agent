import type { SessionMessage } from "@slopus/happy-providers";
import { Type } from "@sinclair/typebox";
import { createRootContext } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it } from "vitest";

import {
    Agent,
    defineAgentTool,
    withAgentDatabase,
    type AgentModuleHooks,
    type AgentModuleRuntime,
} from "../sources/index.js";
import {
    agentMessage,
    providersOf,
    queued,
    sharedKV,
    system,
    testAgentDatabase,
    textTurn,
    user,
} from "./gym/fixtures.js";
import { InMemoryPersistence } from "./gym/InMemoryPersistence.js";
import { ScriptedProvider, ScriptedSession } from "./gym/ScriptedProvider.js";

const ctx = withAgentDatabase(
    createRootContext().named("system-notifications-test"),
    testAgentDatabase(),
);
const agents = new Set<Agent>();
afterEach(async () => {
    await Promise.all([...agents].map((agent) => agent.close()));
    agents.clear();
});

function module(name: string, hooks: AgentModuleHooks): AgentModuleRuntime {
    return { name, module: { name }, hooks };
}

// A small feature exercising the public hook and its two store lifetimes. Base itself must
// know nothing about senders, profiles, or how a feature decides a notification is redundant.
function senderModule(profile = () => "profile") {
    return module("sender", {
        systemNotificationsTransact: async (hookCtx, scope, boundary) => {
            if (boundary.type === "message" && boundary.accepted.message.role === "user") {
                await scope.kv.write(hookCtx, "sender", boundary.accepted.metadata?.sender ?? null);
            }
            const sender = await scope.kv.read(hookCtx, "sender");
            if (sender === undefined) return;
            const text = `Sender: ${JSON.stringify(sender)}; ${profile()}`;
            if ((await scope.historyKV.read(hookCtx, "announced")) === text) return;
            await scope.historyKV.write(hookCtx, "announced", text);
            return [system(text)];
        },
    });
}

async function open(
    persistence: InMemoryPersistence,
    provider: ScriptedProvider,
    modules: readonly AgentModuleRuntime[],
) {
    const agent = await Agent.create(ctx, {
        id: "notifications-agent",
        providers: providersOf(provider),
        provider: "scripted",
        persistence,
        sharedKV: sharedKV(),
        sendMode: "all",
        steeringMode: "all",
        modules,
    });
    agents.add(agent);
    return agent;
}

function seed(persistence: InMemoryPersistence, kind: "send" | "steering") {
    for (const [index, sender] of ["Alice", "Alice", "Bob", "Alice"].entries()) {
        const envelope = queued(user(`message ${index}`));
        // Admission persists the identity alongside the queue envelope, before consumption.
        persistence.values.set(`message.${envelope.id}`, true);
        persistence.values.set(`${kind}.00000000000001.00000${index}`, {
            ...envelope,
            metadata: { sender },
        });
    }
}

function messages(persistence: InMemoryPersistence): SessionMessage[] {
    return persistence.records.flatMap((record) =>
        record.type === "system" || record.type === "user" ? [record.message] : [],
    );
}

describe("transactional system notifications", () => {
    it.each(["send", "steering"] as const)(
        "interleaves notifications within a restored mixed-sender %s batch",
        async (kind) => {
            const persistence = new InMemoryPersistence();
            seed(persistence, kind);
            const provider = new ScriptedProvider([textTurn("done")]);
            const agent = await open(persistence, provider, [senderModule()]);
            agent.start();
            await agent.waitForIdle();

            const expected = [
                system('Sender: "Alice"; profile'),
                user("message 0"),
                user("message 1"),
                system('Sender: "Bob"; profile'),
                user("message 2"),
                system('Sender: "Alice"; profile'),
                user("message 3"),
            ];
            expect(provider.sessions[0]?.requests[0]?.context.messages).toEqual(expected);
            expect(messages(persistence)).toEqual(expected);
            expect(
                [...persistence.values.keys()].filter((key) => key.startsWith(`${kind}.`)),
            ).toEqual([]);

            // Both a duplicate submitted by somebody else and a restart preserve the author
            // and the history-scoped deduplication state.
            await agent.send(ctx, user("spoofed retry"), {
                id: queued(user("message 2")).id,
                metadata: { sender: "Mallory" },
            });
            await agent.waitForIdle();
            expect(messages(persistence)).toEqual(expected);
            await agent.close();
            const nextProvider = new ScriptedProvider([textTurn("continued")]);
            const restored = await open(persistence, nextProvider, [senderModule()]);
            await restored.send(ctx, user("same sender"), { metadata: { sender: "Alice" } });
            await restored.waitForIdle();
            expect(messages(persistence)).toEqual([...expected, user("same sender")]);
        },
    );

    it("rolls back the whole batch, notifications, and module state when a later module fails", async () => {
        const persistence = new InMemoryPersistence();
        seed(persistence, "send");
        const provider = new ScriptedProvider([textTurn("done")]);
        const failure = module("failure", {
            systemNotificationsTransact: (_hookCtx, _scope, boundary) => {
                if (boundary.type === "message" && boundary.accepted.metadata?.sender === "Bob") {
                    throw new Error("Notification rejected");
                }
            },
        });
        const agent = await open(persistence, provider, [senderModule(), failure]);
        agent.start();
        await agent.waitForIdle();
        expect(provider.sessions.flatMap((session) => session.requests)).toEqual([]);
        expect(persistence.records.filter((record) => record.type === "user")).toEqual([]);
        expect(messages(persistence)).not.toContainEqual(system('Sender: "Alice"; profile'));
        expect(
            [...persistence.values.keys()].filter((key) => key.includes(".module.sender.")),
        ).toEqual([]);
        expect(
            [...persistence.values.keys()].filter((key) => key.startsWith("send.")),
        ).toHaveLength(4);
        await agent.close();

        const recovered = await open(persistence, provider, [senderModule()]);
        recovered.start();
        await recovered.waitForIdle();
        expect(messages(persistence).filter((message) => message.role === "user")).toHaveLength(4);
        expect(messages(persistence).filter((message) => message.role === "system")).toContainEqual(
            system('Sender: "Bob"; profile'),
        );
    });

    it("merges modules in order and isolates their history stores at both boundaries", async () => {
        const persistence = new InMemoryPersistence();
        const provider = new ScriptedProvider([textTurn("done")]);
        const seen: unknown[] = [];
        const notices = (name: string) =>
            module(name, {
                systemNotificationsTransact: async (hookCtx, scope, boundary) => {
                    seen.push([name, boundary.type, await scope.historyKV.read(hookCtx, "seen")]);
                    await scope.historyKV.write(hookCtx, "seen", boundary.type);
                    return [system(`${name}: ${boundary.type}`)];
                },
            });
        const agent = await open(persistence, provider, [notices("first"), notices("second")]);
        await agent.send(ctx, user("original"));
        await agent.waitForIdle();
        expect(seen).toEqual([
            ["first", "message", undefined],
            ["second", "message", undefined],
            ["first", "inference", "message"],
            ["second", "inference", "message"],
        ]);
        const expected = [
            system("first: message"),
            system("second: message"),
            user("original"),
            system("first: inference"),
            system("second: inference"),
        ];
        expect(messages(persistence)).toEqual(expected);
        expect(provider.sessions[0]?.requests[0]?.context.messages).toEqual(expected);
    });

    it("reintroduces current context after compaction and request-profile resets", async () => {
        const persistence = new InMemoryPersistence();
        const provider = new ScriptedProvider([
            textTurn("first"),
            textTurn("second"),
            textTurn("third"),
        ]);
        const agent = await open(persistence, provider, [senderModule()]);
        await agent.send(ctx, user("hello"), { metadata: { sender: "Alice" } });
        await agent.waitForIdle();
        const summary: SessionMessage = {
            role: "compaction",
            content: "summary",
            encryptedContent: null,
        };
        (provider.sessions[0] as ScriptedSession).compactionResults.push({
            status: "completed",
            preservedMessages: [],
            usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 11 },
            context: { instructions: "", messages: [summary] },
        });
        await agent.compact(ctx);
        await agent.waitForIdle();
        // A system message does not supply a new sender; inference must restore the current one.
        await agent.send(ctx, system("continue"));
        await agent.waitForIdle();
        expect(
            provider.sessions.flatMap((session) => session.requests)[1]?.context.messages,
        ).toEqual([summary, system('Sender: "Alice"; profile'), system("continue")]);

        await agent.send(ctx, user("new context"), {
            profile: "new-profile",
            metadata: { sender: "Alice" },
        });
        await agent.waitForIdle();
        expect(
            provider.sessions.flatMap((session) => session.requests).at(-1)?.context.messages,
        ).toEqual([system('Sender: "Alice"; profile'), user("new context")]);
    });

    it("refreshes changed profile context at inference without rewriting an accepted message", async () => {
        let profile = "old name";
        const persistence = new InMemoryPersistence();
        const provider = new ScriptedProvider([textTurn("done")]);
        const agent = await open(persistence, provider, [
            senderModule(() => profile),
            module("rename", {
                messageAccepted: () => {
                    profile = "new name";
                },
            }),
        ]);
        await agent.send(ctx, user("original"), { metadata: { sender: "Alice" } });
        await agent.waitForIdle();
        expect(provider.sessions[0]?.requests[0]?.context.messages).toEqual([
            system('Sender: "Alice"; old name'),
            user("original"),
            system('Sender: "Alice"; new name'),
        ]);
    });

    it("can clear unknown human authors without treating agent messages as a human", async () => {
        const persistence = new InMemoryPersistence();
        const provider = new ScriptedProvider([
            textTurn("one"),
            textTurn("two"),
            textTurn("three"),
        ]);
        const agent = await open(persistence, provider, [senderModule()]);
        await agent.send(ctx, user("Alice"), { metadata: { sender: "Alice" } });
        await agent.waitForIdle();
        await agent.send(ctx, agentMessage("agent update"));
        await agent.waitForIdle();
        await agent.send(ctx, user("unknown"));
        await agent.waitForIdle();
        expect(messages(persistence).filter((message) => message.role === "system")).toEqual([
            system('Sender: "Alice"; profile'),
            system("Sender: null; profile"),
        ]);
        expect(messages(persistence).at(-1)).toEqual(user("unknown"));
    });

    it("restores context at inference when preparation compacts newly accepted input", async () => {
        const persistence = new InMemoryPersistence();
        const provider = new ScriptedProvider([textTurn("done")]);
        const summary: SessionMessage = {
            role: "compaction",
            content: "summary",
            encryptedContent: null,
        };
        const createSession = provider.session.bind(provider);
        provider.session = async (id, options) => {
            const session = (await createSession(id, options)) as ScriptedSession;
            session.compactionResults.push({
                status: "completed",
                preservedMessages: [],
                usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 11 },
                context: { instructions: "", messages: [summary] },
            });
            return session;
        };
        let compact = true;
        const agent = await open(persistence, provider, [
            senderModule(),
            module("compact", {
                prepareInference: () => {
                    if (!compact) return;
                    compact = false;
                    return [{ type: "compact" }];
                },
            }),
        ]);
        await agent.send(ctx, user("original"), { metadata: { sender: "Alice" } });
        await agent.waitForIdle();
        expect(
            provider.sessions.flatMap((session) => session.requests)[0]?.context.messages,
        ).toEqual([summary, system('Sender: "Alice"; profile')]);
        expect(persistence.records.filter((record) => record.type === "system")).toEqual([
            { type: "system", message: system('Sender: "Alice"; profile') },
        ]);
    });

    it("rolls back inference notifications and their state when the inference stage fails", async () => {
        const persistence = new InMemoryPersistence();
        const provider = new ScriptedProvider([textTurn("done")]);
        let fail = true;
        const notifications = module("inference-notice", {
            systemNotificationsTransact: async (hookCtx, scope, boundary) => {
                if (
                    boundary.type !== "inference" ||
                    (await scope.historyKV.read(hookCtx, "announced"))
                )
                    return;
                await scope.historyKV.write(hookCtx, "announced", true);
                return [system("Inference context")];
            },
            beforeInferenceTransact: () => {
                if (fail) throw new Error("Inference stage rejected");
            },
        });
        const agent = await open(persistence, provider, [notifications]);
        await agent.send(ctx, user("original"));
        await agent.waitForIdle();
        expect(provider.sessions.flatMap((session) => session.requests)).toEqual([]);
        expect(messages(persistence)).not.toContainEqual(system("Inference context"));
        expect(
            [...persistence.values.keys()].filter((key) =>
                key.includes(".module.inference-notice."),
            ),
        ).toEqual([]);

        fail = false;
        await agent.send(ctx, user("continue"));
        await agent.waitForIdle();
        expect(
            provider.sessions.flatMap((session) => session.requests)[0]?.context.messages.at(-1),
        ).toEqual(system("Inference context"));
        expect(
            messages(persistence).filter(
                (message) =>
                    JSON.stringify(message) === JSON.stringify(system("Inference context")),
            ),
        ).toHaveLength(1);
    });

    it("does not repeat a committed inference notification after draining before the provider call", async () => {
        const persistence = new InMemoryPersistence();
        const provider = new ScriptedProvider([textTurn("done")]);
        const notifications = module("inference-notice", {
            systemNotificationsTransact: async (hookCtx, scope, boundary) => {
                if (
                    boundary.type !== "inference" ||
                    (await scope.historyKV.read(hookCtx, "announced"))
                )
                    return;
                await scope.historyKV.write(hookCtx, "announced", true);
                return [system("Inference context")];
            },
        });
        const agent = await open(persistence, provider, [
            notifications,
            module("drain", {
                beforeInference: () => {
                    void agent.drain();
                },
            }),
        ]);
        await agent.send(ctx, user("original"));
        await agent.waitForIdle();
        expect(provider.sessions.flatMap((session) => session.requests)).toEqual([]);
        expect(messages(persistence)).toEqual([user("original"), system("Inference context")]);
        await agent.close();
        const restored = await open(persistence, provider, [notifications]);
        restored.start();
        await restored.waitForIdle();
        expect(
            provider.sessions.flatMap((session) => session.requests)[0]?.context.messages,
        ).toEqual([user("original"), system("Inference context")]);
        expect(messages(persistence)).toEqual([user("original"), system("Inference context")]);
    });

    it("keeps a requested tool call and its result together before inference notifications", async () => {
        const persistence = new InMemoryPersistence();
        const provider = new ScriptedProvider([textTurn("done")]);
        const agent = await open(persistence, provider, [
            senderModule(),
            module("tool", {
                tools: () => [
                    defineAgentTool({
                        name: "read_status",
                        returnType: Type.Object({}),
                        shouldReviewInAutoMode: () => false,
                        execute: async () => ({}),
                        toLLM: () => [{ type: "text", text: "ready" }],
                    }),
                ],
                systemNotificationsTransact: (_hookCtx, _scope, boundary) =>
                    boundary.type === "inference" ? [system("Ready for inference")] : undefined,
            }),
        ]);
        await agent.send(
            ctx,
            {
                role: "user",
                content: [
                    { type: "text", text: "original" },
                    { type: "tool_call_request", name: "read_status" },
                ],
            },
            { metadata: { sender: "Alice" } },
        );
        await agent.waitForIdle();
        expect(provider.sessions[0]?.requests[0]?.context.messages).toEqual([
            system('Sender: "Alice"; profile'),
            user("original"),
            expect.objectContaining({
                role: "assistant",
                content: [expect.objectContaining({ type: "tool_call", name: "read_status" })],
            }),
            expect.objectContaining({ role: "tool" }),
            system("Ready for inference"),
        ]);
    });
});
