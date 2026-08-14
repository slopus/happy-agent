import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import {
    Agent,
    AgentKV,
    AgentProviders,
    type AgentFeature,
    type AgentFeatureScope,
} from "@slopus/happy-agent-base";
import {
    BaseProvider,
    BaseSession,
    type ProviderModality,
    type SessionCompaction,
    type SessionCompactionOptions,
    type SessionEvent,
    type SessionOptions,
    type SessionRunRequest,
    type SessionStream,
} from "@slopus/happy-providers";
import {
    HistoryFeature,
    type HistoryMessage,
    type HistoryPage,
    type HistoryStore,
    type HistoryStoreQuery,
} from "@slopus/happy-agent-features";
import type { Context } from "@steve.kite/stdlib";
import { createTestRootContext } from "../../testing/createTestRootContext.js";
import { migrateSessionDatabase } from "../../persistence/database/migrateSessionDatabase.js";
import { openSessionDatabase } from "../../persistence/database/openSessionDatabase.js";
import type { SessionDatabase } from "../../persistence/database/SessionDatabase.js";
import { SqliteAgentPersistence } from "../persistence/SqliteAgentPersistence.js";
import { RigHistoryStore } from "../RigHistoryStore.js";
import { describe, expect, it, afterEach } from "vitest";

const ctx = createTestRootContext().named("rig-history-integration-test");
const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { force: true, recursive: true })),
    );
});

