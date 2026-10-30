import {
    withAgentConfig,
    withAgentContext,
    withAgentPermissionMode,
    type AgentConfig,
    type AgentMessageAcceptance,
    type AgentMetadata,
    type AgentModel,
    type AgentModuleHooks,
    type AgentPermissionMode,
    type AgentSystemRef,
} from "@slopus/happy-agent-base";
import { Value } from "@sinclair/typebox/value";
import { parseHappyUrl } from "@slopus/happy-agent-client";
import { createRootContext, type Context } from "@steve.kite/stdlib";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { AbortModule } from "../../sources/abort/index.js";
import {
    botSettingsMigrations,
    BotSettingsModule,
    DEFAULT_BOT_SETTINGS,
} from "../../sources/botSettings/index.js";
import {
    archiveAgentTool,
    CollaborationModule,
    createAgentTool,
    interruptAgentTool,
    sendMessageTool,
} from "../../sources/collaboration/index.js";
import {
    collaborationCreateInputSchema,
    collaborationSendToolInputSchema,
} from "../../sources/collaboration/CollaborationAgent.js";
import { ComputeModule } from "../../sources/compute/index.js";
import { SecretsModule } from "../../sources/secrets/index.js";
import { HistoryModule } from "../../sources/history/index.js";
import { testConfig } from "../support/computeModule.js";
import { temporaryTestConfig } from "../support/configModule.js";
import { moduleDatabase } from "../support/moduleDatabase.js";
import { resolveModuleHooks } from "../support/moduleHooks.js";

const MODELS: readonly AgentModel[] = [
    {
        providerId: "codex",
        id: "gpt-5.6-sol",
        name: "GPT-5.6 Sol",
        effortLevels: ["low", "medium", "high"],
        defaultEffort: "medium",
        serviceTiers: ["priority"],
    },
    {
        providerId: "claude",
        id: "opus-5",
        name: "Opus 5",
        effortLevels: ["medium", "high"],
        defaultEffort: "medium",
    },
    {
        providerId: "bedrock",
        id: "opus-5",
        name: "Opus 5",
        effortLevels: ["medium"],
        defaultEffort: "medium",
    },
];

interface Delivery {
    readonly toAgentId: string;
    readonly text: string;
    readonly options: Record<string, unknown>;
}

/**
 * A stand-in for the agent collection. It records exactly what the module asked of it, which is
 * the whole contract now that the module keeps no state of its own.
 */
class Collection {
    readonly configs = new Map<string, AgentConfig>();
    readonly parents = new Map<string, string | null>();
    readonly created: Array<{ readonly id: string; readonly parent: string | null }> = [];
    readonly delivered: Delivery[] = [];
    readonly steered: Delivery[] = [];
    readonly aborted: string[] = [];
    createReturnId: string | undefined;
    sendReturnId: string | undefined;
    sendFailure: Error | undefined;
    abortFailure: Error | undefined;

    readonly models = MODELS;

    /** Register an agent that already exists, as the collection would after a restart. */
    seed(id: string, parent: string | null, config: AgentConfig = {}): void {
        this.configs.set(id, config);
        this.parents.set(id, parent);
    }

    async config(_ctx: Context, agentId: string): Promise<AgentConfig | undefined> {
        return this.configs.get(agentId);
    }

    async parentOf(_ctx: Context, agentId: string): Promise<string | null> {
        return this.parents.get(agentId) ?? null;
    }

    async childOf(_ctx: Context, agentId: string): Promise<readonly string[]> {
        return [...this.parents.entries()]
            .filter(([, parent]) => parent === agentId)
            .map(([id]) => id);
    }

    async create(
        _ctx: Context,
        config: AgentConfig,
        options: { readonly id?: string; readonly parent?: string | null },
    ): Promise<{ readonly id: string }> {
        const id = options.id ?? "generated";
        if (this.configs.has(id)) throw new Error(`Agent "${id}" already exists.`);
        this.configs.set(id, config);
        this.parents.set(id, options.parent ?? null);
        this.created.push({ id, parent: options.parent ?? null });
        return { id: this.createReturnId ?? id };
    }

    async send(
        _ctx: Context,
        agentId: string,
        message: { readonly content: readonly { readonly text: string }[] },
        options: Record<string, unknown>,
    ): Promise<AgentMessageAcceptance> {
        if (this.sendFailure !== undefined) throw this.sendFailure;
        this.delivered.push({
            toAgentId: agentId,
            text: message.content[0]!.text,
            options,
        });
        return {
            id: this.sendReturnId ?? (options.id as string),
            delivery: "send",
            accepted: "created",
        };
    }

    async steer(
        _ctx: Context,
        agentId: string,
        message: { readonly content: readonly { readonly text: string }[] },
        options: Record<string, unknown>,
    ): Promise<AgentMessageAcceptance> {
        if (this.sendFailure !== undefined) throw this.sendFailure;
        const delivery = {
            toAgentId: agentId,
            text: message.content[0]!.text,
            options,
        };
        this.delivered.push(delivery);
        this.steered.push(delivery);
        return {
            id: this.sendReturnId ?? (options.id as string),
            delivery: "steer",
            accepted: "created",
        };
    }

    async abort(_ctx: Context, agentId: string): Promise<void> {
        if (this.abortFailure !== undefined) throw this.abortFailure;
        this.aborted.push(agentId);
    }

    async updateMetadata(_ctx: Context, agentId: string, update: AgentMetadata): Promise<void> {
        const config = this.configs.get(agentId);
        if (config === undefined) throw new Error(`Agent "${agentId}" does not exist.`);
        this.configs.set(agentId, { ...config, metadata: { ...config.metadata, ...update } });
    }

    /** The module holds an `AgentSystemRef`; this stub supplies only what it actually calls. */
    asRef(): AgentSystemRef {
        return this as unknown as AgentSystemRef;
    }
}

async function started(
    collection: Collection,
    config = testConfig,
    botSettings?: { readonly module: BotSettingsModule; readonly ctx: Context },
): Promise<{
    module: CollaborationModule;
    hooks: AgentModuleHooks;
    ctx: Context;
    history: HistoryModule;
    releasedMachines: string[];
}> {
    const abort = abortModule();
    vi.spyOn(abort, "abort").mockImplementation(
        async (ctx, agentId) => await collection.abort(ctx, agentId),
    );
    const history = new HistoryModule();
    vi.spyOn(history, "toolSpawnPresentation").mockResolvedValue(undefined);
    vi.spyOn(history, "recordToolSpawnPresentation").mockResolvedValue(undefined);
    const compute = computeModule();
    const releasedMachines: string[] = [];
    vi.spyOn(compute, "archiveAgent").mockImplementation(async (_ctx, agentId) => {
        releasedMachines.push(agentId);
    });
    const module = new CollaborationModule(config, abort, history, compute, botSettings?.module);
    botSettings?.module.beforeStart(botSettings.ctx, collection.asRef());
    const base = botSettings?.ctx ?? createRootContext().named("collaboration-test");
    const ctx = withAgentConfig(base, {
        environment: {
            osVersion: "test",
            platform: "darwin",
            workingDirectory: "/work",
            shell: "/bin/zsh",
        },
        modules: { collaboration: {} },
        metadata: { title: "Parent agent" },
    });
    const resolved = await resolveModuleHooks(ctx, module, collection.asRef());
    // Most tests hand the tools hook only the agent; give it the store it freezes options in.
    const hooks: AgentModuleHooks = {
        ...resolved,
        tools: async (toolCtx, scope) =>
            await resolved.tools!(toolCtx, {
                ...scope,
                kv: scope.kv ?? memoryKV(),
            } as typeof scope),
    };
    return { module, hooks, ctx, history, releasedMachines };
}

function computeModule(): ComputeModule {
    return new ComputeModule(testConfig, new SecretsModule());
}

function abortModule(): AbortModule {
    return new AbortModule(computeModule());
}

/** A stand-in run store; the module only ever keeps one note in it. */
function runScope(agentId: string) {
    const values = new Map<string, unknown>();
    return {
        agent: { id: agentId },
        runKV: {
            read: async (_ctx: Context, key: string) => values.get(key),
            write: async (_ctx: Context, key: string, value: unknown) => {
                values.set(key, value);
            },
        },
    } as never;
}

function textEnd(text: string) {
    return { type: "text_end", block: { type: "text", text } } as never;
}

function settlement(settlementId: string, error?: string) {
    return { loopId: "loop", settlementId, ...(error === undefined ? {} : { error }) } as never;
}

function toolCall(id: string) {
    return {
        id,
        kv: undefined,
        commit: async (_ctx: Context, result: unknown) => result,
    } as never;
}

const TASK = {
    title: "Reviewer",
    model: "gpt-5.6-sol",
    effort: "high",
    text: "Review the parser change.",
} as const;

/** The sending agent a tool is built for, on the Codex route. */
const CREATOR = { provider: "codex", model: undefined } as const;

const NO_CROSS_WORKSPACE_TOML = "[features]\ncross_workspace = false\n";

