import type { CompletedSessionCompaction, SessionEvent } from "@slopus/happy-providers";
import { createRootContext } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";
import { AgentBase, AgentProviders, type AgentBaseHooks } from "../sources/index.js";
import { InMemoryPersistence } from "./gym/InMemoryPersistence.js";
import { ScriptedProvider } from "./gym/ScriptedProvider.js";
import { textTurn, user } from "./gym/fixtures.js";

const ctx = createRootContext().named("native-compaction-test");
const summary = { role: "compaction" as const, content: "Native summary", encryptedContent: null };
function checkpoint(id = "native-checkpoint-one"): SessionEvent {
    const result: CompletedSessionCompaction = {
        status: "completed",
        compaction: summary,
        preservedMessages: [],
        usage: { input: 730473, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 730473 },
        context: { instructions: "Instructions", messages: [summary] },
    };
    // Structural until the dependency publishes the context_compacted union member.
    return { type: "context_compacted", checkpointId: id, result } as unknown as SessionEvent;
}
function registry(first: ScriptedProvider, second: ScriptedProvider) {
    const providers = new AgentProviders();
    providers.add("first", first, "claude");
    providers.add("second", second, "claude");
    return providers;
}
function answer(text: string): SessionEvent[] {
    return textTurn(text).filter((e) => e.type !== "block_start");
}

