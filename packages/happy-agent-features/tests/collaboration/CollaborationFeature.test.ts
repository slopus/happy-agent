import { Value } from "@sinclair/typebox/value";
import { AgentKV, withAgentKV, type AgentConfig } from "@slopus/happy-agent-base";
import { createRootContext, type Context } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import {
    COLLABORATION_MAX_TIMESTAMP,
    collaborationAgentSchema,
    collaborationCreateInputSchema,
    type CollaborationAgent,
} from "../../sources/collaboration/CollaborationAgent.js";
import type { CollaborationEvent } from "../../sources/collaboration/CollaborationEvent.js";
import { CollaborationFeature } from "../../sources/collaboration/CollaborationFeature.js";
import {
    collaborationMessageSchema,
    collaborationScheduleSchema,
    type CollaborationMessage,
    type CollaborationObligation,
    type CollaborationSchedule,
    type CollaborationSendResult,
} from "../../sources/collaboration/CollaborationMessage.js";
import {
    type CollaborationBroker,
    type CollaborationMutationReceipt,
    type CollaborationRoster,
    type CollaborationStore,
    type CollaborationTransactionChange,
} from "../../sources/collaboration/CollaborationStore.js";
import { InMemoryPersistence } from "../support/InMemoryPersistence.js";
import {
    collaborationMutationReceiptSchema,
    collaborationTransactionChangeSchema,
} from "../../sources/collaboration/CollaborationStore.js";
import {
    CollaborationFeature as RootCollaborationFeature,
    collaborationAgentSchema as rootCollaborationAgentSchema,
    collaborationMutationReceiptSchema as rootCollaborationMutationReceiptSchema,
    scheduleMessageTool as rootScheduleMessageTool,
} from "../../sources/index.js";

const baseCtx = createRootContext().named("happy-agent-features-collaboration");

class Host implements CollaborationRoster, CollaborationStore, CollaborationBroker {
    readonly agents = new Map<string, CollaborationAgent>();
    readonly configs = new Map<string, AgentConfig>();
    readonly messages = new Map<string, CollaborationMessage>();
    readonly obligations = new Map<string, CollaborationObligation>();
    readonly receipts = new Map<string, CollaborationMutationReceipt>();
    readonly schedules = new Map<string, CollaborationSchedule>();
    readonly sent: Array<{ readonly target: string; readonly id: string }> = [];
    readonly transactions: string[] = [];
    readonly postCommit: Array<(ctx: Context) => void | Promise<void>> = [];
    failWriteAgent = false;
    mutateWriteAgent = false;
    mutateCreateConfig = false;
    substituteTransaction = false;
    malformedListPage = false;
    resolvePendingWait = false;
    waitCalledInsideTransaction = false;
    #inTransaction = false;
    #tail: Promise<void> = Promise.resolve();

