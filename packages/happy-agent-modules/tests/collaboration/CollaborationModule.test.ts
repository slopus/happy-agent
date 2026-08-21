import {
    withAgentConfig,
    type AgentConfig,
    type AgentMessageAcceptance,
    type AgentModel,
    type AgentModuleHooks,
    type AgentSystemRef,
} from "@slopus/happy-agent-base";
import { createRootContext, type Context } from "@steve.kite/stdlib";
import { describe, expect, it, vi } from "vitest";

import { AbortModule } from "../../sources/abort/index.js";
import {
    CollaborationModule,
    createAgentTool,
    interruptAgentTool,
    sendMessageTool,
} from "../../sources/collaboration/index.js";
import { ComputeModule } from "../../sources/compute/index.js";
import { testConfig } from "../support/computeModule.js";
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
    seed(id: string, parent: string | null): void {
        this.configs.set(id, {});
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

    /** The module holds an `AgentSystemRef`; this stub supplies only what it actually calls. */
    asRef(): AgentSystemRef {
        return this as unknown as AgentSystemRef;
    }
}

async function started(
    collection: Collection,
): Promise<{ module: CollaborationModule; hooks: AgentModuleHooks; ctx: Context }> {
    const abort = abortModule();
    vi.spyOn(abort, "abort").mockImplementation(
        async (ctx, agentId) => await collection.abort(ctx, agentId),
    );
    const module = new CollaborationModule(abort);
    const ctx = withAgentConfig(createRootContext().named("collaboration-test"), {
        environment: {
            osVersion: "test",
            platform: "darwin",
            workingDirectory: "/work",
            shell: "/bin/zsh",
        },
        modules: { collaboration: {} },
        metadata: { title: "Parent agent" },
    });
    const hooks = await resolveModuleHooks(ctx, module, collection.asRef());
    return { module, hooks, ctx };
}

