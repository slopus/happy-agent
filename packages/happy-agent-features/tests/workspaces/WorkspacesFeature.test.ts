import { AgentKV, agentKV, withAgentKV } from "@slopus/happy-agent-base";
import { Value } from "@sinclair/typebox/value";
import { createRootContext, type Context } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import {
    workspaceFeatureOptionsSchema,
    type Workspace,
    type WorkspaceEvent,
    type WorkspaceFeatureListener,
    type WorkspaceMutationProof,
    type WorkspaceOperationReceipt,
    type WorkspacePage,
    type WorkspaceStore,
    type WorkspaceStoreArchiveInput,
    type WorkspaceStoreCreateInput,
    type WorkspaceStoreMutationResult,
    type WorkspaceMutationRequest,
    type WorkspaceTransferStoreResult,
    type WorkspaceTransactionChange,
    WorkspacesFeature,
} from "../../sources/workspaces/index.js";
import {
    workspaceMutationProofSchema,
    workspaceOperationStateSchema,
    workspaceOperationReceiptSchema,
    workspaceBranchMetadataPageSchema,
    workspaceDetailPageSchema,
    workspaceSchema,
} from "../../sources/workspaces/index.js";
import { agentWorld } from "../support/agentWorld.js";

const root = createRootContext().named("workspaces-feature-test");
const agent = "agent-a";
const otherAgent = "agent-b";

function makeWorkspace(
    id: string,
    ownerAgentId = agent,
    overrides: Partial<Workspace> = {},
): Workspace {
    return {
        id,
        ownerAgentId,
        projectRef: "project-opaque",
        name: id,
        status: "ready",
        createdAt: 1,
        updatedAt: 1,
        ...overrides,
    };
}