    transaction(
        ctx: Context,
        actingAgentId: string,
        work: (txCtx: Context) => Promise<CollaborationTransactionChange>,
    ): Promise<CollaborationTransactionChange> {
        const run = this.#tail.then(async () => {
            const snapshot = this.snapshot();
            const callbackCount = this.postCommit.length;
            this.transactions.push(actingAgentId);
            this.#inTransaction = true;
            try {
                const result = await work(ctx);
                if (this.substituteTransaction) {
                    return {
                        ...result,
                        changed: !result.changed,
                    };
                }
                return structuredClone(result);
            } catch (error: unknown) {
                this.restore(snapshot);
                this.postCommit.splice(callbackCount);
                throw error;
            } finally {
                this.#inTransaction = false;
            }
        });
        this.#tail = run.then(
            () => undefined,
            () => undefined,
        );
        return run;
    }

    afterCommit(_ctx: Context, callback: (ctx: Context) => void | Promise<void>): void {
        this.postCommit.push(callback);
    }

    async readAgent(_ctx: Context, id: string): Promise<CollaborationAgent | undefined> {
        return clone(this.agents.get(id));
    }

    async writeAgent(_ctx: Context, agent: CollaborationAgent): Promise<void> {
        if (this.failWriteAgent) throw new Error("roster write failed");
        const persisted = clone(agent)!;
        if (this.mutateWriteAgent) {
            (agent as { status: CollaborationAgent["status"] }).status = "active";
            persisted.status = "active";
        }
        this.agents.set(agent.id, persisted);
    }

    async listAgents(
        _ctx: Context,
        _actingAgentId: string,
        query: Parameters<CollaborationRoster["listAgents"]>[2],
    ): ReturnType<CollaborationRoster["listAgents"]> {
        if (this.malformedListPage) {
            return Promise.resolve({
                agents: [],
                limit: query.limit ?? 1,
                nextCursor: query.cursor ?? "same",
            });
        }
        const limit = query.limit ?? 50;
        const rows = [...this.agents.values()]
            .filter((agent) => query.groupId === undefined || agent.groupId === query.groupId)
            .sort((left, right) => left.id.localeCompare(right.id));
        const start = query.cursor === undefined ? 0 : Number(query.cursor);
        const agents = rows.slice(start, start + limit).map((agent) => clone(agent)!);
        return {
            agents,
            limit,
            ...(start + agents.length < rows.length
                ? { nextCursor: String(start + agents.length) }
                : {}),
        };
    }

    async readMessage(_ctx: Context, id: string): Promise<CollaborationMessage | undefined> {
        return clone(this.messages.get(id));
    }

    async writeMessage(_ctx: Context, message: CollaborationMessage): Promise<void> {
        this.messages.set(message.id, clone(message)!);
    }

    async readObligation(_ctx: Context, id: string): Promise<CollaborationObligation | undefined> {
        return clone(this.obligations.get(id));
    }

    async writeObligation(_ctx: Context, obligation: CollaborationObligation): Promise<void> {
        this.obligations.set(obligation.id, clone(obligation)!);
    }

    async listObligations(
        _ctx: Context,
        _actingAgentId: string,
        query: Parameters<CollaborationStore["listObligations"]>[2],
    ): ReturnType<CollaborationStore["listObligations"]> {
        const limit = query.limit ?? 50;
        const obligations = [...this.obligations.values()]
            .filter(
                (obligation) => query.status === undefined || obligation.status === query.status,
            )
            .slice(0, limit)
            .map((obligation) => clone(obligation)!);
        return Promise.resolve({ obligations, limit });
    }

    async readReceipt(
        _ctx: Context,
        actingAgentId: string,
        operationId: string,
    ): Promise<CollaborationMutationReceipt | undefined> {
        return clone(this.receipts.get(`${actingAgentId}:${operationId}`));
    }

    async writeReceipt(_ctx: Context, receipt: CollaborationMutationReceipt): Promise<void> {
        this.receipts.set(`${receipt.actingAgentId}:${receipt.operationId}`, clone(receipt)!);
    }

    async create(
        _ctx: Context,
        config: AgentConfig,
        options: { readonly id: string; readonly parent: string | null },
    ): Promise<{ readonly id: string }> {
        this.configs.set(
            options.id,
            this.mutateCreateConfig ? { metadata: { substituted: true } } : structuredClone(config),
        );
        return { id: options.id };
    }

    async config(_ctx: Context, id: string): Promise<AgentConfig | undefined> {
        const value = this.configs.get(id);
        return value === undefined ? undefined : structuredClone(value);
    }

    async send(
        _ctx: Context,
        target: string,
        _message: Parameters<CollaborationBroker["send"]>[2],
        options: Parameters<CollaborationBroker["send"]>[3],
    ): Promise<void> {
        this.sent.push({ target, id: options.id });
    }

    async wait(
        _ctx: Context,
        _actingAgentId: string,
        obligationId: string,
    ): Promise<CollaborationObligation> {
        if (this.#inTransaction) this.waitCalledInsideTransaction = true;
        const obligation = this.obligations.get(obligationId);
        if (obligation === undefined) {
            throw new Error("missing obligation");
        }
        if (obligation.status === "pending" && !this.resolvePendingWait) {
            throw new Error("host wait is still pending");
        }
        if (obligation.status === "pending") {
            const answerMessageId = "answer-after-wait";
            this.messages.set(answerMessageId, {
                id: answerMessageId,
                fromAgentId: obligation.responderAgentId,
                toAgentId: obligation.requesterAgentId,
                text: "done",
                replyTo: obligation.id,
                createdAt: 2_001,
            });
            const answered: CollaborationObligation = {
                ...obligation,
                status: "answered",
                answerMessageId,
                updatedAt: 2_001,
            };
            this.obligations.set(obligationId, answered);
            return clone(answered)!;
        }
        return clone(obligation)!;
    }

    async schedule(
        _ctx: Context,
        _actingAgentId: string,
        request: {
            readonly id: string;
            readonly ownerAgentId: string;
            readonly targetAgentId: string;
            readonly message: string;
            readonly dueAt: number;
        },
    ): Promise<CollaborationSchedule> {
        const scheduled: CollaborationSchedule = {
            ...request,
            status: "pending",
            createdAt: request.dueAt,
            updatedAt: request.dueAt,
        };
        this.schedules.set(scheduled.id, clone(scheduled)!);
        return clone(scheduled)!;
    }

    async getSchedule(
        _ctx: Context,
        _actingAgentId: string,
        id: string,
    ): Promise<CollaborationSchedule | undefined> {
        return clone(this.schedules.get(id));
    }

    async flush(ctx: Context = baseCtx): Promise<void> {
        const callback = this.postCommit.shift();
        if (callback === undefined) throw new Error("No post-commit callback.");
        await callback(ctx);
    }

    answer(obligationId: string, answerMessageId: string, at = 2_000): void {
        const current = this.obligations.get(obligationId);
        if (current === undefined) throw new Error("missing obligation");
        this.obligations.set(obligationId, {
            ...current,
            status: "answered",
            answerMessageId,
            updatedAt: at,
        });
    }

    snapshot() {
        return {
            agents: new Map([...this.agents].map(([key, value]) => [key, clone(value)!])),
            configs: new Map(
                [...this.configs].map(([key, value]) => [key, structuredClone(value)]),
            ),
            messages: new Map([...this.messages].map(([key, value]) => [key, clone(value)!])),
            obligations: new Map([...this.obligations].map(([key, value]) => [key, clone(value)!])),
            receipts: new Map([...this.receipts].map(([key, value]) => [key, clone(value)!])),
            schedules: new Map([...this.schedules].map(([key, value]) => [key, clone(value)!])),
        };
    }

    restore(snapshot: ReturnType<Host["snapshot"]>): void {
        restore(this.agents, snapshot.agents);
        restore(this.configs, snapshot.configs);
        restore(this.messages, snapshot.messages);
        restore(this.obligations, snapshot.obligations);
        restore(this.receipts, snapshot.receipts);
        restore(this.schedules, snapshot.schedules);
    }
}

