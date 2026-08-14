import { Value } from "@sinclair/typebox/value";
import { AgentKV, withAgentKV } from "@slopus/happy-agent-base";
import { createRootContext, type Context } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import {
    MAX_SLOT_ENTRIES,
    allowedSlotScopes,
    scopeReferenceFromEntry,
    slotActionSchema,
    slotContentSchema,
    slotCreateInputSchema,
    slotEntrySchema,
    slotIdSchema,
    slotScopeReferenceSchema,
    slotOperationFingerprintSchema,
    type SlotCreateInput,
    type SlotEntry,
    type SlotUpdateInput,
} from "../../sources/slots/Slot.js";
import type { SlotEvent } from "../../sources/slots/SlotEvent.js";
import {
    slotCursorSchema,
    slotPageQuerySchema,
    type SlotPageQuery,
} from "../../sources/slots/SlotPage.js";
import { slotDetailPageSchema } from "../../sources/slots/SlotDetailPage.js";
import { SlotsFeature, type SlotsFeatureOptions } from "../../sources/slots/SlotsFeature.js";
import {
    slotStoreCreateInputContractSchema,
    slotStoreSchema,
    type SlotMutationProof,
    type SlotOperationReceipt,
    type SlotMutationRequest,
    type SlotStoreCreateResult,
    type SlotStoreRemoveResult,
    type SlotStoreReorderResult,
    type SlotStoreUpdateResult,
    type SlotStore,
} from "../../sources/slots/SlotStore.js";
import { agentWorld } from "../support/agentWorld.js";

const ctx = createRootContext().named("happy-agent-features-slots");

type ReorderTamper =
    | "id"
    | "authorAgentId"
    | "scope"
    | "content"
    | "description"
    | "purpose"
    | "createdAt"
    | "updatedAt";

class MemorySlotStore implements SlotStore {
    readonly entries = new Map<string, SlotEntry>();
    readonly receipts = new Map<string, SlotOperationReceipt>();
    readonly proofs = new Map<string, SlotMutationProof>();
    readonly callbacks: Array<(ctx: Context) => void | Promise<void>> = [];
    readonly overReturn: boolean;
    readonly repeatCursor: boolean;
    readonly unsafeCursor: boolean;
    readonly rejectNonIntegerCursor: boolean;
    readonly driftUpdateOrdering: boolean;
    readonly reorderTamper: ReorderTamper | undefined;
    readonly noOpReceiptWrite: boolean;
    readonly mismatchedReceiptWrite: boolean;
    #depth = 0;
    #snapshot: Map<string, SlotEntry> | undefined;
    #receiptSnapshot: Map<string, SlotOperationReceipt> | undefined;
    #proofSnapshot: Map<string, SlotMutationProof> | undefined;
    #callbackCount = 0;
    #now = 100;

    constructor(
        options: {
            readonly overReturn?: boolean;
            readonly repeatCursor?: boolean;
            readonly unsafeCursor?: boolean;
            readonly rejectNonIntegerCursor?: boolean;
            readonly driftUpdateOrdering?: boolean;
            readonly reorderTamper?: ReorderTamper;
            readonly noOpReceiptWrite?: boolean;
            readonly mismatchedReceiptWrite?: boolean;
        } = {},
    ) {
        this.overReturn = options.overReturn ?? false;
        this.repeatCursor = options.repeatCursor ?? false;
        this.unsafeCursor = options.unsafeCursor ?? false;
        this.rejectNonIntegerCursor = options.rejectNonIntegerCursor ?? false;
        this.driftUpdateOrdering = options.driftUpdateOrdering ?? false;
        this.reorderTamper = options.reorderTamper;
        this.noOpReceiptWrite = options.noOpReceiptWrite ?? false;
        this.mismatchedReceiptWrite = options.mismatchedReceiptWrite ?? false;
    }