describe("collaboration", () => {
    it("resolves a subtask's provider once using the same curated collaborator models", async () => {
        const { module } = await started(new Collection());
        expect(module.selectModel(TASK)).toEqual({
            model: TASK.model,
            effort: TASK.effort,
            provider: "codex",
        });
        expect(
            module.selectModel(
                { ...TASK, model: "opus-5" },
                { provider: "claude", model: undefined },
            ),
        ).toMatchObject({
            provider: "claude",
        });
        expect(() => module.selectModel({ ...TASK, model: "opus-5" })).toThrow(
            "Provider is required",
        );
        expect(() => module.selectModel({ ...TASK, model: "unavailable" })).toThrow(
            "not available",
        );
    });

    it("checks archival through the real transactional messaging tool", async () => {
        const collection = new Collection();
        collection.seed("parent", null);
        collection.seed("child", "parent", { metadata: { subtask: true, archivedAt: 1 } });
        const { module, ctx } = await started(collection);
        const tool = sendMessageTool(module, "parent", true, CREATOR);
        expect(tool.transactional).toBe(true);
        expect(
            await tool.shouldReviewInAutoMode(
                { toAgentId: "child", explanation: "Follow-up", text: "Follow up" },
                ctx,
            ),
        ).toBe(false);
        await expect(
            tool.execute(
                ctx,
                { toAgentId: "child", explanation: "Follow-up", text: "Follow up" },
                toolCall("message"),
            ),
        ).rejects.toThrow("archived");
        expect(collection.steered).toEqual([]);
    });

    it("does not revive an archived parent with a settlement report", async () => {
        const collection = new Collection();
        collection.seed("parent", null, { metadata: { archivedAt: 1 } });
        collection.seed("child", "parent");
        const { hooks, ctx } = await started(collection);
        await hooks.afterAgentSettledTransact?.(ctx, runScope("child"), settlement("done"));
        expect(collection.steered).toEqual([]);
    });

    it("creates a collaborator as a child of its creator", async () => {
        const collection = new Collection();
        const { module, hooks, ctx } = await started(collection);

        const result = await module.createAgent(ctx, "parent", TASK, "child");

        expect(result).toEqual({ agentId: "child" });
        expect(collection.created).toEqual([{ id: "child", parent: "parent" }]);
    });

    it("puts the collaborator's name in the agent's real metadata", async () => {
        const collection = new Collection();
        const { module, hooks, ctx } = await started(collection);

        await module.createAgent(ctx, "parent", TASK, "child");

        expect(collection.configs.get("child")?.metadata).toMatchObject({ title: "Reviewer" });
    });

    it("persists resolved model identity before creating the child and adds its ID only after delivery", async () => {
        const collection = new Collection();
        const { module, ctx, history } = await started(collection);
        const writes: unknown[] = [];
        vi.mocked(history.recordToolSpawnPresentation).mockImplementation(
            async (_ctx, agentId, callId, presentation) => {
                expect(agentId).toBe("parent");
                expect(callId).toBe("child");
                if (presentation.agentId === undefined) {
                    expect(collection.created).toEqual([]);
                    expect(collection.delivered).toEqual([]);
                } else {
                    expect(collection.created).toHaveLength(1);
                    expect(collection.delivered).toHaveLength(1);
                }
                writes.push(presentation);
            },
        );
        await module.createToolAgent(
            ctx,
            "parent",
            { ...TASK, title: "Definitely not a model name" },
            "child",
        );
        const model = { modelId: "gpt-5.6-sol", providerId: "codex", name: "GPT-5.6 Sol" };
        expect(writes).toEqual([
            { type: "agent_spawn", model },
            { type: "agent_spawn", model, agentId: "child" },
        ]);
        expect(collection.delivered[0]?.options.provider).toBe(model.providerId);
    });

    it("retains the original catalog name on retry and never confirms failed initial delivery", async () => {
        const collection = new Collection();
        collection.seed("child", "parent");
        collection.sendFailure = new Error("Initial delivery failed");
        const { module, ctx, history } = await started(collection);
        const model = {
            modelId: "gpt-5.6-sol",
            providerId: "codex",
            name: "Original catalog name",
        };
        vi.mocked(history.toolSpawnPresentation).mockResolvedValue({ type: "agent_spawn", model });
        await expect(module.createToolAgent(ctx, "parent", TASK, "child")).rejects.toThrow(
            "Initial delivery failed",
        );
        expect(history.recordToolSpawnPresentation).toHaveBeenCalledExactlyOnceWith(
            ctx,
            "parent",
            "child",
            { type: "agent_spawn", model },
        );
        expect(collection.created).toEqual([]);
    });

    it("does not fabricate resolved identity for unavailable or ambiguous models", async () => {
        const collection = new Collection();
        const { module, ctx, history } = await started(collection);
        await expect(
            module.createToolAgent(ctx, "parent", { ...TASK, model: "unknown" }, "child"),
        ).rejects.toThrow("not available");
        await expect(
            module.createToolAgent(ctx, "parent", { ...TASK, model: "opus-5" }, "child"),
        ).rejects.toThrow("Provider is required");
        expect(history.recordToolSpawnPresentation).not.toHaveBeenCalled();
        expect(collection.created).toEqual([]);
    });

    it("gives a collaborator the machine its creator works on", async () => {
        const collection = new Collection();
        const { module, hooks, ctx } = await started(collection);

        await module.createAgent(ctx, "parent", TASK, "child");

        expect(collection.configs.get("child")?.environment?.workingDirectory).toBe("/work");
        expect(collection.configs.get("child")?.modules).toEqual({ collaboration: {} });
    });

    it("chooses what a collaborator runs on with the message that starts it", async () => {
        const collection = new Collection();
        const { module, hooks, ctx } = await started(collection);

        await module.createAgent(
            ctx,
            "parent",
            { ...TASK, provider: "codex", serviceTier: "priority" },
            "child",
        );

        expect(collection.delivered).toHaveLength(1);
        expect(collection.delivered[0]!.options).toMatchObject({
            model: "gpt-5.6-sol",
            effort: "high",
            provider: "codex",
            serviceTier: "priority",
        });
    });

    it("leaves what a collaborator runs on alone when a later message names no model", async () => {
        const collection = new Collection();
        const { module, hooks, ctx } = await started(collection);
        await module.createAgent(ctx, "parent", TASK, "child");

        await module.sendMessage(
            ctx,
            "parent",
            { toAgentId: "child", text: "One more thing." },
            "m1",
        );

        const followUp = collection.delivered[1]!.options;
        expect(followUp).not.toHaveProperty("model");
        expect(followUp).not.toHaveProperty("effort");
        expect(followUp).not.toHaveProperty("provider");
        expect(followUp).not.toHaveProperty("serviceTier");
        expect(followUp).not.toHaveProperty("permissionMode");
    });

    it("names the sender in the text, because that is the address a reply goes to", async () => {
        const collection = new Collection();
        const { module, hooks, ctx } = await started(collection);
        await module.createAgent(ctx, "parent", TASK, "child");

        expect(collection.delivered[0]!.text).toBe(
            "Message from agent parent:\n\nReview the parser change.",
        );
    });

    it("marks an ordinary delivery with its sender and both endpoints", async () => {
        const collection = new Collection();
        const { module, hooks, ctx } = await started(collection);
        await module.createAgent(ctx, "parent", TASK, "child");

        expect(collection.delivered[0]!.options.metadata).toMatchObject({
            collaboration: { fromAgentId: "parent", toAgentId: "child" },
            senderAgentId: "parent",
        });
    });

    it("explains an opening task with the collaborator's title when it fits on one line", async () => {
        const collection = new Collection();
        const { module, ctx } = await started(collection);
        await module.createAgent(ctx, "parent", { ...TASK, title: "  CSV parser fix  " }, "child");
        await module.createAgent(ctx, "parent", { ...TASK, title: "x".repeat(121) }, "second");
        await module.createAgent(ctx, "parent", { ...TASK, title: "Two\nlines" }, "third");

        expect(collection.delivered[0]!.options.metadata).toMatchObject({
            senderAgentId: "parent",
            senderAgentExplanation: "CSV parser fix",
        });
        for (const delivery of collection.delivered.slice(1)) {
            expect(delivery.options.metadata).not.toHaveProperty("senderAgentExplanation");
        }
    });

    it("delivers under the durable tool call's own identity", async () => {
        const collection = new Collection();
        const { module, hooks, ctx } = await started(collection);

        await module.createAgent(ctx, "parent", TASK, "child");
        await module.sendMessage(ctx, "parent", { toAgentId: "child", text: "Again." }, "call-2");

        expect(collection.delivered.map(({ options }) => options.id)).toEqual(["child", "call-2"]);
    });

    it("does not create a collaborator twice when its durable call is retried", async () => {
        const collection = new Collection();
        const { module, hooks, ctx } = await started(collection);

        await module.createAgent(ctx, "parent", TASK, "child");
        await module.createAgent(ctx, "parent", TASK, "child");

        // Creating again would throw; the retry recognises the identity the collection already
        // holds and only redoes delivery, which Agent Base settles by message ID.
        expect(collection.created).toHaveLength(1);
    });

    it("limits one root tree to five ordinary collaborators", async () => {
        const collection = new Collection();
        collection.seed("c1", "parent");
        collection.seed("c2", "c1");
        collection.seed("c3", "parent");
        collection.seed("c4", "c3");
        collection.seed("c5", "parent");
        const { module, ctx } = await started(collection);

        await expect(module.createToolAgent(ctx, "parent", TASK, "c6")).rejects.toThrow(
            "limited to 5 collaborators",
        );
        expect(collection.created).toHaveLength(0);
        expect(collection.delivered).toHaveLength(0);
    });

    it("allows only one of two concurrent creations to take the final tree slot", async () => {
        const collection = new Collection();
        for (const id of ["c1", "c2", "c3", "c4"]) collection.seed(id, "parent");
        const { module, ctx } = await started(collection);

        const outcomes = await Promise.allSettled([
            module.createToolAgent(ctx, "parent", TASK, "c5"),
            module.createToolAgent(ctx, "parent", TASK, "c6"),
        ]);

        expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
        expect(outcomes.filter(({ status }) => status === "rejected")).toHaveLength(1);
        expect(collection.created).toHaveLength(1);
        expect(collection.delivered).toHaveLength(1);
    });

    it("allows a durable retry after the tree has reached its collaborator limit", async () => {
        const collection = new Collection();
        for (const id of ["child", "c2", "c3", "c4", "c5"]) {
            collection.seed(id, "parent");
        }
        const { module, ctx } = await started(collection);

        await expect(module.createToolAgent(ctx, "parent", TASK, "child")).resolves.toEqual({
            agentId: "child",
        });
        expect(collection.created).toHaveLength(0);
        expect(collection.delivered).toHaveLength(1);
    });

    it("frees a collaborator slot when the creator archives a collaborator that cannot work", async () => {
        const collection = new Collection();
        for (const id of ["c1", "c2", "c3", "c4", "c5"]) collection.seed(id, "parent");
        const { module, ctx } = await started(collection);
        await expect(module.createToolAgent(ctx, "parent", TASK, "c6")).rejects.toThrow(
            "free a place by archiving one that can no longer work with archive_agent",
        );

        await module.archiveAgent(ctx, "parent", "c1");

        await expect(module.createToolAgent(ctx, "parent", TASK, "c6")).resolves.toEqual({
            agentId: "c6",
        });
        expect(collection.created).toEqual([{ id: "c6", parent: "parent" }]);
    });

    it("still counts the collaborators below an archived collaborator", async () => {
        const collection = new Collection();
        collection.seed("c1", "parent", { metadata: { archivedAt: 1 } });
        for (const id of ["c2", "c3", "c4", "c5", "c6"]) collection.seed(id, "c1");
        const { module, ctx } = await started(collection);

        await expect(module.createToolAgent(ctx, "parent", TASK, "c7")).rejects.toThrow(
            "limited to 5 collaborators",
        );
    });

    it("archives a collaborator by stopping it, marking only it archived, and releasing its machine", async () => {
        const collection = new Collection();
        collection.seed("child", "parent", { metadata: { title: "Reviewer", version: 3 } });
        collection.seed("grandchild", "child");
        const { module, ctx, releasedMachines } = await started(collection);

        await module.archiveAgent(ctx, "parent", "child");

        expect(collection.aborted).toEqual(["child"]);
        expect(collection.configs.get("child")?.metadata).toMatchObject({
            title: "Reviewer",
            archivedAt: expect.any(Number),
            version: 4,
        });
        expect(collection.configs.get("grandchild")?.metadata?.["archivedAt"]).toBeUndefined();
        await vi.waitFor(() => expect(releasedMachines).toEqual(["child"]));
        await expect(
            module.sendMessage(ctx, "parent", { toAgentId: "child", text: "Hi." }, "m1"),
        ).rejects.toThrow("archived");
    });

    it("treats a repeated archival as already done while still releasing the machine", async () => {
        const collection = new Collection();
        collection.seed("child", "parent", { metadata: { archivedAt: 1, version: 2 } });
        const { module, ctx, releasedMachines } = await started(collection);

        await module.archiveAgent(ctx, "parent", "child");

        expect(collection.aborted).toEqual([]);
        expect(collection.configs.get("child")?.metadata).toEqual({ archivedAt: 1, version: 2 });
        await vi.waitFor(() => expect(releasedMachines).toEqual(["child"]));
    });

    it("archives only ordinary collaborators the acting agent created", async () => {
        const collection = new Collection();
        collection.seed("child", "parent");
        collection.seed("grandchild", "child");
        collection.seed("stranger", null);
        collection.seed("sub", "parent", { metadata: { subtask: true } });
        collection.seed("flow", "parent", { metadata: { workflow: { runId: "run" } } });
        const { module, ctx, releasedMachines } = await started(collection);

        for (const [acting, target] of [
            ["parent", "grandchild"],
            ["parent", "stranger"],
            ["parent", "missing"],
            ["child", "parent"],
        ] as const) {
            await expect(module.archiveAgent(ctx, acting, target)).rejects.toThrow(
                "may archive only collaborators it created",
            );
        }
        await expect(module.archiveAgent(ctx, "parent", "sub")).rejects.toThrow(
            "use archive_subtask",
        );
        await expect(module.archiveAgent(ctx, "parent", "flow")).rejects.toThrow(
            "belongs to a workflow",
        );
        expect(collection.aborted).toEqual([]);
        expect(releasedMachines).toEqual([]);
    });

    it("limits collaborator depth to three agents including the root", async () => {
        const collection = new Collection();
        collection.seed("child", "root");
        collection.seed("grandchild", "child");
        const { module, ctx } = await started(collection);

        await expect(
            module.createToolAgent(ctx, "grandchild", TASK, "greatgrandchild"),
        ).rejects.toThrow("maximum depth of 3 agents including the root");
        expect(collection.created).toHaveLength(0);
        expect(collection.delivered).toHaveLength(0);
    });

    it("allows a child to create a grandchild at the depth boundary", async () => {
        const collection = new Collection();
        collection.seed("child", "root");
        const { module, ctx } = await started(collection);

        await expect(module.createToolAgent(ctx, "child", TASK, "grandchild")).resolves.toEqual({
            agentId: "grandchild",
        });
        expect(collection.created).toEqual([{ id: "grandchild", parent: "child" }]);
    });

    it("enforces collaborator limits persisted in Happy settings", async () => {
        const config = await temporaryTestConfig(
            [
                "[providers]",
                "default_enable = true",
                "[settings]",
                "max_collaborators = 2",
                "max_collaboration_depth = 2",
            ].join("\n"),
        );
        const countCollection = new Collection();
        countCollection.seed("c1", "root");
        countCollection.seed("c2", "root");
        const {
            module: countModule,
            hooks: countHooks,
            ctx: countCtx,
        } = await started(countCollection, config);

        await expect(countModule.createToolAgent(countCtx, "root", TASK, "c3")).rejects.toThrow(
            "limited to 2 collaborators",
        );
        const [create] = await countHooks.tools!(countCtx, {
            agent: { id: "root", provider: "codex" },
        } as never);
        expect(create!.description).toContain("at most 2 ordinary collaborators");
        expect(create!.description).toContain("maximum depth is 2 agents including the root");

        const depthCollection = new Collection();
        depthCollection.seed("child", "root");
        const { module: depthModule, ctx: depthCtx } = await started(depthCollection, config);

        await expect(
            depthModule.createToolAgent(depthCtx, "child", TASK, "grandchild"),
        ).rejects.toThrow("maximum depth of 2 agents including the root");
    });

    it("leaves direct module creation to the calling module's own limits", async () => {
        const collection = new Collection();
        for (const id of ["c1", "c2", "c3", "c4", "c5"]) {
            collection.seed(id, "root");
        }
        const { module, ctx } = await started(collection);

        await module.createAgent(ctx, "root", TASK, "moduleowned");

        expect(collection.created).toEqual([{ id: "moduleowned", parent: "root" }]);
    });

    it("uses explicit workflow ownership as a separate tool-budget boundary", async () => {
        const collection = new Collection();
        for (const id of ["w1", "w2", "w3", "w4", "w5", "w6"]) {
            collection.seed(id, "root", {
                metadata: { workflow: { runId: "run", callIndex: Number(id.slice(1)) } },
            });
            collection.seed(`${id}child`, id);
        }
        for (const id of ["c1", "c2", "c3", "c4"]) collection.seed(id, "root");
        const { module, ctx } = await started(collection);

        await module.createToolAgent(ctx, "root", TASK, "c5");

        expect(collection.created).toEqual([{ id: "c5", parent: "root" }]);
    });

    it("gives a workflow agent its own tool depth and collaborator budget", async () => {
        const collection = new Collection();
        collection.seed("workflowagent", "root", {
            metadata: { workflow: { runId: "run", callIndex: 0 } },
        });
        const { module, ctx } = await started(collection);

        await module.createToolAgent(ctx, "workflowagent", TASK, "child");
        await module.createToolAgent(ctx, "child", TASK, "grandchild");

        expect(collection.created).toEqual([
            { id: "child", parent: "workflowagent" },
            { id: "grandchild", parent: "child" },
        ]);
        await expect(
            module.createToolAgent(ctx, "grandchild", TASK, "greatgrandchild"),
        ).rejects.toThrow("maximum depth of 3 agents including the root");
    });

    it("does not count a root's subtasks as collaborators", async () => {
        const collection = new Collection();
        for (const id of ["s1", "s2", "s3", "s4", "s5", "s6"]) {
            collection.seed(id, "root", {
                metadata: { subtask: true, ...(id === "s6" ? { archivedAt: 1 } : {}) },
            });
        }
        collection.seed("s1s1", "s1", { metadata: { subtask: true } });
        for (const id of ["c1", "c2", "c3", "c4"]) collection.seed(id, "root");
        const { module, ctx } = await started(collection);

        await module.createToolAgent(ctx, "root", TASK, "c5");

        expect(collection.created).toEqual([{ id: "c5", parent: "root" }]);
        await expect(module.createToolAgent(ctx, "root", TASK, "c6")).rejects.toThrow(
            "limited to 5 collaborators",
        );
    });

    it("shares one tree budget between a task and the collaborators of its subtasks", async () => {
        const config = await temporaryTestConfig(
            ["[providers]", "default_enable = true", "[settings]", "max_collaborators = 2"].join(
                "\n",
            ),
        );
        const collection = new Collection();
        collection.seed("task", null);
        collection.seed("c1", "task");
        collection.seed("sub", "task", { metadata: { subtask: true } });
        collection.seed("subsub", "sub", { metadata: { subtask: true } });
        const { module, ctx } = await started(collection, config);

        await module.createToolAgent(ctx, "subsub", TASK, "s1");

        expect(collection.created).toEqual([{ id: "s1", parent: "subsub" }]);
        for (const [actor, id] of [
            ["task", "c2"],
            ["sub", "s2"],
            ["subsub", "s3"],
        ] as const) {
            await expect(module.createToolAgent(ctx, actor, TASK, id)).rejects.toThrow(
                "limited to 2 collaborators",
            );
        }
        expect(collection.created).toHaveLength(1);
    });

    it("adds no collaborator depth for subtasks", async () => {
        const collection = new Collection();
        collection.seed("task", null);
        collection.seed("sub", "task", { metadata: { subtask: true } });
        collection.seed("subsub", "sub", { metadata: { subtask: true } });
        const { module, ctx } = await started(collection);

        await module.createToolAgent(ctx, "subsub", TASK, "child");
        await module.createToolAgent(ctx, "child", TASK, "grandchild");

        expect(collection.created).toEqual([
            { id: "child", parent: "subsub" },
            { id: "grandchild", parent: "child" },
        ]);
        await expect(
            module.createToolAgent(ctx, "grandchild", TASK, "greatgrandchild"),
        ).rejects.toThrow("maximum depth of 3 agents including the root");
    });

    it("does not treat an existing unrelated identity as a retry", async () => {
        const collection = new Collection();
        collection.seed("child", "other");
        const { module, hooks, ctx } = await started(collection);

        await expect(module.createAgent(ctx, "parent", TASK, "child")).rejects.toThrow(
            'Agent "child" already exists.',
        );
        expect(collection.delivered).toHaveLength(0);
    });

    it("propagates a collaborator creation identity mismatch without delivering its task", async () => {
        const collection = new Collection();
        collection.createReturnId = "different";
        const { module, hooks, ctx } = await started(collection);

        await expect(module.createAgent(ctx, "parent", TASK, "child")).rejects.toThrow(
            "did not preserve the requested collaborator ID",
        );
        expect(collection.created).toEqual([{ id: "child", parent: "parent" }]);
        expect(collection.delivered).toHaveLength(0);
    });

    it("propagates a message identity mismatch after the delivery attempt", async () => {
        const collection = new Collection();
        collection.seed("child", "parent");
        collection.sendReturnId = "different";
        const { module, hooks, ctx } = await started(collection);

        await expect(
            module.sendMessage(ctx, "parent", { toAgentId: "child", text: "Again." }, "m2"),
        ).rejects.toThrow("did not preserve the requested message ID");
        expect(collection.delivered).toHaveLength(1);
    });

    it("does not hide a recipient send failure", async () => {
        const collection = new Collection();
        collection.seed("child", "parent");
        collection.sendFailure = new Error("recipient storage unavailable");
        const { module, hooks, ctx } = await started(collection);

        await expect(
            module.sendMessage(ctx, "parent", { toAgentId: "child", text: "Again." }, "m2"),
        ).rejects.toThrow("recipient storage unavailable");
        expect(collection.delivered).toHaveLength(0);
    });

    it("does not hide an interrupt failure", async () => {
        const collection = new Collection();
        collection.seed("child", "parent");
        collection.abortFailure = new Error("abort unavailable");
        const { module, hooks, ctx } = await started(collection);

        await expect(module.interruptAgent(ctx, "parent", "child")).rejects.toThrow(
            "abort unavailable",
        );
        expect(collection.aborted).toHaveLength(0);
    });

    it("refuses a model the collection does not offer", async () => {
        const collection = new Collection();
        const { module, hooks, ctx } = await started(collection);

        await expect(
            module.createAgent(ctx, "parent", { ...TASK, model: "imaginary" }, "child"),
        ).rejects.toThrow('Model "imaginary" is not available for collaborators.');
        expect(collection.created).toHaveLength(0);
    });

    it("offers and accepts only models allowed for subagents by provider configuration", async () => {
        const config = await temporaryTestConfig(
            [
                "[providers.codex]",
                "enabled = true",
                'include_subagent_models = ["gpt-5.6-sol"]',
                'exclude_subagent_models = ["gpt-5.6-sol"]',
                "",
                "[providers.claude]",
                "enabled = true",
                'include_subagent_models = ["opus-5"]',
                "",
                "[providers.bedrock]",
                "enabled = true",
                "include_subagent_models = []",
            ].join("\n"),
        );
        const collection = new Collection();
        const { module, hooks, ctx } = await started(collection, config);
        const tools = await hooks.tools!(ctx, {
            agent: { id: "parent", provider: "claude" },
        } as never);
        const listed = module
            .agentOptions({ provider: "claude", model: undefined })
            .harnesses.flatMap((harness) => harness.providers)
            .map((provider) => `${provider.id}: ${provider.models.map((m) => m.id).join(" ")}`);

        expect(listed).toContain("claude: opus-5");
        expect(listed.join("\n")).not.toContain("gpt-5.6-sol");
        expect(listed.join("\n")).not.toContain("bedrock");
        expect(tools.some((tool) => tool.name === "agent_options")).toBe(true);
        await expect(module.createAgent(ctx, "parent", TASK, "blockedchild")).rejects.toThrow(
            'Model "gpt-5.6-sol" is not available for collaborators.',
        );
        await expect(
            module.createAgent(
                ctx,
                "parent",
                { ...TASK, model: "opus-5", effort: "medium", provider: "claude" },
                "allowedchild",
            ),
        ).resolves.toEqual({ agentId: "allowedchild" });
        expect(collection.created).toEqual([{ id: "allowedchild", parent: "parent" }]);
    });

    it("refuses an effort the chosen model does not support", async () => {
        const collection = new Collection();
        const { module, hooks, ctx } = await started(collection);

        await expect(
            module.createAgent(
                ctx,
                "parent",
                { ...TASK, effort: "low", model: "opus-5", provider: "claude" },
                "child",
            ),
        ).rejects.toThrow('Effort "low" is not available for collaborator model "opus-5".');
    });

    it("asks for a provider when a model name alone is ambiguous", async () => {
        const collection = new Collection();
        const { module, hooks, ctx } = await started(collection);

        await expect(
            module.createAgent(ctx, "parent", { ...TASK, model: "opus-5" }, "child"),
        ).rejects.toThrow("available from more than one provider");
    });

    it("uses the creator's current provider when an ambiguous model omits one", async () => {
        const collection = new Collection();
        const { hooks, ctx } = await started(collection);
        const tools = await hooks.tools!(ctx, {
            agent: { id: "parent", provider: "claude" },
        } as never);
        const create = tools.find((tool) => tool.name === "create_agent");
        if (create === undefined) throw new Error("The create_agent tool was not offered.");

        await create.execute(
            ctx,
            { ...TASK, model: "opus-5", effort: "medium" },
            toolCall("currentproviderchild"),
        );

        expect(collection.delivered[0]!.options).toMatchObject({
            model: "opus-5",
            effort: "medium",
            provider: "claude",
        });
    });

    it("refuses a service tier the chosen model does not offer", async () => {
        const collection = new Collection();
        const { module, hooks, ctx } = await started(collection);

        await expect(
            module.createAgent(
                ctx,
                "parent",
                { ...TASK, model: "opus-5", provider: "claude", serviceTier: "priority" },
                "child",
            ),
        ).rejects.toThrow('Service tier "priority" is not available');
    });

    it("resolves the provider of an unambiguous model and records it as the collaborator's mode", async () => {
        const collection = new Collection();
        const { module, hooks, ctx } = await started(collection);

        await module.createAgent(ctx, "parent", TASK, "child");

        // The opening task is the collaborator's first message, so what it selected is the
        // mode a person joining a user-visible collaborator composes on top of.
        const mode = {
            effort: "high",
            modelId: "gpt-5.6-sol",
            permissionMode: "auto",
            providerId: "codex",
            serviceTier: null,
        };
        expect(collection.delivered[0]!.options).toMatchObject({
            model: "gpt-5.6-sol",
            effort: "high",
            provider: "codex",
            permissionMode: "auto",
            metadata: expect.objectContaining({ mode }),
        });
        expect(collection.configs.get("child")?.metadata?.["lastMode"]).toEqual(mode);
    });

    it("refuses a provider that does not expose the requested model", async () => {
        const collection = new Collection();
        const { module, hooks, ctx } = await started(collection);

        await expect(
            module.createAgent(ctx, "parent", { ...TASK, provider: "claude" }, "child"),
        ).rejects.toThrow('Model "gpt-5.6-sol" is not available from provider "claude".');
        expect(collection.created).toHaveLength(0);
        expect(collection.delivered).toHaveLength(0);
    });

    it("rejects malformed public inputs without touching the agent collection", async () => {
        const collection = new Collection();
        const { module, hooks, ctx } = await started(collection);

        await expect(module.createAgent(ctx, "PARENT", TASK, "child")).rejects.toThrow(
            "Invalid collaboration acting agent ID.",
        );
        await expect(module.createAgent(ctx, "parent", TASK, "Child")).rejects.toThrow(
            "Invalid collaboration collaborator ID.",
        );
        await expect(
            module.createAgent(ctx, "parent", { ...TASK, text: "" }, "child"),
        ).rejects.toThrow("Invalid collaboration create agent.");
        await expect(
            module.createAgent(ctx, "parent", { ...TASK, unexpected: true } as never, "child"),
        ).rejects.toThrow("Invalid collaboration create agent.");

        expect(collection.created).toHaveLength(0);
        expect(collection.delivered).toHaveLength(0);
    });

    it("rejects malformed message and interrupt inputs before authorization", async () => {
        const collection = new Collection();
        const { module, hooks, ctx } = await started(collection);

        await expect(
            module.sendMessage(ctx, "PARENT", { toAgentId: "child", text: "Hi." }, "m1"),
        ).rejects.toThrow("Invalid collaboration acting agent ID.");
        await expect(
            module.sendMessage(ctx, "parent", { toAgentId: "C", text: "Hi." }, "m1"),
        ).rejects.toThrow("Invalid collaboration send message.");
        await expect(
            module.sendMessage(ctx, "parent", { toAgentId: "child", text: "" }, "m1"),
        ).rejects.toThrow("Invalid collaboration send message.");
        await expect(module.interruptAgent(ctx, "PARENT", "child")).rejects.toThrow(
            "Invalid collaboration acting agent ID.",
        );
        await expect(module.interruptAgent(ctx, "parent", "C")).rejects.toThrow(
            "Invalid collaboration target agent ID.",
        );

        expect(collection.delivered).toHaveLength(0);
        expect(collection.aborted).toHaveLength(0);
    });

    it("lets a collaborator answer the agent that created it", async () => {
        const collection = new Collection();
        const { module, hooks, ctx } = await started(collection);
        await module.createAgent(ctx, "parent", TASK, "child");

        await module.sendMessage(ctx, "child", { toAgentId: "parent", text: "Done." }, "m1");

        expect(collection.delivered[1]).toMatchObject({
            toAgentId: "parent",
            text: "Message from agent child:\n\nDone.",
        });
        expect(collection.steered).toEqual([collection.delivered[1]]);
    });

    it("steers a creator's follow-up into its collaborator", async () => {
        const collection = new Collection();
        const { module, hooks, ctx } = await started(collection);
        await module.createAgent(ctx, "parent", TASK, "child");

        await module.sendMessage(
            ctx,
            "parent",
            { toAgentId: "child", text: "Please also check Windows." },
            "m1",
        );

        expect(collection.delivered[1]).toMatchObject({
            toAgentId: "child",
            text: "Message from agent parent:\n\nPlease also check Windows.",
        });
        expect(collection.steered).toEqual([collection.delivered[1]]);
    });

    it("refuses a message between agents with no relationship", async () => {
        const config = await temporaryTestConfig(NO_CROSS_WORKSPACE_TOML);
        const collection = new Collection();
        collection.seed("child", "parent");
        collection.seed("stranger", null);
        const { module, hooks, ctx } = await started(collection, config);

        await expect(
            module.sendMessage(ctx, "child", { toAgentId: "stranger", text: "Hello." }, "m1"),
        ).rejects.toThrow('Agent "child" is not authorized to send to agent "stranger".');
    });

    it("lets an agent message an unrelated agent by ID when cross-workspace access is enabled", async () => {
        const collection = new Collection();
        collection.seed("sender", null);
        collection.seed("recipient", null);
        const { module, ctx } = await started(collection);

        await module.sendMessage(
            ctx,
            "sender",
            { toAgentId: "recipient", text: "Coordinate across workspaces." },
            "crossworkspacemessage",
        );

        expect(collection.steered).toContainEqual(
            expect.objectContaining({
                text: "Message from agent sender:\n\nCoordinate across workspaces.",
                toAgentId: "recipient",
            }),
        );
    });

    it("rejects an unknown Agent ID even when cross-workspace access is enabled", async () => {
        const collection = new Collection();
        collection.seed("sender", null);
        const { module, ctx } = await started(collection);

        await expect(
            module.sendMessage(
                ctx,
                "sender",
                { toAgentId: "missing", text: "Are you there?" },
                "unknownrecipient",
            ),
        ).rejects.toThrow('Agent "missing" does not exist.');
        expect(collection.delivered).toHaveLength(0);
    });

    it("keeps the agents of a bot that restricts reach to the bot's own tree", async () => {
        const database = moduleDatabase(botSettingsMigrations, "collaboration-bot-reach");
        await database.ready;
        try {
            const botSettings = new BotSettingsModule();
            const collection = new Collection();
            collection.seed("botagent", null);
            collection.seed("child", "botagent");
            collection.seed("grandchild", "child");
            collection.seed("stranger", null);
            const { module, hooks, ctx } = await started(collection, testConfig, {
                module: botSettings,
                ctx: database.context,
            });
            await botSettings.write(ctx, "botagent", {
                ...DEFAULT_BOT_SETTINGS,
                crossWorkspace: false,
            });

            await expect(
                module.sendMessage(ctx, "grandchild", { toAgentId: "stranger", text: "Hi." }, "m1"),
            ).rejects.toThrow(
                "This bot's settings let agent \"grandchild\" message only the bot's own agents",
            );
            // Inside the bot's tree, agents still reach one another by ID.
            await module.sendMessage(
                ctx,
                "grandchild",
                { toAgentId: "botagent", text: "Done." },
                "m2",
            );
            await module.sendMessage(ctx, "child", { toAgentId: "grandchild", text: "Go." }, "m3");
            // The restriction is the bot's own reach; an agent it does not govern may write in.
            await module.sendMessage(ctx, "stranger", { toAgentId: "child", text: "Hello." }, "m4");
            expect(collection.delivered.map((delivery) => delivery.toAgentId)).toEqual([
                "botagent",
                "grandchild",
                "child",
            ]);

            const instructions = await hooks.instructions!(ctx, {
                agent: { id: "child" },
            } as never);
            expect(instructions).not.toContain("Cross-workspace agent messaging is enabled");
            const tools = await hooks.tools!(ctx, {
                agent: { id: "child", provider: "codex" },
            } as never);
            expect(
                tools.find((tool) => tool.name === "send_agent_message")?.description,
            ).not.toContain("any existing agent by its Agent ID");
            await expect(
                hooks.instructions!(ctx, { agent: { id: "stranger" } } as never),
            ).resolves.toContain("Cross-workspace agent messaging is enabled");
        } finally {
            database.close();
        }
    });

    it("never widens reach past the installation setting for a bot that allows it", async () => {
        const database = moduleDatabase(botSettingsMigrations, "collaboration-bot-narrow-only");
        await database.ready;
        try {
            const config = await temporaryTestConfig(NO_CROSS_WORKSPACE_TOML);
            const botSettings = new BotSettingsModule();
            const collection = new Collection();
            collection.seed("botagent", null);
            collection.seed("child", "botagent");
            collection.seed("stranger", null);
            const { module, hooks, ctx } = await started(collection, config, {
                module: botSettings,
                ctx: database.context,
            });
            await botSettings.write(ctx, "botagent", {
                ...DEFAULT_BOT_SETTINGS,
                allowedSecretIds: [],
            });

            await expect(
                module.sendMessage(ctx, "child", { toAgentId: "stranger", text: "Hi." }, "m1"),
            ).rejects.toThrow('Agent "child" is not authorized to send to agent "stranger".');
            await expect(
                hooks.instructions!(ctx, { agent: { id: "child" } } as never),
            ).resolves.not.toContain("Cross-workspace agent messaging is enabled");
        } finally {
            database.close();
        }
    });

    it("refuses sibling and grandchild messages because authorization is direct ancestry only", async () => {
        const config = await temporaryTestConfig(NO_CROSS_WORKSPACE_TOML);
        const collection = new Collection();
        collection.seed("child", "parent");
        collection.seed("sibling", "parent");
        collection.seed("grandchild", "sibling");
        const { module, hooks, ctx } = await started(collection, config);

        await expect(
            module.sendMessage(ctx, "child", { toAgentId: "sibling", text: "Hello." }, "m1"),
        ).rejects.toThrow("is not authorized to send");
        await expect(
            module.sendMessage(ctx, "parent", { toAgentId: "grandchild", text: "Hello." }, "m2"),
        ).rejects.toThrow("is not authorized to send");
        expect(collection.delivered).toHaveLength(0);
    });

    it("interrupts a collaborator it created", async () => {
        const collection = new Collection();
        const { module, hooks, ctx } = await started(collection);
        await module.createAgent(ctx, "parent", TASK, "child");

        await module.interruptAgent(ctx, "parent", "child");

        expect(collection.aborted).toEqual(["child"]);
    });

    it("refuses to interrupt an agent it has no relationship with", async () => {
        const collection = new Collection();
        collection.seed("stranger", null);
        const { module, hooks, ctx } = await started(collection);

        await expect(module.interruptAgent(ctx, "parent", "stranger")).rejects.toThrow(
            "is not authorized to interrupt",
        );
        expect(collection.aborted).toEqual([]);
    });

    it("tells a collaborator the address to answer on", async () => {
        const collection = new Collection();
        const { module, hooks, ctx } = await started(collection);
        await module.createAgent(ctx, "parent", TASK, "child");

        // The sender's name is in the delivered message too, but that line ages out of history on
        // compaction while the relationship does not.
        const instructions = await hooks.instructions!(ctx, {
            agent: { id: "child" },
        } as never);

        expect(instructions).toContain("created by agent parent");
        expect(instructions).toContain("send_agent_message");
    });

    it("tells an unreported agent that its creator hears from it only through messages", async () => {
        const collection = new Collection();
        const { module, hooks, ctx } = await started(collection);
        collection.seed("conversation", "parent", { metadata: module.unreportedAgentMetadata() });

        const instructions = await hooks.instructions!(ctx, {
            agent: { id: "conversation", metadata: module.unreportedAgentMetadata() },
        } as never);

        expect(instructions).toContain(
            "You were created by agent parent. What you say is not reported to it automatically; use send_agent_message when it needs to hear from you.",
        );
        expect(instructions).not.toContain("reported to it automatically, so finish");
    });

    it("tells an agent which collaborators it created", async () => {
        const collection = new Collection();
        const { module, hooks, ctx } = await started(collection);
        await module.createAgent(ctx, "parent", TASK, "child");

        const instructions = await hooks.instructions!(ctx, {
            agent: { id: "parent" },
        } as never);

        expect(instructions).toContain("Collaborators you created: child.");
    });

    it("includes both creator and collaborator addresses in deterministic instruction order", async () => {
        const config = await temporaryTestConfig(NO_CROSS_WORKSPACE_TOML);
        const collection = new Collection();
        collection.seed("sibling", "parent");
        collection.seed("child", "parent");
        const { module, hooks, ctx } = await started(collection, config);

        const instructions = await hooks.instructions!(ctx, {
            agent: { id: "parent" },
        } as never);

        expect(instructions.split("\n")).toEqual([
            "Your Agent ID is parent.",
            expect.stringContaining("happy://agents/parent/files/"),
            "Collaborators you created: sibling, child. Each reports back on its own when it finishes; nothing waits for them.",
        ]);
    });

    it("always tells an agent its own Agent ID", async () => {
        const config = await temporaryTestConfig(NO_CROSS_WORKSPACE_TOML);
        const collection = new Collection();
        const { module, hooks, ctx } = await started(collection, config);

        const instructions = await hooks.instructions!(ctx, { agent: { id: "lonely" } } as never);
        expect(instructions.split("\n")[0]).toBe("Your Agent ID is lonely.");
    });

    it("tells an agent to link files that are read outside its own chat through its Agent ID", async () => {
        const config = await temporaryTestConfig(NO_CROSS_WORKSPACE_TOML);
        const { hooks, ctx } = await started(new Collection(), config);

        const instructions = await hooks.instructions!(ctx, { agent: { id: "a1b2" } } as never);

        expect(instructions).toContain(
            "link it as [Foo.tsx:42](happy://agents/a1b2/files/<path from your workspace root>#L42-L50)",
        );
        expect(instructions).toContain(
            "Copy happy:// and happy-file:// links you receive unchanged.",
        );
        expect(instructions).toContain("Otherwise keep writing path:line.");
        // The example the model copies, with its path filled in, is a link the shared parser accepts.
        const example = /\(happy:\/\/[^)]*\)/.exec(instructions)?.[0].slice(1, -1) ?? "";
        expect(
            parseHappyUrl(
                example.replace("<path from your workspace root>", "packages/app/Foo.tsx"),
            ),
        ).toEqual({
            type: "file",
            file: {
                target: { type: "agent", agentId: "a1b2" },
                path: "packages/app/Foo.tsx",
                lines: { start: 42, end: 50 },
            },
        });
    });

    it("explains Agent-ID messaging when cross-workspace access is enabled", async () => {
        const collection = new Collection();
        const { hooks, ctx } = await started(collection);

        const instructions = await hooks.instructions!(ctx, {
            agent: { id: "sender" },
        } as never);

        expect(instructions).toContain("Your Agent ID is sender.");
        expect(instructions).toContain("Cross-workspace agent messaging is enabled");
        expect(instructions).toContain("send_agent_message");
        expect(instructions).toContain("Agent IDs are unguessable");

        const tools = await hooks.tools!(ctx, {
            agent: { id: "sender", provider: "codex" },
        } as never);
        expect(tools.find((tool) => tool.name === "send_agent_message")?.description).toContain(
            "any existing agent by its Agent ID",
        );
    });

    it("reports a collaborator's last words to its creator when it stops working", async () => {
        const collection = new Collection();
        const { module, hooks, ctx } = await started(collection);
        await module.createAgent(ctx, "parent", TASK, "child");
        const scope = runScope("child");

        await hooks.onEventTransact!(ctx, scope, textEnd("The parser change looks correct."));
        await hooks.afterAgentSettledTransact!(ctx, scope, settlement("s1"));

        expect(collection.delivered[1]).toMatchObject({
            toAgentId: "parent",
            text: "Collaborator child finished working. Its answer follows, verbatim.\n\nThe parser change looks correct.",
        });
        expect(collection.steered).toHaveLength(1);
    });

    it("does not report an interrupted collaborator's last words to its creator", async () => {
        const collection = new Collection();
        const { module, hooks, ctx } = await started(collection);
        await module.createAgent(ctx, "parent", TASK, "child");
        const scope = runScope("child");

        await hooks.onEventTransact!(ctx, scope, textEnd("Still investigating."));
        await hooks.afterTurnTransact!(ctx, scope, {
            aborted: true,
            contextTokens: 10,
            loopId: "loop",
            turnId: "turn",
        });
        await hooks.afterAgentSettledTransact!(ctx, scope, settlement("s1"));

        expect(collection.delivered).toHaveLength(1);
        expect(collection.steered).toHaveLength(0);
    });

    it("marks the report so it can be shown as a notice rather than as someone talking", async () => {
        const collection = new Collection();
        const { module, hooks, ctx } = await started(collection);
        await module.createAgent(ctx, "parent", TASK, "child");
        const scope = runScope("child");

        await hooks.onEventTransact!(ctx, scope, textEnd("Done."));
        await hooks.afterAgentSettledTransact!(ctx, scope, settlement("s1"));

        expect(collection.delivered[1]!.options.metadata).toEqual({
            collaboration: {
                kind: "subagent_report",
                fromAgentId: "child",
                toAgentId: "parent",
            },
            senderAgentId: "child",
            senderAgentExplanation: "Finished: final answer",
        });
    });

    it("reports when the collaborator stopped without answering", async () => {
        const collection = new Collection();
        const { module, hooks, ctx } = await started(collection);
        await module.createAgent(ctx, "parent", TASK, "child");
        const scope = runScope("child");

        // A hard stop can resume settlement in a later process that no longer knows the original
        // error. The creator must still learn that no answer is coming.
        await hooks.afterAgentSettledTransact!(ctx, scope, settlement("s1"));

        expect(collection.delivered).toHaveLength(2);
        expect(collection.delivered[1]!.text).toBe("Collaborator child stopped without answering.");
    });

    it("reports why a collaborator stopped when it failed before answering", async () => {
        const collection = new Collection();
        const { module, hooks, ctx } = await started(collection);
        await module.createAgent(ctx, "parent", TASK, "child");
        const scope = runScope("child");

        // A provider error ends the run without a single text_end, and the settlement carries why.
        // Nothing waits for a collaborator, so a silent settlement here would leave the creator
        // expecting an answer that can never arrive.
        await hooks.afterAgentSettledTransact!(
            ctx,
            scope,
            settlement("s1", "You've hit your Codex usage limit."),
        );

        expect(collection.delivered).toHaveLength(2);
        expect(collection.delivered[1]!.text).toBe(
            "Collaborator child stopped without answering. It failed with, verbatim.\n\nYou've hit your Codex usage limit.",
        );
    });

    it("reports what a collaborator said when it recovered from an earlier failure", async () => {
        const collection = new Collection();
        const { module, hooks, ctx } = await started(collection);
        await module.createAgent(ctx, "parent", TASK, "child");
        const scope = runScope("child");

        // A run that recovered settles without a failure, whatever it survived on the way.
        await hooks.onEventTransact!(ctx, scope, textEnd("Final answer."));
        await hooks.afterAgentSettledTransact!(ctx, scope, settlement("s1"));

        expect(collection.delivered[1]!.text).toContain("Final answer.");
    });

    it("says why a run stopped even when the failure had no words of its own", async () => {
        const collection = new Collection();
        const { module, hooks, ctx } = await started(collection);
        await module.createAgent(ctx, "parent", TASK, "child");
        const scope = runScope("child");

        await hooks.afterAgentSettledTransact!(ctx, scope, settlement("s1", "   "));

        expect(collection.delivered[1]!.text).toBe(
            "Collaborator child stopped without answering. It failed with, verbatim.\n\nThe model did not answer.",
        );
    });

    it("reports a stopped run even when no failure reason survived", async () => {
        const collection = new Collection();
        const { module, hooks, ctx } = await started(collection);
        await module.createAgent(ctx, "parent", TASK, "child");
        const scope = runScope("child");

        await hooks.afterAgentSettledTransact!(ctx, scope, settlement("s1"));

        expect(collection.delivered[1]!.text).toBe("Collaborator child stopped without answering.");
    });

    it("reports under the settlement's identity, so a retry is not a second report", async () => {
        const collection = new Collection();
        const { module, hooks, ctx } = await started(collection);
        await module.createAgent(ctx, "parent", TASK, "child");
        const scope = runScope("child");

        await hooks.onEventTransact!(ctx, scope, textEnd("Done."));
        await hooks.afterAgentSettledTransact!(ctx, scope, settlement("s1"));

        expect(collection.delivered[1]!.options.id).toBe("s1");
    });

    it("says nothing upward when the agent that stopped has no creator", async () => {
        const collection = new Collection();
        const { module, hooks, ctx } = await started(collection);
        const scope = runScope("root");

        await hooks.onEventTransact!(ctx, scope, textEnd("All done."));
        await hooks.afterAgentSettledTransact!(ctx, scope, settlement("s1"));

        expect(collection.delivered).toHaveLength(0);
    });

    it("keeps only the most recent thing the model said", async () => {
        const collection = new Collection();
        const { module, hooks, ctx } = await started(collection);
        await module.createAgent(ctx, "parent", TASK, "child");
        const scope = runScope("child");

        await hooks.onEventTransact!(ctx, scope, textEnd("Thinking out loud."));
        await hooks.onEventTransact!(ctx, scope, textEnd("Final answer."));
        await hooks.afterAgentSettledTransact!(ctx, scope, settlement("s1"));

        expect(collection.delivered[1]!.text).toContain("Final answer.");
        expect(collection.delivered[1]!.text).not.toContain("Thinking out loud.");
    });

    it("trims a completed text block and ignores unrelated persisted events", async () => {
        const collection = new Collection();
        const { module, hooks, ctx } = await started(collection);
        await module.createAgent(ctx, "parent", TASK, "child");
        const scope = runScope("child");

        await hooks.onEventTransact!(ctx, scope, {
            type: "text_delta",
            delta: "ignored",
        } as never);
        await hooks.onEventTransact!(ctx, scope, textEnd(" \n  Final answer with padding. \t "));
        await hooks.afterAgentSettledTransact!(ctx, scope, settlement("s1"));

        expect(collection.delivered[1]!.text).toContain("Final answer with padding.");
        expect(collection.delivered[1]!.text).not.toContain("padding. \t");
    });

    it("treats a non-string or blank run-store value as a missing answer", async () => {
        const collection = new Collection();
        const { module, hooks, ctx } = await started(collection);
        await module.createAgent(ctx, "parent", TASK, "child");

        const nonString = {
            agent: { id: "child" },
            runKV: { read: async () => 123 },
        } as never;
        await hooks.afterAgentSettledTransact!(ctx, nonString, settlement("s1"));
        expect(collection.delivered[1]!.text).toBe("Collaborator child stopped without answering.");

        const blank = {
            agent: { id: "child" },
            runKV: { read: async () => " \n\t " },
        } as never;
        await expect(
            hooks.afterAgentSettledTransact!(ctx, blank, settlement("s2")),
        ).resolves.toBeUndefined();
        expect(collection.delivered[2]!.text).toBe("Collaborator child stopped without answering.");
    });

    it("does not read run state for an agent with no creator", async () => {
        const collection = new Collection();
        const { module, hooks, ctx } = await started(collection);
        let reads = 0;
        const scope = {
            agent: { id: "root" },
            runKV: {
                read: async () => {
                    reads += 1;
                    throw new Error("run state should not be read");
                },
            },
        } as never;

        await hooks.afterAgentSettledTransact!(ctx, scope, settlement("s1"));

        expect(reads).toBe(0);
        expect(collection.delivered).toHaveLength(0);
    });

    it("propagates a failure delivering a settlement report", async () => {
        const collection = new Collection();
        const { module, hooks, ctx } = await started(collection);
        await module.createAgent(ctx, "parent", TASK, "child");
        const scope = runScope("child");
        await hooks.onEventTransact!(ctx, scope, textEnd("Done."));
        collection.sendFailure = new Error("parent inbox unavailable");

        await expect(
            hooks.afterAgentSettledTransact!(ctx, scope, settlement("s1")),
        ).rejects.toThrow("parent inbox unavailable");
    });

    it("exposes the fixed five-tool surface with the intended durability and review policy", async () => {
        const collection = new Collection();
        const { module, hooks, ctx } = await started(collection);
        const tools = await hooks.tools!(ctx, { agent: { id: "parent" } } as never);

        expect(tools.map((tool) => tool.name)).toEqual([
            "create_agent",
            "agent_options",
            "send_agent_message",
            "interrupt_agent",
            "archive_agent",
        ]);
        expect(tools.map((tool) => tool.durable)).toEqual([true, false, true, false, true]);
        expect(tools.map((tool) => tool.requiresAutoOrFullAccess)).toEqual([
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
        ]);
    });

    it("archives through the real transactional tool and keeps it reviewable", async () => {
        const collection = new Collection();
        collection.seed("child", "parent");
        const { module, ctx } = await started(collection);
        const archive = archiveAgentTool(module, "parent");

        expect(archive.transactional).toBe(true);
        expect(archive.shouldReviewInAutoMode({ targetAgentId: "child" }, ctx)).toBe(true);
        expect(archive.shouldRunInFullAccessInAutoMode).toBeUndefined();
        expect(archive.describeAutoPermissionAction!({ targetAgentId: "child" }, ctx)).toContain(
            '"child"',
        );
        await expect(
            archive.execute(ctx, { targetAgentId: "child" }, toolCall("archive")),
        ).resolves.toBeUndefined();
        expect(collection.configs.get("child")?.metadata?.["archivedAt"]).toEqual(
            expect.any(Number),
        );
        expect(archive.toLLM(undefined)).toEqual([
            {
                type: "text",
                text: "Archived the collaborator. Its place in the collaborator limit is free, its conversation history is preserved, and running descendants were stopped, not archived.",
            },
        ]);
    });

    it("describes the offered model/provider pairs without a dynamic capacity lookup", () => {
        const module = new CollaborationModule(
            testConfig,
            abortModule(),
            new HistoryModule(),
            computeModule(),
        );
        const create = createAgentTool(
            module,
            "parent",
            { provider: "codex", model: undefined },
            "auto",
            "OPTIONS-LISTING",
            5,
            3,
        );
        // The listing is whatever was frozen for the agent; the description never looks it up.
        expect(create.description).toContain("\n\nOPTIONS-LISTING\n\nCall agent_options");
        expect(create.description).toContain("at most 5 ordinary collaborators");
        expect(create.description).toContain("maximum depth is 3 agents including the root");
        expect(create.description).toContain(
            "Subtasks belong to the tree but count toward neither limit; collaborators they create do count.",
        );
        expect(create.description).toContain("substantial, distinct workstreams");
        expect(create.description).toContain("changes across projects");
        expect(create.description).toContain("small steps inline");
        expect(create.description).toContain(
            "Usually create second-level subtasks only on explicit user request.",
        );
    });

    it("keeps send and create routine while interrupt remains reviewable", async () => {
        const collection = new Collection();
        const { module, hooks, ctx } = await started(collection);
        const create = createAgentTool(
            module,
            "parent",
            { provider: "codex", model: undefined },
            "auto",
            "OPTIONS-LISTING",
            5,
            3,
        );
        const send = sendMessageTool(module, "parent", false, CREATOR);
        const interrupt = interruptAgentTool(module, "parent");

        expect(create.shouldReviewInAutoMode(TASK, ctx)).toBe(false);
        expect(
            send.shouldReviewInAutoMode(
                { toAgentId: "child", explanation: "Greeting", text: "Hi." },
                ctx,
            ),
        ).toBe(false);
        expect(interrupt.shouldReviewInAutoMode({ targetAgentId: "child" }, ctx)).toBe(true);
        expect(interrupt.shouldRunInFullAccessInAutoMode).toBeUndefined();
        expect(interrupt.describeAutoPermissionAction!({ targetAgentId: "child" }, ctx)).toContain(
            '"child"',
        );
    });

    it("routes tool execution through the public operations and renders complete model results", async () => {
        const collection = new Collection();
        const { module, hooks, ctx } = await started(collection);
        const create = createAgentTool(
            module,
            "parent",
            { provider: "codex", model: undefined },
            "auto",
            "OPTIONS-LISTING",
            5,
            3,
        );
        const send = sendMessageTool(module, "parent", false, CREATOR);
        const interrupt = interruptAgentTool(module, "parent");

        await expect(create.execute(ctx, TASK, toolCall("created"))).resolves.toEqual({
            agentId: "created",
        });
        await expect(
            send.execute(
                ctx,
                { toAgentId: "created", explanation: "Follow-up", text: "Follow up." },
                toolCall("message"),
            ),
        ).resolves.toBeUndefined();
        await expect(
            interrupt.execute(ctx, { targetAgentId: "created" }, toolCall("interrupt")),
        ).resolves.toBeUndefined();

        expect(collection.created).toEqual([{ id: "created", parent: "parent" }]);
        expect(collection.delivered.map(({ options }) => options.id)).toEqual([
            "created",
            "message",
        ]);
        expect(collection.aborted).toEqual(["created"]);
        expect(create.toLLM({ agentId: "created" })).toEqual([
            {
                type: "text",
                text: "Created collaborator created and sent it the task. Anything it has to say will arrive as a message; nothing is waiting on it.",
            },
        ]);
        expect(send.toLLM(undefined)).toEqual([
            {
                type: "text",
                text: "Message delivered. Any answer arrives as a message; carry on with other work in the meantime.",
            },
        ]);
        expect(interrupt.toLLM(undefined)).toEqual([
            {
                type: "text",
                text: "Aborted the collaborator and every running descendant immediately. Nothing waits for them to settle, and they remain available for follow-up work.",
            },
        ]);
    });

    it("declares only the retirement of the schema it used to keep", () => {
        // Agents are actors: the inbox, the ancestry, and the identity all belong to Agent Base,
        // so this module owns no table. The released keys stay because Agent Base requires the
        // applied migrations to remain a prefix of the declared ones — drop one of these and
        // every database that ran an earlier build refuses to open.
        expect(
            new CollaborationModule(
                testConfig,
                abortModule(),
                new HistoryModule(),
                computeModule(),
            ).migrations.map(([key]) => key),
        ).toEqual([
            "001-collaboration",
            "002-drop-collaboration-receipts",
            "003-collaboration-run-state",
            "004-collaboration-storage-removed",
        ]);
    });

    it("refuses to work before the agent collection is available", async () => {
        const module = new CollaborationModule(
            testConfig,
            abortModule(),
            new HistoryModule(),
            computeModule(),
        );
        const ctx = createRootContext().named("unstarted");

        await expect(module.createAgent(ctx, "parent", TASK, "child")).rejects.toThrow(
            "has not been started yet",
        );
    });
});