function clone<Value>(value: Value | undefined): Value | undefined {
    return value === undefined ? undefined : structuredClone(value);
}

function restore<Value>(target: Map<string, Value>, snapshot: Map<string, Value>): void {
    target.clear();
    for (const [key, value] of snapshot) target.set(key, value);
}

function feature(
    host: Host,
    options: {
        readonly authorize?: boolean;
        readonly events?: CollaborationEvent[];
        readonly postEvents?: CollaborationEvent[];
        readonly maxOutputCharacters?: number;
    } = {},
): CollaborationFeature {
    let sequence = 0;
    return new CollaborationFeature({
        roster: host,
        store: host,
        broker: host,
        ...(options.authorize === undefined
            ? {}
            : {
                  authorization: {
                      authorize: async () => options.authorize!,
                  },
              }),
        idFactory: () => `agent${++sequence}`,
        operationIdFactory: () => `operation${++sequence}`,
        messageIdFactory: () => `message${++sequence}`,
        obligationIdFactory: () => `obligation${++sequence}`,
        scheduleIdFactory: () => `schedule${++sequence}`,
        eventIdFactory: () => `event${++sequence}`,
        clock: () => 1_000 + sequence,
        ...(options.maxOutputCharacters === undefined
            ? {}
            : { maxOutputCharacters: options.maxOutputCharacters }),
        listener: {
            onEventTransactional: async (_ctx, event) => {
                options.events?.push(event);
            },
            onEvent: async (_ctx, event) => {
                options.postEvents?.push(event);
            },
        },
    });
}

async function createRoot(
    featureInstance: CollaborationFeature,
    id: string,
): Promise<CollaborationAgent> {
    return await featureInstance.createAgent(baseCtx, id, {
        operationId: `create-${id}`,
        id,
        config: {},
    });
}