describe("native compaction checkpoints", () => {
    it("commits the native replacement before continuing, so switching accounts cannot resurrect old history", async () => {
        const before = textTurn("Before checkpoint").filter(
            (e) => e.type !== "done" && e.type !== "block_stop",
        );
        const first = new ScriptedProvider([
            [...before, checkpoint(), ...answer("After checkpoint")],
            textTurn("Back on first"),
        ]);
        const second = new ScriptedProvider([textTurn("On second")]);
        const store = new InMemoryPersistence();
        const hooks: string[] = [];
        const seen: SessionEvent[] = [];
        const agent = await AgentBase.create(ctx, {
            id: "native-test",
            providers: registry(first, second),
            provider: "first",
            persistence: store,
            initialState: { instructions: "Instructions" },
            hooks: {
                beforeCompaction: () => {
                    hooks.push("before");
                },
                historyErasedTransact: () => {
                    hooks.push("commit");
                },
                afterCompaction: () => {
                    hooks.push("after");
                },
                onEvent: (_ctx, event) => {
                    seen.push(event);
                },
            },
        });
        await agent.send(ctx, user("Superseded huge history"));
        await agent.waitForIdle();
        await agent.send(ctx, user("Switch account"), { provider: "second" });
        await agent.waitForIdle();
        await agent.send(ctx, user("Switch back"), { provider: "first" });
        await agent.waitForIdle();
        expect(hooks).toEqual(["before", "commit", "after"]);
        expect(second.sessions[0]!.requests[0]!.context.messages[0]).toEqual(summary);
        expect(JSON.stringify(second.sessions[0]!.requests[0]!.context.messages)).not.toContain(
            "Superseded huge history",
        );
        expect(JSON.stringify(second.sessions[0]!.requests[0]!.context.messages)).not.toContain(
            "Before checkpoint",
        );
        expect(JSON.stringify(first.sessions.at(-1)!.requests[0]!.context.messages)).toContain(
            "After checkpoint",
        );
        expect(JSON.stringify(first.sessions.at(-1)!.requests[0]!.context.messages)).not.toContain(
            "Superseded huge history",
        );
        expect(store.records[0]).toMatchObject({
            type: "compaction",
            checkpointId: "native-checkpoint-one",
        });
        expect(seen.some((e) => (e as { type: string }).type === "context_compacted")).toBe(false);
        await agent.close();
    });

    it("keeps the old context when the atomic checkpoint commit fails", async () => {
        const first = new ScriptedProvider([[checkpoint(), ...textTurn("Should not appear")]]);
        const second = new ScriptedProvider([textTurn("Recovered")]);
        const store = new InMemoryPersistence();
        const agent = await AgentBase.create(ctx, {
            id: "native-failure",
            providers: registry(first, second),
            provider: "first",
            persistence: store,
            hooks: {
                historyErasedTransact: () => {
                    throw new Error("checkpoint observer failed");
                },
            },
        });
        await agent.send(ctx, user("Keep this authorized history"));
        await agent.waitForIdle();
        expect(store.records.some((r) => r.type === "compaction")).toBe(false);
        expect(JSON.stringify(store.records)).toContain("Keep this authorized history");
        await agent.close();
    });

    it("does not erase later output or input when a checkpoint is delivered twice, including after restart", async () => {
        const first = new ScriptedProvider([
            [
                checkpoint(),
                ...textTurn("retained answer").filter(
                    (e) => e.type !== "done" && e.type !== "block_stop" && e.type !== "block_start",
                ),
                checkpoint(),
                { type: "block_stop" },
                { type: "done", state: "normal", tokens: { input: 12, output: 2 } },
            ],
        ]);
        const store = new InMemoryPersistence();
        let commits = 0;
        const makeHooks = (): AgentBaseHooks => ({
            historyErasedTransact: () => {
                commits++;
            },
        });
        const providers = registry(first, new ScriptedProvider([]));
        const agent = await AgentBase.create(ctx, {
            id: "native-dedup",
            providers,
            provider: "first",
            persistence: store,
            hooks: makeHooks(),
        });
        await agent.send(ctx, user("superseded"));
        await agent.waitForIdle();
        await agent.close();
        expect(commits).toBe(1);
        expect(JSON.stringify(store.records)).toContain("retained answer");
        const restoredProvider = new ScriptedProvider([[checkpoint(), ...textTurn("new answer")]]);
        const restored = await AgentBase.load(ctx, {
            id: "native-dedup",
            providers: registry(restoredProvider, new ScriptedProvider([])),
            provider: "first",
            persistence: store,
            hooks: makeHooks(),
        });
        await restored.send(ctx, user("new input"));
        await restored.waitForIdle();
        expect(commits).toBe(1);
        expect(JSON.stringify(store.records)).toContain("retained answer");
        expect(JSON.stringify(store.records)).toContain("new input");
        await restored.close();
    });

    it("refuses a checkpoint across an unresolved tool call", async () => {
        const first = new ScriptedProvider([
            [
                { type: "block_start" },
                { type: "toolcall_start", callId: "native-tool", name: "Read", server: true },
                { type: "toolcall_end", callId: "native-tool", arguments: "{}" },
                checkpoint(),
            ],
        ]);
        const store = new InMemoryPersistence();
        const agent = await AgentBase.create(ctx, {
            id: "native-open-tool",
            providers: registry(first, new ScriptedProvider([])),
            provider: "first",
            persistence: store,
        });
        await agent.send(ctx, user("keep until tool settles"));
        await agent.waitForIdle();
        expect(store.records.some((r) => r.type === "compaction")).toBe(false);
        expect(JSON.stringify(store.records)).toContain("keep until tool settles");
        await agent.close();
    });

    it("recovers from the replacement transaction without resurrecting the source when the process stopped mid-response", async () => {
        let committed!: () => void;
        const atCommit = new Promise<void>((resolve) => {
            committed = resolve;
        });
        let release!: () => void;
        const released = new Promise<void>((resolve) => {
            release = resolve;
        });
        const provider = new ScriptedProvider([[checkpoint(), ...textTurn("old-process tail")]]);
        const store = new InMemoryPersistence();
        const agent = await AgentBase.create(ctx, {
            id: "native-crash",
            providers: registry(provider, new ScriptedProvider([])),
            provider: "first",
            persistence: store,
            hooks: {
                afterCompaction: async () => {
                    committed();
                    await released;
                },
            },
        });
        await agent.send(ctx, user("old long source"));
        await atCommit;
        const copy = new InMemoryPersistence(structuredClone(store.records));
        for (const [key, value] of store.values) copy.values.set(key, structuredClone(value));
        const recoveredProvider = new ScriptedProvider([textTurn("continued after restart")]);
        const recovered = await AgentBase.load(ctx, {
            id: "native-crash",
            providers: registry(recoveredProvider, new ScriptedProvider([])),
            provider: "first",
            persistence: copy,
        });
        recovered.start();
        await recovered.waitForIdle();
        expect(recoveredProvider.sessions[0]!.requests[0]!.context.messages[0]).toEqual(summary);
        expect(
            JSON.stringify(recoveredProvider.sessions[0]!.requests[0]!.context.messages),
        ).not.toContain("old long source");
        expect(JSON.stringify(copy.records)).toContain("continued after restart");
        await recovered.close();
        release();
        await agent.waitForIdle();
        await agent.close();
    });
});