const FOREIGN_MODELS: readonly AgentModel[] = [
    {
        providerId: "claude",
        id: "opus-5",
        name: "Opus 5",
        effortLevels: ["medium", "high"],
        defaultEffort: "medium",
    },
    {
        providerId: "claude",
        id: "claude-code/sonnet",
        name: "Sonnet",
        effortLevels: ["high"],
        defaultEffort: "high",
    },
    {
        providerId: "antigravity",
        id: "antigravity/gemini-3.8-flash",
        name: "Gemini 3.8 Flash",
        effortLevels: ["high"],
        defaultEffort: "high",
    },
];

class ForeignCollection extends Collection {
    override models: readonly AgentModel[] = FOREIGN_MODELS;
}

const HARNESSES_TOML = [
    "[providers.claude]",
    "enabled = true",
    "[harnesses.claude_code]",
    "[harnesses.antigravity]",
].join("\n");

/**
 * Configuration with the harnesses above and a stand-in `agy` that reports Antigravity's quota,
 * so no test reaches the machine's own Antigravity.
 */
async function harnessConfig(extra = "") {
    const bin = await mkdtemp(join(tmpdir(), "fake-agy-"));
    const agy = join(bin, "agy");
    await writeFile(
        agy,
        [
            "#!/bin/sh",
            "printf 'Gemini Models\\tWeekly Limit Remaining\\t95%%\\t2026-10-27T00:00:00Z\\n'",
            "printf 'Gemini Models\\tFive Hour Limit Remaining\\t99%%\\t2026-10-21T01:34:03Z\\n'",
            "printf 'Gemini 4 Argon\\tGemini 4 Argon Weekly Limit\\t0%%\\t2026-10-26T21:29:49Z\\n'",
            "",
        ].join("\n"),
        { mode: 0o755 },
    );
    return await temporaryTestConfig(`${HARNESSES_TOML}\nenv = { AGY_BIN = "${agy}" }\n${extra}`);
}