async function createChild(
    featureInstance: CollaborationFeature,
    ownerAgentId: string,
    id: string,
): Promise<CollaborationAgent> {
    return await featureInstance.createAgent(baseCtx, ownerAgentId, {
        operationId: `create-${id}`,
        id,
        parentId: ownerAgentId,
        config: {},
    });
}

describe("CollaborationFeature", () => {
    it("exports the feature, contracts, and common tools from the package root", () => {
        expect(RootCollaborationFeature).toBe(CollaborationFeature);
        expect(rootCollaborationAgentSchema).toBe(collaborationAgentSchema);
        expect(rootCollaborationMutationReceiptSchema).toBe(collaborationMutationReceiptSchema);
        expect(rootScheduleMessageTool).toBeTypeOf("function");
    });

    it("uses caller-supplied Agent Base IDs and metadata inside one shared host transaction", async () => {
        const host = new Host();
        const events: CollaborationEvent[] = [];
        const postEvents: CollaborationEvent[] = [];
        const collaboration = feature(host, { events, postEvents });
        const root = await createRoot(collaboration, "owner");
        const child = await collaboration.createAgent(baseCtx, "owner", {
            operationId: "create-child",
            id: "child",
            role: "reviewer",
            parentId: "owner",
            config: { metadata: { fromConfig: "yes" } },
            metadata: { fromInput: "yes" },
        });

        expect(root.id).toBe("owner");
        expect(child.ownerAgentId).toBe("owner");
        expect(child.metadata).toEqual({ fromConfig: "yes", fromInput: "yes" });
        expect(await host.configs.get("child")).toEqual({
            metadata: { fromConfig: "yes", fromInput: "yes" },
        });
        expect(host.transactions).toEqual(["owner", "owner"]);
        expect(events).toHaveLength(2);
        expect(Object.isFrozen(events[1])).toBe(true);
        expect(Value.Check(collaborationAgentSchema, child)).toBe(true);
        await host.flush();
        await host.flush();
        expect(postEvents).toHaveLength(2);
    });

    it("rejects cross-owner access unless an injected authorization policy grants it", async () => {
        const host = new Host();
        const collaboration = feature(host);
        await createRoot(collaboration, "owner");
        await createRoot(collaboration, "peer");

        await expect(
            collaboration.sendMessage(baseCtx, "owner", {
                operationId: "send-peer",
                messageId: "message-peer",
                toAgentId: "peer",
                text: "private",
            }),
        ).rejects.toThrow("not authorized");

        const allowed = feature(host, { authorize: true });
        const sent = await allowed.sendMessage(baseCtx, "owner", {
            operationId: "send-peer-allowed",
            messageId: "message-peer-allowed",
            toAgentId: "peer",
            text: "allowed",
        });
        expect(sent.message.fromAgentId).toBe("owner");
    });

    it("keeps durable receipts authoritative and rejects altered replays", async () => {
        const host = new Host();
        const collaboration = feature(host);
        await createRoot(collaboration, "owner");
        await createChild(collaboration, "owner", "child");

        const input = {
            operationId: "send-once",
            messageId: "message-once",
            toAgentId: "child",
            text: "review",
            expectReply: true as const,
        };
        const first = await collaboration.sendMessage(baseCtx, "owner", input);
        const replay = await collaboration.sendMessage(baseCtx, "owner", input);
        expect(replay).toEqual(first);
        expect(host.sent).toHaveLength(1);
        expect(host.receipts.get("owner:send-once")).toEqual(
            expect.objectContaining({ fingerprint: expect.any(String) }),
        );
        await expect(
            collaboration.sendMessage(baseCtx, "owner", {
                ...input,
                text: "changed",
            }),
        ).rejects.toThrow("reused with different input");

        const answered = await collaboration.replyMessage(baseCtx, "child", {
            operationId: "reply-once",
            messageId: "answer-message",
            toAgentId: "owner",
            text: "done",
            replyTo: first.obligation!.id,
        });
        expect(answered.obligation?.status).toBe("answered");
        const waited = await collaboration.waitForReply(baseCtx, "owner", {
            operationId: "wait-once",
            obligationId: first.obligation!.id,
        });
        expect(waited.status).toBe("answered");
    });

    it("delegates scheduling to the durable broker and replays its receipt", async () => {
        const host = new Host();
        const collaboration = feature(host);
        await createRoot(collaboration, "owner");
        await createChild(collaboration, "owner", "child");

        const input = {
            operationId: "schedule-once",
            id: "schedule-once",
            targetAgentId: "child",
            message: "later",
            dueAt: 2_000,
        };
        const first = await collaboration.scheduleMessage(baseCtx, "owner", input);
        const replay = await collaboration.scheduleMessage(baseCtx, "owner", input);
        expect(replay).toEqual(first);
        expect(Value.Check(collaborationScheduleSchema, first)).toBe(true);
        await expect(
            collaboration.scheduleMessage(baseCtx, "owner", {
                ...input,
                dueAt: 2_001,
            }),
        ).rejects.toThrow("reused with different input");
    });

    it("rolls back roster, receipt, and events when a host write fails", async () => {
        const host = new Host();
        const events: CollaborationEvent[] = [];
        const collaboration = feature(host, { events });
        host.failWriteAgent = true;

        await expect(createRoot(collaboration, "rollback")).rejects.toThrow("roster write failed");
        expect(host.agents).toHaveLength(0);
        expect(host.receipts).toHaveLength(0);
        expect(events).toHaveLength(0);
        expect(host.postCommit).toHaveLength(0);
    });

    it("rejects malformed contracts, pages, and bounded metadata", async () => {
        const host = new Host();
        expect(
            () =>
                new CollaborationFeature({
                    roster: host,
                    store: host,
                    broker: {} as never,
                }),
        ).toThrow("options");

        const collaboration = feature(host);
        const tooDeep: Record<string, unknown> = {};
        let current = tooDeep;
        for (let index = 0; index < 12; index += 1) {
            current.child = {};
            current = current.child as Record<string, unknown>;
        }
        await expect(
            collaboration.createAgent(baseCtx, "root", {
                operationId: "bad-metadata",
                id: "root",
                config: {},
                metadata: { tooDeep } as never,
            }),
        ).rejects.toThrow("metadata");

        await createRoot(collaboration, "root");
        host.malformedListPage = true;
        await expect(
            collaboration.listAgents(baseCtx, "root", { limit: 1, cursor: "same" }),
        ).rejects.toThrow("cursor");
    });

    it("detects a substituted transaction result and serializes concurrent host calls", async () => {
        const host = new Host();
        const collaboration = feature(host);
        host.substituteTransaction = true;
        await expect(createRoot(collaboration, "substituted")).rejects.toThrow(
            "substituted change",
        );

        host.substituteTransaction = false;
        const [left, right] = await Promise.all([
            createRoot(collaboration, "left"),
            createRoot(collaboration, "right"),
        ]);
        expect([left.id, right.id].sort()).toEqual(["left", "right"]);
        expect(host.transactions.slice(-2)).toEqual(["left", "right"]);
    });

    it("rejects an answer from the wrong responder", async () => {
        const host = new Host();
        const collaboration = feature(host, { authorize: true });
        await createRoot(collaboration, "owner");
        await createRoot(collaboration, "responder");
        const request = await collaboration.sendMessage(baseCtx, "owner", {
            operationId: "request",
            messageId: "request-message",
            toAgentId: "responder",
            text: "answer",
            expectReply: true,
        });
        await expect(
            collaboration.replyMessage(baseCtx, "owner", {
                operationId: "wrong-answer",
                messageId: "wrong-answer",
                toAgentId: "owner",
                text: "wrong",
                replyTo: request.obligation!.id,
            }),
        ).rejects.toThrow("requested responder");
    });

    it("does not expose scheduling to subagents", async () => {
        const host = new Host();
        const collaboration = feature(host);
        await createRoot(collaboration, "owner");
        await createChild(collaboration, "owner", "child");

        const rootTools = await collaboration.tools(baseCtx, {
            agent: { id: "owner" },
        } as never);
        const childTools = await collaboration.tools(baseCtx, {
            agent: { id: "child" },
        } as never);
        expect(rootTools.map((tool) => tool.name)).toContain("schedule_message");
        expect(childTools.map((tool) => tool.name)).not.toContain("schedule_message");
    });

    it("keeps durable identities out of model tool inputs and waits outside transactions", async () => {
        const host = new Host();
        const collaboration = feature(host);
        await createRoot(collaboration, "owner");
        await createChild(collaboration, "owner", "child");

        const tools = await collaboration.tools(baseCtx, {
            agent: { id: "owner" },
        } as never);
        const toolByName = new Map(tools.map((tool) => [tool.name, tool]));
        const properties = (name: string): Record<string, unknown> => {
            const tool = toolByName.get(name);
            if (tool === undefined) throw new Error(`Missing tool ${name}.`);
            const parameters = tool.parameters as {
                readonly properties?: Record<string, unknown>;
            };
            return parameters.properties ?? {};
        };

        expect(properties("create_agent")).not.toHaveProperty("id");
        expect(properties("create_agent")).not.toHaveProperty("operationId");
        expect(properties("send_agent_message")).not.toHaveProperty("messageId");
        expect(properties("send_agent_message")).not.toHaveProperty("operationId");
        expect(properties("reply_to_agent_message")).not.toHaveProperty("messageId");
        expect(properties("reply_to_agent_message")).not.toHaveProperty("operationId");
        expect(properties("wait_for_reply")).not.toHaveProperty("operationId");
        expect(properties("schedule_message")).not.toHaveProperty("id");
        expect(properties("schedule_message")).not.toHaveProperty("operationId");

        const request = await collaboration.sendMessage(baseCtx, "owner", {
            operationId: "wait-outside-request",
            messageId: "wait-outside-message",
            toAgentId: "child",
            text: "reply later",
            expectReply: true,
        });
        host.resolvePendingWait = true;
        const waited = await collaboration.waitForReply(baseCtx, "owner", {
            operationId: "wait-outside",
            obligationId: request.obligation!.id,
        });
        expect(waited.status).toBe("answered");
        expect(host.waitCalledInsideTransaction).toBe(false);
    });

    it("rejects answered obligations whose answer message is missing or misdirected", async () => {
        const host = new Host();
        const collaboration = feature(host);
        await createRoot(collaboration, "owner");
        await createChild(collaboration, "owner", "child");
        const request = await collaboration.sendMessage(baseCtx, "owner", {
            operationId: "invalid-answer-request",
            messageId: "invalid-answer-message",
            toAgentId: "child",
            text: "answer this",
            expectReply: true,
        });
        host.answer(request.obligation!.id, "missing-answer");
        await expect(
            collaboration.listObligations(baseCtx, "owner", { limit: 10 }),
        ).rejects.toThrow("invalid answer message reference");

        const answerId = "wrong-direction-answer";
        host.messages.set(answerId, {
            id: answerId,
            fromAgentId: "owner",
            toAgentId: "child",
            text: "not a reply",
            replyTo: request.obligation!.id,
            createdAt: 2_001,
        });
        host.answer(request.obligation!.id, answerId);
        await expect(
            collaboration.waitForReply(baseCtx, "owner", {
                operationId: "invalid-answer-wait",
                obligationId: request.obligation!.id,
            }),
        ).rejects.toThrow("invalid answer message reference");
    });

    it("validates target ownership references, parent cycles, and self-parent targets on get", async () => {
        const missingHost = new Host();
        const missingFeature = feature(missingHost);
        await createRoot(missingFeature, "owner");
        missingHost.agents.set("target", {
            id: "target",
            ownerAgentId: "owner",
            parentId: "missing",
            status: "idle",
            createdAt: 1,
            updatedAt: 1,
        });
        await expect(missingFeature.getAgent(baseCtx, "owner", "target")).rejects.toThrow(
            "missing parent",
        );

        const cycleHost = new Host();
        const cycleFeature = feature(cycleHost);
        await createRoot(cycleFeature, "owner");
        await createChild(cycleFeature, "owner", "agentone");
        await createChild(cycleFeature, "owner", "agenttwo");
        cycleHost.agents.set("agentone", {
            ...cycleHost.agents.get("agentone")!,
            parentId: "agenttwo",
        });
        cycleHost.agents.set("agenttwo", {
            ...cycleHost.agents.get("agenttwo")!,
            parentId: "agentone",
        });
        await expect(cycleFeature.getAgent(baseCtx, "owner", "agentone")).rejects.toThrow(
            "cyclic parentage",
        );

        const selfHost = new Host();
        const selfFeature = feature(selfHost);
        await createRoot(selfFeature, "owner");
        selfHost.agents.set("owner", {
            ...selfHost.agents.get("owner")!,
            parentId: "owner",
        });
        await expect(selfFeature.getAgent(baseCtx, "owner", "owner")).rejects.toThrow(
            "parent invariants",
        );
    });

    it("isolates durable create identities across distinct call-scoped AgentKV instances", async () => {
        const host = new Host();
        const collaboration = feature(host);
        await createRoot(collaboration, "owner");
        const createTool = (
            await collaboration.tools(baseCtx, {
                agent: { id: "owner" },
            } as never)
        ).find((tool) => tool.name === "create_agent")!;
        const persistence = new InMemoryPersistence();
        const firstCall = withAgentKV(baseCtx, new AgentKV(persistence, "agent.owner.call.first."));
        const secondCall = withAgentKV(
            baseCtx,
            new AgentKV(persistence, "agent.owner.call.second."),
        );

        const first = await createTool.execute(firstCall, { config: {} });
        const second = await createTool.execute(secondCall, { config: {} });

        expect(second.id).not.toBe(first.id);
        expect(host.agents).toHaveLength(3);
        expect(host.receipts).toHaveLength(3);
    });

    it("reduces roster pages before returning so every visible identity can reach the model", async () => {
        const host = new Host();
        const collaboration = feature(host, { maxOutputCharacters: 256 });
        await createRoot(collaboration, "owner");
        for (let index = 0; index < 12; index += 1) {
            await createChild(collaboration, "owner", `child${String(index).padStart(2, "0")}`);
        }

        const seen: string[] = [];
        let cursor: string | undefined;
        do {
            const page = await collaboration.listAgents(baseCtx, "owner", {
                limit: 50,
                ...(cursor === undefined ? {} : { cursor }),
            });
            const text = collaboration.formatAgentPageForModel(page);
            for (const agent of page.agents) {
                expect(text).toContain(agent.id);
                seen.push(agent.id);
            }
            cursor = page.nextCursor;
        } while (cursor !== undefined);

        expect(seen).toEqual(
            [
                "owner",
                ...Array.from(
                    { length: 12 },
                    (_, index) => `child${String(index).padStart(2, "0")}`,
                ),
            ].sort(),
        );
    });

    it("rejects mutable host substitutions and missing post-create Agent Base configuration", async () => {
        const mutatedHost = new Host();
        mutatedHost.mutateWriteAgent = true;
        await expect(createRoot(feature(mutatedHost), "mutated")).rejects.toThrow("substituted");

        const configHost = new Host();
        configHost.mutateCreateConfig = true;
        await expect(createRoot(feature(configHost), "wrongconfig")).rejects.toThrow(
            "different Agent Base configuration",
        );
        expect(configHost.agents).toHaveLength(0);
    });

    it("rejects altered reply receipts and unbounded schedule times", async () => {
        const host = new Host();
        const collaboration = feature(host, { authorize: true });
        await createRoot(collaboration, "owner");
        await createRoot(collaboration, "responder");
        const request = await collaboration.sendMessage(baseCtx, "owner", {
            operationId: "request-replay",
            messageId: "request-replay-message",
            toAgentId: "responder",
            text: "answer",
            expectReply: true,
        });
        const replyInput = {
            operationId: "reply-replay",
            messageId: "reply-replay-message",
            toAgentId: "owner",
            text: "done",
            replyTo: request.obligation!.id,
        } as const;
        await collaboration.replyMessage(baseCtx, "responder", replyInput);
        const receipt = host.receipts.get("responder:reply-replay")!;
        const replyResult = receipt.result as CollaborationSendResult;
        if (replyResult.obligation?.status !== "answered") throw new Error("missing reply");
        host.receipts.set("responder:reply-replay", {
            ...receipt,
            result: {
                ...replyResult,
                obligation: {
                    ...replyResult.obligation,
                    answerMessageId: "different-answer",
                },
            },
        });
        await expect(collaboration.replyMessage(baseCtx, "responder", replyInput)).rejects.toThrow(
            "receipt disagrees",
        );

        await expect(
            collaboration.scheduleMessage(baseCtx, "owner", {
                operationId: "too-far",
                targetAgentId: "responder",
                message: "later",
                dueAt: COLLABORATION_MAX_TIMESTAMP + 1,
            }),
        ).rejects.toThrow("schedule message");
    });
});

void collaborationMessageSchema;
void collaborationCreateInputSchema;
void collaborationMutationReceiptSchema;
void collaborationTransactionChangeSchema;