describe("Agent Base and Rig history", () => {
    it("archives an Agent turn in the same SQLite database as Agent Base state", async () => {
        const world = await openWorld();
        const provider = new ScriptedProvider([textTurn("from the shared database")]);
        const providers = providersOf(provider);
        const historyStore = new RigHistoryStore(world.database);
        const history = new HistoryFeature({ store: historyStore });
        const persistence = new SqliteAgentPersistence(world.database, "shared-agent");
        const agent = await Agent.create(ctx, {
            id: "shared-agent",
            model: "scripted/model",
            persistence,
            provider: "scripted",
            providers,
            sharedKV: new AgentKV(
                new SqliteAgentPersistence(world.database, "shared-system"),
                "shared.",
            ),
            features: [history],
        });

        try {
            await agent.send(ctx, user("persist this"), { await: true });
            await agent.waitForIdle();

            const page = await historyStore.read(ctx, agent.id, { limit: 500 });
            expect(page.messages.map((record) => record.message.role)).toEqual([
                "user",
                "assistant",
            ]);
            expect(page.messages[1]?.message.blocks).toEqual([
                { text: "from the shared database", type: "text" },
            ]);

            const records = await persistence.load(ctx);
            expect(records.map((record) => record.type)).toContain("user");
            expect(records.map((record) => record.type)).toContain("block");
        } finally {
            await agent.close();
            await world.close();
        }

        const reopened = await openWorld(world.path);
        try {
            const page = await new RigHistoryStore(reopened.database).read(ctx, "shared-agent", {
                limit: 500,
            });
            expect(page.messages.map((record) => record.message.role)).toEqual([
                "user",
                "assistant",
            ]);
            expect(
                await new SqliteAgentPersistence(reopened.database, "shared-agent").load(ctx),
            ).not.toHaveLength(0);
        } finally {
            await reopened.close();
        }
    });

    it("rolls an accepted history write back with Agent Base and retries it", async () => {
        const world = await openWorld();
        const provider = new ScriptedProvider([textTurn("after retry")]);
        const delegate = new RigHistoryStore(world.database);
        const store = new FailingHistoryStore(delegate);
        store.failuresRemaining = 1;
        const agent = await Agent.create(ctx, {
            id: "retry-agent",
            model: "scripted/model",
            persistence: new SqliteAgentPersistence(world.database, "retry-agent"),
            provider: "scripted",
            providers: providersOf(provider),
            sharedKV: new AgentKV(
                new SqliteAgentPersistence(world.database, "retry-system"),
                "shared.",
            ),
            features: [new HistoryFeature({ store })],
        });

        try {
            await agent.send(ctx, user("retry this"), { await: true });
            await agent.waitForIdle();
            expect((await delegate.read(ctx, agent.id, { limit: 500 })).messages).toHaveLength(0);

            agent.start();
            await agent.waitForIdle();
            const records = (await delegate.read(ctx, agent.id, { limit: 500 })).messages;
            expect(records.map((record) => record.message.role)).toEqual(["user", "assistant"]);
            expect(records.filter((record) => record.message.role === "user")).toHaveLength(1);
        } finally {
            await agent.close();
            await world.close();
        }
    });

    it("rolls a persisted block back and retries the Agent turn", async () => {
        const world = await openWorld();
        const delegate = new RigHistoryStore(world.database);
        const provider = new ScriptedProvider([
            textTurn("discarded response"),
            textTurn("retried response"),
        ]);
        const agent = await Agent.create(ctx, {
            id: "block-retry-agent",
            model: "scripted/model",
            persistence: new SqliteAgentPersistence(world.database, "block-retry-agent"),
            provider: "scripted",
            providers: providersOf(provider),
            sharedKV: new AgentKV(
                new SqliteAgentPersistence(world.database, "block-retry-system"),
                "shared.",
            ),
            features: [new HistoryFeature({ store: delegate }), failFirstBlock()],
        });

        try {
            await agent.send(ctx, user("retry the blocked response"), { await: true });
            await agent.waitForIdle();
            expect(
                (await delegate.read(ctx, agent.id, { limit: 500 })).messages.map(
                    (record) => record.message.role,
                ),
            ).toEqual(["user"]);

            await agent.close();
            const recovered = await Agent.load(ctx, {
                id: "block-retry-agent",
                model: "scripted/model",
                persistence: new SqliteAgentPersistence(world.database, "block-retry-agent"),
                provider: "scripted",
                providers: providersOf(provider),
                sharedKV: new AgentKV(
                    new SqliteAgentPersistence(world.database, "block-retry-system"),
                    "shared.",
                ),
                features: [new HistoryFeature({ store: delegate })],
            });
            recovered.start();
            await recovered.waitForIdle();
            const page = await delegate.read(ctx, agent.id, { limit: 500 });
            expect(page.messages.map((record) => record.message.role)).toEqual([
                "user",
                "assistant",
            ]);
            expect(page.messages[1]?.message.blocks).toEqual([
                { text: "retried response", type: "text" },
            ]);
            await recovered.close();
        } finally {
            await agent.close();
            await world.close();
        }
    });

    it("retries a strict inference archive in Agent Base settlement", async () => {
        const world = await openWorld();
        const delegate = new RigHistoryStore(world.database);
        const store = new FailingHistoryStore(delegate);
        store.failAssistantOnly = true;
        store.failuresRemaining = 1;
        const agent = await Agent.create(ctx, {
            id: "inference-retry-agent",
            model: "scripted/model",
            persistence: new SqliteAgentPersistence(world.database, "inference-retry-agent"),
            provider: "scripted",
            providers: providersOf(new ScriptedProvider([textTurn("archived after retry")])),
            sharedKV: new AgentKV(
                new SqliteAgentPersistence(world.database, "inference-retry-system"),
                "shared.",
            ),
            features: [new HistoryFeature({ store })],
        });

        try {
            await agent.send(ctx, user("archive the answer"), { await: true });
            await agent.waitForIdle();
            const page = await delegate.read(ctx, agent.id, { limit: 500 });
            expect(page.messages.map((record) => record.message.role)).toEqual([
                "user",
                "assistant",
            ]);
            expect(page.messages[1]?.message.blocks).toEqual([
                { text: "archived after retry", type: "text" },
            ]);
            expect(
                page.messages.filter((record) => record.message.role === "assistant"),
            ).toHaveLength(1);
        } finally {
            await agent.close();
            await world.close();
        }
    });

    it("recovers pending assistant blocks after restart and settles them exactly once", async () => {
        const world = await openWorld();
        const persistence = new SqliteAgentPersistence(world.database, "restart-agent");
        const runKV = new AgentKV(persistence, "kv.restart-agent.run.feature.history.");
        await runKV.write(ctx, "pending_blocks", [
            { text: "written before the process stopped", type: "text" },
        ]);
        await runKV.write(ctx, "pending_record_id", "response-before-restart");
        await world.close();

        const reopened = await openWorld(world.path);
        const delegate = new RigHistoryStore(reopened.database);
        const store = new FailingHistoryStore(delegate);
        store.failuresRemaining = 1;
        const history = new HistoryFeature({ store });
        const scope = restartScope(reopened.database, "restart-agent");

        try {
            await expect(history.afterAgentSettledTransact(ctx, scope)).rejects.toThrow(
                "history append failed",
            );
            expect(
                await new AgentKV(
                    new SqliteAgentPersistence(reopened.database, "restart-agent"),
                    "kv.restart-agent.run.feature.history.",
                ).read(ctx, "pending_blocks"),
            ).toEqual([{ text: "written before the process stopped", type: "text" }]);

            await history.afterAgentSettledTransact(ctx, scope);
            await history.afterAgentSettledTransact(ctx, scope);
            const records = (await delegate.read(ctx, "restart-agent", { limit: 500 })).messages;
            expect(records).toHaveLength(1);
            expect(records[0]?.message.recordId).toBe("response-before-restart:assistant");
        } finally {
            await reopened.close();
        }
    });

    it("rejects malformed pending KV after restart without archiving it", async () => {
        const world = await openWorld();
        await new AgentKV(
            new SqliteAgentPersistence(world.database, "malformed-agent"),
            "kv.malformed-agent.run.feature.history.",
        ).write(ctx, "pending_blocks", [{ type: "not-a-history-block" }]);
        await world.close();

        const reopened = await openWorld(world.path);
        const store = new RigHistoryStore(reopened.database);
        const history = new HistoryFeature({ store });
        try {
            await expect(
                history.afterAgentSettledTransact(
                    ctx,
                    restartScope(reopened.database, "malformed-agent"),
                ),
            ).rejects.toThrow("History feature found invalid pending blocks.");
            expect(
                (await store.read(ctx, "malformed-agent", { limit: 500 })).messages,
            ).toHaveLength(0);
        } finally {
            await reopened.close();
        }
    });
});