const ON_HAPPY = { provider: "claude", model: "opus-5" } as const;
const ON_ANTIGRAVITY = { provider: "antigravity", model: "antigravity/gemini-3.8-flash" } as const;

function memoryKV(values = new Map<string, unknown>()) {
    return {
        read: async (_ctx: Context, key: string) => values.get(key),
        write: async (_ctx: Context, key: string, value: unknown) => {
            values.set(key, value);
        },
        update: async (_ctx: Context, key: string, updater: (current: unknown) => unknown) => {
            const next = await updater(values.get(key));
            values.set(key, next);
            return next;
        },
        delete: async (_ctx: Context, key: string) => {
            values.delete(key);
        },
        getOrCreate: async (_ctx: Context, key: string, create: () => unknown) => {
            if (!values.has(key)) values.set(key, await create());
            return values.get(key);
        },
    };
}

/** A stand-in for the agent's own store, which is all the change notice keeps. */
function kvScope(agent: { readonly provider: string; readonly model: string }) {
    const values = new Map<string, unknown>();
    return {
        values,
        scope: { agent: { id: "parent", ...agent }, kv: memoryKV(values) } as never,
    };
}

function ctx0(): Context {
    return createRootContext().named("usage-test");
}

/** The notice reads nothing from the turn itself. */
const TURN = {} as never;