    async transaction<Result>(
        _ctx: Context,
        work: (txCtx: Context) => Promise<Result>,
    ): Promise<Result> {
        const outer = this.#depth === 0;
        if (outer) {
            this.#snapshot = new Map(
                [...this.entries].map(([id, entry]) => [id, structuredClone(entry)]),
            );
            this.#receiptSnapshot = new Map(
                [...this.receipts].map(([id, receipt]) => [id, structuredClone(receipt)]),
            );
            this.#proofSnapshot = new Map(
                [...this.proofs].map(([id, proof]) => [id, structuredClone(proof)]),
            );
            this.#callbackCount = this.callbacks.length;
        }
        this.#depth += 1;
        try {
            const result = await work(ctx);
            this.#depth -= 1;
            if (outer) {
                this.#snapshot = undefined;
                this.#receiptSnapshot = undefined;
                this.#proofSnapshot = undefined;
            }
            return result;
        } catch (error: unknown) {
            this.#depth -= 1;
            if (outer) {
                this.entries.clear();
                for (const [id, entry] of this.#snapshot ?? []) {
                    this.entries.set(id, structuredClone(entry));
                }
                this.receipts.clear();
                for (const [id, receipt] of this.#receiptSnapshot ?? []) {
                    this.receipts.set(id, structuredClone(receipt));
                }
                this.proofs.clear();
                for (const [id, proof] of this.#proofSnapshot ?? []) {
                    this.proofs.set(id, structuredClone(proof));
                }
                this.callbacks.splice(this.#callbackCount);
                this.#snapshot = undefined;
                this.#receiptSnapshot = undefined;
                this.#proofSnapshot = undefined;
            }
            throw error;
        }
    }

    afterCommit(_txCtx: Context, callback: (postCommitCtx: Context) => void | Promise<void>): void {
        this.callbacks.push(callback);
    }

    async list(_ctx: Context, _agentId: string, query: SlotPageQuery) {
        if (
            this.rejectNonIntegerCursor &&
            query.cursor !== undefined &&
            (!Number.isInteger(query.cursor) || query.cursor < 0)
        ) {
            throw new Error("Host requires an integer offset cursor.");
        }
        const entries = [...this.entries.values()]
            .map((entry) => ({ entry, reference: scopeReferenceFromEntry(entry) }))
            .filter(({ entry }) => query.slot === undefined || entry.slot === query.slot)
            .filter(({ entry, reference }) => {
                if (!("scope" in query)) return true;
                switch (query.scope) {
                    case "everywhere":
                        return entry.scope === "everywhere";
                    case "project":
                        return (
                            reference.scope === "project" && reference.projectId === query.projectId
                        );
                    case "workspace":
                        return (
                            reference.scope === "workspace" &&
                            reference.workspaceId === query.workspaceId
                        );
                    case "session":
                        return (
                            reference.scope === "session" && reference.sessionId === query.sessionId
                        );
                }
            })
            .sort((left, right) => left.entry.ordering - right.entry.ordering)
            .map(({ entry }) => entry);
        const start = query.cursor ?? 0;
        const limit = query.limit ?? 100;
        const pageEntries = entries.slice(start, start + (this.overReturn ? limit + 1 : limit));
        return {
            entries: pageEntries,
            limit,
            ...(start + pageEntries.length < entries.length
                ? {
                      nextCursor: this.unsafeCursor
                          ? MAX_SLOT_ENTRIES + 1
                          : this.repeatCursor
                            ? start
                            : start + pageEntries.length,
                  }
                : {}),
        };
    }

    async get(_ctx: Context, _agentId: string, id: string): Promise<SlotEntry | undefined> {
        const entry = this.entries.get(id);
        return entry === undefined ? undefined : structuredClone(entry);
    }

    async create(
        _ctx: Context,
        _agentId: string,
        input: SlotCreateInput & { readonly id: string; readonly authorAgentId: string },
        operation: SlotMutationRequest,
    ): Promise<SlotStoreCreateResult> {
        const existing = this.entries.get(input.id);
        if (existing !== undefined) {
            return {
                operation: "create",
                operationId: operation.operationId,
                fingerprint: operation.fingerprint,
                changed: true,
                entry: structuredClone(existing),
            };
        }
        const now = ++this.#now;
        const entry: SlotEntry = {
            ...structuredClone(input),
            createdAt: now,
            updatedAt: now,
            ordering: this.entries.size,
        };
        this.entries.set(entry.id, entry);
        return {
            operation: "create",
            operationId: operation.operationId,
            fingerprint: operation.fingerprint,
            changed: true,
            entry: structuredClone(entry),
        };
    }

    async update(
        _ctx: Context,
        _agentId: string,
        id: string,
        changes: SlotUpdateInput,
        operation: SlotMutationRequest,
    ): Promise<SlotStoreUpdateResult> {
        const existing = this.entries.get(id);
        if (existing === undefined) throw new Error("missing entry");
        const entry = {
            ...existing,
            ...structuredClone(changes),
            updatedAt: ++this.#now,
            ...(this.driftUpdateOrdering
                ? { ordering: (existing.ordering + 1) % this.entries.size }
                : {}),
        };
        this.entries.set(id, entry);
        return {
            operation: "update",
            operationId: operation.operationId,
            fingerprint: operation.fingerprint,
            changed: true,
            entry: structuredClone(entry),
        };
    }

    async reorder(
        _ctx: Context,
        _agentId: string,
        ids: readonly string[],
        operation: SlotMutationRequest,
    ): Promise<SlotStoreReorderResult> {
        const now = ++this.#now;
        ids.forEach((id, ordering) => {
            const entry = this.entries.get(id);
            if (entry !== undefined) {
                const reordered: SlotEntry = { ...entry, ordering, updatedAt: now };
                switch (this.reorderTamper) {
                    case "id":
                        reordered.id = `tampered-id-${String(ordering)}`;
                        break;
                    case "authorAgentId":
                        reordered.authorAgentId = "other-agent";
                        break;
                    case "scope":
                        if (reordered.scope === "project") reordered.projectId = "project-2";
                        break;
                    case "content":
                        reordered.content = { type: "text", markdown: "Tampered content" };
                        break;
                    case "description":
                        reordered.description = "Tampered description";
                        break;
                    case "purpose":
                        reordered.purpose = "Tampered purpose";
                        break;
                    case "createdAt":
                        reordered.createdAt += 1;
                        break;
                    case "updatedAt":
                        reordered.updatedAt = Math.max(reordered.createdAt, entry.updatedAt - 1);
                        break;
                    case undefined:
                        break;
                }
                this.entries.set(id, reordered);
            }
        });
        const entries = ids.flatMap((id) => {
            const entry = this.entries.get(id);
            return entry === undefined ? [] : [structuredClone(entry)];
        });
        return {
            operation: "reorder",
            operationId: operation.operationId,
            fingerprint: operation.fingerprint,
            changed: true,
            entryIds: [...ids],
            entries,
        };
    }

    async remove(
        _ctx: Context,
        _agentId: string,
        id: string,
        operation: SlotMutationRequest,
    ): Promise<SlotStoreRemoveResult> {
        const existing = this.entries.get(id);
        if (existing === undefined) {
            return {
                operation: "remove",
                operationId: operation.operationId,
                fingerprint: operation.fingerprint,
                removed: false,
                entryId: id,
            };
        }
        this.entries.delete(id);
        [...this.entries.values()]
            .sort((left, right) => left.ordering - right.ordering)
            .forEach((entry, ordering) => {
                this.entries.set(entry.id, { ...entry, ordering, updatedAt: ++this.#now });
            });
        return {
            operation: "remove",
            operationId: operation.operationId,
            fingerprint: operation.fingerprint,
            removed: true,
            entryId: id,
            entry: structuredClone(existing),
        };
    }

    async readReceipt(
        _ctx: Context,
        _agentId: string,
        operationId: string,
    ): Promise<SlotOperationReceipt | undefined> {
        const receipt = this.receipts.get(operationId);
        return receipt === undefined ? undefined : structuredClone(receipt);
    }

    async writeReceipt(
        _ctx: Context,
        _agentId: string,
        receipt: SlotOperationReceipt,
    ): Promise<void> {
        if (this.noOpReceiptWrite) return;
        const stored = structuredClone(receipt);
        if (this.mismatchedReceiptWrite && stored.result.operation === "create") {
            stored.result.entry.description = "Different receipt content";
        }
        this.receipts.set(receipt.operationId, stored);
    }

    async readMutationProof(
        _ctx: Context,
        _agentId: string,
        operationId: string,
    ): Promise<SlotMutationProof | undefined> {
        const proof = this.proofs.get(operationId);
        return proof === undefined ? undefined : structuredClone(proof);
    }

    async writeMutationProof(
        _ctx: Context,
        _agentId: string,
        proof: SlotMutationProof,
    ): Promise<void> {
        const existing = this.proofs.get(proof.operationId);
        if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(proof)) {
            throw new Error("immutable proof was rewritten");
        }
        this.proofs.set(proof.operationId, structuredClone(proof));
    }

    async flush(): Promise<void> {
        const callback = this.callbacks.shift();
        if (callback === undefined) throw new Error("No pending commit callback.");
        await callback(ctx);
    }

    contract(): SlotStore {
        return {
            transaction: this.transaction.bind(this),
            afterCommit: this.afterCommit.bind(this),
            list: this.list.bind(this),
            get: this.get.bind(this),
            create: this.create.bind(this),
            update: this.update.bind(this),
            reorder: this.reorder.bind(this),
            remove: this.remove.bind(this),
            readReceipt: this.readReceipt.bind(this),
            writeReceipt: this.writeReceipt.bind(this),
            readMutationProof: this.readMutationProof.bind(this),
            writeMutationProof: this.writeMutationProof.bind(this),
        };
    }
}