class FailingHistoryStore implements HistoryStore {
    #failuresRemaining = 0;
    #failAssistantOnly = false;

    readonly #delegate: HistoryStore;

    constructor(delegate: HistoryStore) {
        this.#delegate = delegate;
    }

    get failuresRemaining(): number {
        return this.#failuresRemaining;
    }

    set failuresRemaining(value: number) {
        this.#failuresRemaining = value;
    }

    get failAssistantOnly(): boolean {
        return this.#failAssistantOnly;
    }

    set failAssistantOnly(value: boolean) {
        this.#failAssistantOnly = value;
    }

    async append(
        ctx: Context,
        agentId: string,
        messages: readonly HistoryMessage[],
    ): Promise<void> {
        if (
            this.#failuresRemaining > 0 &&
            (!this.#failAssistantOnly || messages.some((message) => message.role === "assistant"))
        ) {
            this.#failuresRemaining -= 1;
            throw new Error("history append failed");
        }
        await this.#delegate.append(ctx, agentId, [...messages]);
    }

    async read(ctx: Context, agentId: string, query: HistoryStoreQuery): Promise<HistoryPage> {
        return await this.#delegate.read(ctx, agentId, query);
    }
}

function failFirstBlock(): AgentFeature {
    let shouldFail = true;
    return {
        name: "test-fail-first-block",
        onEventTransact: async (_ctx, _scope, event) => {
            if (shouldFail && event.type === "text_end") {
                shouldFail = false;
                throw new Error("block archive failed");
            }
        },
    };
}

class ScriptedProvider extends BaseProvider {
    static override readonly name = "scripted";
    static override readonly inputTypes: readonly ProviderModality[] = ["text"];
    static override readonly outputTypes: readonly ProviderModality[] = ["text"];

    readonly #script: SessionEvent[][];

    constructor(script: SessionEvent[][]) {
        super();
        this.#script = script;
    }

    override session(id: string, options: SessionOptions): Promise<BaseSession> {
        return Promise.resolve(new ScriptedSession(id, this.#script, options));
    }
}

class ScriptedSession extends BaseSession {
    constructor(
        id: string,
        private readonly script: SessionEvent[][],
        readonly options: SessionOptions,
    ) {
        super(id);
    }

    override run(_ctx: Context, _request: SessionRunRequest): SessionStream {
        const events = this.script.shift() ?? [];
        return (async function* () {
            yield* events;
        })();
    }

    override compact(
        _ctx: Context,
        _options: SessionCompactionOptions,
    ): Promise<SessionCompaction> {
        return Promise.reject(new Error("No scripted compaction result."));
    }

    override destroy(): void {}
}

function providersOf(provider: BaseProvider): AgentProviders {
    const providers = new AgentProviders();
    providers.add("scripted", provider, "gym");
    return providers;
}

function textTurn(text: string): SessionEvent[] {
    return [
        { type: "text_start" },
        { type: "text_delta", delta: text },
        { type: "text_end" },
        { type: "done", state: "normal", tokens: { input: 1, output: 1 } },
    ];
}

function user(text: string) {
    return { content: [{ text, type: "text" as const }], role: "user" as const };
}

function restartScope(database: SessionDatabase, agentId: string) {
    const persistence = new SqliteAgentPersistence(database, agentId);
    return {
        agent: {
            effort: undefined,
            id: agentId,
            metadata: undefined,
            model: "scripted/model",
            permissionMode: "auto" as const,
            provider: "scripted",
            providerKind: "gym" as const,
            tier: undefined,
        },
        kv: new AgentKV(persistence, `kv.${agentId}.feature.history.`),
        runKV: new AgentKV(persistence, `kv.${agentId}.run.feature.history.`),
        sharedKV: new AgentKV(persistence, "shared."),
    } satisfies AgentFeatureScope;
}

async function openWorld(path?: string) {
    const directory =
        path === undefined
            ? await mkdtemp(join(process.cwd(), ".rig-history-integration-"))
            : undefined;
    if (directory !== undefined) temporaryDirectories.push(directory);
    const databasePath =
        path === undefined ? join(directory!, "sessions.sqlite") : join(path, "sessions.sqlite");
    const opened = await openSessionDatabase(ctx, databasePath);
    await migrateSessionDatabase(opened.ctx);
    return {
        close: () => opened.database.close(ctx),
        database: opened.database,
        path: directory ?? path!,
    };
}