function harnessesOf(options: { readonly harnesses: readonly { readonly id: string }[] }) {
    return options.harnesses.map((harness) => harness.id);
}

describe("sub-agent harnesses", () => {
    it("lets Happy reach only the foreign harnesses whose models it cannot run itself", async () => {
        const collection = new ForeignCollection();
        const { module, ctx } = await started(collection, await harnessConfig());

        expect(harnessesOf(module.agentOptions(ON_HAPPY))).toEqual(["happy", "antigravity"]);
        await expect(
            module.createToolAgent(
                ctx,
                "parent",
                { ...TASK, model: "antigravity/gemini-3.8-flash" },
                "geminichild",
                ON_HAPPY,
            ),
        ).resolves.toEqual({ agentId: "geminichild" });
        expect(collection.delivered[0]!.options).toMatchObject({
            model: "antigravity/gemini-3.8-flash",
            provider: "antigravity",
        });
        await expect(
            module.createToolAgent(
                ctx,
                "parent",
                { ...TASK, model: "claude-code/sonnet" },
                "sonnetchild",
                ON_HAPPY,
            ),
        ).rejects.toThrow(
            'An agent on harness "happy" cannot create sub-agents on harness "claude_code". It can use: happy, antigravity. Call agent_options',
        );
    });

    it("lets a foreign harness reach every other foreign harness but not Happy", async () => {
        const collection = new ForeignCollection();
        const { module, ctx } = await started(collection, await harnessConfig());

        expect(harnessesOf(module.agentOptions(ON_ANTIGRAVITY))).toEqual([
            "claude_code",
            "antigravity",
        ]);
        await expect(
            module.createToolAgent(
                ctx,
                "parent",
                { ...TASK, model: "claude-code/sonnet" },
                "sonnetchild",
                ON_ANTIGRAVITY,
            ),
        ).resolves.toEqual({ agentId: "sonnetchild" });
        await expect(
            module.createToolAgent(
                ctx,
                "parent",
                { ...TASK, model: "opus-5", effort: "medium" },
                "opuschild",
                ON_ANTIGRAVITY,
            ),
        ).rejects.toThrow('cannot create sub-agents on harness "happy"');
    });

    it("lets a harness's foreign sub-agents replace the default reach", async () => {
        const collection = new ForeignCollection();
        const config = await harnessConfig(
            '[harnesses.happy]\nsubagent_harnesses = ["claude_code"]',
        );
        const { module } = await started(collection, config);

        expect(harnessesOf(module.agentOptions(ON_HAPPY))).toEqual(["happy", "claude_code"]);
    });

    it("refuses a harness that does not run the model", async () => {
        const collection = new ForeignCollection();
        const { module, ctx } = await started(collection, await harnessConfig());

        await expect(
            module.createToolAgent(
                ctx,
                "parent",
                { ...TASK, model: "antigravity/gemini-3.8-flash", harness: "claude_code" },
                "child",
                ON_HAPPY,
            ),
        ).rejects.toThrow(
            'Model "antigravity/gemini-3.8-flash" does not run on harness "claude_code"; it runs on antigravity.',
        );
        expect(collection.created).toHaveLength(0);
    });

    it("lists options by harness and account, one line per model, with usage on request", async () => {
        const collection = new ForeignCollection();
        const { module } = await started(collection, await harnessConfig());

        const options = module.agentOptions(ON_HAPPY);
        expect(options).toMatchObject({
            current: { harness: "happy", provider: "claude" },
            harnesses: [
                {
                    id: "happy",
                    name: "Happy",
                    providers: [{ id: "claude", models: [{ id: "opus-5" }] }],
                },
                {
                    id: "antigravity",
                    name: "Antigravity",
                    providers: [
                        {
                            id: "antigravity",
                            models: [{ id: "antigravity/gemini-3.8-flash" }],
                        },
                    ],
                },
            ],
        });
        expect(module.agentOptionsText(ON_HAPPY).split("\n")).toEqual([
            "Models you can start agents on (* = default effort):",
            "opus-5 (Opus 5) on happy via claude: medium*, high",
            "antigravity/gemini-3.8-flash (Gemini 3.8 Flash) on antigravity via antigravity: high*",
        ]);
        expect(await module.agentOptionsUsage(ON_HAPPY)).toBe(
            "antigravity: Gemini Models 5-hour 99%, weekly 95%; Gemini 4 Argon weekly out until 2026-10-26T21:29Z",
        );
    });

    it("adds every account's latest vendor reading to usage, beside Antigravity's own", async () => {
        const collection = new ForeignCollection();
        const usage = {
            list: () => [
                {
                    providerId: "claude",
                    usage: {
                        windows: {
                            fiveHour: {
                                usedPercent: 30,
                                resetsAt: Date.parse("2026-10-21T00:00:00Z"),
                            },
                            weekly: {
                                usedPercent: 100,
                                resetsAt: Date.parse("2026-10-28T00:00:00Z"),
                            },
                            monthly: null,
                        },
                    },
                },
            ],
        };
        const module = new CollaborationModule(
            await harnessConfig(),
            abortModule(),
            new HistoryModule(),
            computeModule(),
            undefined,
            usage as never,
        );
        await resolveModuleHooks(ctx0(), module, collection.asRef());

        // An exhausted week hides the session window: nothing runs until the week resets.
        expect((await module.agentOptionsUsage(ON_HAPPY)).split("\n")).toEqual([
            "claude: weekly out until 2026-10-28T00:00Z",
            "antigravity: Gemini Models 5-hour 99%, weekly 95%; Gemini 4 Argon weekly out until 2026-10-26T21:29Z",
        ]);
    });

    it("keeps tool definitions byte-identical when the options change", async () => {
        const collection = new ForeignCollection();
        const { hooks, ctx } = await started(collection, await harnessConfig());
        const { scope } = kvScope(ON_HAPPY);
        const definitions = async () =>
            JSON.stringify(
                (await hooks.tools!(ctx, scope)).map((tool) => [
                    tool.name,
                    tool.description,
                    tool.parameters,
                ]),
            );

        const before = await definitions();
        collection.models = FOREIGN_MODELS.slice(0, 1);
        expect(await definitions()).toBe(before);
        // The listing the agent started with stays in the description.
        expect(before).toContain("antigravity/gemini-3.8-flash");
    });

    it("tells an agent once what changed since the listing it last saw", async () => {
        const collection = new ForeignCollection();
        const { hooks, ctx } = await started(collection, await harnessConfig());
        const { scope, values } = kvScope(ON_HAPPY);
        await hooks.tools!(ctx, scope);
        expect(await hooks.beforeTurn!(ctx, scope, TURN)).toBeUndefined();

        collection.models = FOREIGN_MODELS.slice(0, 1);
        const [notice] = (await hooks.beforeTurn!(ctx, scope, TURN))! as never as [
            {
                type: string;
                id: string;
                message: { role: string; content: [{ text: string }] };
                metadata: Record<string, unknown>;
            },
        ];
        expect(notice).toMatchObject({
            type: "steer",
            message: { role: "system" },
            metadata: { hideFromUser: true },
        });
        expect(notice.message.content[0].text).toBe(
            [
                "Your sub-agent options changed:",
                "- antigravity/gemini-3.8-flash (Gemini 3.8 Flash) on antigravity via antigravity: high*",
            ].join("\n"),
        );
        // Until the notice is in history, every turn offers the same notice again.
        const [again] = (await hooks.beforeTurn!(ctx, scope, TURN))! as never as [{ id: string }];
        expect(again.id).toBe(notice.id);

        await hooks.messageAcceptedTransact!(ctx, scope, {
            id: notice.id,
            kind: "steering",
            metadata: notice.metadata,
        } as never);
        expect(await hooks.beforeTurn!(ctx, scope, TURN)).toBeUndefined();
        expect(values.has("agentOptionsChange")).toBe(false);

        // Reading the current list makes it what the agent knows.
        collection.models = FOREIGN_MODELS;
        const options = (await hooks.tools!(ctx, scope)).find(
            (tool) => tool.name === "agent_options",
        )!;
        const listed = (await options.execute(ctx, {}, toolCall("options"))) as { text: string };
        expect(listed.text).toContain("antigravity/gemini-3.8-flash");
        expect(listed.text).not.toContain("Usage");
        expect(await hooks.beforeTurn!(ctx, scope, TURN)).toBeUndefined();
    });
});