function configured(
    store: MemorySlotStore,
    overrides: Partial<SlotsFeatureOptions> = {},
    useClassInstance = false,
): SlotsFeature {
    let nextId = 0;
    let nextEvent = 0;
    let now = 1_000;
    return new SlotsFeature({
        store: useClassInstance ? store : store.contract(),
        scopeResolver: async (_ctx, _agentId, reference) => {
            if (reference.scope === "project") return reference.projectId !== "missing";
            if (reference.scope === "workspace") return reference.workspaceId !== "missing";
            if (reference.scope === "session") return reference.sessionId !== "missing";
            return true;
        },
        publisher: () => undefined,
        idFactory: () => `slot-${++nextId}`,
        eventIdFactory: () => `event-${++nextEvent}`,
        clock: () => ++now,
        ...overrides,
    });
}

function createInput(overrides: Record<string, unknown> = {}): SlotCreateInput {
    return {
        slot: "status-line",
        scope: "everywhere",
        content: { type: "text", markdown: "Ready" },
        description: "Status",
        purpose: "Show readiness",
        ...overrides,
    } as SlotCreateInput;
}

describe("SlotsFeature", () => {
    it("exposes a closed TypeBox host store contract", () => {
        expect(
            Value.Check(slotStoreSchema, {
                transaction: async (_ctx: Context, work: (ctx: Context) => Promise<unknown>) =>
                    await work(ctx),
                afterCommit: () => undefined,
                list: async () => ({ entries: [], limit: 1 }),
                get: async () => undefined,
                create: async () => {
                    throw new Error("unused");
                },
                update: async () => undefined,
                reorder: async () => [],
                remove: async () => undefined,
                readReceipt: async () => undefined,
                writeReceipt: async () => undefined,
                readMutationProof: async () => undefined,
                writeMutationProof: async () => undefined,
            }),
        ).toBe(true);
    });

    it("defines bounded generic content and opaque applet actions", () => {
        expect(
            Value.Check(slotActionSchema, {
                type: "open-applet",
                appletId: "host-owned-applet-id",
            }),
        ).toBe(true);
        expect(
            Value.Check(slotActionSchema, {
                type: "open-applet",
                applet: "name-is-not-a-feature-field",
            }),
        ).toBe(false);
        expect(
            Value.Check(slotContentSchema, {
                type: "button",
                label: "Open",
                action: { type: "send-current-chat", message: "Hi" },
            }),
        ).toBe(true);
        expect(allowedSlotScopes.sidebar).toEqual(["everywhere"]);
    });

    it("uses exact discriminated scope contracts for references and creation", () => {
        expect(Value.Check(slotScopeReferenceSchema, { scope: "everywhere" })).toBe(true);
        expect(
            Value.Check(slotScopeReferenceSchema, {
                scope: "everywhere",
                projectId: "not-allowed",
            }),
        ).toBe(false);
        expect(
            Value.Check(slotScopeReferenceSchema, {
                scope: "project",
                workspaceId: "wrong-target",
            }),
        ).toBe(false);
        expect(
            Value.Check(slotCreateInputSchema, {
                ...createInput(),
                scope: "project",
            }),
        ).toBe(false);
        expect(
            Value.Check(slotCreateInputSchema, {
                ...createInput(),
                scope: "project",
                projectId: "project-1",
            }),
        ).toBe(true);
        expect(
            Value.Check(slotStoreCreateInputContractSchema, {
                id: "entry-1",
                authorAgentId: "agent-1",
                slot: "status-line",
                scope: "project",
                projectId: "project-1",
                content: { type: "text", markdown: "Ready" },
                description: "Status",
                purpose: "Show readiness",
            }),
        ).toBe(true);
        expect(
            Value.Check(slotStoreCreateInputContractSchema, {
                id: "entry-1",
                authorAgentId: "agent-1",
                slot: "status-line",
                scope: "everywhere",
                projectId: "unexpected",
                content: { type: "text", markdown: "Ready" },
                description: "Status",
                purpose: "Show readiness",
            }),
        ).toBe(false);
    });

    it("uses exact discriminated scope contracts for page queries", () => {
        const common = { slot: "status-line" as const, limit: 2 };
        expect(Value.Check(slotPageQuerySchema, common)).toBe(true);
        expect(Value.Check(slotPageQuerySchema, { ...common, scope: "everywhere" })).toBe(true);
        expect(
            Value.Check(slotPageQuerySchema, {
                ...common,
                scope: "project",
                projectId: "project-1",
            }),
        ).toBe(true);
        expect(
            Value.Check(slotPageQuerySchema, {
                ...common,
                scope: "workspace",
                workspaceId: "workspace-1",
            }),
        ).toBe(true);
        expect(
            Value.Check(slotPageQuerySchema, {
                ...common,
                scope: "session",
                sessionId: "session-1",
            }),
        ).toBe(true);

        for (const query of [
            { ...common, scope: "everywhere", projectId: "wrong-target" },
            { ...common, scope: "project" },
            { ...common, scope: "project", workspaceId: "wrong-target" },
            { ...common, projectId: "missing-scope" },
            { ...common, scope: "workspace", projectId: "wrong-target" },
            { ...common, scope: "session", workspaceId: "wrong-target" },
        ]) {
            expect(Value.Check(slotPageQuerySchema, query)).toBe(false);
        }
    });

    it("persists entries through public operations and exposes the same state through tools", async () => {
        const store = new MemorySlotStore();
        const transactional: SlotEvent[] = [];
        const published: SlotEvent[] = [];
        const slots = configured(store, {
            listener: {
                onEventTransactional: (_ctx, event) => {
                    transactional.push(event);
                },
            },
            publisher: async (_ctx, event) => {
                published.push(event as SlotEvent);
            },
        });

        const created = await slots.create(
            ctx,
            "agent-1",
            createInput({
                id: "build",
                content: {
                    type: "button",
                    label: "Open report",
                    action: { type: "open-applet", appletId: "build-report" },
                },
            }),
        );
        expect(Value.Check(slotEntrySchema, created)).toBe(true);
        expect(created.authorAgentId).toBe("agent-1");
        expect(await slots.list(ctx, "agent-1")).toEqual([created]);
        expect(slots.tools(ctx, { agent: { id: "agent-1" } } as never)).toHaveLength(6);
        expect(transactional).toHaveLength(1);
        expect(published).toHaveLength(0);
        await store.flush();
        expect(published).toHaveLength(1);
        expect(published[0]?.eventId).toBe(transactional[0]?.eventId);

        const tools = slots.tools(ctx, { agent: { id: "agent-1" } } as never);
        const toolCreated = await tools[0]!.execute(ctx, {
            slot: "status-line",
            scope: "everywhere",
            content: { type: "text", markdown: "Tool-created" },
            description: "Tool entry",
            purpose: "Exercise the common tools",
        });
        expect((await tools[1]!.execute(ctx, {})).entries).toHaveLength(2);
        expect((await tools[2]!.execute(ctx, { id: created.id })).entry).toEqual(created);
        const toolUpdated = await tools[3]!.execute(ctx, {
            id: toolCreated.entry.id,
            purpose: "Updated through the common tool",
        });
        expect((await slots.get(ctx, "agent-1", toolCreated.entry.id))?.purpose).toBe(
            toolUpdated.entry.purpose,
        );
        await tools[4]!.execute(ctx, { entryIds: [created.id, toolCreated.entry.id] });
        expect((await tools[5]!.execute(ctx, { id: toolCreated.entry.id })).removed).toBe(true);

        const updated = await slots.update(ctx, "agent-1", "build", {
            description: "Build report shortcut",
        });
        expect(updated.description).toBe("Build report shortcut");
        const second = await slots.create(
            ctx,
            "agent-1",
            createInput({
                id: "status",
                description: "Status text",
            }),
        );
        expect(
            (await slots.reorder(ctx, "agent-1", [second.id, created.id])).map((entry) => entry.id),
        ).toEqual(["status", "build"]);
        expect(await slots.remove(ctx, "agent-1", "status")).toBe(true);
        expect(await slots.remove(ctx, "agent-1", "status")).toBe(false);
        expect((await slots.list(ctx, "agent-1"))[0]?.id).toBe("build");
    });

    it("keeps create and update receipts bounded when entry detail nearly fills the budget", async () => {
        const store = new MemorySlotStore();
        const slots = configured(store, { maxOutputCharacters: 256 });
        const tools = slots.tools(ctx, { agent: { id: "agent-1" } } as never);
        const createTool = tools[0]!;
        const updateTool = tools[3]!;
        const id = "operation-budget-entry";
        const description = "d".repeat(62);
        const purpose = "p".repeat(62);

        const created = await createTool.execute(ctx, {
            id,
            slot: "status-line",
            scope: "everywhere",
            content: { type: "text", markdown: "Ready" },
            description,
            purpose,
        });
        const body = slots.formatForModel([created.entry]);
        expect(body.length).toBeGreaterThan(256 - "Slot entry created.\n".length);

        const createdText = createTool.toLLM(created)[0];
        if (createdText?.type !== "text") throw new Error("Create tool did not return text.");
        expect(createdText.text.length).toBeLessThanOrEqual(256);
        expect(createdText.text).toContain(id);

        const updated = await updateTool.execute(ctx, {
            id,
            purpose: "u".repeat(62),
        });
        const updatedText = updateTool.toLLM(updated)[0];
        if (updatedText?.type !== "text") throw new Error("Update tool did not return text.");
        expect(updatedText.text.length).toBeLessThanOrEqual(256);
        expect(updatedText.text).toContain(id);
    });

    it("rejects incompatible scopes and missing opaque scope targets", async () => {
        const store = new MemorySlotStore();
        const slots = configured(store);
        await expect(
            slots.create(
                ctx,
                "agent-1",
                createInput({
                    slot: "sidebar",
                    scope: "session",
                    sessionId: "session-1",
                }),
            ),
        ).rejects.toThrow("does not allow");
        await expect(
            slots.create(
                ctx,
                "agent-1",
                createInput({
                    scope: "project",
                    projectId: "missing",
                }),
            ),
        ).rejects.toThrow("does not exist");
        await expect(
            slots.create(
                ctx,
                "agent-1",
                createInput({
                    scope: "project",
                    projectId: "project-1",
                    sessionId: "extra",
                }),
            ),
        ).rejects.toThrow("creation input is invalid");
    });

    it("requires the scope resolver to return an explicit boolean", async () => {
        const store = new MemorySlotStore();
        const slots = configured(store, {
            scopeResolver: (() => undefined) as never,
        });
        await expect(
            slots.create(ctx, "agent-1", createInput({ id: "resolver-result" })),
        ).rejects.toThrow("invalid result");
    });

    it("uses bounded pages and rejects a host store that over-returns", async () => {
        const store = new MemorySlotStore({ overReturn: true });
        for (const [id, ordering] of [
            ["one", 0],
            ["two", 1],
            ["three", 2],
        ] as const) {
            store.entries.set(id, {
                ...createInput({ id }),
                id,
                authorAgentId: "agent-1",
                createdAt: 1,
                updatedAt: 1,
                ordering,
            });
        }
        const slots = configured(store, { maxPageSize: 2 });
        await expect(slots.listPage(ctx, "agent-1", { limit: 2 })).rejects.toThrow(
            "more entries than requested",
        );
    });

    it("rejects out-of-bounds numeric cursors", async () => {
        const store = new MemorySlotStore({ unsafeCursor: true });
        store.entries.set("one", {
            ...createInput({ id: "one" }),
            id: "one",
            authorAgentId: "agent-1",
            createdAt: 1,
            updatedAt: 1,
            ordering: 0,
        });
        store.entries.set("two", {
            ...createInput({ id: "two" }),
            id: "two",
            authorAgentId: "agent-1",
            createdAt: 2,
            updatedAt: 2,
            ordering: 1,
        });
        const slots = configured(store, { maxPageSize: 1 });
        await expect(slots.listPage(ctx, "agent-1", { limit: 1 })).rejects.toThrow(
            "invalid bounded",
        );
    });

    it("keeps maximum valid identities and cursors actionable at the minimum output budget", async () => {
        const maximumId = "i".repeat(192);
        const maximumCursor = MAX_SLOT_ENTRIES;
        expect(Value.Check(slotIdSchema, maximumId)).toBe(true);
        expect(Value.Check(slotIdSchema, `${maximumId}x`)).toBe(false);
        expect(Value.Check(slotCursorSchema, maximumCursor)).toBe(true);
        expect(Value.Check(slotCursorSchema, -1)).toBe(false);

        const store = new MemorySlotStore();
        const slots = configured(store, {
            maxOutputCharacters: 256,
            maxPageSize: 2,
        });
        const first = await slots.create(ctx, "agent-1", createInput({ id: maximumId }), {
            operationId: "minimum-output-first",
        });
        const secondMaximumId = "j".repeat(192);
        const second = await slots.create(ctx, "agent-1", createInput({ id: secondMaximumId }), {
            operationId: "minimum-output-second",
        });

        const page = await slots.listPage(ctx, "agent-1", { limit: 2 });
        expect(page.entries).toHaveLength(1);
        expect(page.entries[0]?.id).toBe(maximumId);
        expect(page.nextCursor).toBe(1);
        expect(slots.formatForModel([first]).length).toBeLessThanOrEqual(256);
        const formattedPage = slots.formatPageForModel({
            entries: [first],
            limit: 1,
            nextCursor: maximumCursor,
        });
        expect(formattedPage.length).toBeLessThanOrEqual(256);
        expect(formattedPage).toContain(maximumId);
        expect(formattedPage).toContain(String(maximumCursor));

        const tools = slots.tools(ctx, { agent: { id: "agent-1" } } as never);
        const reorderTool = tools.find((tool) => tool.name === "reorder_slots");
        const listTool = tools.find((tool) => tool.name === "list_slots");
        if (reorderTool === undefined || listTool === undefined) {
            throw new Error("Slots tools did not expose reorder and list operations.");
        }
        const reordered = await reorderTool.execute(ctx, {
            entryIds: [second.id, first.id],
        });
        const text = reorderTool.toLLM(reordered)[0];
        if (text?.type !== "text") throw new Error("Reorder tool did not return text.");
        expect(text.text.length).toBeLessThanOrEqual(256);
        expect(reordered.entries.length).toBeLessThan(2);
        expect(reordered.nextCursor).toBeDefined();
        expect(text.text).toContain(reordered.entries[0]?.id);

        const remainder = await listTool.execute(ctx, {
            cursor: reordered.nextCursor,
        });
        expect((remainder as { entries: SlotEntry[] }).entries.map((entry) => entry.id)).toContain(
            first.id,
        );
    });

    it("uses exact integer offsets for every max-length reordered identity", async () => {
        const store = new MemorySlotStore({ rejectNonIntegerCursor: true });
        const slots = configured(store, {
            maxOutputCharacters: 256,
            maxPageSize: 2,
        });
        const ids = ["i", "j", "k"].map((prefix) => prefix.repeat(192));
        for (const [index, id] of ids.entries()) {
            await slots.create(ctx, "agent-1", createInput({ id }), {
                operationId: `maximum-reorder-create-${String(index)}`,
            });
        }

        const requested = [ids[2]!, ids[1]!, ids[0]!];
        const first = await slots.reorderPage(ctx, "agent-1", requested, {
            operationId: "maximum-reorder",
        });
        expect(first.entries.map((entry) => entry.id)).toEqual([requested[0]]);
        expect(first.nextCursor).toBe(1);
        expect(Value.Check(slotCursorSchema, first.nextCursor)).toBe(true);

        const seen = first.entries.map((entry) => entry.id);
        let cursor = first.nextCursor;
        while (cursor !== undefined) {
            const page = await slots.listPage(ctx, "agent-1", {
                cursor,
                limit: 2,
            });
            seen.push(...page.entries.map((entry) => entry.id));
            cursor = page.nextCursor;
        }
        expect(seen).toEqual(requested);
    });

    it("accepts maximum Unicode create input and stores a fixed digest fingerprint", async () => {
        const store = new MemorySlotStore();
        const slots = configured(store);
        const entry = await slots.create(
            ctx,
            "a".repeat(192),
            createInput({
                id: "i".repeat(192),
                content: { type: "text", markdown: "界".repeat(12_000) },
                description: "d".repeat(2_000),
                purpose: "p".repeat(2_000),
            }),
            { operationId: "maximum-create-input" },
        );

        expect(entry.content).toEqual({ type: "text", markdown: "界".repeat(12_000) });
        const receipt = store.receipts.get("maximum-create-input");
        expect(receipt).toBeDefined();
        expect(Value.Check(slotOperationFingerprintSchema, receipt?.fingerprint)).toBe(true);
    });

    it("accepts maximum Unicode update input and preserves its hashed replay identity", async () => {
        const store = new MemorySlotStore();
        const slots = configured(store);
        const created = await slots.create(
            ctx,
            "agent-1",
            createInput({ id: "maximum-update-input" }),
            { operationId: "maximum-update-create" },
        );
        const query = Object.fromEntries(
            Array.from({ length: 32 }, (_, index) => [
                `${"k".repeat(126)}${String(index).padStart(2, "0")}`,
                "界".repeat(2_000),
            ]),
        );
        const content = {
            type: "button" as const,
            label: "l".repeat(500),
            action: {
                type: "open-applet" as const,
                appletId: "a".repeat(192),
                path: "p".repeat(2_048),
                query,
            },
        };
        const updated = await slots.update(
            ctx,
            "agent-1",
            created.id,
            { content },
            { operationId: "maximum-update-input" },
        );

        expect(updated.content).toEqual(content);
        const receipt = store.receipts.get("maximum-update-input");
        expect(receipt).toBeDefined();
        expect(Value.Check(slotOperationFingerprintSchema, receipt?.fingerprint)).toBe(true);
        expect(
            await slots.update(
                ctx,
                "agent-1",
                created.id,
                { content },
                { operationId: "maximum-update-input" },
            ),
        ).toEqual(updated);
    });

    it("accepts the maximum reorder input with maximum-length identities", async () => {
        const store = new MemorySlotStore();
        const slots = configured(store);
        const ids = Array.from(
            { length: MAX_SLOT_ENTRIES },
            (_, index) => `${String(index).padStart(3, "0")}${"i".repeat(189)}`,
        );
        for (const [ordering, id] of ids.entries()) {
            store.entries.set(id, {
                ...createInput({ id }),
                id,
                authorAgentId: "agent-1",
                createdAt: 1,
                updatedAt: 1,
                ordering,
            });
        }

        const requested = [...ids].reverse();
        const reordered = await slots.reorder(ctx, "agent-1", requested, {
            operationId: "maximum-reorder-input",
        });

        expect(reordered.map((entry) => entry.id)).toEqual(requested);
        const receipt = store.receipts.get("maximum-reorder-input");
        expect(receipt).toBeDefined();
        expect(Value.Check(slotOperationFingerprintSchema, receipt?.fingerprint)).toBe(true);
    });

    it("keeps exact replay conflicts when an operation ID receives different input", async () => {
        const store = new MemorySlotStore();
        const slots = configured(store);
        await slots.create(
            ctx,
            "agent-1",
            createInput({ id: "exact-replay", purpose: "first input" }),
            { operationId: "exact-replay-operation" },
        );

        await expect(
            slots.create(
                ctx,
                "agent-1",
                createInput({ id: "exact-replay", purpose: "different input" }),
                { operationId: "exact-replay-operation" },
            ),
        ).rejects.toThrow("different input");
    });

    it("validates persisted invariants and emits nothing when the outer transaction rolls back", async () => {
        const store = new MemorySlotStore();
        const slots = configured(store);
        const invalid = {
            ...createInput({ slot: "sidebar", scope: "everywhere" }),
            id: "invalid",
            authorAgentId: "agent-1",
            createdAt: 1,
            updatedAt: 1,
            ordering: 0,
        } satisfies Omit<SlotEntry, "id"> & { id: string };
        store.entries.set(invalid.id, {
            ...invalid,
            slot: "sidebar",
            scope: "project",
            projectId: "project-1",
        });
        await expect(slots.listPage(ctx, "agent-1")).rejects.toThrow("incompatible slot and scope");
        store.entries.clear();

        const events: SlotEvent[] = [];
        const publishing = configured(store, {
            publisher: (_ctx, event) => {
                events.push(event as SlotEvent);
            },
        });
        await expect(
            store.transaction(ctx, async (outerCtx) => {
                await publishing.create(outerCtx, "agent-1", createInput({ id: "rolled-back" }));
                throw new Error("rollback");
            }),
        ).rejects.toThrow("rollback");
        expect(store.entries).toHaveLength(0);
        expect(store.callbacks).toHaveLength(0);
        expect(events).toHaveLength(0);
    });

    it("rolls back catalog changes when writeReceipt is a no-op", async () => {
        const store = new MemorySlotStore({ noOpReceiptWrite: true });
        const slots = configured(store);

        await expect(
            slots.create(ctx, "agent-1", createInput({ id: "receipt-no-op" }), {
                operationId: "receipt-no-op-operation",
            }),
        ).rejects.toThrow("did not persist");
        expect(store.entries).toHaveLength(0);
        expect(store.receipts).toHaveLength(0);
        expect(store.callbacks).toHaveLength(0);
    });

    it("rolls back catalog changes when writeReceipt reads back different content", async () => {
        const store = new MemorySlotStore({ mismatchedReceiptWrite: true });
        const slots = configured(store);

        await expect(
            slots.create(ctx, "agent-1", createInput({ id: "receipt-mismatch" }), {
                operationId: "receipt-mismatch-operation",
            }),
        ).rejects.toThrow("different receipt content");
        expect(store.entries).toHaveLength(0);
        expect(store.receipts).toHaveLength(0);
        expect(store.callbacks).toHaveLength(0);
    });

    it("reuses a durable create identity on tool replay", async () => {
        const store = new MemorySlotStore();
        const world = agentWorld();
        let generated = 0;
        const slots = configured(store, {
            idFactory: () => `generated-${++generated}`,
        });
        const tool = slots.tools(ctx, { agent: { id: "agent-1" } } as never)[0]!;
        const callCtx = withAgentKV(
            ctx,
            new AgentKV(world.storage.persistence("agent-1"), "kv.agent-1.call.slot-call."),
        );
        const first = await tool.execute(callCtx, {
            slot: "status-line",
            scope: "everywhere",
            content: { type: "text", markdown: "Replay" },
            description: "Replay entry",
            purpose: "Test durable replay",
        });
        const replay = await tool.execute(callCtx, {
            slot: "status-line",
            scope: "everywhere",
            content: { type: "text", markdown: "Replay" },
            description: "Replay entry",
            purpose: "Test durable replay",
        });
        expect(replay.entry).toEqual(first.entry);
        const second = await tool.execute(callCtx, {
            slot: "status-line",
            scope: "everywhere",
            content: { type: "text", markdown: "Another replay-safe entry" },
            description: "Another entry",
            purpose: "Ensure call state is not feature-global",
        });
        expect(second.entry.id).not.toBe(first.entry.id);
        expect(generated).toBe(4);
        expect(store.entries).toHaveLength(2);
    });

    it("derives create changed from authoritative before and after state", async () => {
        const store = new MemorySlotStore();
        const events: SlotEvent[] = [];
        const slots = configured(store, {
            listener: {
                onEventTransactional: (_ctx, event) => {
                    events.push(event);
                },
            },
        });
        const input = createInput({ id: "create-changed" });
        const first = await slots.create(ctx, "agent-1", input, {
            operationId: "create-changed-first",
        });
        const duplicate = await slots.create(ctx, "agent-1", input, {
            operationId: "create-changed-duplicate",
        });
        expect(duplicate).toEqual(first);
        expect(store.receipts.get("create-changed-duplicate")?.result).toMatchObject({
            operation: "create",
            changed: false,
            entry: first,
        });
        expect(events).toHaveLength(1);

        expect(
            await slots.create(ctx, "agent-1", input, {
                operationId: "create-changed-duplicate",
            }),
        ).toEqual(first);
        expect(events).toHaveLength(1);

        await slots.remove(ctx, "agent-1", first.id, { operationId: "create-changed-remove" });
        const recreated = await slots.create(ctx, "agent-1", input, {
            operationId: "create-changed-recreate",
        });
        expect(recreated.id).toBe(first.id);
        expect(store.receipts.get("create-changed-recreate")?.result).toMatchObject({
            operation: "create",
            changed: true,
            entry: recreated,
        });
        expect(
            await slots.create(ctx, "agent-1", input, {
                operationId: "create-changed-recreate",
            }),
        ).toEqual(recreated);
    });

    it("persists and replays durable receipts for update, reorder, and remove", async () => {
        const store = new MemorySlotStore();
        const slots = configured(store);
        const first = await slots.create(ctx, "agent-1", createInput({ id: "first" }), {
            operationId: "create-first",
        });
        const second = await slots.create(
            ctx,
            "agent-1",
            createInput({ id: "second", description: "Second" }),
            { operationId: "create-second" },
        );

        const updated = await slots.update(
            ctx,
            "agent-1",
            first.id,
            { purpose: "Changed exactly once" },
            { operationId: "update-first" },
        );
        expect(
            await slots.update(
                ctx,
                "agent-1",
                first.id,
                { purpose: "Changed exactly once" },
                { operationId: "update-first" },
            ),
        ).toEqual(updated);

        const reordered = await slots.reorder(ctx, "agent-1", [second.id, first.id], {
            operationId: "reorder-both",
        });
        expect(
            (
                await slots.reorder(ctx, "agent-1", [second.id, first.id], {
                    operationId: "reorder-both",
                })
            ).map((entry) => entry.id),
        ).toEqual(reordered.map((entry) => entry.id));
        await slots.reorder(ctx, "agent-1", [first.id, second.id], {
            operationId: "reorder-later",
        });
        expect(
            (
                await slots.reorder(ctx, "agent-1", [second.id, first.id], {
                    operationId: "reorder-both",
                })
            ).map((entry) => entry.id),
        ).toEqual([first.id, second.id]);

        await expect(
            slots.remove(ctx, "agent-1", first.id, { operationId: "remove-first" }),
        ).resolves.toBe(true);
        await expect(
            slots.remove(ctx, "agent-1", first.id, { operationId: "remove-first" }),
        ).resolves.toBe(true);
        expect([...store.receipts.keys()].sort()).toEqual([
            "create-first",
            "create-second",
            "remove-first",
            "reorder-both",
            "reorder-later",
            "update-first",
        ]);
    });

    it("replays remove proofs across later recreation without changing the catalog", async () => {
        const store = new MemorySlotStore();
        const slots = configured(store);
        const removed = await slots.create(ctx, "agent-1", createInput({ id: "replay-remove" }), {
            operationId: "replay-remove-create",
        });
        await expect(
            slots.remove(ctx, "agent-1", removed.id, { operationId: "replay-remove-success" }),
        ).resolves.toBe(true);
        const recreated = await slots.create(
            ctx,
            "agent-1",
            createInput({
                id: removed.id,
                content: { type: "text", markdown: "Recreated" },
                description: "New entry",
                purpose: "Must survive replay",
            }),
            { operationId: "replay-remove-recreate" },
        );
        const beforeReplay = [...store.entries].map(([id, entry]) => [id, structuredClone(entry)]);
        await expect(
            slots.remove(ctx, "agent-1", removed.id, { operationId: "replay-remove-success" }),
        ).resolves.toBe(true);
        expect([...store.entries]).toEqual(beforeReplay);
        expect(store.entries.get(recreated.id)).toEqual(recreated);

        await expect(
            slots.remove(ctx, "agent-1", "replay-remove-absent", {
                operationId: "replay-remove-absent",
            }),
        ).resolves.toBe(false);
        const absentRecreated = await slots.create(
            ctx,
            "agent-1",
            createInput({ id: "replay-remove-absent" }),
            { operationId: "replay-remove-absent-recreate" },
        );
        const beforeAbsentReplay = [...store.entries].map(([id, entry]) => [
            id,
            structuredClone(entry),
        ]);
        await expect(
            slots.remove(ctx, "agent-1", absentRecreated.id, {
                operationId: "replay-remove-absent",
            }),
        ).resolves.toBe(false);
        expect([...store.entries]).toEqual(beforeAbsentReplay);
    });

    it("traverses complete slot content, action, description, and purpose at 256 characters", async () => {
        const store = new MemorySlotStore();
        const slots = configured(store, { maxOutputCharacters: 256 });
        const markdown = "m".repeat(12_000);
        const message = "q".repeat(8_000);
        const description = "d".repeat(2_000);
        const purpose = "p".repeat(2_000);
        const textEntry: SlotEntry = {
            ...createInput({
                id: "detail-text",
                content: { type: "text", markdown },
                description,
                purpose,
            }),
            id: "detail-text",
            authorAgentId: "agent-1",
            createdAt: 1,
            updatedAt: 1,
            ordering: 0,
        };
        const actionEntry: SlotEntry = {
            ...createInput({
                id: "detail-action",
                content: {
                    type: "button",
                    label: "Send",
                    action: { type: "send-current-chat", message },
                },
                description,
                purpose,
            }),
            id: "detail-action",
            authorAgentId: "agent-1",
            createdAt: 2,
            updatedAt: 2,
            ordering: 1,
        };
        store.entries.set(textEntry.id, textEntry);
        store.entries.set(actionEntry.id, actionEntry);
        const collectDetail = async (id: string): Promise<string> => {
            const parts: string[] = [];
            let detailOffset: number | undefined;
            do {
                const page = await slots.getPage(ctx, "agent-1", id, {
                    detailLimit: 100,
                    ...(detailOffset === undefined ? {} : { detailOffset }),
                });
                expect(Value.Check(slotDetailPageSchema, page)).toBe(true);
                expect(slots.formatDetailPageForModel(page).length).toBeLessThanOrEqual(256);
                if (page.entry === null)
                    throw new Error("The slot entry unexpectedly disappeared.");
                parts.push(page.detail);
                const next = page.nextDetailOffset;
                if (next !== undefined) {
                    expect(next).toBeGreaterThan(page.detailOffset);
                }
                detailOffset = next;
            } while (detailOffset !== undefined);
            return parts.join("");
        };

        const textDetail = await collectDetail(textEntry.id);
        expect(textDetail).toContain(`"markdown":"${markdown}"`);
        expect(textDetail).toContain(`Description: ${description}`);
        expect(textDetail).toContain(`Purpose: ${purpose}`);
        const actionDetail = await collectDetail(actionEntry.id);
        expect(actionDetail).toContain(`"message":"${message}"`);
        expect(actionDetail).toContain(`"label":"Send"`);
    });

    it("rejects a removed receipt whose archived owner was corrupted", async () => {
        const store = new MemorySlotStore();
        const slots = configured(store);
        await slots.create(ctx, "agent-1", createInput({ id: "removed" }), {
            operationId: "removed-create",
        });
        await expect(
            slots.remove(ctx, "agent-1", "removed", { operationId: "removed-operation" }),
        ).resolves.toBe(true);
        const receipt = store.receipts.get("removed-operation");
        if (receipt?.result.operation === "remove" && receipt.result.removed) {
            receipt.result.entry.authorAgentId = "other-agent";
        }
        await expect(
            slots.remove(ctx, "agent-1", "removed", { operationId: "removed-operation" }),
        ).rejects.toThrow("not the owner");
    });

    it("rejects schema-valid reorder tampering outside ordering and forward updatedAt", async () => {
        const tamperedFields: readonly ReorderTamper[] = [
            "id",
            "authorAgentId",
            "scope",
            "content",
            "description",
            "purpose",
            "createdAt",
            "updatedAt",
        ];
        for (const [index, field] of tamperedFields.entries()) {
            const store = new MemorySlotStore({ reorderTamper: field });
            const slots = configured(store);
            const first = await slots.create(
                ctx,
                "agent-1",
                createInput({
                    id: `tamper-first-${String(index)}`,
                    scope: "project",
                    projectId: "project-1",
                }),
                { operationId: `tamper-create-first-${String(index)}` },
            );
            const second = await slots.create(
                ctx,
                "agent-1",
                createInput({
                    id: `tamper-second-${String(index)}`,
                    scope: "project",
                    projectId: "project-1",
                }),
                { operationId: `tamper-create-second-${String(index)}` },
            );
            await slots.update(
                ctx,
                "agent-1",
                first.id,
                { purpose: "Advance first timestamp" },
                { operationId: `tamper-update-first-${String(index)}` },
            );
            await slots.update(
                ctx,
                "agent-1",
                second.id,
                { purpose: "Advance second timestamp" },
                { operationId: `tamper-update-second-${String(index)}` },
            );

            await expect(
                slots.reorder(ctx, "agent-1", [second.id, first.id], {
                    operationId: `tamper-reorder-${String(index)}`,
                }),
            ).rejects.toThrow();
        }
    });

    it("rejects a host update that changes the durable ordering", async () => {
        const store = new MemorySlotStore({ driftUpdateOrdering: true });
        const slots = configured(store);
        await slots.create(ctx, "agent-1", createInput({ id: "one" }), {
            operationId: "drift-create-one",
        });
        await slots.create(ctx, "agent-1", createInput({ id: "two" }), {
            operationId: "drift-create-two",
        });
        await slots.create(ctx, "agent-1", createInput({ id: "three" }), {
            operationId: "drift-create-three",
        });
        await expect(
            slots.update(
                ctx,
                "agent-1",
                "one",
                { purpose: "drift" },
                { operationId: "drift-update" },
            ),
        ).rejects.toThrow("ordering");
    });

    it("rejects mutations by an agent that does not own the entry", async () => {
        const store = new MemorySlotStore();
        const slots = configured(store);
        await slots.create(ctx, "owner-agent", createInput({ id: "owned" }), {
            operationId: "owner-create",
        });
        await expect(
            slots.update(
                ctx,
                "other-agent",
                "owned",
                { purpose: "steal" },
                { operationId: "owner-update" },
            ),
        ).rejects.toThrow("not the owner");
        await expect(
            slots.remove(ctx, "other-agent", "owned", { operationId: "owner-remove" }),
        ).rejects.toThrow("not the owner");
    });

    it("denies cross-agent reads by default and allows an injected read policy in tools", async () => {
        const store = new MemorySlotStore();
        const defaultSlots = configured(store);
        const created = await defaultSlots.create(
            ctx,
            "owner-agent",
            createInput({ id: "private-entry" }),
            { operationId: "private-create" },
        );

        await expect(defaultSlots.get(ctx, "reader-agent", created.id)).rejects.toThrow(
            "not authorized",
        );
        await expect(defaultSlots.listPage(ctx, "reader-agent")).rejects.toThrow("not authorized");

        const authorizationCalls: Array<[string, string, string]> = [];
        const authorizedSlots = configured(store, {
            readAuthorization: (_ctx, requester, owner, operation) => {
                authorizationCalls.push([requester, owner, operation]);
                return requester === "reader-agent" && owner === "owner-agent";
            },
        });
        await expect(authorizedSlots.get(ctx, "reader-agent", created.id)).resolves.toEqual(
            created,
        );
        const tools = authorizedSlots.tools(ctx, {
            agent: { id: "reader-agent" },
        } as never);
        const listTool = tools.find((tool) => tool.name === "list_slots");
        const getTool = tools.find((tool) => tool.name === "get_slot");
        if (listTool === undefined || getTool === undefined) {
            throw new Error("Slots tools did not expose read operations.");
        }
        await expect(listTool.execute(ctx, {})).resolves.toMatchObject({
            entries: [created],
        });
        await expect(getTool.execute(ctx, { id: created.id })).resolves.toMatchObject({
            entry: created,
        });
        expect(authorizationCalls).toEqual([
            ["reader-agent", "owner-agent", "get"],
            ["reader-agent", "owner-agent", "list"],
            ["reader-agent", "owner-agent", "get"],
        ]);
    });

    it("delivers one deeply frozen event instance through both phases and preserves listener this", async () => {
        class Listener {
            transactional: SlotEvent | undefined;
            postCommit: SlotEvent | undefined;

            onEventTransactional(_ctx: Context, event: SlotEvent): void {
                this.transactional = event;
            }

            onEvent(_ctx: Context, event: SlotEvent): void {
                this.postCommit = event;
            }
        }

        const store = new MemorySlotStore();
        const listener = new Listener();
        const slots = configured(store, { listener });
        await slots.create(ctx, "agent-1", createInput({ id: "frozen" }), {
            operationId: "frozen-create",
        });
        expect(listener.transactional).toBeDefined();
        expect(Object.isFrozen(listener.transactional)).toBe(true);
        if (listener.transactional !== undefined && "entry" in listener.transactional) {
            expect(Object.isFrozen(listener.transactional.entry)).toBe(true);
        }
        expect(listener.postCommit).toBeUndefined();
        await store.flush();
        expect(listener.postCommit).toBe(listener.transactional);
    });

    it("contains post-commit observer failures without hiding the publisher", async () => {
        const store = new MemorySlotStore();
        const published: SlotEvent[] = [];
        const reported: unknown[] = [];
        const slots = configured(store, {
            listener: {
                onEvent: () => {
                    throw { hostile: true };
                },
            },
            publisher: (_ctx, event) => {
                published.push(event);
            },
            onPostCommitError: (_ctx, _event, error) => {
                reported.push(error);
            },
        });
        await slots.create(ctx, "agent-1", createInput({ id: "observer-failure" }), {
            operationId: "observer-create",
        });
        await store.flush();
        expect(published).toHaveLength(1);
        expect(reported).toHaveLength(1);
        expect(reported[0]).toEqual({ hostile: true });
    });

    it("rolls back the host catalog and receipt when the transactional listener fails", async () => {
        const store = new MemorySlotStore();
        const slots = configured(store, {
            listener: {
                onEventTransactional: () => {
                    throw new Error("transactional failure");
                },
            },
        });
        await expect(
            slots.create(ctx, "agent-1", createInput({ id: "listener-rollback" }), {
                operationId: "listener-rollback-op",
            }),
        ).rejects.toThrow("transactional failure");
        expect(store.entries).toHaveLength(0);
        expect(store.receipts).toHaveLength(0);
        expect(store.callbacks).toHaveLength(0);
    });

    it("does not trust a schema-valid corrupted receipt over the authoritative entry", async () => {
        const store = new MemorySlotStore();
        const slots = configured(store);
        const created = await slots.create(ctx, "agent-1", createInput({ id: "authoritative" }), {
            operationId: "authoritative-create",
        });
        const updated = await slots.update(
            ctx,
            "agent-1",
            created.id,
            { purpose: "authoritative purpose" },
            { operationId: "authoritative-update" },
        );
        const receipt = store.receipts.get("authoritative-update");
        expect(receipt?.result.operation).toBe("update");
        if (receipt?.result.operation === "update") {
            receipt.result.entry.purpose = "corrupted receipt";
        }
        expect(
            await slots.update(
                ctx,
                "agent-1",
                created.id,
                { purpose: "authoritative purpose" },
                { operationId: "authoritative-update" },
            ),
        ).toEqual(updated);
    });

    it("rejects a repeating cursor during a transactional read", async () => {
        const store = new MemorySlotStore({ repeatCursor: true });
        store.entries.set("one", {
            ...createInput({ id: "one" }),
            id: "one",
            authorAgentId: "agent-1",
            createdAt: 1,
            updatedAt: 1,
            ordering: 0,
        });
        store.entries.set("two", {
            ...createInput({ id: "two" }),
            id: "two",
            authorAgentId: "agent-1",
            createdAt: 2,
            updatedAt: 2,
            ordering: 1,
        });
        const slots = configured(store, { maxPageSize: 1 });
        await expect(
            slots.update(
                ctx,
                "agent-1",
                "one",
                { purpose: "will not reach write" },
                { operationId: "repeat-cursor-op" },
            ),
        ).rejects.toThrow("cursor");
    });

    it("accepts a class-backed store directly and preserves its method ownership", async () => {
        const store = new MemorySlotStore();
        const slots = configured(store, {}, true);
        const created = await slots.create(ctx, "agent-1", createInput({ id: "class-backed" }), {
            operationId: "class-backed-create",
        });
        expect(await slots.get(ctx, "agent-1", created.id)).toEqual(created);
        expect(Value.Check(slotStoreSchema, store.contract())).toBe(true);
    });
});
