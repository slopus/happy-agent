import { AsyncLocalStorage } from "node:async_hooks";

import { AgentKV, withAgentKV } from "@slopus/happy-agent-base";
import { Value } from "@sinclair/typebox/value";
import { createRootContext, type Context } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import {
    assertProjectSettings,
    projectDetailPageSchema,
    projectAgentIdSchema,
    projectFeatureOptionsSchema,
    projectIdSchema,
    projectMutationProofSchema,
    projectOperationReceiptSchema,
    projectSchema,
    projectSettingsSchema,
    projectSettingsPageSchema,
    type Project,
    type ProjectEvent,
    type ProjectFeatureListener,
    type ProjectMutationProof,
    type ProjectOperationReceipt,
    type ProjectPage,
    type ProjectStore,
    type ProjectStoreCreateInput,
    type ProjectStoreEnsureInput,
    type ProjectStoreMutationResult,
    type ProjectStoreRenameInput,
    type ProjectStoreSettingsUpdateInput,
    type ProjectMutationRequest,
    type ProjectTransactionChange,
    ProjectsFeature,
} from "../../sources/projects/index.js";
import { agentWorld } from "../support/agentWorld.js";

const root = createRootContext().named("projects-feature-test");
const agent = "agent-a";
const otherAgent = "agent-b";

function makeProject(id: string, ownerAgentId = agent, overrides: Partial<Project> = {}): Project {
    return {
        id,
        ownerAgentId,
        repositoryRef: `repo:${id}`,
        name: id,
        status: "active",
        createdAt: 1,
        updatedAt: 1,
        ...overrides,
    };
}

class MemoryProjectStore implements ProjectStore {
    readonly rows = new Map<string, Project>();
    readonly settings = new Map<string, Record<string, unknown>>();
    readonly receipts = new Map<string, ProjectOperationReceipt>();
    readonly proofs = new Map<string, ProjectMutationProof>();
    readonly calls: string[] = [];
    mutateExistingEnsure = false;
    mutateRenameDescription = false;
    keepProjectRowOnSettingsChange = false;
    tamperCreatedState: "archive" | "description" | "timestamps" | undefined;
    ensureGate: Promise<void> | undefined;
    ensureEntered: (() => void) | undefined;
    readonly #callbacks: Array<(ctx: Context) => void | Promise<void>> = [];
    readonly #transactionScope = new AsyncLocalStorage<symbol>();
    #ensureCallCount = 0;
    #queue: Promise<void> = Promise.resolve();
    #depth = 0;
    #snapshot:
        | {
              rows: Map<string, Project>;
              settings: Map<string, Record<string, unknown>>;
              receipts: Map<string, ProjectOperationReceipt>;
              proofs: Map<string, ProjectMutationProof>;
          }
        | undefined;

    asStore(): ProjectStore {
        return {
            transaction: this.transaction.bind(this),
            afterCommit: this.afterCommit.bind(this),
            create: this.create.bind(this),
            ensure: this.ensure.bind(this),
            list: this.list.bind(this),
            get: this.get.bind(this),
            findByRepositoryRef: this.findByRepositoryRef.bind(this),
            rename: this.rename.bind(this),
            archive: this.archive.bind(this),
            readSettings: this.readSettings.bind(this),
            updateSettings: this.updateSettings.bind(this),
            readReceipt: this.readReceipt.bind(this),
            writeReceipt: this.writeReceipt.bind(this),
            readMutationProof: this.readMutationProof.bind(this),
            writeMutationProof: this.writeMutationProof.bind(this),
        };
    }