const PERMISSION_MODES: readonly AgentPermissionMode[] = [
    "read_only",
    "workspace_write",
    "auto",
    "full_access",
];

describe("collaborator permission modes", () => {
    /** create_agent as Agent Base builds it for an agent whose persistent mode is `mode`. */
    async function createToolIn(mode: AgentPermissionMode) {
        const collection = new Collection();
        collection.seed("parent", null);
        const started_ = await started(collection);
        const tools = await started_.hooks.tools!(started_.ctx, {
            agent: { id: "parent", provider: "codex", permissionMode: mode },
        } as never);
        const create = tools.find((tool) => tool.name === "create_agent");
        if (create === undefined) throw new Error("The create_agent tool was not offered.");
        return { ...started_, collection, create };
    }

    it.each(PERMISSION_MODES)("runs a collaborator in its creator's %s mode", async (mode) => {
        const { collection, create, ctx } = await createToolIn(mode);

        await create.execute(ctx, TASK, toolCall("child"));

        expect(collection.delivered[0]!.options).toMatchObject({
            permissionMode: mode,
            metadata: expect.objectContaining({
                mode: expect.objectContaining({ permissionMode: mode }),
            }),
        });
        expect(collection.configs.get("child")?.metadata?.["lastMode"]).toMatchObject({
            permissionMode: mode,
        });
    });

    it.each(PERMISSION_MODES)("lets a %s creator hand a collaborator Read only", async (mode) => {
        const { collection, create, ctx } = await createToolIn(mode);

        await create.execute(ctx, { ...TASK, read_only: true }, toolCall("child"));

        expect(collection.delivered[0]!.options.permissionMode).toBe("read_only");
    });

    it("lets a Full access creator ask for Full access", async () => {
        const { collection, create, ctx } = await createToolIn("full_access");

        await create.execute(ctx, { ...TASK, full_mode: true }, toolCall("child"));

        expect(collection.delivered[0]!.options.permissionMode).toBe("full_access");
    });

    it.each(["read_only", "workspace_write", "auto"] as const)(
        "refuses full_mode from a %s creator before anything is created",
        async (mode) => {
            const { collection, create, ctx, history } = await createToolIn(mode);

            await expect(
                create.execute(ctx, { ...TASK, full_mode: true }, toolCall("child")),
            ).rejects.toThrow("full_mode is allowed only while you are in Full access yourself");

            expect(collection.created).toEqual([]);
            expect(collection.delivered).toEqual([]);
            expect(history.recordToolSpawnPresentation).not.toHaveBeenCalled();
        },
    );

    it("accepts no other name for full_mode", () => {
        expect(Value.Check(collaborationCreateInputSchema, { ...TASK, full_mode: true })).toBe(
            true,
        );
        expect(Value.Check(collaborationCreateInputSchema, { ...TASK, full: true })).toBe(false);
    });

    it("refuses read_only and full_mode together", async () => {
        const { collection, create, ctx } = await createToolIn("full_access");

        await expect(
            create.execute(ctx, { ...TASK, read_only: true, full_mode: true }, toolCall("child")),
        ).rejects.toThrow("Set read_only or full_mode, not both.");
        expect(collection.created).toEqual([]);
    });

    it("does not count Full access an Auto review lent the call as the creator's mode", async () => {
        const { collection, create, ctx } = await createToolIn("auto");
        // The context one reviewed call may run on after an Auto review elevates it.
        const elevated = withAgentPermissionMode(
            withAgentContext(ctx, { id: "parent", provider: "codex", permissionMode: "auto" }),
            "full_access",
        );

        await expect(
            create.execute(elevated, { ...TASK, full_mode: true }, toolCall("refused")),
        ).rejects.toThrow("you are in Auto");
        await create.execute(elevated, TASK, toolCall("child"));

        expect(collection.created).toEqual([{ id: "child", parent: "parent" }]);
        expect(collection.delivered[0]!.options.permissionMode).toBe("auto");
    });

    it("holds direct module creation to the creator mode it is given", async () => {
        const collection = new Collection();
        const { module, ctx } = await started(collection);

        await module.createAgent(ctx, "parent", TASK, "child", {
            creatorPermissionMode: "workspace_write",
        });
        await expect(
            module.createAgent(ctx, "parent", { ...TASK, full_mode: true }, "second", {
                creatorPermissionMode: "workspace_write",
            }),
        ).rejects.toThrow("you are in Workspace write");
        // Code creating an agent on no agent's behalf gets the product default.
        await module.createAgent(ctx, "parent", TASK, "third");

        expect(collection.delivered.map(({ options }) => options.permissionMode)).toEqual([
            "workspace_write",
            "auto",
        ]);
        expect(collection.created.map(({ id }) => id)).toEqual(["child", "third"]);
    });

    it("gives follow-up messages no way to change a collaborator's mode", async () => {
        const { collection, create, ctx, module } = await createToolIn("read_only");
        await create.execute(ctx, TASK, toolCall("child"));

        expect(
            Value.Check(collaborationSendToolInputSchema, {
                toAgentId: "child",
                explanation: "Widen it",
                text: "Carry on.",
                full_mode: true,
            }),
        ).toBe(false);
        await module.sendMessage(ctx, "parent", { toAgentId: "child", text: "Carry on." }, "m1");

        expect(collection.delivered[1]!.options).not.toHaveProperty("permissionMode");
        expect(collection.configs.get("child")?.metadata?.["lastMode"]).toMatchObject({
            permissionMode: "read_only",
        });
    });

    it("starts a never-run conversation no wider than the sender's own mode", async () => {
        const collection = new Collection();
        collection.seed("parent", null);
        // A mode chosen when the conversation was created, from the installation's catalog.
        const initialMode = {
            providerId: "codex",
            modelId: "openai/gpt-6.1-sol",
            effort: "high",
            serviceTier: null,
            permissionMode: "full_access",
        };
        collection.seed("child", "parent", { metadata: { initialMode } });
        const { module, ctx } = await started(collection);
        const sender = withAgentContext(ctx, {
            id: "parent",
            provider: "codex",
            model: "openai/gpt-6.1-sol",
            permissionMode: "workspace_write",
        });

        await module.sendMessage(sender, "parent", { toAgentId: "child", text: "Start." }, "m1");

        expect(collection.delivered[0]!.options.permissionMode).toBe("workspace_write");
        expect(collection.configs.get("child")?.metadata?.["lastMode"]).toMatchObject({
            permissionMode: "workspace_write",
        });
    });
});