function abortModule(): AbortModule {
    return new AbortModule(new ComputeModule(testConfig));
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
        providerCallId: `${id}-provider`,
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

describe("collaboration", () => {
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

        expect(collection.configs.get("child")?.metadata).toEqual({ title: "Reviewer" });
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

    it("never lets a later message change what a collaborator runs on", async () => {
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

        expect(collection.delivered[0]!.options.metadata).toEqual({
            collaboration: { fromAgentId: "parent", toAgentId: "child" },
            senderAgentId: "parent",
        });
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

    it("omits provider when an unambiguous model does not need one", async () => {
        const collection = new Collection();
        const { module, hooks, ctx } = await started(collection);

        await module.createAgent(ctx, "parent", TASK, "child");

        expect(collection.delivered[0]!.options).toMatchObject({
            model: "gpt-5.6-sol",
            effort: "high",
        });
        expect(collection.delivered[0]!.options).not.toHaveProperty("provider");
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
    });

    it("refuses a message between agents with no relationship", async () => {
        const collection = new Collection();
        collection.seed("stranger", null);
        const { module, hooks, ctx } = await started(collection);
        await module.createAgent(ctx, "parent", TASK, "child");

        await expect(
            module.sendMessage(ctx, "child", { toAgentId: "stranger", text: "Hello." }, "m1"),
        ).rejects.toThrow('Agent "child" is not authorized to send to agent "stranger".');
    });

    it("refuses sibling and grandchild messages because authorization is direct ancestry only", async () => {
        const collection = new Collection();
        collection.seed("sibling", "parent");
        collection.seed("grandchild", "sibling");
        const { module, hooks, ctx } = await started(collection);
        await module.createAgent(ctx, "parent", TASK, "child");

        await expect(
            module.sendMessage(ctx, "child", { toAgentId: "sibling", text: "Hello." }, "m1"),
        ).rejects.toThrow("is not authorized to send");
        await expect(
            module.sendMessage(ctx, "parent", { toAgentId: "grandchild", text: "Hello." }, "m2"),
        ).rejects.toThrow("is not authorized to send");
        expect(collection.delivered).toHaveLength(1);
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
        const collection = new Collection();
        collection.seed("sibling", "parent");
        const { module, hooks, ctx } = await started(collection);
        await module.createAgent(ctx, "parent", TASK, "child");

        const instructions = await hooks.instructions!(ctx, {
            agent: { id: "parent" },
        } as never);

        expect(instructions).toBe(
            "Collaborators you created: sibling, child. Each reports back on its own when it finishes; nothing waits for them.",
        );
    });

    it("says nothing to an agent with no collaborators at all", async () => {
        const collection = new Collection();
        const { module, hooks, ctx } = await started(collection);

        expect(await hooks.instructions!(ctx, { agent: { id: "lonely" } } as never)).toBe("");
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
        });
    });

    it("says nothing when the collaborator finished in silence", async () => {
        const collection = new Collection();
        const { module, hooks, ctx } = await started(collection);
        await module.createAgent(ctx, "parent", TASK, "child");
        const scope = runScope("child");

        // No text_end ever arrived — an interrupted turn, or one that was told no action was
        // needed. There is no answer to pass on, and announcing the silence would tell the
        // creator something it already knows.
        await hooks.afterAgentSettledTransact!(ctx, scope, settlement("s1"));

        expect(collection.delivered).toHaveLength(1);
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

    it("keeps silence silent when a run ends without an answer and without a failure", async () => {
        const collection = new Collection();
        const { module, hooks, ctx } = await started(collection);
        await module.createAgent(ctx, "parent", TASK, "child");
        const scope = runScope("child");

        // A cancelled run is not a failed one: it was interrupted on purpose, so it settles
        // without a failure.
        await hooks.afterAgentSettledTransact!(ctx, scope, settlement("s1"));

        expect(collection.delivered).toHaveLength(1);
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

    it("does not report a non-string or blank run-store value", async () => {
        const collection = new Collection();
        const { module, hooks, ctx } = await started(collection);
        await module.createAgent(ctx, "parent", TASK, "child");

        const nonString = {
            agent: { id: "child" },
            runKV: { read: async () => 123 },
        } as never;
        await hooks.afterAgentSettledTransact!(ctx, nonString, settlement("s1"));
        expect(collection.delivered).toHaveLength(1);

        const blank = {
            agent: { id: "child" },
            runKV: { read: async () => " \n\t " },
        } as never;
        await expect(
            hooks.afterAgentSettledTransact!(ctx, blank, settlement("s2")),
        ).resolves.toBeUndefined();
        expect(collection.delivered).toHaveLength(1);
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

    it("exposes the fixed three-tool surface with the intended durability and review policy", async () => {
        const collection = new Collection();
        const { module, hooks, ctx } = await started(collection);
        const tools = await hooks.tools!(ctx, { agent: { id: "parent" } } as never);

        expect(tools.map((tool) => tool.name)).toEqual([
            "create_agent",
            "send_agent_message",
            "interrupt_agent",
        ]);
        expect(tools.map((tool) => tool.durable)).toEqual([true, true, false]);
        expect(tools.map((tool) => tool.requiresAutoOrFullAccess)).toEqual([
            undefined,
            undefined,
            undefined,
        ]);
    });

    it("describes the offered model/provider pairs without a dynamic capacity lookup", () => {
        const module = new CollaborationModule(abortModule());
        const create = createAgentTool(module, "parent", "codex", MODELS);
        const empty = createAgentTool(module, "parent", "codex", []);

        expect(create.description).toContain("codex + gpt-5.6-sol");
        expect(create.description).toContain("claude + opus-5");
        expect(create.description).toContain("tiers: priority");
        expect(empty.description).not.toContain("Available model/provider pairs:");
    });

    it("keeps send and create routine while interrupt remains reviewable", async () => {
        const collection = new Collection();
        const { module, hooks, ctx } = await started(collection);
        const create = createAgentTool(module, "parent", "codex", MODELS);
        const send = sendMessageTool(module, "parent");
        const interrupt = interruptAgentTool(module, "parent");

        expect(create.shouldReviewInAutoMode(TASK, ctx)).toBe(false);
        expect(send.shouldReviewInAutoMode({ toAgentId: "child", text: "Hi." }, ctx)).toBe(false);
        expect(interrupt.shouldReviewInAutoMode({ targetAgentId: "child" }, ctx)).toBe(true);
        expect(interrupt.shouldRunInFullAccessInAutoMode).toBeUndefined();
        expect(interrupt.describeAutoPermissionAction!({ targetAgentId: "child" }, ctx)).toContain(
            '"child"',
        );
    });

    it("routes tool execution through the public operations and renders complete model results", async () => {
        const collection = new Collection();
        const { module, hooks, ctx } = await started(collection);
        const create = createAgentTool(module, "parent", "codex", MODELS);
        const send = sendMessageTool(module, "parent");
        const interrupt = interruptAgentTool(module, "parent");

        await expect(create.execute(ctx, TASK, toolCall("created"))).resolves.toEqual({
            agentId: "created",
        });
        await expect(
            send.execute(ctx, { toAgentId: "created", text: "Follow up." }, toolCall("message")),
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
        expect(new CollaborationModule(abortModule()).migrations.map(([key]) => key)).toEqual([
            "001-collaboration",
            "002-drop-collaboration-receipts",
            "003-collaboration-run-state",
            "004-collaboration-storage-removed",
        ]);
    });

    it("refuses to work before the agent collection is available", async () => {
        const module = new CollaborationModule(abortModule());
        const ctx = createRootContext().named("unstarted");

        await expect(module.createAgent(ctx, "parent", TASK, "child")).rejects.toThrow(
            "has not been started yet",
        );
    });
});