    async transaction(
        _ctx: Context,
        _agentId: string,
        work: (txCtx: Context) => Promise<ProjectTransactionChange>,
    ): Promise<ProjectTransactionChange> {
        if (this.#transactionScope.getStore() !== undefined) {
            return await this.#withinTransaction(work);
        }
        const run = this.#queue.then(() =>
            this.#transactionScope.run(Symbol(), () => this.#withinTransaction(work)),
        );
        this.#queue = run.then(
            () => undefined,
            () => undefined,
        );
        return await run;
    }

    afterCommit(
        _ctx: Context,
        _agentId: string,
        callback: (postCommitCtx: Context) => void | Promise<void>,
    ): void {
        this.#callbacks.push(callback);
    }

    async create(
        _ctx: Context,
        actingAgentId: string,
        input: ProjectStoreCreateInput,
        operation: ProjectMutationRequest,
    ): Promise<Extract<ProjectStoreMutationResult, { operation: "create" }>> {
        this.calls.push("create");
        if (this.rows.has(input.id)) throw new Error(`duplicate project ID: ${input.id}`);
        const project = this.#tamperCreatedProject(
            makeProject(input.id, input.ownerAgentId, {
                repositoryRef: input.repositoryRef,
                name: input.name,
                ...(input.description === undefined ? {} : { description: input.description }),
                createdAt: 10,
                updatedAt: 10,
            }),
        );
        this.rows.set(project.id, project);
        if (!this.settings.has(project.id)) this.settings.set(project.id, {});
        return {
            operation: "create",
            agentId: actingAgentId,
            operationId: operation.operationId,
            fingerprint: operation.fingerprint,
            changed: true,
            project,
        };
    }

    async ensure(
        _ctx: Context,
        actingAgentId: string,
        input: ProjectStoreEnsureInput,
        operation: ProjectMutationRequest,
    ): Promise<Extract<ProjectStoreMutationResult, { operation: "ensure" }>> {
        this.calls.push("ensure");
        this.ensureEntered?.();
        this.ensureEntered = undefined;
        const ensureCall = this.#ensureCallCount;
        this.#ensureCallCount += 1;
        const existing = [...this.rows.values()].find(
            (project) => project.repositoryRef === input.repositoryRef,
        );
        if (ensureCall === 0 && this.ensureGate !== undefined) {
            await this.ensureGate;
        }
        if (existing !== undefined) {
            if (this.mutateExistingEnsure) {
                const mutated = {
                    ...existing,
                    name: `${existing.name}-mutated`,
                    updatedAt: existing.updatedAt + 1,
                };
                this.rows.set(mutated.id, mutated);
                return {
                    operation: "ensure",
                    agentId: actingAgentId,
                    operationId: operation.operationId,
                    fingerprint: operation.fingerprint,
                    changed: false,
                    created: false,
                    project: structuredClone(mutated),
                };
            }
            return {
                operation: "ensure",
                agentId: actingAgentId,
                operationId: operation.operationId,
                fingerprint: operation.fingerprint,
                changed: false,
                created: false,
                project: structuredClone(existing),
            };
        }
        if (this.rows.has(input.id)) throw new Error(`duplicate project ID: ${input.id}`);
        const project = this.#tamperCreatedProject(
            makeProject(input.id, input.ownerAgentId, {
                repositoryRef: input.repositoryRef,
                ...(input.name === undefined ? {} : { name: input.name }),
                ...(input.description === undefined ? {} : { description: input.description }),
                createdAt: 11,
                updatedAt: 11,
            }),
        );
        this.rows.set(project.id, project);
        this.settings.set(project.id, {});
        return {
            operation: "ensure",
            agentId: actingAgentId,
            operationId: operation.operationId,
            fingerprint: operation.fingerprint,
            changed: true,
            created: true,
            project,
        };
    }

    async list(
        _ctx: Context,
        _agentId: string,
        query: {
            readonly status?: "active" | "archived";
            readonly includeArchived?: boolean;
            readonly cursor?: string;
            readonly limit?: number;
        },
    ): Promise<ProjectPage> {
        this.calls.push("list");
        const projects = [...this.rows.values()]
            .filter(
                (project) =>
                    (query.status === undefined || project.status === query.status) &&
                    (query.status !== undefined ||
                        query.includeArchived === true ||
                        project.status !== "archived"),
            )
            .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
        const start = query.cursor === undefined ? 0 : Number(query.cursor);
        const limit = query.limit ?? 50;
        const projectsOnPage = projects.slice(start, start + limit);
        const next =
            start + projectsOnPage.length < projects.length
                ? String(start + projectsOnPage.length)
                : undefined;
        return {
            projects: structuredClone(projectsOnPage),
            ...(next === undefined ? {} : { nextCursor: next }),
        };
    }

    async get(_ctx: Context, _agentId: string, projectId: string): Promise<Project | undefined> {
        this.calls.push("get");
        return structuredClone(this.rows.get(projectId));
    }

    async findByRepositoryRef(
        _ctx: Context,
        _agentId: string,
        repositoryRef: string,
    ): Promise<Project | undefined> {
        this.calls.push("findByRepositoryRef");
        const project = [...this.rows.values()].find((row) => row.repositoryRef === repositoryRef);
        return structuredClone(project);
    }

    async rename(
        _ctx: Context,
        actingAgentId: string,
        input: ProjectStoreRenameInput,
        operation: ProjectMutationRequest,
    ): Promise<Extract<ProjectStoreMutationResult, { operation: "rename" }>> {
        this.calls.push("rename");
        const before = this.rows.get(input.projectId);
        if (before === undefined) throw new Error("missing project");
        const after = {
            ...before,
            name: input.name,
            updatedAt: before.name === input.name ? before.updatedAt : before.updatedAt + 1,
            ...(this.mutateRenameDescription ? { description: "Unexpected description" } : {}),
        };
        this.rows.set(after.id, after);
        return {
            operation: "rename",
            agentId: actingAgentId,
            operationId: operation.operationId,
            fingerprint: operation.fingerprint,
            changed: before.name !== after.name,
            project: after,
        };
    }

    async archive(
        _ctx: Context,
        actingAgentId: string,
        input: { readonly projectId: string },
        operation: ProjectMutationRequest,
    ): Promise<Extract<ProjectStoreMutationResult, { operation: "archive" }>> {
        this.calls.push("archive");
        const before = this.rows.get(input.projectId);
        if (before === undefined) throw new Error("missing project");
        if (before.status === "archived") {
            return {
                operation: "archive",
                agentId: actingAgentId,
                operationId: operation.operationId,
                fingerprint: operation.fingerprint,
                changed: false,
                project: structuredClone(before),
            };
        }
        const after = {
            ...before,
            status: "archived" as const,
            archivedAt: before.updatedAt + 1,
            updatedAt: before.updatedAt + 1,
        };
        this.rows.set(after.id, after);
        return {
            operation: "archive",
            agentId: actingAgentId,
            operationId: operation.operationId,
            fingerprint: operation.fingerprint,
            changed: true,
            project: after,
        };
    }

    async readSettings(
        _ctx: Context,
        _agentId: string,
        projectId: string,
    ): Promise<Record<string, unknown>> {
        this.calls.push("readSettings");
        return structuredClone(this.settings.get(projectId) ?? {});
    }

    async updateSettings(
        _ctx: Context,
        actingAgentId: string,
        input: ProjectStoreSettingsUpdateInput,
        operation: ProjectMutationRequest,
    ): Promise<Extract<ProjectStoreMutationResult, { operation: "update_settings" }>> {
        this.calls.push("updateSettings");
        const before = this.settings.get(input.projectId) ?? {};
        const changed = JSON.stringify(before) !== JSON.stringify(input.settings);
        this.settings.set(input.projectId, structuredClone(input.settings));
        const project = this.rows.get(input.projectId);
        if (project === undefined) throw new Error("missing project");
        if (changed && !this.keepProjectRowOnSettingsChange) {
            this.rows.set(input.projectId, { ...project, updatedAt: project.updatedAt + 1 });
        }
        return {
            operation: "update_settings",
            agentId: actingAgentId,
            operationId: operation.operationId,
            fingerprint: operation.fingerprint,
            changed,
            projectId: input.projectId,
            settings: structuredClone(input.settings),
        };
    }

    async readReceipt(
        _ctx: Context,
        actingAgentId: string,
        operationId: string,
    ): Promise<ProjectOperationReceipt | undefined> {
        this.calls.push("readReceipt");
        return structuredClone(this.receipts.get(this.#key(actingAgentId, operationId)));
    }

    async writeReceipt(
        _ctx: Context,
        actingAgentId: string,
        receipt: ProjectOperationReceipt,
    ): Promise<void> {
        this.calls.push("writeReceipt");
        this.receipts.set(this.#key(actingAgentId, receipt.operationId), structuredClone(receipt));
    }

    async readMutationProof(
        _ctx: Context,
        actingAgentId: string,
        operationId: string,
    ): Promise<ProjectMutationProof | undefined> {
        this.calls.push("readMutationProof");
        return structuredClone(this.proofs.get(this.#key(actingAgentId, operationId)));
    }

    async writeMutationProof(
        _ctx: Context,
        actingAgentId: string,
        proof: ProjectMutationProof,
    ): Promise<void> {
        this.calls.push("writeMutationProof");
        this.proofs.set(this.#key(actingAgentId, proof.operationId), structuredClone(proof));
    }

    async #withinTransaction(
        work: (txCtx: Context) => Promise<ProjectTransactionChange>,
    ): Promise<ProjectTransactionChange> {
        if (this.#depth === 0) {
            this.#snapshot = {
                rows: new Map(
                    [...this.rows].map(([id, project]) => [id, structuredClone(project)]),
                ),
                settings: new Map(
                    [...this.settings].map(([id, value]) => [id, structuredClone(value)]),
                ),
                receipts: new Map(
                    [...this.receipts].map(([id, receipt]) => [id, structuredClone(receipt)]),
                ),
                proofs: new Map(
                    [...this.proofs].map(([id, proof]) => [id, structuredClone(proof)]),
                ),
            };
        }
        this.#depth += 1;
        try {
            const result = await work(root);
            this.#depth -= 1;
            if (this.#depth === 0) {
                this.#snapshot = undefined;
                const callbacks = this.#callbacks.splice(0);
                for (const callback of callbacks) await callback(root);
            }
            return result;
        } catch (error: unknown) {
            this.#depth -= 1;
            if (this.#depth === 0) {
                const snapshot = this.#snapshot;
                this.#snapshot = undefined;
                if (snapshot !== undefined) {
                    this.rows.clear();
                    for (const [id, project] of snapshot.rows) this.rows.set(id, project);
                    this.settings.clear();
                    for (const [id, value] of snapshot.settings) this.settings.set(id, value);
                    this.receipts.clear();
                    for (const [id, receipt] of snapshot.receipts) this.receipts.set(id, receipt);
                    this.proofs.clear();
                    for (const [id, proof] of snapshot.proofs) this.proofs.set(id, proof);
                }
                this.#callbacks.length = 0;
            }
            throw error;
        }
    }

    #key(agentId: string, operationId: string): string {
        return `${agentId}:${operationId}`;
    }

    #tamperCreatedProject(project: Project): Project {
        if (this.tamperCreatedState === "archive") {
            return {
                ...project,
                status: "archived",
                archivedAt: project.createdAt,
            };
        }
        if (this.tamperCreatedState === "description") {
            return {
                ...project,
                description: "Unexpected host description",
            };
        }
        if (this.tamperCreatedState === "timestamps") {
            return {
                ...project,
                updatedAt: project.updatedAt + 1,
            };
        }
        return project;
    }
}

function makeFeature(
    store: MemoryProjectStore,
    overrides: Partial<ConstructorParameters<typeof ProjectsFeature>[0]> = {},
): ProjectsFeature {
    let nextId = 0;
    let nextEvent = 0;
    return new ProjectsFeature({
        store: store.asStore(),
        idFactory: (_ctx, agentId) => `${agentId}-project-${++nextId}`,
        eventIdFactory: (_ctx, agentId) => `${agentId}-event-${++nextEvent}`,
        clock: () => 100,
        ...overrides,
    });
}

function callContext(agentId = agent): Context {
    const world = agentWorld();
    return withAgentKV(root, new AgentKV(world.storage.persistence(agentId), "project-tool-call."));
}

function nestedSettings(depth: number): Record<string, unknown> {
    let value: unknown = true;
    for (let index = 0; index < depth; index += 1) {
        value = { child: value };
    }
    return { value };
}

describe("ProjectsFeature", () => {
    it("shares behavior between public methods and all provider-neutral tools", async () => {
        const store = new MemoryProjectStore();
        const projects = makeFeature(store);
        const toolCtx = callContext();
        const tools = projects.tools(toolCtx, { agent: { id: agent } } as never);
        expect(tools.map((tool) => tool.name)).toEqual([
            "list_projects",
            "get_project",
            "create_project",
            "ensure_project",
            "rename_project",
            "archive_project",
            "get_project_settings",
            "update_project_settings",
        ]);
        const created = await tools[2]!.execute(toolCtx, {
            repositoryRef: "repo:tool",
            name: "Tool project",
        });
        const replayedCreate = await tools[2]!.execute(toolCtx, {
            repositoryRef: "repo:tool",
            name: "Tool project",
        });
        expect(replayedCreate).toEqual(created);
        expect(created.ownerAgentId).toBe(agent);
        expect(await projects.get(root, agent, created.id)).toEqual(created);
        expect((await tools[0]!.execute(root, {})).projects).toEqual([created]);
        expect((await tools[1]!.execute(root, { projectId: created.id })).project).toEqual(created);
        const renamed = await tools[4]!.execute(toolCtx, {
            projectId: created.id,
            name: "Renamed",
        });
        const renamedReplay = await tools[4]!.execute(toolCtx, {
            projectId: created.id,
            name: "Renamed",
        });
        expect(renamedReplay).toEqual(renamed);
        expect(renamed.name).toBe("Renamed");
        expect(Value.Check(projectSchema, renamed)).toBe(true);

        const ensured = await tools[3]!.execute(toolCtx, {
            repositoryRef: "repo:tool-ensure",
            name: "Ensured",
        });
        const ensuredReplay = await tools[3]!.execute(toolCtx, {
            repositoryRef: "repo:tool-ensure",
            name: "Ensured",
        });
        expect(ensuredReplay).toEqual(ensured);
        expect(ensured.created).toBe(true);

        const archived = await tools[5]!.execute(toolCtx, { projectId: created.id });
        const archivedReplay = await tools[5]!.execute(toolCtx, { projectId: created.id });
        expect(archivedReplay).toEqual(archived);
        expect(archived.status).toBe("archived");

        const settingsPage = await tools[6]!.execute(toolCtx, {
            projectId: created.id,
        });
        expect(settingsPage.projectId).toBe(created.id);
        const settings = { theme: "dark" };
        const updatedSettings = await tools[7]!.execute(toolCtx, {
            projectId: created.id,
            settings,
        });
        const updatedSettingsReplay = await tools[7]!.execute(toolCtx, {
            projectId: created.id,
            settings,
        });
        expect(updatedSettingsReplay).toEqual(updatedSettings);
        expect(updatedSettings.settings).toEqual(settings);
    });

    it("ensures one repository inside the store transaction across operation identities", async () => {
        const store = new MemoryProjectStore();
        const projects = makeFeature(store);
        const first = await projects.ensure(root, agent, {
            repositoryRef: "repo:unique",
            name: "First",
            operationId: "ensure-a",
        });
        const second = await projects.ensure(root, agent, {
            repositoryRef: "repo:unique",
            name: "Different name",
            operationId: "ensure-b",
        });
        expect(first.created).toBe(true);
        expect(second.created).toBe(false);
        expect(second.project).toEqual(first.project);
        expect(store.rows.size).toBe(1);
        expect(store.calls.filter((call) => call === "ensure")).toHaveLength(2);
    });

    it("derives ensure flags from authoritative before and after state", async () => {
        const store = new MemoryProjectStore();
        const projects = makeFeature(store);
        const first = await projects.ensure(root, agent, {
            repositoryRef: "repo:ensure-proof",
            operationId: "ensure-proof-first",
        });
        store.mutateExistingEnsure = true;

        await expect(
            projects.ensure(root, agent, {
                repositoryRef: "repo:ensure-proof",
                operationId: "ensure-proof-corrupt",
            }),
        ).rejects.toThrow("changed flag");
        expect(store.rows.get(first.project.id)).toEqual(first.project);
        expect(store.receipts.has(`${agent}:ensure-proof-corrupt`)).toBe(false);
        expect(store.proofs.has(`${agent}:ensure-proof-corrupt`)).toBe(false);
    });

    it("replays durable ensure and create calls and persists through a fresh feature", async () => {
        const store = new MemoryProjectStore();
        const firstFeature = makeFeature(store);
        const first = await firstFeature.ensure(root, agent, {
            repositoryRef: "repo:restart",
            operationId: "restart-ensure",
        });
        const callsBeforeReplay = store.calls.filter((call) => call === "ensure").length;
        const restarted = makeFeature(store);
        const replay = await restarted.ensure(root, agent, {
            repositoryRef: "repo:restart",
            operationId: "restart-ensure",
        });
        expect(replay).toEqual(first);
        expect(store.calls.filter((call) => call === "ensure")).toHaveLength(callsBeforeReplay);

        const created = await restarted.create(root, agent, {
            id: "created-restart",
            operationId: "restart-create",
            repositoryRef: "repo:create",
            name: "Created",
        });
        expect(Value.Check(projectOperationReceiptSchema, [...store.receipts.values()][1])).toBe(
            true,
        );
        expect(Value.Check(projectMutationProofSchema, [...store.proofs.values()][1])).toBe(true);
        expect(created.id).toBe("created-restart");
    });

    it("replays catalog and settings mutations against current authoritative state", async () => {
        const store = new MemoryProjectStore();
        const projects = makeFeature(store);
        const created = await projects.create(root, agent, {
            id: "replay-project",
            operationId: "replay-create",
            repositoryRef: "repo:replay-project",
            name: "Initial",
        });

        await projects.rename(root, agent, {
            projectId: created.id,
            operationId: "replay-rename-first",
            name: "Renamed once",
        });
        await projects.rename(root, agent, {
            projectId: created.id,
            operationId: "replay-rename-second",
            name: "Renamed twice",
        });
        const renameReplay = await projects.rename(root, agent, {
            projectId: created.id,
            operationId: "replay-rename-first",
            name: "Renamed once",
        });
        expect(renameReplay.name).toBe("Renamed twice");

        await projects.updateSettings(root, agent, {
            projectId: created.id,
            operationId: "replay-settings-first",
            settings: { mode: "first" },
        });
        await projects.updateSettings(root, agent, {
            projectId: created.id,
            operationId: "replay-settings-second",
            settings: { mode: "second" },
        });
        const settingsReplay = await projects.updateSettings(root, agent, {
            projectId: created.id,
            operationId: "replay-settings-first",
            settings: { mode: "first" },
        });
        expect(settingsReplay.settings).toEqual({ mode: "second" });

        await projects.archive(root, agent, created.id, { operationId: "replay-archive-first" });
        await projects.rename(root, agent, {
            projectId: created.id,
            operationId: "replay-archive-intervening",
            name: "Archived and renamed",
        });
        const archiveReplay = await projects.archive(root, agent, created.id, {
            operationId: "replay-archive-first",
        });
        expect(archiveReplay).toMatchObject({
            id: created.id,
            name: "Archived and renamed",
            status: "archived",
        });
    });

    it("replays settings when the host leaves the project row unchanged", async () => {
        const store = new MemoryProjectStore();
        store.rows.set("settings-no-row-change", makeProject("settings-no-row-change"));
        store.settings.set("settings-no-row-change", {});
        store.keepProjectRowOnSettingsChange = true;
        const projects = makeFeature(store);
        const input = {
            projectId: "settings-no-row-change",
            operationId: "settings-no-row-change-op",
            settings: { enabled: true },
        } as const;

        const first = await projects.updateSettings(root, agent, input);
        const replay = await projects.updateSettings(root, agent, input);
        expect(first).toEqual(replay);
        expect(replay.settings).toEqual(input.settings);
    });

    it("rejects settings replay redirected to another project or nested operation", async () => {
        const store = new MemoryProjectStore();
        store.rows.set("settings-subject", makeProject("settings-subject"));
        store.rows.set("settings-other", makeProject("settings-other"));
        store.settings.set("settings-subject", {});
        store.settings.set("settings-other", {});
        const projects = makeFeature(store);
        const input = {
            projectId: "settings-subject",
            operationId: "settings-subject-op",
            settings: { enabled: true },
        } as const;
        await projects.updateSettings(root, agent, input);
        const key = `${agent}:${input.operationId}`;
        const receipt = store.receipts.get(key)!;
        const proof = store.proofs.get(key)!;
        const receiptResult = receipt.result as Extract<
            ProjectStoreMutationResult,
            { operation: "update_settings" }
        >;
        const proofResult = proof.result as Extract<
            ProjectStoreMutationResult,
            { operation: "update_settings" }
        >;
        const redirectedProject = store.rows.get("settings-other")!;
        const redirectedReceiptResult = {
            ...receiptResult,
            projectId: redirectedProject.id,
            operationId: "redirected-nested-operation",
            fingerprint: "b".repeat(64),
        };
        const redirectedProofResult = {
            ...proofResult,
            projectId: redirectedProject.id,
            operationId: "redirected-nested-operation",
            fingerprint: "b".repeat(64),
        };
        store.receipts.set(key, {
            ...receipt,
            result: redirectedReceiptResult,
        });
        store.proofs.set(key, {
            ...proof,
            subjectId: redirectedProject.id,
            before: redirectedProject,
            after: redirectedProject,
            changed: false,
            result: redirectedProofResult,
            settingsBefore: {},
            settingsAfter: { enabled: true },
        });
        await expect(projects.updateSettings(root, agent, input)).rejects.toThrow();
    });

    it("rejects schema-valid receipt and proof tampering during replay", async () => {
        const receiptStore = new MemoryProjectStore();
        const receiptFeature = makeFeature(receiptStore);
        const receiptInput = {
            id: "tampered-receipt",
            operationId: "tampered-receipt-op",
            repositoryRef: "repo:tampered-receipt",
            name: "Receipt",
        } as const;
        const receiptProject = await receiptFeature.create(root, agent, receiptInput);
        const receiptKey = `${agent}:${receiptInput.operationId}`;
        const receipt = receiptStore.receipts.get(receiptKey)!;
        const receiptResult = receipt.result as Extract<
            ProjectStoreMutationResult,
            { operation: "create" }
        >;
        receiptStore.receipts.set(receiptKey, {
            ...receipt,
            result: {
                ...receiptResult,
                project: { ...receiptResult.project, name: "Tampered" },
            },
        });
        await expect(receiptFeature.create(root, agent, receiptInput)).rejects.toThrow("disagree");
        expect(receiptProject.name).toBe("Receipt");

        const proofStore = new MemoryProjectStore();
        const proofFeature = makeFeature(proofStore);
        const proofInput = {
            id: "tampered-proof",
            operationId: "tampered-proof-op",
            repositoryRef: "repo:tampered-proof",
            name: "Proof",
        } as const;
        await proofFeature.create(root, agent, proofInput);
        const proofKey = `${agent}:${proofInput.operationId}`;
        const proof = proofStore.proofs.get(proofKey)!;
        proofStore.proofs.set(proofKey, {
            ...proof,
            after: { ...(proof.after as Project), name: "Tampered" },
        });
        await expect(proofFeature.create(root, agent, proofInput)).rejects.toThrow("disagree");

        const settingsStore = new MemoryProjectStore();
        const settingsFeature = makeFeature(settingsStore);
        await settingsFeature.create(root, agent, {
            id: "tampered-settings",
            operationId: "tampered-settings-create",
            repositoryRef: "repo:tampered-settings",
            name: "Settings",
        });
        const settingsInput = {
            projectId: "tampered-settings",
            operationId: "tampered-settings-op",
            settings: { expected: true },
        } as const;
        await settingsFeature.updateSettings(root, agent, settingsInput);
        const settingsKey = `${agent}:${settingsInput.operationId}`;
        const settingsProof = settingsStore.proofs.get(settingsKey)!;
        settingsStore.proofs.set(settingsKey, {
            ...settingsProof,
            settingsAfter: { expected: false },
        });
        await expect(settingsFeature.updateSettings(root, agent, settingsInput)).rejects.toThrow(
            "disagree",
        );
    });

    it("rejects rename results that mutate the description", async () => {
        const store = new MemoryProjectStore();
        const project = makeProject("rename-description", agent, {
            description: "Original description",
        });
        store.rows.set(project.id, project);
        store.mutateRenameDescription = true;
        const projects = makeFeature(store);

        await expect(
            projects.rename(root, agent, {
                projectId: project.id,
                operationId: "rename-description-op",
                name: "Renamed",
            }),
        ).rejects.toThrow("fields outside");
        expect(store.rows.get(project.id)).toEqual(project);
        expect(store.receipts).toHaveLength(0);
        expect(store.proofs).toHaveLength(0);
    });

    it("rejects host-introduced fields in created project states", async () => {
        for (const tamper of ["archive", "description", "timestamps"] as const) {
            const createStore = new MemoryProjectStore();
            createStore.tamperCreatedState = tamper;
            await expect(
                makeFeature(createStore).create(root, agent, {
                    id: `created-${tamper}`,
                    operationId: `created-${tamper}-operation`,
                    repositoryRef: `repo:created-${tamper}`,
                    name: "Created",
                }),
            ).rejects.toThrow("created state");
            expect(createStore.rows.size).toBe(0);
            expect(createStore.receipts.size).toBe(0);
            expect(createStore.proofs.size).toBe(0);

            const ensureStore = new MemoryProjectStore();
            ensureStore.tamperCreatedState = tamper;
            await expect(
                makeFeature(ensureStore).ensure(root, agent, {
                    operationId: `ensured-${tamper}-operation`,
                    repositoryRef: `repo:ensured-${tamper}`,
                }),
            ).rejects.toThrow("created state");
            expect(ensureStore.rows.size).toBe(0);
            expect(ensureStore.receipts.size).toBe(0);
            expect(ensureStore.proofs.size).toBe(0);
        }
    });

    it("rejects malformed persisted rows and settings", async () => {
        const badProjectStore = new MemoryProjectStore();
        badProjectStore.rows.set("bad", makeProject("bad", agent, { status: "archived" }));
        await expect(makeFeature(badProjectStore).get(root, agent, "bad")).rejects.toThrow(
            "archivedAt",
        );

        const settingsStore = new MemoryProjectStore();
        settingsStore.rows.set("settings", makeProject("settings"));
        settingsStore.settings.set("settings", { bad: Number.NaN });
        await expect(
            makeFeature(settingsStore).readSettings(root, agent, "settings"),
        ).rejects.toThrow("invalid");
    });

    it("publishes no post-commit event when an outer transaction rolls back", async () => {
        const store = new MemoryProjectStore();
        const events: ProjectEvent[] = [];
        const projects = makeFeature(store, {
            listener: {
                onEvent: (_ctx, event) => {
                    events.push(event);
                },
            },
        });
        await expect(
            store.transaction(root, agent, async (ctx) => {
                await projects.create(ctx, agent, {
                    id: "nested",
                    operationId: "nested-create",
                    repositoryRef: "repo:nested",
                    name: "Nested",
                });
                throw new Error("rollback outer");
            }),
        ).rejects.toThrow("rollback outer");
        expect(store.rows.size).toBe(0);
        expect(store.receipts.size).toBe(0);
        expect(events).toHaveLength(0);
    });

    it("serializes concurrent mutations through the injected store transaction", async () => {
        const store = new MemoryProjectStore();
        const projects = makeFeature(store);
        let releaseFirst: (() => void) | undefined;
        store.ensureGate = new Promise<void>((resolve) => {
            releaseFirst = resolve;
        });
        const firstEnsureEntered = new Promise<void>((resolve) => {
            store.ensureEntered = resolve;
        });
        const first = projects.ensure(root, agent, {
            repositoryRef: "repo:concurrent",
            operationId: "concurrent-a",
        });
        await firstEnsureEntered;
        const second = projects.ensure(root, agent, {
            repositoryRef: "repo:concurrent",
            operationId: "concurrent-b",
        });
        releaseFirst!();
        const results = await Promise.all([first, second]);
        expect(results.filter((result) => result.created)).toHaveLength(1);
        expect(store.rows.size).toBe(1);
    });

    it("delivers the same deeply frozen event to transactional and post-commit listeners", async () => {
        const store = new MemoryProjectStore();
        class Listener implements ProjectFeatureListener {
            transactional: ProjectEvent[] = [];
            committed: ProjectEvent[] = [];

            onEventTransactional(_ctx: Context, event: ProjectEvent): void {
                this.transactional.push(event);
            }

            onEvent(_ctx: Context, event: ProjectEvent): void {
                this.committed.push(event);
            }
        }
        const listener = new Listener();
        const projects = makeFeature(store, {
            listener: {
                onEventTransactional: listener.onEventTransactional.bind(listener),
                onEvent: listener.onEvent.bind(listener),
            },
        });
        await projects.create(root, agent, {
            id: "stable",
            operationId: "stable-op",
            repositoryRef: "repo:stable",
            name: "Stable",
        });
        expect(listener.transactional[0]).toBe(listener.committed[0]);
        expect(Object.isFrozen(listener.transactional[0])).toBe(true);
        expect(
            Object.isFrozen(
                (listener.transactional[0] as Extract<ProjectEvent, { project: Project }>).project,
            ),
        ).toBe(true);
    });

    it("contains post-commit listener failure and reports hostile thrown values", async () => {
        const errors: string[] = [];
        const store = new MemoryProjectStore();
        const projects = makeFeature(store, {
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
            projects.create(root, agent, {
                id: "observer",
                operationId: "observer-op",
                repositoryRef: "repo:observer",
                name: "Observer",
            }),
        ).resolves.toMatchObject({ id: "observer" });
        expect(errors).toEqual(["Unknown project observer error."]);
    });

    it("rolls back durable state when the transactional listener fails", async () => {
        const store = new MemoryProjectStore();
        const projects = makeFeature(store, {
            listener: {
                onEventTransactional: () => {
                    throw new Error("transactional listener failed");
                },
            },
        });

        await expect(
            projects.create(root, agent, {
                id: "transactional-failure",
                operationId: "transactional-failure-op",
                repositoryRef: "repo:transactional-failure",
                name: "Failure",
            }),
        ).rejects.toThrow("transactional listener failed");
        expect(store.rows).toHaveLength(0);
        expect(store.receipts).toHaveLength(0);
        expect(store.proofs).toHaveLength(0);
    });

    it("publishes no events for no-op mutations", async () => {
        const store = new MemoryProjectStore();
        const events: ProjectEvent[] = [];
        const projects = makeFeature(store, {
            listener: {
                onEventTransactional: (_ctx, event) => {
                    events.push(event);
                },
            },
        });
        const project = await projects.create(root, agent, {
            id: "no-op",
            operationId: "no-op-create",
            repositoryRef: "repo:no-op",
            name: "No-op",
        });
        expect(events).toHaveLength(1);
        events.length = 0;

        await projects.ensure(root, agent, {
            repositoryRef: project.repositoryRef,
            operationId: "no-op-ensure",
            name: "Ignored",
        });
        await projects.rename(root, agent, {
            projectId: project.id,
            operationId: "no-op-rename",
            name: project.name,
        });
        await projects.updateSettings(root, agent, {
            projectId: project.id,
            operationId: "no-op-settings",
            settings: {},
        });
        await projects.archive(root, agent, project.id, { operationId: "no-op-archive" });
        expect(events).toHaveLength(1);
        events.length = 0;
        await projects.archive(root, agent, project.id, { operationId: "no-op-archive-again" });
        expect(events).toHaveLength(0);
    });

    it("enforces page and recursive settings bounds at the feature/store boundary", async () => {
        const store = new MemoryProjectStore();
        store.rows.set("a", makeProject("a"));
        store.rows.set("b", makeProject("b"));
        const projects = makeFeature(store, { maxPageSize: 1 });
        await expect(projects.listPage(root, agent, { limit: 2 })).rejects.toThrow("cannot exceed");
        const tooDeep: Record<string, unknown> = {};
        let current: Record<string, unknown> = tooDeep;
        for (let index = 0; index < 10; index += 1) {
            const child: Record<string, unknown> = {};
            current.child = child;
            current = child;
        }
        await expect(
            projects.updateSettings(root, agent, {
                projectId: "a",
                operationId: "deep-settings",
                settings: tooDeep,
            }),
        ).rejects.toThrow("invalid");
        expect(() => assertProjectSettings({ values: Array(65).fill(true) })).toThrow();
    });

    it("rejects non-plain objects instead of canonicalizing them as empty JSON", async () => {
        expect(Value.Check(projectSettingsSchema, new Map([["value", true]]))).toBe(false);
        expect(Value.Check(projectSettingsSchema, new Date())).toBe(false);
        expect(Value.Check(projectSettingsSchema, { nested: new Map([["value", true]]) })).toBe(
            false,
        );
        expect(() => assertProjectSettings(new Map([["value", true]]) as never)).toThrow("invalid");
        expect(() => assertProjectSettings(new Date() as never)).toThrow("invalid");
    });

    it("keeps the exported settings schema aligned with runtime depth validation", async () => {
        const runtimeLimit = nestedSettings(7);
        const oneTooDeep = nestedSettings(8);
        expect(Value.Check(projectSettingsSchema, runtimeLimit)).toBe(true);
        expect(Value.Check(projectSettingsSchema, oneTooDeep)).toBe(false);
        expect(() => assertProjectSettings(runtimeLimit)).not.toThrow();
        expect(() => assertProjectSettings(oneTooDeep)).toThrow("invalid");
    });

    it("canonicalizes equivalent Unicode settings key insertion orders identically", async () => {
        const store = new MemoryProjectStore();
        const projects = makeFeature(store);
        const composed = "e\u0301";
        const precomposed = "é";
        const first = projects.formatSettingsForModel({
            [precomposed]: "precomposed",
            [composed]: "composed",
        });
        const second = projects.formatSettingsForModel({
            [composed]: "composed",
            [precomposed]: "precomposed",
        });
        expect(first).toBe(second);
    });

    it("rejects invisible project IDs while retaining the maximum visible length", async () => {
        expect(Value.Check(projectIdSchema, " ".repeat(96))).toBe(false);
        expect(Value.Check(projectIdSchema, "\t".repeat(96))).toBe(false);
        expect(Value.Check(projectIdSchema, "\u0085".repeat(96))).toBe(false);
        expect(Value.Check(projectIdSchema, "\u200B".repeat(96))).toBe(false);
        expect(Value.Check(projectIdSchema, "\u0301".repeat(96))).toBe(false);
        expect(Value.Check(projectIdSchema, "\u200D".repeat(96))).toBe(false);
        expect(Value.Check(projectIdSchema, "\uFFF9".repeat(96))).toBe(false);
        expect(Value.Check(projectIdSchema, "\u{1BCA0}".repeat(96))).toBe(false);
        expect(Value.Check(projectIdSchema, "\uD800")).toBe(false);
        expect(Value.Check(projectIdSchema, "x\uD800")).toBe(false);
        for (const id of ["project id", "a\u200Bb", "❤️", "👨‍💻", "界".repeat(96)]) {
            expect(Value.Check(projectIdSchema, id)).toBe(true);
            expect(Value.Check(projectAgentIdSchema, id)).toBe(true);
        }
        expect(Value.Check(projectIdSchema, "x".repeat(96))).toBe(true);
        expect(Value.Check(projectIdSchema, "x".repeat(97))).toBe(false);
        for (const id of [
            " ".repeat(96),
            "\u200B".repeat(96),
            "\u034F".repeat(96),
            "\u0301".repeat(96),
            "\uD800",
        ]) {
            expect(Value.Check(projectAgentIdSchema, id)).toBe(false);
        }
    });

    it("rejects settings whose encoded bytes exceed the persistence boundary", async () => {
        const store = new MemoryProjectStore();
        store.rows.set("encoded", makeProject("encoded"));
        store.settings.set("encoded", {});
        const projects = makeFeature(store);
        const oversized = Object.fromEntries(
            Array.from({ length: 64 }, (_, index) => [`key-${index}`, "x".repeat(400)]),
        );

        expect(() => assertProjectSettings(oversized)).toThrow("encoded-byte");
        await expect(
            projects.updateSettings(root, agent, {
                projectId: "encoded",
                operationId: "encoded-too-large",
                settings: oversized,
            }),
        ).rejects.toThrow("encoded-byte");
        expect(store.calls).not.toContain("updateSettings");
    });

    it("keeps minimum-budget maximum-length identities actionable and detail complete", async () => {
        const store = new MemoryProjectStore();
        const longId = "界".repeat(96);
        const project = makeProject(longId, agent, {
            repositoryRef: "repo:" + "r".repeat(1_000),
            name: "name-" + "n".repeat(450),
            description: "description-" + "d".repeat(1_000),
        });
        store.rows.set(longId, project);
        store.settings.set(longId, { long: "x".repeat(4_000) });
        const projects = makeFeature(store, { maxPageSize: 2, maxOutputCharacters: 256 });
        const page = await projects.listPage(root, agent, { limit: 1 });
        expect(page.projects).toHaveLength(1);
        expect(page.projects[0]!.id).toBe(longId);
        expect(projects.formatPageForModel(page)).toContain(longId);

        const detailParts: string[] = [];
        let offset: number | undefined;
        do {
            const detail = await projects.getPage(root, agent, longId, {
                detailLimit: 80,
                ...(offset === undefined ? {} : { detailOffset: offset }),
            });
            expect(Value.Check(projectDetailPageSchema, detail)).toBe(true);
            expect(projects.formatDetailPageForModel(detail).length).toBeLessThanOrEqual(256);
            if (detail.project === null) throw new Error("project disappeared");
            detailParts.push(detail.detail);
            offset = detail.nextDetailOffset;
        } while (offset !== undefined);
        expect(detailParts.join("")).toContain(project.repositoryRef);
        expect(detailParts.join("")).toContain(project.ownerAgentId);
        const settingsPage = await projects.readSettingsPage(root, agent, longId, {
            detailLimit: 80,
        });
        expect(Value.Check(projectSettingsPageSchema, settingsPage)).toBe(true);
        expect(projects.formatSettingsPageForModel(settingsPage).length).toBeLessThanOrEqual(256);
    });

    it("denies cross-agent access by default and allows injected policy", async () => {
        const store = new MemoryProjectStore();
        store.rows.set("foreign", makeProject("foreign", otherAgent));
        store.settings.set("foreign", { visible: true });
        await expect(makeFeature(store).get(root, agent, "foreign")).rejects.toThrow(
            "not authorized",
        );
        const allowed = makeFeature(store, {
            authorization: async (_ctx, acting, owner, action) =>
                acting === agent && owner === otherAgent && action === "get",
        });
        await expect(allowed.get(root, agent, "foreign")).resolves.toMatchObject({
            id: "foreign",
            ownerAgentId: otherAgent,
        });
        await expect(allowed.readSettings(root, agent, "foreign")).rejects.toThrow(
            "not authorized",
        );
    });

    it("routes cross-agent mutations and their replays through authorization policy", async () => {
        const store = new MemoryProjectStore();
        store.rows.set("foreign-mutations", makeProject("foreign-mutations", otherAgent));
        store.settings.set("foreign-mutations", {});
        const denied = makeFeature(store);
        await expect(
            denied.rename(root, agent, {
                projectId: "foreign-mutations",
                operationId: "foreign-rename-denied",
                name: "Denied",
            }),
        ).rejects.toThrow("not authorized");
        await expect(
            denied.updateSettings(root, agent, {
                projectId: "foreign-mutations",
                operationId: "foreign-settings-denied",
                settings: { denied: true },
            }),
        ).rejects.toThrow("not authorized");
        await expect(
            denied.archive(root, agent, "foreign-mutations", {
                operationId: "foreign-archive-denied",
            }),
        ).rejects.toThrow("not authorized");
        await expect(
            denied.ensure(root, agent, {
                repositoryRef: "repo:foreign-mutations",
                operationId: "foreign-ensure-denied",
            }),
        ).rejects.toThrow("not authorized");

        let allow = true;
        const allowed = makeFeature(store, {
            authorization: async (_ctx, acting, owner, action) =>
                allow &&
                acting === agent &&
                owner === otherAgent &&
                ["rename", "settings_update", "archive", "ensure"].includes(action),
        });
        const renamed = await allowed.rename(root, agent, {
            projectId: "foreign-mutations",
            operationId: "foreign-rename-allowed",
            name: "Allowed",
        });
        expect(renamed.name).toBe("Allowed");
        allow = false;
        await expect(
            allowed.rename(root, agent, {
                projectId: "foreign-mutations",
                operationId: "foreign-rename-allowed",
                name: "Allowed",
            }),
        ).rejects.toThrow("not authorized");
        allow = true;
        const ensured = await allowed.ensure(root, agent, {
            repositoryRef: "repo:foreign-mutations",
            operationId: "foreign-ensure-allowed",
        });
        expect(ensured.created).toBe(false);
        const settings = await allowed.updateSettings(root, agent, {
            projectId: "foreign-mutations",
            operationId: "foreign-settings-allowed",
            settings: { allowed: true },
        });
        expect(settings.settings).toEqual({ allowed: true });
        const archived = await allowed.archive(root, agent, "foreign-mutations", {
            operationId: "foreign-archive-allowed",
        });
        expect(archived.status).toBe("archived");
    });

    it("keeps the in-memory store's IDs unique and uses JavaScript ordering", async () => {
        const store = new MemoryProjectStore();
        const host = store.asStore();
        const operation = {
            operation: "create" as const,
            operationId: "double-create",
            fingerprint: "a".repeat(64),
        };
        const input = {
            id: "double",
            ownerAgentId: agent,
            repositoryRef: "repo:double",
            name: "Double",
        } as const;
        await host.create(root, agent, input, operation);
        await expect(
            host.create(root, agent, input, {
                ...operation,
                operationId: "double-create-again",
            }),
        ).rejects.toThrow("duplicate project ID");

        store.rows.set("z", makeProject("z"));
        store.rows.set("ä", makeProject("ä"));
        const page = await makeFeature(store).listPage(root, agent, { limit: 2 });
        expect(page.projects.map((project) => project.id)).toEqual(["double", "z"]);
        const unicodePage = await makeFeature(store).listPage(root, agent, {
            cursor: "2",
            limit: 2,
        });
        expect(unicodePage.projects.map((project) => project.id)).toEqual(["ä"]);
    });

    it("validates options and tool schemas without exposing operation identities", async () => {
        const store = new MemoryProjectStore();
        expect(Value.Check(projectFeatureOptionsSchema, { store, extra: true })).toBe(false);
        expect(() => new ProjectsFeature({ store, extra: true } as never)).toThrow("invalid");
        const projects = makeFeature(store);
        const tools = projects.tools(callContext(), { agent: { id: agent } } as never);
        expect(Value.Check(tools[2]!.parameters, { repositoryRef: "repo", name: "name" })).toBe(
            true,
        );
        expect(
            Value.Check(tools[2]!.parameters, {
                repositoryRef: "repo",
                name: "name",
                operationId: "hidden",
                id: "hidden",
            }),
        ).toBe(false);
    });
});