describe("switching a direct child's model with a message", () => {
    /** A parent with a collaborator on GPT-5.6 Sol, as its opening task left it. */
    async function withChild(childMode: AgentPermissionMode = "workspace_write") {
        const collection = new Collection();
        collection.seed("parent", null);
        collection.seed("child", "parent", {
            metadata: {
                lastMode: {
                    providerId: "codex",
                    modelId: "gpt-5.6-sol",
                    effort: "high",
                    serviceTier: "priority",
                    permissionMode: childMode,
                },
            },
        });
        collection.seed("grandchild", "child");
        collection.seed("sibling", "parent");
        collection.seed("stranger", null);
        return { collection, ...(await started(collection)) };
    }

    it("delivers the new model on the message, the way a person's composer selection travels", async () => {
        const { collection, module, ctx } = await withChild();

        await module.sendMessage(
            ctx,
            "parent",
            { toAgentId: "child", text: "Take another look on Opus.", explanation: "Second look" },
            "m1",
            { model: "opus-5", effort: "high", provider: "claude" },
            CREATOR,
        );

        const mode = {
            effort: "high",
            modelId: "opus-5",
            permissionMode: "workspace_write",
            providerId: "claude",
            serviceTier: null,
        };
        expect(collection.steered).toHaveLength(1);
        expect(collection.steered[0]).toMatchObject({
            toAgentId: "child",
            text: "Message from agent parent:\n\nTake another look on Opus.",
            options: {
                id: "m1",
                model: "opus-5",
                effort: "high",
                provider: "claude",
                // Null leaves the priority tier the child was on, as a person's message does.
                serviceTier: null,
                permissionMode: "workspace_write",
                metadata: expect.objectContaining({ mode, senderAgentExplanation: "Second look" }),
            },
        });
        expect(collection.configs.get("child")?.metadata?.["lastMode"]).toEqual(mode);
    });

    it.each(PERMISSION_MODES)(
        "keeps a %s child's own permission mode whatever its creator runs in",
        async (childMode) => {
            const { collection, module, ctx } = await withChild(childMode);
            const sender = withAgentContext(ctx, {
                id: "parent",
                provider: "codex",
                permissionMode: "full_access",
            });

            await module.sendMessage(
                sender,
                "parent",
                { toAgentId: "child", text: "Switch." },
                "m1",
                { model: "gpt-5.6-sol", effort: "low" },
                CREATOR,
            );

            expect(collection.steered[0]!.options.permissionMode).toBe(childMode);
        },
    );

    it("starts a never-run child no wider than its creator's own mode", async () => {
        const collection = new Collection();
        collection.seed("parent", null);
        collection.seed("child", "parent");
        const { module, ctx } = await started(collection);
        const sender = withAgentContext(ctx, {
            id: "parent",
            provider: "codex",
            permissionMode: "read_only",
        });

        await module.sendMessage(
            sender,
            "parent",
            { toAgentId: "child", text: "Start." },
            "m1",
            { model: "gpt-5.6-sol", effort: "medium" },
            CREATOR,
        );

        expect(collection.steered[0]!.options.permissionMode).toBe("read_only");
    });

    it.each([
        ["its own creator", "child", "parent"],
        ["a grandchild", "parent", "grandchild"],
        ["a sibling", "sibling", "child"],
        ["an unrelated agent reachable by ID", "parent", "stranger"],
    ])("refuses to switch %s and delivers nothing", async (_label, from, to) => {
        const { collection, module, ctx } = await withChild();

        await expect(
            module.sendMessage(
                ctx,
                from,
                { toAgentId: to, text: "Switch." },
                "m1",
                { model: "opus-5", effort: "high", provider: "claude" },
                CREATOR,
            ),
        ).rejects.toThrow(`may switch the model only of agents it created directly`);
        expect(collection.delivered).toEqual([]);
        // The same message without a model choice is ordinary cross-workspace messaging.
        await module.sendMessage(ctx, from, { toAgentId: to, text: "Hello." }, "m2");
        expect(collection.delivered[0]!.options).not.toHaveProperty("model");
    });

    it.each([
        [{ model: "unavailable", effort: "high" }, "not available"],
        [{ model: "opus-5", effort: "low", provider: "claude" }, 'Effort "low" is not available'],
        [{ model: "opus-5", effort: "medium" }, "Provider is required"],
        [{ model: "opus-5", effort: "high", serviceTier: "priority", provider: "claude" }, "tier"],
    ] as const)("validates %j against what new agents are offered", async (choice, error) => {
        const { collection, module, ctx } = await withChild();

        await expect(
            module.sendMessage(
                ctx,
                "parent",
                { toAgentId: "child", text: "Switch." },
                "m1",
                choice,
                CREATOR,
            ),
        ).rejects.toThrow(error);
        expect(collection.delivered).toEqual([]);
        expect(collection.configs.get("child")?.metadata?.["lastMode"]).toMatchObject({
            modelId: "gpt-5.6-sol",
        });
    });

    it("defaults the provider to the sender's own when it serves the model", async () => {
        const { collection, module, ctx } = await withChild();

        await module.sendMessage(
            ctx,
            "parent",
            { toAgentId: "child", text: "Switch." },
            "m1",
            { model: "opus-5", effort: "medium" },
            { provider: "bedrock", model: "opus-5" },
        );

        expect(collection.steered[0]!.options.provider).toBe("bedrock");
    });

    it("refuses to switch an archived child", async () => {
        const { collection, module, ctx } = await withChild();
        await collection.updateMetadata(ctx, "child", { archivedAt: 1 });

        await expect(
            module.sendMessage(
                ctx,
                "parent",
                { toAgentId: "child", text: "Switch." },
                "m1",
                { model: "gpt-5.6-sol", effort: "low" },
                CREATOR,
            ),
        ).rejects.toThrow("archived");
        expect(collection.delivered).toEqual([]);
    });

    it("switches through send_agent_message's model fields and needs model and effort together", async () => {
        const { collection, module, ctx } = await withChild();
        const send = sendMessageTool(module, "parent", true, CREATOR);
        const input = {
            toAgentId: "child",
            explanation: "Switching to Opus",
            text: "Continue on Opus.",
            model: "opus-5",
            effort: "high",
            provider: "claude",
        } as const;

        expect(Value.Check(collaborationSendToolInputSchema, input)).toBe(true);
        expect(send.description).toContain("To switch a collaborator or subtask you created");
        expect(send.description).toContain("Any other recipient is refused.");
        await expect(
            send.execute(
                ctx,
                { toAgentId: "child", explanation: "Think harder", text: "Go.", effort: "high" },
                toolCall("partial"),
            ),
        ).rejects.toThrow("give both model and effort");
        await send.execute(ctx, input, toolCall("switch"));

        expect(collection.steered).toHaveLength(1);
        expect(collection.steered[0]!.options).toMatchObject({
            id: "switch",
            model: "opus-5",
            provider: "claude",
            effort: "high",
        });
    });

    it("never lets a foreign harness switch a child onto a harness it cannot reach", async () => {
        const collection = new ForeignCollection();
        collection.seed("parent", null);
        collection.seed("child", "parent");
        const { module, ctx } = await started(collection, await harnessConfig());

        await expect(
            module.sendMessage(
                ctx,
                "parent",
                { toAgentId: "child", text: "Switch." },
                "m1",
                { model: "opus-5", effort: "medium" },
                ON_ANTIGRAVITY,
            ),
        ).rejects.toThrow('cannot create sub-agents on harness "happy"');
        await module.sendMessage(
            ctx,
            "parent",
            { toAgentId: "child", text: "Switch." },
            "m2",
            { model: "claude-code/sonnet", effort: "high" },
            ON_ANTIGRAVITY,
        );
        expect(collection.steered.map(({ options }) => options.model)).toEqual([
            "claude-code/sonnet",
        ]);
    });
});