class FakeWorkspaceStore implements WorkspaceStore {
    readonly #rows = new Map<string, Workspace>();
    readonly #receipts = new Map<string, WorkspaceOperationReceipt>();
    readonly #proofs = new Map<string, WorkspaceMutationProof>();
    readonly #callbacks: Array<{
        readonly agentId: string;
        readonly callback: (ctx: Context) => void | Promise<void>;
    }> = [];
    readonly #calls: Array<{ readonly method: string; readonly agentId: string }> = [];
    #queue: Promise<void> = Promise.resolve();
    #depth = 0;
    #snapshot:
        | {
              rows: Map<string, Workspace>;
              receipts: Map<string, WorkspaceOperationReceipt>;
              proofs: Map<string, WorkspaceMutationProof>;
          }
        | undefined;
    #tamperReceiptOnRead = false;
    #tamperProofOnRead = false;

    get rows(): Map<string, Workspace> {
        return this.#rows;
    }

    get receipts(): Map<string, WorkspaceOperationReceipt> {
        return this.#receipts;
    }

    get proofs(): Map<string, WorkspaceMutationProof> {
        return this.#proofs;
    }

    get calls(): readonly { readonly method: string; readonly agentId: string }[] {
        return this.#calls;
    }

    tamperReceiptOnNextRead(): void {
        this.#tamperReceiptOnRead = true;
    }

    tamperProofOnNextRead(): void {
        this.#tamperProofOnRead = true;
    }

    async transaction(
        _ctx: Context,
        _actingAgentId: string,
        work: (txCtx: Context) => Promise<WorkspaceTransactionChange>,
    ): Promise<WorkspaceTransactionChange> {
        if (this.#depth > 0) return await this.#withinTransaction(work);
        const run = this.#queue.then(() => this.#withinTransaction(work));
        this.#queue = run.then(
            () => undefined,
            () => undefined,
        );
        return await run;
    }

    afterCommit(
        _ctx: Context,
        actingAgentId: string,
        callback: (postCommitCtx: Context) => void | Promise<void>,
    ): void {
        this.#calls.push({ method: "afterCommit", agentId: actingAgentId });
        this.#callbacks.push({ agentId: actingAgentId, callback });
    }

    async create(
        _ctx: Context,
        actingAgentId: string,
        input: WorkspaceStoreCreateInput,
        operation: WorkspaceMutationRequest,
    ): Promise<Extract<WorkspaceStoreMutationResult, { operation: "create" }>> {
        this.#calls.push({ method: "create", agentId: actingAgentId });
        const created = makeWorkspace(input.id, input.ownerAgentId, {
            ...(input.projectRef === undefined ? {} : { projectRef: input.projectRef }),
            ...(input.baseRef === undefined ? {} : { baseRef: input.baseRef }),
            name: input.name,
            createdAt: 10,
            updatedAt: 10,
        });
        this.#rows.set(created.id, created);
        return {
            operation: "create",
            agentId: actingAgentId,
            operationId: operation.operationId,
            fingerprint: operation.fingerprint,
            changed: true,
            workspace: created,
        };
    }

    async list(
        _ctx: Context,
        actingAgentId: string,
        query: { readonly cursor?: string; readonly limit?: number; readonly projectRef?: string },
    ): Promise<WorkspacePage> {
        this.#calls.push({ method: "list", agentId: actingAgentId });
        const values = [...this.#rows.values()].filter(
            (workspace) =>
                query.projectRef === undefined || workspace.projectRef === query.projectRef,
        );
        values.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
        const start = query.cursor === undefined ? 0 : Number(query.cursor);
        const limit = query.limit ?? 50;
        const page = values.slice(start, start + limit);
        const next = start + page.length < values.length ? String(start + page.length) : undefined;
        return {
            workspaces: page,
            ...(next === undefined ? {} : { nextCursor: next }),
        };
    }

    async get(_ctx: Context, actingAgentId: string, id: string): Promise<Workspace | undefined> {
        this.#calls.push({ method: "get", agentId: actingAgentId });
        return this.#rows.get(id);
    }

    async transfer(
        _ctx: Context,
        actingAgentId: string,
        input: {
            readonly targetWorkspaceId?: string;
            readonly workspaceId?: string;
            readonly targetProjectRef?: string;
        },
        operation: WorkspaceMutationRequest,
    ): Promise<WorkspaceTransferStoreResult> {
        this.#calls.push({ method: "transfer", agentId: actingAgentId });
        if (input.targetWorkspaceId !== undefined) {
            const current = this.#rows.get(input.targetWorkspaceId);
            if (current === undefined) throw new Error("missing target workspace");
            this.#rows.set(input.targetWorkspaceId, {
                ...current,
                updatedAt: current.updatedAt + 1,
            });
            return {
                agentId: actingAgentId,
                operationId: operation.operationId,
                fingerprint: operation.fingerprint,
                changed: true,
                state: "scheduled",
                targetWorkspaceId: input.targetWorkspaceId,
            };
        }
        const current = this.#rows.get(input.workspaceId!);
        if (current === undefined) throw new Error("missing workspace");
        const moved = {
            ...current,
            projectRef: input.targetProjectRef!,
            updatedAt: current.updatedAt + 1,
        };
        this.#rows.set(moved.id, moved);
        return {
            agentId: actingAgentId,
            operationId: operation.operationId,
            fingerprint: operation.fingerprint,
            changed: true,
            state: "transferred",
            workspace: {
                id: moved.id,
                projectRef: moved.projectRef,
                ownerAgentId: moved.ownerAgentId,
            },
        };
    }

    async archive(
        _ctx: Context,
        actingAgentId: string,
        input: WorkspaceStoreArchiveInput,
        operation: WorkspaceMutationRequest,
    ): Promise<Extract<WorkspaceStoreMutationResult, { operation: "archive" }>> {
        this.#calls.push({ method: "archive", agentId: actingAgentId });
        const current = this.#rows.get(input.workspaceId);
        if (current === undefined) throw new Error("missing workspace");
        const archived = makeWorkspace(input.workspaceId, current.ownerAgentId, {
            ...current,
            status: "archived",
            archivedAt: current.updatedAt + 1,
            updatedAt: current.updatedAt + 1,
        });
        this.#rows.set(archived.id, archived);
        return {
            operation: "archive",
            agentId: actingAgentId,
            operationId: operation.operationId,
            fingerprint: operation.fingerprint,
            changed: true,
            workspace: archived,
        };
    }

    async branchMetadata(_ctx: Context, actingAgentId: string, id: string) {
        this.#calls.push({ method: "branchMetadata", agentId: actingAgentId });
        return {
            workspaceId: id,
            branch: "worktree/demo",
            ahead: 1,
            behind: 2,
            detached: false,
        };
    }

    async readReceipt(
        _ctx: Context,
        actingAgentId: string,
        operationId: string,
    ): Promise<WorkspaceOperationReceipt | undefined> {
        this.#calls.push({ method: "readReceipt", agentId: actingAgentId });
        const value = this.#receipts.get(this.#key(actingAgentId, operationId));
        if (value === undefined) return undefined;
        if (this.#tamperReceiptOnRead) {
            this.#tamperReceiptOnRead = false;
            return {
                ...value,
                result: { ...value.result, changed: !value.result.changed },
            } as WorkspaceOperationReceipt;
        }
        return structuredClone(value);
    }

    async writeReceipt(
        _ctx: Context,
        actingAgentId: string,
        receipt: WorkspaceOperationReceipt,
    ): Promise<void> {
        this.#calls.push({ method: "writeReceipt", agentId: actingAgentId });
        this.#receipts.set(this.#key(actingAgentId, receipt.operationId), structuredClone(receipt));
    }

    async readMutationProof(
        _ctx: Context,
        actingAgentId: string,
        operationId: string,
    ): Promise<WorkspaceMutationProof | undefined> {
        this.#calls.push({ method: "readMutationProof", agentId: actingAgentId });
        const value = this.#proofs.get(this.#key(actingAgentId, operationId));
        if (value === undefined) return undefined;
        if (this.#tamperProofOnRead) {
            this.#tamperProofOnRead = false;
            return { ...value, changed: !value.changed };
        }
        return structuredClone(value);
    }

    async writeMutationProof(
        _ctx: Context,
        actingAgentId: string,
        proof: WorkspaceMutationProof,
    ): Promise<void> {
        this.#calls.push({ method: "writeMutationProof", agentId: actingAgentId });
        this.#proofs.set(this.#key(actingAgentId, proof.operationId), structuredClone(proof));
    }

    async #withinTransaction(
        work: (txCtx: Context) => Promise<WorkspaceTransactionChange>,
    ): Promise<WorkspaceTransactionChange> {
        if (this.#depth === 0) {
            this.#snapshot = {
                rows: new Map([...this.#rows].map(([id, value]) => [id, structuredClone(value)])),
                receipts: new Map(
                    [...this.#receipts].map(([id, value]) => [id, structuredClone(value)]),
                ),
                proofs: new Map(
                    [...this.#proofs].map(([id, value]) => [id, structuredClone(value)]),
                ),
            };
        }
        this.#depth++;
        try {
            const result = await work(root);
            this.#depth--;
            if (this.#depth === 0) {
                this.#snapshot = undefined;
                const callbacks = this.#callbacks.splice(0);
                for (const entry of callbacks) await entry.callback(root);
            }
            return result;
        } catch (error: unknown) {
            this.#depth--;
            if (this.#depth === 0) {
                const snapshot = this.#snapshot;
                this.#snapshot = undefined;
                if (snapshot !== undefined) {
                    this.#rows.clear();
                    for (const [id, value] of snapshot.rows) this.#rows.set(id, value);
                    this.#receipts.clear();
                    for (const [id, value] of snapshot.receipts) this.#receipts.set(id, value);
                    this.#proofs.clear();
                    for (const [id, value] of snapshot.proofs) this.#proofs.set(id, value);
                }
                this.#callbacks.length = 0;
            }
            throw error;
        }
    }

    #key(agentId: string, operationId: string): string {
        return `${agentId}:${operationId}`;
    }
}

function feature(
    store: FakeWorkspaceStore,
    overrides: Partial<ConstructorParameters<typeof WorkspacesFeature>[0]> = {},
): WorkspacesFeature {
    let nextId = 0;
    let nextEvent = 0;
    return new WorkspacesFeature({
        store,
        idFactory: (_ctx, agentId) => `${agentId}-workspace-${++nextId}`,
        eventIdFactory: (_ctx, agentId) => `${agentId}-event-${++nextEvent}`,
        clock: () => 100,
        ...overrides,
    });
}

function callContext(agentId = agent): Context {
    const world = agentWorld();
    return withAgentKV(
        root,
        new AgentKV(world.storage.persistence(agentId), "workspace-tool-call."),
    );
}

describe("WorkspacesFeature", () => {
    it("uses acting-agent scope across public methods and tools", async () => {
        const store = new FakeWorkspaceStore();
        const workspaces = feature(store);
        const toolCtx = callContext();
        const tools = workspaces.tools(toolCtx, { agent: { id: agent } } as never);
        expect(tools.map((tool) => tool.name)).toEqual([
            "create_workspace",
            "list_workspaces",
            "get_workspace",
            "transfer_workspace",
            "archive_workspace",
            "get_workspace_branch_metadata",
        ]);
        const created = await tools[0]!.execute(toolCtx, { name: "Implement workspaces" });
        expect(created.ownerAgentId).toBe(agent);
        expect(await workspaces.get(root, agent, created.id)).toEqual(created);
        expect((await tools[1]!.execute(root, { limit: 1 })).workspaces).toEqual([created]);
        expect((await tools[2]!.execute(root, { workspaceId: created.id })).workspace).toEqual(
            created,
        );
        expect(await tools[5]!.execute(root, { workspaceId: created.id })).toMatchObject({
            workspaceId: created.id,
            branch: "worktree/demo",
        });
        expect(Value.Check(workspaceSchema, created)).toBe(true);
        expect(store.calls.every((call) => call.agentId === agent)).toBe(true);
    });

    it("requires a host operation identity outside a durable tool call", async () => {
        const workspaces = feature(new FakeWorkspaceStore());
        await expect(
            workspaces.create(root, agent, { id: "host-id", name: "Host request" }),
        ).rejects.toThrow("operation identity");
        await expect(
            workspaces.archive(root, agent, "missing", { operationId: "archive-op" }),
        ).rejects.toThrow("not found");
    });

    it("allocates and replays a direct create ID without call-scoped KV", async () => {
        const store = new FakeWorkspaceStore();
        let allocated = 0;
        const workspaces = feature(store, {
            idFactory: (ctx, agentId) => {
                expect(agentKV(ctx)).toBeUndefined();
                return `${agentId}-direct-${++allocated}`;
            },
        });
        const input = { operationId: "direct-create", name: "Direct create" };

        const first = await workspaces.create(root, agent, input);
        const replay = await workspaces.create(root, agent, input);

        expect(first.id).toBe("agent-a-direct-1");
        expect(replay).toEqual(first);
        expect(allocated).toBe(1);
        expect(store.calls.filter((call) => call.method === "create")).toHaveLength(1);
        expect(store.receipts.get(`${agent}:direct-create`)).toMatchObject({
            agentId: agent,
            operation: "create",
            operationId: "direct-create",
            result: { workspace: { id: first.id } },
        });
        expect(store.proofs.get(`${agent}:direct-create`)).toMatchObject({
            subjectId: first.id,
            result: { workspace: { id: first.id } },
        });
    });

    it("keeps concurrent direct creates independently durable", async () => {
        const store = new FakeWorkspaceStore();
        let allocated = 0;
        const workspaces = feature(store, {
            idFactory: async (_ctx, agentId) => `${agentId}-concurrent-${++allocated}`,
        });

        const results = await Promise.all([
            workspaces.create(root, agent, {
                operationId: "concurrent-create-a",
                name: "A",
            }),
            workspaces.create(root, agent, {
                operationId: "concurrent-create-b",
                name: "B",
            }),
        ]);

        expect(results.map((result) => result.id).sort()).toEqual([
            "agent-a-concurrent-1",
            "agent-a-concurrent-2",
        ]);
        expect(allocated).toBe(2);
        expect(store.rows.size).toBe(2);
        expect(store.receipts.size).toBe(2);
        expect(store.proofs.size).toBe(2);
    });

    it("persists generated create identities in the tool call scope", async () => {
        const world = agentWorld();
        const kv = new AgentKV(world.storage.persistence(agent), "workspace-tool-call.");
        const ctx = withAgentKV(root, kv);
        const store = new FakeWorkspaceStore();
        const workspaces = feature(store);
        const tool = workspaces.tools(ctx, { agent: { id: agent } } as never)[0]!;

        const created = await tool.execute(ctx, { name: "Scoped create" });
        const operationState = await kv.read(root, "workspace.create.operation");
        const idState = await kv.read(root, "workspace.create.id");

        expect(Value.Check(workspaceOperationStateSchema, operationState)).toBe(true);
        expect(Value.Check(workspaceOperationStateSchema, idState)).toBe(true);
        expect(operationState).toMatchObject({ fingerprint: expect.any(String) });
        expect(idState).toMatchObject({ id: created.id, fingerprint: expect.any(String) });
        expect(
            store.receipts.get(`${agent}:${(operationState as { id: string }).id}`),
        ).toMatchObject({
            result: { workspace: { id: created.id } },
        });
    });

    it("reuses call-scoped durable IDs only for identical input", async () => {
        const store = new FakeWorkspaceStore();
        const workspaces = feature(store);
        const toolCtx = callContext();
        const tool = workspaces.tools(toolCtx, { agent: { id: agent } } as never)[0]!;
        const first = await tool.execute(toolCtx, { name: "Replay me" });
        const replay = await tool.execute(toolCtx, { name: "Replay me" });
        expect(replay).toEqual(first);
        await expect(tool.execute(toolCtx, { name: "Different" })).rejects.toThrow("reused");
        expect(store.calls.filter((call) => call.method === "create")).toHaveLength(1);
    });

    it("keeps concurrent host mutations independently addressable", async () => {
        const store = new FakeWorkspaceStore();
        const workspaces = feature(store);
        const results = await Promise.all([
            workspaces.create(root, agent, {
                id: "parallel-a",
                operationId: "parallel-op-a",
                name: "A",
            }),
            workspaces.create(root, agent, {
                id: "parallel-b",
                operationId: "parallel-op-b",
                name: "B",
            }),
        ]);
        expect(results.map((result) => result.id).sort()).toEqual(["parallel-a", "parallel-b"]);
        expect(store.rows.size).toBe(2);
    });

    it("archives and transfers through the same durable receipt boundary", async () => {
        const store = new FakeWorkspaceStore();
        store.rows.set("source", makeWorkspace("source"));
        store.rows.set("target", makeWorkspace("target"));
        const events: WorkspaceEvent[] = [];
        const workspaces = feature(store, {
            listener: {
                onEvent: (_ctx, event) => {
                    events.push(event);
                },
            },
        });

        const archived = await workspaces.archive(root, agent, "source", {
            operationId: "archive-source",
        });
        expect(archived.status).toBe("archived");
        const scheduled = await workspaces.transfer(root, agent, {
            targetWorkspaceId: "target",
            operationId: "schedule-target",
        });
        expect(scheduled).toMatchObject({
            state: "scheduled",
            targetWorkspaceId: "target",
        });
        const moved = await workspaces.transfer(root, agent, {
            workspaceId: "target",
            targetProjectRef: "project-next",
            operationId: "move-target",
        });
        expect(moved).toMatchObject({
            state: "transferred",
            workspace: { id: "target", projectRef: "project-next" },
        });
        expect(events.map((event) => event.type)).toEqual([
            "workspace_archived",
            "workspace_transfer_scheduled",
            "workspace_transferred",
        ]);
        expect(store.receipts.size).toBe(3);
        expect(store.proofs.size).toBe(3);
    });

    it("rolls back nested transactions without receipts or post-commit events", async () => {
        const store = new FakeWorkspaceStore();
        const events: WorkspaceEvent[] = [];
        const workspaces = feature(store, {
            listener: {
                onEvent: (_ctx, event) => {
                    events.push(event);
                },
            },
        });
        await expect(
            store.transaction(root, agent, async (outerCtx) => {
                await workspaces.create(outerCtx, agent, {
                    id: "nested",
                    operationId: "nested-op",
                    name: "Nested",
                });
                throw new Error("outer rollback");
            }),
        ).rejects.toThrow("outer rollback");
        expect(store.rows.size).toBe(0);
        expect(store.receipts.size).toBe(0);
        expect(store.proofs.size).toBe(0);
        expect(events).toHaveLength(0);
    });

    it("delivers one frozen event to a class listener after the outer commit", async () => {
        const store = new FakeWorkspaceStore();
        class Listener implements WorkspaceFeatureListener {
            #transactional: WorkspaceEvent[] = [];
            #committed: WorkspaceEvent[] = [];

            get transactional(): readonly WorkspaceEvent[] {
                return this.#transactional;
            }

            get committed(): readonly WorkspaceEvent[] {
                return this.#committed;
            }

            onEventTransactional(_ctx: Context, event: WorkspaceEvent): void {
                this.#transactional.push(event);
            }

            onEvent(_ctx: Context, event: WorkspaceEvent): void {
                this.#committed.push(event);
            }
        }
        const listener = new Listener();
        const workspaces = feature(store, { listener });
        await workspaces.create(root, agent, {
            id: "stable",
            operationId: "stable-op",
            name: "Stable",
        });
        expect(listener.transactional[0]).toBe(listener.committed[0]);
        expect(Object.isFrozen(listener.transactional[0])).toBe(true);
        const event = listener.transactional[0]!;
        if ("workspace" in event) {
            expect(Object.isFrozen(event.workspace)).toBe(true);
        }
    });

    it("denies another owner by default and allows only the injected policy", async () => {
        const store = new FakeWorkspaceStore();
        store.rows.set("foreign", makeWorkspace("foreign", otherAgent));
        const denied = feature(store);
        await expect(denied.get(root, agent, "foreign")).rejects.toThrow("not authorized");
        const allowed = feature(store, {
            authorization: async (_ctx, acting, owner, action) =>
                acting === agent && owner === otherAgent && action === "get",
        });
        await expect(allowed.get(root, agent, "foreign")).resolves.toMatchObject({
            id: "foreign",
            ownerAgentId: otherAgent,
        });
        await expect(
            allowed.archive(root, agent, "foreign", { operationId: "foreign-archive" }),
        ).rejects.toThrow("not the owner");
    });

    it("rejects malformed options, host identities, and bounded pages", async () => {
        const store = new FakeWorkspaceStore();
        expect(Value.Check(workspaceFeatureOptionsSchema, { store, extra: true })).toBe(false);
        expect(() => new WorkspacesFeature({ store, extra: true } as never)).toThrow("invalid");

        const malformed = new FakeWorkspaceStore();
        const originalCreate = malformed.create.bind(malformed);
        malformed.create = async (...args: Parameters<FakeWorkspaceStore["create"]>) => {
            const result = await originalCreate(...args);
            return { ...result, workspace: makeWorkspace("different") };
        };
        const invalidFeature = feature(malformed);
        await expect(
            invalidFeature.create(root, agent, {
                id: "requested",
                operationId: "requested-op",
                name: "Requested",
            }),
        ).rejects.toThrow("identity");

        const tooMany = new FakeWorkspaceStore();
        tooMany.rows.set("one", makeWorkspace("one"));
        tooMany.rows.set("two", makeWorkspace("two"));
        tooMany.list = async () => ({
            workspaces: [makeWorkspace("one"), makeWorkspace("two")],
        });
        await expect(feature(tooMany).listPage(root, agent, { limit: 1 })).rejects.toThrow(
            "more records",
        );

        const skipped = new FakeWorkspaceStore();
        skipped.list = async () => ({
            workspaces: [makeWorkspace("one")],
            nextCursor: "2",
        });
        await expect(feature(skipped).listPage(root, agent, { limit: 2 })).rejects.toThrow(
            "exactly",
        );

        const duplicated = new FakeWorkspaceStore();
        duplicated.list = async () => ({
            workspaces: [makeWorkspace("one"), makeWorkspace("one")],
        });
        await expect(feature(duplicated).listPage(root, agent, { limit: 2 })).rejects.toThrow(
            "unique",
        );

        const unordered = new FakeWorkspaceStore();
        unordered.list = async () => ({
            workspaces: [makeWorkspace("two"), makeWorkspace("one")],
        });
        await expect(feature(unordered).listPage(root, agent, { limit: 2 })).rejects.toThrow(
            "ordered",
        );
    });

    it("makes minimum-budget pages progress with maximum legal identities", async () => {
        const store = new FakeWorkspaceStore();
        const firstId = "i".repeat(96);
        store.rows.set(firstId, makeWorkspace(firstId, agent, { name: "n".repeat(500) }));
        store.rows.set("j".repeat(96), makeWorkspace("j".repeat(96)));
        store.rows.set("k".repeat(96), makeWorkspace("k".repeat(96)));
        const workspaces = feature(store, { maxPageSize: 3, maxOutputCharacters: 256 });
        const page = await workspaces.listPage(root, agent, { limit: 3 });
        expect(page.workspaces.length).toBeGreaterThanOrEqual(1);
        expect(page.workspaces.length).toBeLessThan(3);
        expect(page.nextCursor).toBe(String(page.workspaces.length));
        expect(workspaces.formatPageForModel(page)).toContain(firstId);
    });

    it("reconciles replay receipts with later authoritative state and rejects tampering", async () => {
        const store = new FakeWorkspaceStore();
        const workspaces = feature(store);
        const input = { id: "replay", operationId: "replay-op", name: "Original" };
        const first = await workspaces.create(root, agent, input);
        store.rows.set(first.id, { ...first, name: "Later authoritative name", updatedAt: 20 });
        const replay = await workspaces.create(root, agent, input);
        expect(replay.name).toBe("Later authoritative name");
        store.tamperReceiptOnNextRead();
        await expect(workspaces.create(root, agent, input)).rejects.toThrow(
            "receipt and immutable proof",
        );
        store.tamperProofOnNextRead();
        await expect(workspaces.create(root, agent, input)).rejects.toThrow(
            "receipt and immutable proof",
        );
        expect(Value.Check(workspaceOperationReceiptSchema, [...store.receipts.values()][0])).toBe(
            true,
        );
        expect(Value.Check(workspaceMutationProofSchema, [...store.proofs.values()][0])).toBe(true);
    });

    it("contains post-commit observer failures and normalizes hostile thrown values", async () => {
        const store = new FakeWorkspaceStore();
        const errors: string[] = [];
        const workspaces = feature(store, {
            listener: {
                onEvent: () => {
                    throw Object.create(null);
                },
            },
            onPostCommitError: (_ctx, _event, error) => {
                errors.push(String(error));
            },
        });
        await expect(
            workspaces.create(root, agent, {
                id: "observer",
                operationId: "observer-op",
                name: "Observer",
            }),
        ).resolves.toMatchObject({ id: "observer" });
        expect(errors).toEqual(["Unknown workspace observer error."]);
    });

    it("rejects substituted session and project transfer targets before durable proof", async () => {
        const sessionStore = new FakeWorkspaceStore();
        sessionStore.rows.set("target", makeWorkspace("target"));
        const originalSessionTransfer = sessionStore.transfer.bind(sessionStore);
        sessionStore.transfer = async (...args) => {
            const result = await originalSessionTransfer(...args);
            if ("targetWorkspaceId" in args[2]) {
                return { ...result, targetWorkspaceId: "substitute" };
            }
            return result;
        };
        const session = feature(sessionStore);
        await expect(
            session.transfer(root, agent, {
                targetWorkspaceId: "target",
                operationId: "substituted-session-target",
            }),
        ).rejects.toThrow("target");
        expect(sessionStore.receipts.size).toBe(0);
        expect(sessionStore.proofs.size).toBe(0);

        const projectStore = new FakeWorkspaceStore();
        projectStore.rows.set("source", makeWorkspace("source"));
        const originalProjectTransfer = projectStore.transfer.bind(projectStore);
        projectStore.transfer = async (...args) => {
            const result = await originalProjectTransfer(...args);
            if ("workspaceId" in args[2] && "state" in result && result.state === "transferred") {
                return {
                    ...result,
                    workspace: { ...result.workspace, projectRef: "substituted-project" },
                };
            }
            return result;
        };
        const project = feature(projectStore);
        await expect(
            project.transfer(root, agent, {
                workspaceId: "source",
                targetProjectRef: "requested-project",
                operationId: "substituted-project-ref",
            }),
        ).rejects.toThrow("project reference");
        expect(projectStore.receipts.size).toBe(0);
        expect(projectStore.proofs.size).toBe(0);
    });

    it("rejects owner mutation for session and project transfers before durable proof", async () => {
        const sessionStore = new FakeWorkspaceStore();
        sessionStore.rows.set("target", makeWorkspace("target"));
        const originalSessionTransfer = sessionStore.transfer.bind(sessionStore);
        sessionStore.transfer = async (...args) => {
            const result = await originalSessionTransfer(...args);
            const current = sessionStore.rows.get("target")!;
            sessionStore.rows.set("target", { ...current, ownerAgentId: otherAgent });
            return result;
        };
        const sessionEvents: WorkspaceEvent[] = [];
        const session = feature(sessionStore, {
            listener: {
                onEventTransactional: (_ctx, event) => {
                    sessionEvents.push(event);
                },
            },
        });
        await expect(
            session.transfer(root, agent, {
                targetWorkspaceId: "target",
                operationId: "owner-mutated-session",
            }),
        ).rejects.toThrow("ownership");
        expect(sessionStore.receipts.size).toBe(0);
        expect(sessionStore.proofs.size).toBe(0);
        expect(sessionEvents).toHaveLength(0);

        const projectStore = new FakeWorkspaceStore();
        projectStore.rows.set("source", makeWorkspace("source"));
        const originalProjectTransfer = projectStore.transfer.bind(projectStore);
        projectStore.transfer = async (...args) => {
            const result = await originalProjectTransfer(...args);
            const current = projectStore.rows.get("source")!;
            projectStore.rows.set("source", { ...current, ownerAgentId: otherAgent });
            return result;
        };
        const projectEvents: WorkspaceEvent[] = [];
        const project = feature(projectStore, {
            listener: {
                onEventTransactional: (_ctx, event) => {
                    projectEvents.push(event);
                },
            },
        });
        await expect(
            project.transfer(root, agent, {
                workspaceId: "source",
                targetProjectRef: "requested-project",
                operationId: "owner-mutated-project",
            }),
        ).rejects.toThrow("ownership");
        expect(projectStore.receipts.size).toBe(0);
        expect(projectStore.proofs.size).toBe(0);
        expect(projectEvents).toHaveLength(0);
    });

    it("replays scheduled history after later owner drift without touching current state", async () => {
        const store = new FakeWorkspaceStore();
        store.rows.set("target", makeWorkspace("target"));
        const workspaces = feature(store, {
            authorization: async () => true,
        });
        const input = {
            targetWorkspaceId: "target" as const,
            operationId: "owner-drift-replay",
        };
        await workspaces.transfer(root, agent, input);
        const current = store.rows.get("target")!;
        store.rows.set("target", { ...current, ownerAgentId: otherAgent });

        const beforeReplay = store.calls.length;
        await expect(workspaces.transfer(root, agent, input)).resolves.toMatchObject({
            state: "scheduled",
            targetWorkspaceId: "target",
        });
        expect(store.calls.slice(beforeReplay).map((call) => call.method)).toEqual([
            "readReceipt",
            "readMutationProof",
        ]);
        expect(store.receipts.size).toBe(1);
        expect(store.proofs.size).toBe(1);
    });

    it("compacts a full workspace returned by a project transfer adapter", async () => {
        const store = new FakeWorkspaceStore();
        store.rows.set("source", makeWorkspace("source"));
        store.transfer = async (_ctx, actingAgentId, input, _operation) => {
            if (input.workspaceId === undefined || input.targetProjectRef === undefined) {
                throw new Error("unexpected session transfer");
            }
            const current = store.rows.get(input.workspaceId);
            if (current === undefined) throw new Error("missing workspace");
            const moved = {
                ...current,
                projectRef: input.targetProjectRef,
                updatedAt: current.updatedAt + 1,
            };
            store.rows.set(moved.id, moved);
            return moved;
        };
        const workspaces = feature(store);

        const result = await workspaces.transfer(root, agent, {
            workspaceId: "source",
            targetProjectRef: "project-next",
            operationId: "compact-project-transfer",
        });

        expect(result).toEqual({
            agentId: agent,
            operationId: "compact-project-transfer",
            fingerprint: expect.any(String),
            changed: true,
            state: "transferred",
            targetWorkspaceId: "source",
            workspace: {
                id: "source",
                projectRef: "project-next",
                ownerAgentId: agent,
            },
        });
    });

    it("derives changed=false from an unchanged full workspace transfer result", async () => {
        const store = new FakeWorkspaceStore();
        store.rows.set("source", makeWorkspace("source", agent, { projectRef: "project-current" }));
        const events: WorkspaceEvent[] = [];
        store.transfer = async (_ctx, _actingAgentId, input) => {
            if (input.workspaceId === undefined || input.targetProjectRef === undefined) {
                throw new Error("unexpected session transfer");
            }
            return store.rows.get(input.workspaceId)!;
        };
        const workspaces = feature(store, {
            listener: {
                onEventTransactional: (_ctx, event) => {
                    events.push(event);
                },
            },
        });

        const result = await workspaces.transfer(root, agent, {
            workspaceId: "source",
            targetProjectRef: "project-current",
            operationId: "compact-project-no-op",
        });

        expect(result).toMatchObject({
            state: "transferred",
            changed: false,
            targetWorkspaceId: "source",
            workspace: {
                id: "source",
                projectRef: "project-current",
                ownerAgentId: agent,
            },
        });
        expect(events).toHaveLength(0);
        expect(store.proofs.get(`${agent}:compact-project-no-op`)).toMatchObject({
            changed: false,
        });
    });

    it("derives scheduled changed from authoritative before and after and suppresses no-op events", async () => {
        const store = new FakeWorkspaceStore();
        store.rows.set("target", makeWorkspace("target"));
        const events: WorkspaceEvent[] = [];
        store.transfer = async (_ctx, actingAgentId, input, operation) => {
            if ("targetWorkspaceId" in input) {
                return {
                    agentId: actingAgentId,
                    operationId: operation.operationId,
                    fingerprint: operation.fingerprint,
                    changed: false,
                    state: "scheduled",
                    targetWorkspaceId: input.targetWorkspaceId,
                };
            }
            throw new Error("unexpected project transfer");
        };
        const workspaces = feature(store, {
            listener: {
                onEventTransactional: (_ctx, event) => {
                    events.push(event);
                },
            },
        });
        const first = await workspaces.transfer(root, agent, {
            targetWorkspaceId: "target",
            operationId: "scheduled-no-op",
        });
        expect(first).toMatchObject({ state: "scheduled", changed: false });
        expect(events).toHaveLength(0);
        expect(store.proofs.get(`${agent}:scheduled-no-op`)).toMatchObject({
            changed: false,
            before: store.rows.get("target"),
            after: store.rows.get("target"),
        });
        await expect(
            workspaces.transfer(root, agent, {
                targetWorkspaceId: "target",
                operationId: "scheduled-no-op",
            }),
        ).resolves.toEqual(first);
        expect(events).toHaveLength(0);
    });

    it("rejects archive results that do not make an exact archived transition", async () => {
        const readyStore = new FakeWorkspaceStore();
        readyStore.rows.set("ready", makeWorkspace("ready"));
        readyStore.archive = async (_ctx, actingAgentId, input, operation) => {
            const current = readyStore.rows.get(input.workspaceId)!;
            const result = {
                operation: "archive" as const,
                agentId: actingAgentId,
                operationId: operation.operationId,
                fingerprint: operation.fingerprint,
                changed: true,
                workspace: current,
            };
            return result;
        };
        const readyFeature = feature(readyStore);
        await expect(
            readyFeature.archive(root, agent, "ready", { operationId: "archive-ready" }),
        ).rejects.toThrow("archived");
        expect(readyStore.receipts.size).toBe(0);
        expect(readyStore.proofs.size).toBe(0);

        const missingTimestampStore = new FakeWorkspaceStore();
        missingTimestampStore.rows.set("missing-at", makeWorkspace("missing-at"));
        const originalArchive = missingTimestampStore.archive.bind(missingTimestampStore);
        missingTimestampStore.archive = async (...args) => {
            const result = await originalArchive(...args);
            const { archivedAt: _archivedAt, ...withoutTimestamp } = result.workspace;
            const workspace = withoutTimestamp;
            missingTimestampStore.rows.set(workspace.id, workspace);
            return { ...result, workspace };
        };
        const missingTimestampFeature = feature(missingTimestampStore);
        await expect(
            missingTimestampFeature.archive(root, agent, "missing-at", {
                operationId: "archive-missing-at",
            }),
        ).rejects.toThrow("archivedAt");
        expect(missingTimestampStore.receipts.size).toBe(0);
        expect(missingTimestampStore.proofs.size).toBe(0);
    });

    it("replays a scheduled transfer after later non-owner fields change", async () => {
        const store = new FakeWorkspaceStore();
        store.rows.set("scheduled", makeWorkspace("scheduled"));
        const workspaces = feature(store);
        const input = {
            targetWorkspaceId: "scheduled" as const,
            operationId: "scheduled-history",
        };

        const first = await workspaces.transfer(root, agent, input);
        const current = store.rows.get("scheduled")!;
        store.rows.set("scheduled", {
            ...current,
            name: "changed after scheduling",
            updatedAt: current.updatedAt + 1,
        });

        const replay = await workspaces.transfer(root, agent, input);
        expect(replay).toEqual(first);
        expect(store.calls.filter((call) => call.method === "transfer")).toHaveLength(1);
    });

    it("replays scheduled history without reading or authorizing later state", async () => {
        const store = new FakeWorkspaceStore();
        store.rows.set("scheduled", makeWorkspace("scheduled"));
        const workspaces = feature(store);
        const input = {
            targetWorkspaceId: "scheduled" as const,
            operationId: "scheduled-no-current-read",
        };

        const first = await workspaces.transfer(root, agent, input);
        store.rows.delete("scheduled");
        const beforeReplay = store.calls.length;

        await expect(workspaces.transfer(root, agent, input)).resolves.toEqual(first);

        expect(store.calls.slice(beforeReplay).map((call) => call.method)).toEqual([
            "readReceipt",
            "readMutationProof",
        ]);
    });

    it("rejects project transfers that mutate updatedAt without the requested project change", async () => {
        const store = new FakeWorkspaceStore();
        store.rows.set(
            "project-row",
            makeWorkspace("project-row", agent, {
                projectRef: "project-current",
            }),
        );
        store.transfer = async (_ctx, actingAgentId, input, operation) => {
            if (input.workspaceId === undefined || input.targetProjectRef === undefined) {
                throw new Error("unexpected session transfer");
            }
            const current = store.rows.get(input.workspaceId);
            if (current === undefined) throw new Error("missing workspace");
            const after = { ...current, updatedAt: current.updatedAt + 1 };
            store.rows.set(after.id, after);
            return {
                agentId: actingAgentId,
                operationId: operation.operationId,
                fingerprint: operation.fingerprint,
                changed: true,
                state: "transferred",
                workspace: {
                    id: after.id,
                    projectRef: after.projectRef,
                    ownerAgentId: after.ownerAgentId,
                },
            };
        };

        await expect(
            feature(store).transfer(root, agent, {
                workspaceId: "project-row",
                targetProjectRef: "project-current",
                operationId: "project-time-only",
            }),
        ).rejects.toThrow("updatedAt");
        expect(store.receipts.size).toBe(0);
        expect(store.proofs.size).toBe(0);
    });

    it("rejects transfer rows that change fields outside the requested transition", async () => {
        const store = new FakeWorkspaceStore();
        store.rows.set("tampered", makeWorkspace("tampered"));
        const originalTransfer = store.transfer.bind(store);
        store.transfer = async (...args) => {
            const result = await originalTransfer(...args);
            const current = store.rows.get("tampered")!;
            store.rows.set("tampered", {
                ...current,
                name: "host substitution",
            });
            return result;
        };

        await expect(
            feature(store).transfer(root, agent, {
                targetWorkspaceId: "tampered",
                operationId: "transfer-field-tamper",
            }),
        ).rejects.toThrow("fields outside");
        expect(store.receipts.size).toBe(0);
        expect(store.proofs.size).toBe(0);
    });

    it("rejects persisted rows with invalid timestamp or archive invariants", async () => {
        const timestampStore = new FakeWorkspaceStore();
        timestampStore.rows.set(
            "bad-time",
            makeWorkspace("bad-time", agent, { createdAt: 10, updatedAt: 9 }),
        );
        const timestampFeature = feature(timestampStore);
        await expect(timestampFeature.get(root, agent, "bad-time")).rejects.toThrow("timestamps");

        const archiveStore = new FakeWorkspaceStore();
        archiveStore.rows.set(
            "bad-archive",
            makeWorkspace("bad-archive", agent, { status: "archived" }),
        );
        const archiveFeature = feature(archiveStore);
        await expect(archiveFeature.listPage(root, agent, { limit: 1 })).rejects.toThrow(
            "archivedAt",
        );
    });

    it("rejects host pages that violate the requested project filter", async () => {
        const store = new FakeWorkspaceStore();
        store.rows.set(
            "wrong-project",
            makeWorkspace("wrong-project", agent, { projectRef: "other" }),
        );
        store.list = async () => ({
            workspaces: [store.rows.get("wrong-project")!],
        });

        await expect(
            feature(store).listPage(root, agent, {
                projectRef: "requested",
                limit: 1,
            }),
        ).rejects.toThrow("outside the requested project");
    });

    it("rejects the removed readAuthorization compatibility option", async () => {
        const store = new FakeWorkspaceStore();
        expect(
            Value.Check(workspaceFeatureOptionsSchema, {
                store,
                readAuthorization: () => true,
            }),
        ).toBe(false);
    });

    it("pages complete workspace and branch metadata detail within small model budgets", async () => {
        const store = new FakeWorkspaceStore();
        const workspace = makeWorkspace("detail", agent, {
            projectRef: "project-" + "p".repeat(180),
            baseRef: "base-" + "b".repeat(500),
            name: "workspace-" + "n".repeat(180),
            createdAt: 12,
            updatedAt: 34,
        });
        store.rows.set(workspace.id, workspace);
        store.branchMetadata = async (_ctx, _agentId, id) => ({
            workspaceId: id,
            branch: "branch-" + "r".repeat(500),
            head: "head-" + "h".repeat(500),
            upstream: "upstream-" + "u".repeat(500),
            ahead: 1,
            behind: 2,
            detached: false,
        });
        const workspaces = feature(store, { maxOutputCharacters: 256 });

        const workspaceDetails: string[] = [];
        let workspaceOffset: number | undefined;
        do {
            const page = await workspaces.getPage(root, agent, workspace.id, {
                detailLimit: 100,
                ...(workspaceOffset === undefined ? {} : { detailOffset: workspaceOffset }),
            });
            expect(Value.Check(workspaceDetailPageSchema, page)).toBe(true);
            expect(workspaces.formatDetailPageForModel(page).length).toBeLessThanOrEqual(256);
            if (page.workspace === null) throw new Error("workspace unexpectedly disappeared");
            workspaceDetails.push(page.detail);
            workspaceOffset = page.nextDetailOffset;
        } while (workspaceOffset !== undefined);
        const workspaceDetail = workspaceDetails.join("");
        expect(workspaceDetail).toContain(workspace.projectRef);
        expect(workspaceDetail).toContain(workspace.baseRef!);
        expect(workspaceDetail).toContain(workspace.ownerAgentId);
        expect(workspaceDetail).toContain(String(workspace.createdAt));
        expect(workspaceDetail).toContain(String(workspace.updatedAt));
        expect(workspaces.formatWorkspaceForModel(workspace).length).toBeLessThanOrEqual(256);

        const branchDetails: string[] = [];
        let branchOffset: number | undefined;
        do {
            const page = await workspaces.branchMetadataPage(root, agent, workspace.id, {
                detailLimit: 100,
                ...(branchOffset === undefined ? {} : { detailOffset: branchOffset }),
            });
            expect(Value.Check(workspaceBranchMetadataPageSchema, page)).toBe(true);
            expect(workspaces.formatBranchMetadataForModel(page).length).toBeLessThanOrEqual(256);
            branchDetails.push(page.detail);
            branchOffset = page.nextDetailOffset;
        } while (branchOffset !== undefined);
        const branchDetail = branchDetails.join("");
        expect(branchDetail).toContain("branch-" + "r".repeat(500));
        expect(branchDetail).toContain("head-" + "h".repeat(500));
        expect(branchDetail).toContain("upstream-" + "u".repeat(500));
    });
});
