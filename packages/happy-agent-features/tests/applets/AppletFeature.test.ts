import { AgentKV, withAgentKV } from "@slopus/happy-agent-base";
import { Value } from "@sinclair/typebox/value";
import { createRootContext, type Context } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import {
    appletCurrentResultSchema,
    appletSchema,
    type Applet,
    type AppletAsset,
    type AppletImportInput,
    type AppletListPage,
} from "../../sources/applets/Applet.js";
import type { AppletEvent } from "../../sources/applets/AppletEvent.js";
import { AppletFeature, appletFeatureOptionsSchema } from "../../sources/applets/AppletFeature.js";
import * as featureRoot from "../../sources/index.js";
import type {
    AppletCatalog,
    AppletCatalogCreateResult,
    AppletCatalogMutationResult,
    AppletCatalogMutationReceipt,
    AppletCatalogMutationProof,
    AppletCatalogRevertResult,
    AppletCatalogRemoveResult,
    AppletCatalogUpdateResult,
    AssetReader,
    SourceImporter,
} from "../../sources/applets/AppletStore.js";
import { appletCatalogSchema } from "../../sources/applets/AppletStore.js";
import { agentWorld } from "../support/agentWorld.js";

const ctx = createRootContext().named("applets-feature-test");

function makeApplet(name: string, version = 1): Applet {
    return {
        name,
        description: `${name} description`,
        purpose: "testing",
        authorSessionId: "host-author",
        allowedScopes: ["global"],
        currentVersion: version,
        versions: Array.from({ length: version }, (_, index) => ({
            version: index + 1,
            changeDescription: index === 0 ? "Initial import" : `Update ${index + 1}`,
            createdAt: 100 + index,
            operationId: `op-${name}-${index + 1}`,
        })),
        createdAt: 100,
        updatedAt: 100 + version - 1,
    };
}

class FakeAppletCatalog {
    readonly rows = new Map<string, Applet>();
    readonly callbacks: Array<(postCommitCtx: Context) => void | Promise<void>> = [];
    readonly rollbackCallbacks: Array<(rollbackCtx: Context) => void | Promise<void>> = [];
    readonly transactions: string[] = [];
    readonly operationReceipts = new Map<string, AppletCatalogMutationResult>();
    readonly catalogReceipts = new Map<string, AppletCatalogMutationReceipt>();
    readonly catalogProofs = new Map<string, AppletCatalogMutationProof>();
    #depth = 0;
    #snapshot = new Map<string, Applet>();
    #receiptSnapshot = new Map<string, AppletCatalogMutationResult>();
    #catalogReceiptSnapshot = new Map<string, AppletCatalogMutationReceipt>();
    #catalogProofSnapshot = new Map<string, AppletCatalogMutationProof>();

    readonly contract: AppletCatalog = {
        transaction: this.transaction.bind(this),
        afterCommit: this.afterCommit.bind(this),
        onRollback: this.onRollback.bind(this),
        list: this.list.bind(this),
        get: this.get.bind(this),
        create: this.create.bind(this),
        update: this.update.bind(this),
        revert: this.revert.bind(this),
        remove: this.remove.bind(this),
        readReceipt: this.readReceipt.bind(this),
        writeReceipt: this.writeReceipt.bind(this),
        readMutationProof: this.readMutationProof.bind(this),
        writeMutationProof: this.writeMutationProof.bind(this),
        current: this.current.bind(this),
    };

    async transaction<Result>(
        transactionCtx: Context,
        work: (txCtx: Context) => Promise<Result>,
    ): Promise<Result> {
        if (this.#depth === 0) {
            this.#snapshot = cloneRows(this.rows);
            this.#receiptSnapshot = cloneReceipts(this.operationReceipts);
            this.#catalogReceiptSnapshot = cloneMutationReceipts(this.catalogReceipts);
            this.#catalogProofSnapshot = cloneMutationProofs(this.catalogProofs);
        }
        this.#depth++;
        this.transactions.push(`depth:${this.#depth}`);
        try {
            const result = await work(transactionCtx);
            this.#depth--;
            if (this.#depth === 0) {
                const callbacks = this.callbacks.splice(0);
                this.rollbackCallbacks.length = 0;
                for (const callback of callbacks) await callback(ctx);
            }
            return result;
        } catch (error: unknown) {
            this.#depth--;
            if (this.#depth === 0) {
                this.rows.clear();
                for (const [name, applet] of this.#snapshot) {
                    this.rows.set(name, structuredClone(applet));
                }
                this.operationReceipts.clear();
                for (const [key, receipt] of this.#receiptSnapshot) {
                    this.operationReceipts.set(key, structuredClone(receipt));
                }
                this.catalogReceipts.clear();
                for (const [key, receipt] of this.#catalogReceiptSnapshot) {
                    this.catalogReceipts.set(key, structuredClone(receipt));
                }
                this.catalogProofs.clear();
                for (const [key, proof] of this.#catalogProofSnapshot) {
                    this.catalogProofs.set(key, structuredClone(proof));
                }
                const rollbackCallbacks = this.rollbackCallbacks.splice(0);
                this.callbacks.length = 0;
                for (const callback of rollbackCallbacks) {
                    await callback(ctx);
                }
            }
            throw error;
        }
    }

    afterCommit(
        _transactionCtx: Context,
        callback: (postCommitCtx: Context) => void | Promise<void>,
    ): void {
        this.callbacks.push(callback);
    }

    onRollback(
        _transactionCtx: Context,
        callback: (rollbackCtx: Context) => void | Promise<void>,
    ): void {
        this.rollbackCallbacks.push(callback);
    }

    async list(
        _ctx: Context,
        query: { readonly limit: number; readonly cursor?: string },
    ): Promise<AppletListPage> {
        const start = query.cursor === undefined ? 0 : Number(query.cursor);
        const applets = [...this.rows.values()]
            .sort((left, right) => left.name.localeCompare(right.name))
            .slice(start, start + query.limit)
            .map((applet) => structuredClone(applet));
        const hasMore = start + applets.length < this.rows.size;
        if (hasMore) {
            return {
                applets,
                limit: query.limit,
                hasMore: true,
                nextCursor: String(start + applets.length),
            };
        }
        return { applets, limit: query.limit, hasMore: false };
    }

    async get(_ctx: Context, name: string): Promise<Applet | undefined> {
        const applet = this.rows.get(name);
        return applet === undefined ? undefined : structuredClone(applet);
    }

    async create(
        _ctx: Context,
        input: Parameters<AppletCatalog["create"]>[1],
    ): Promise<AppletCatalogCreateResult> {
        const key = `create:${input.name}:${input.operationId}`;
        const receipt = this.operationReceipts.get(key);
        if (receipt !== undefined) return structuredClone(receipt) as AppletCatalogCreateResult;
        if (this.rows.has(input.name)) throw new Error("Applet already exists.");
        const applet: Applet = {
            name: input.name,
            description: input.description,
            purpose: input.purpose,
            authorSessionId: input.authorSessionId,
            allowedScopes: input.allowedScopes ?? ["global"],
            ...(input.sourceDescription === undefined
                ? {}
                : { sourceDescription: input.sourceDescription }),
            currentVersion: 1,
            versions: [structuredClone(input.initialVersion)],
            createdAt: input.initialVersion.createdAt,
            updatedAt: input.initialVersion.createdAt,
        };
        this.rows.set(applet.name, applet);
        const result: AppletCatalogCreateResult = {
            operation: "create",
            name: applet.name,
            operationId: input.operationId,
            targetVersion: 1,
            currentVersion: 1,
            changed: true,
            applet: structuredClone(applet),
        };
        this.operationReceipts.set(key, result);
        return structuredClone(result);
    }

    async update(
        _ctx: Context,
        name: string,
        input: Parameters<AppletCatalog["update"]>[2],
    ): Promise<AppletCatalogUpdateResult> {
        const key = `update:${name}:${input.operationId}`;
        const receipt = this.operationReceipts.get(key);
        if (receipt !== undefined) {
            return { ...structuredClone(receipt), changed: false } as AppletCatalogUpdateResult;
        }
        const current = this.rows.get(name);
        if (current === undefined) throw new Error("missing applet");
        if (input.version !== current.versions.length + 1) {
            throw new Error("wrong target version");
        }
        const updated = structuredClone(current);
        updated.currentVersion = input.version;
        updated.updatedAt = input.createdAt;
        updated.versions.push({
            version: input.version,
            changeDescription: input.changeDescription,
            createdAt: updated.updatedAt,
            operationId: input.operationId,
        });
        if (input.description !== undefined) updated.description = input.description;
        if (input.purpose !== undefined) updated.purpose = input.purpose;
        if (input.allowedScopes !== undefined) updated.allowedScopes = input.allowedScopes;
        if (input.sourceDescription !== undefined) {
            updated.sourceDescription = input.sourceDescription;
        }
        this.rows.set(name, updated);
        const result: AppletCatalogUpdateResult = {
            operation: "update",
            name,
            operationId: input.operationId,
            targetVersion: input.version,
            currentVersion: updated.currentVersion,
            changed: true,
            applet: structuredClone(updated),
        };
        this.operationReceipts.set(key, result);
        return structuredClone(result);
    }

    async revert(
        _ctx: Context,
        name: string,
        input: Parameters<AppletCatalog["revert"]>[2],
    ): Promise<AppletCatalogRevertResult> {
        const key = `revert:${name}:${input.operationId}`;
        const receipt = this.operationReceipts.get(key);
        if (receipt !== undefined) {
            return { ...structuredClone(receipt), changed: false } as AppletCatalogRevertResult;
        }
        const current = this.rows.get(name);
        if (current === undefined) throw new Error("missing applet");
        const reverted = structuredClone(current);
        reverted.currentVersion = input.version;
        reverted.updatedAt++;
        this.rows.set(name, reverted);
        const result: AppletCatalogRevertResult = {
            operation: "revert",
            name,
            operationId: input.operationId,
            targetVersion: input.version,
            currentVersion: input.version,
            changed: current.currentVersion !== input.version,
            applet: structuredClone(reverted),
        };
        this.operationReceipts.set(key, result);
        return structuredClone(result);
    }

    async remove(
        _ctx: Context,
        name: string,
        operationId: string,
    ): Promise<AppletCatalogRemoveResult> {
        const key = `remove:${name}:${operationId}`;
        const receipt = this.operationReceipts.get(key);
        if (receipt !== undefined) {
            return {
                ...structuredClone(receipt),
                changed: false,
                removed: false,
            } as AppletCatalogRemoveResult;
        }
        const existing = this.rows.get(name);
        if (existing === undefined) {
            const result: AppletCatalogRemoveResult = {
                operation: "remove",
                name,
                operationId,
                targetVersion: 0,
                currentVersion: 0,
                changed: false,
                removed: false,
            };
            this.operationReceipts.set(key, result);
            return result;
        }
        this.rows.delete(name);
        const result: AppletCatalogRemoveResult = {
            operation: "remove",
            name,
            operationId,
            targetVersion: 0,
            currentVersion: 0,
            changed: true,
            removed: true,
        };
        this.operationReceipts.set(key, result);
        return result;
    }

    async readReceipt(
        _ctx: Context,
        operationId: string,
    ): Promise<AppletCatalogMutationReceipt | undefined> {
        const receipt = this.catalogReceipts.get(operationId);
        return receipt === undefined ? undefined : structuredClone(receipt);
    }

    async writeReceipt(_ctx: Context, receipt: AppletCatalogMutationReceipt): Promise<void> {
        this.catalogReceipts.set(receipt.operationId, structuredClone(receipt));
    }

    async readMutationProof(
        _ctx: Context,
        operationId: string,
    ): Promise<AppletCatalogMutationProof | undefined> {
        const proof = this.catalogProofs.get(operationId);
        return proof === undefined ? undefined : structuredClone(proof);
    }

    async writeMutationProof(_ctx: Context, proof: AppletCatalogMutationProof): Promise<void> {
        this.catalogProofs.set(proof.operationId, structuredClone(proof));
    }

    async current(_ctx: Context, name: string) {
        const applet = this.rows.get(name);
        return applet?.versions.find((version) => version.version === applet.currentVersion);
    }
}

function cloneRows(rows: Map<string, Applet>): Map<string, Applet> {
    return new Map([...rows].map(([name, applet]) => [name, structuredClone(applet)]));
}

function cloneReceipts(
    receipts: Map<string, AppletCatalogMutationResult>,
): Map<string, AppletCatalogMutationResult> {
    return new Map([...receipts].map(([key, value]) => [key, structuredClone(value)]));
}

function cloneMutationReceipts(
    receipts: Map<string, AppletCatalogMutationReceipt>,
): Map<string, AppletCatalogMutationReceipt> {
    return new Map([...receipts].map(([key, value]) => [key, structuredClone(value)]));
}

function cloneMutationProofs(
    proofs: Map<string, AppletCatalogMutationProof>,
): Map<string, AppletCatalogMutationProof> {
    return new Map([...proofs].map(([key, value]) => [key, structuredClone(value)]));
}

function importer(state: {
    staged: string[];
    committed: string[];
    rolledBack: string[];
}): SourceImporter {
    return {
        stage: async (_ctx, input) => {
            state.staged.push(input.operationId);
            return {
                stageId: `stage-${input.operationId}`,
                name: input.name,
                version: input.version,
                operationId: input.operationId,
                fileCount: 1,
                byteCount: 10,
            };
        },
        commit: async (_ctx, stage) => {
            state.committed.push(stage.operationId);
        },
        rollback: async (_ctx, stage) => {
            state.rolledBack.push(stage.operationId);
        },
    };
}

function assetReader(asset: AppletAsset | undefined = undefined): AssetReader {
    return {
        readAsset: async () => asset,
    };
}

function feature(
    catalog: FakeAppletCatalog,
    state: { staged: string[]; committed: string[]; rolledBack: string[] } = {
        staged: [],
        committed: [],
        rolledBack: [],
    },
    overrides: Partial<AppletFeatureOptionsForTest> = {},
): AppletFeature {
    let event = 0;
    let operation = 0;
    return new AppletFeature({
        catalog: catalog.contract,
        importer: importer(state),
        assetReader: assetReader(),
        idFactory: () => `operation-${++operation}`,
        eventIdFactory: () => `event-${++event}`,
        authorFactory: async (_ctx, agentId) => `author-for-${agentId}`,
        clock: () => 100,
        ...overrides,
    });
}

type AppletFeatureOptionsForTest = ConstructorParameters<typeof AppletFeature>[0];

function featureWithCatalog(catalog: AppletCatalog): AppletFeature {
    return new AppletFeature({
        catalog,
        importer: importer({ staged: [], committed: [], rolledBack: [] }),
        assetReader: assetReader(),
        idFactory: () => "operation-1",
        eventIdFactory: () => "event-1",
        clock: () => 100,
    });
}

const input: AppletImportInput = {
    name: "demo-applet",
    description: "Demo applet",
    purpose: "test applet",
    authorSessionId: "direct-author",
    path: "source/demo",
    allowedScopes: ["global"],
};

describe("AppletFeature", () => {
    it("exports the complete applet runtime, contracts, feature, and tools from the package root", () => {
        expect(featureRoot.AppletFeature).toBe(AppletFeature);
        expect(featureRoot.appletSchema).toBe(appletSchema);
        expect(featureRoot.appletCatalogSchema).toBeDefined();
        expect(featureRoot.appletCatalogMutationProofSchema).toBeDefined();
        expect(featureRoot.assertAppletMutationProof).toBeDefined();
        expect(featureRoot.appletCatalogMutationReceiptSchema).toBeDefined();
        expect(featureRoot.appletEventSchema).toBeDefined();
        expect(featureRoot.createAppletTool).toBeDefined();
        expect(featureRoot.importAppletTool).toBeDefined();
        expect(featureRoot.listAppletsTool).toBeDefined();
        expect(featureRoot.getAppletTool).toBeDefined();
        expect(featureRoot.updateAppletTool).toBeDefined();
        expect(featureRoot.revertAppletTool).toBeDefined();
        expect(featureRoot.removeAppletTool).toBeDefined();
        expect(featureRoot.readAppletAssetTool).toBeDefined();
    });

    it("requires a TypeBox-valid current capability at construction", () => {
        const catalog = new FakeAppletCatalog();
        const missingCurrentCatalog = { ...catalog.contract };
        delete (missingCurrentCatalog as Partial<AppletCatalog>).current;
        expect(Value.Check(appletCatalogSchema, missingCurrentCatalog)).toBe(false);
        expect(() => featureWithCatalog(missingCurrentCatalog as unknown as AppletCatalog)).toThrow(
            "Applet feature options are invalid.",
        );

        const malformedCurrentCatalog = {
            ...catalog.contract,
            current: "not-a-function",
        };
        expect(Value.Check(appletCatalogSchema, malformedCurrentCatalog)).toBe(false);
        expect(() =>
            featureWithCatalog(malformedCurrentCatalog as unknown as AppletCatalog),
        ).toThrow("Applet feature options are invalid.");
    });

    it("requires an exact Promise current result and accepts undefined or a version", async () => {
        expect(Value.Check(appletCurrentResultSchema, undefined)).toBe(true);
        expect(Value.Check(appletCurrentResultSchema, null)).toBe(false);

        const syncCurrentCatalog = {
            ...new FakeAppletCatalog().contract,
            current: () => undefined,
        };
        const syncCurrent = featureWithCatalog(syncCurrentCatalog as unknown as AppletCatalog);
        await expect(syncCurrent.current(ctx, "agent-1", input.name)).rejects.toThrow(
            "Applet catalog current must return a Promise.",
        );

        const nullCurrentCatalog = {
            ...new FakeAppletCatalog().contract,
            current: async () => null,
        };
        const nullCurrent = featureWithCatalog(nullCurrentCatalog as unknown as AppletCatalog);
        await expect(nullCurrent.current(ctx, "agent-1", input.name)).rejects.toThrow(
            "Applet catalog returned an invalid current version.",
        );

        const catalog = new FakeAppletCatalog();
        const applets = feature(catalog);
        await expect(applets.current(ctx, "agent-1", input.name)).resolves.toBeUndefined();
        const created = await applets.import(ctx, input);
        await expect(applets.current(ctx, "agent-1", input.name)).resolves.toEqual(
            created.versions[0],
        );
    });

    it("compares current with the authoritative catalog pointer and rejects stale identities", async () => {
        const catalog = new FakeAppletCatalog();
        const applets = feature(catalog);
        const created = await applets.import(ctx, input);
        await applets.update(ctx, input.name, {
            path: "source/demo-v2",
            changeDescription: "Second version",
        });

        catalog.contract.current = async () => created.versions[0];
        await expect(applets.current(ctx, "agent-1", input.name)).rejects.toThrow(
            "stale or unrelated",
        );

        const unrelatedCatalog = new FakeAppletCatalog();
        unrelatedCatalog.rows.set(input.name, makeApplet(input.name));
        unrelatedCatalog.contract.current = async () => makeApplet("other-applet").versions[0];
        const unrelated = feature(unrelatedCatalog);
        await expect(unrelated.current(ctx, "agent-1", input.name)).rejects.toThrow(
            "stale or unrelated",
        );

        const mismatchedGetCatalog = new FakeAppletCatalog();
        mismatchedGetCatalog.rows.set(input.name, makeApplet(input.name));
        mismatchedGetCatalog.contract.get = async () => makeApplet("other-applet");
        const mismatchedGet = feature(mismatchedGetCatalog);
        await expect(mismatchedGet.current(ctx, "agent-1", input.name)).rejects.toThrow(
            "different applet name",
        );
    });

    it("keeps public operations and common tools on one host catalog", async () => {
        const catalog = new FakeAppletCatalog();
        const applets = feature(catalog);
        const tools = applets.tools(ctx, { agent: { id: "agent-1" } } as never);

        expect(tools.map((tool) => tool.name)).toEqual([
            "create_applet",
            "import_applet",
            "list_applets",
            "get_applet",
            "update_applet",
            "revert_applet",
            "remove_applet",
            "read_applet_asset",
        ]);
        expect(
            Value.Check(tools[0]!.parameters, {
                name: input.name,
                description: input.description,
                purpose: input.purpose,
                path: input.path,
            }),
        ).toBe(true);
        expect(
            Value.Check(tools[0]!.parameters, {
                ...input,
                authorSessionId: "model-controlled",
            }),
        ).toBe(false);

        const created = await tools[0]!.execute(ctx, {
            name: input.name,
            description: input.description,
            purpose: input.purpose,
            path: input.path,
            allowedScopes: input.allowedScopes,
        });
        expect(created.applet.authorSessionId).toBe("author-for-agent-1");
        expect(Value.Check(appletSchema, created.applet)).toBe(true);
        const page = await tools[2]!.execute(ctx, { limit: 10 });
        expect(page.applets).toHaveLength(1);
        expect((await tools[3]!.execute(ctx, { name: input.name })).applet).toEqual(created.applet);
    });

    it("reuses durable call-scoped operation identities for every mutation", async () => {
        const catalog = new FakeAppletCatalog();
        const state = {
            staged: [] as string[],
            committed: [] as string[],
            rolledBack: [] as string[],
        };
        const applets = feature(catalog, state);
        const world = agentWorld();
        const callCtx = withAgentKV(
            ctx,
            new AgentKV(world.storage.persistence("agent-1"), "call.applet."),
        );
        const tools = applets.tools(callCtx, { agent: { id: "agent-1" } } as never);
        const createInput = {
            name: input.name,
            description: input.description,
            purpose: input.purpose,
            path: input.path,
            allowedScopes: input.allowedScopes,
        };
        await tools[0]!.execute(callCtx, createInput);
        await tools[0]!.execute(callCtx, createInput);
        await expect(
            tools[0]!.execute(callCtx, { ...createInput, description: "different request" }),
        ).rejects.toThrow("different input");
        await tools[4]!.execute(callCtx, {
            name: input.name,
            path: "source/demo-v2",
            changeDescription: "Second version",
        });
        await tools[4]!.execute(callCtx, {
            name: input.name,
            path: "source/demo-v2",
            changeDescription: "Second version",
        });
        await tools[5]!.execute(callCtx, { name: input.name, version: 1 });
        await tools[5]!.execute(callCtx, { name: input.name, version: 1 });
        await tools[6]!.execute(callCtx, { name: input.name });
        await tools[6]!.execute(callCtx, { name: input.name });

        expect(state.staged).toEqual(["operation-1", "operation-2"]);
        expect(state.committed).toEqual(["operation-1", "operation-2"]);
        expect(state.rolledBack).toEqual([]);
        expect(catalog.rows.has(input.name)).toBe(false);
    });

    it("rolls staged sources back on listener failure and on an outer rollback", async () => {
        const failedCatalog = new FakeAppletCatalog();
        const failedState = {
            staged: [] as string[],
            committed: [] as string[],
            rolledBack: [] as string[],
        };
        const failed = feature(failedCatalog, failedState, {
            listener: {
                onEventTransactional: () => {
                    throw new Error("listener failed");
                },
            },
        });
        await expect(failed.import(ctx, input)).rejects.toThrow("listener failed");
        expect(failedState.committed).toEqual([]);
        expect(failedState.rolledBack).toEqual(["operation-1"]);
        expect(failedCatalog.rows.size).toBe(0);

        const nestedCatalog = new FakeAppletCatalog();
        const nestedState = {
            staged: [] as string[],
            committed: [] as string[],
            rolledBack: [] as string[],
        };
        const nested = feature(nestedCatalog, nestedState);
        await expect(
            nestedCatalog.transaction(ctx, async (outerCtx) => {
                await nested.import(outerCtx, input);
                throw new Error("outer rollback");
            }),
        ).rejects.toThrow("outer rollback");
        expect(nestedState.committed).toEqual([]);
        expect(nestedState.rolledBack).toEqual(["operation-1"]);
        expect(nestedCatalog.rows.size).toBe(0);
    });

    it("publishes cloned frozen stable events only after the outer commit", async () => {
        const catalog = new FakeAppletCatalog();
        const transactional: AppletEvent[] = [];
        const postCommit: AppletEvent[] = [];
        const applets = feature(catalog, undefined, {
            listener: {
                onEventTransactional: (_ctx, event) => {
                    transactional.push(event);
                    expect(Object.isFrozen(event)).toBe(true);
                    expect(() =>
                        Object.defineProperty(event, "eventId", { value: "mutated" }),
                    ).toThrow();
                },
                onEvent: (_ctx, event) => {
                    postCommit.push(event);
                    expect(Object.isFrozen(event)).toBe(true);
                },
            },
        });

        await catalog.transaction(ctx, async (outerCtx) => {
            await applets.import(outerCtx, input);
            expect(postCommit).toHaveLength(0);
            expect(transactional).toHaveLength(1);
        });
        expect(postCommit).toEqual(transactional);
        expect(postCommit[0]).toBe(transactional[0]);
    });

    it("invokes class-backed listeners with their owning receiver", async () => {
        let transactionalCount = 0;
        let postCommitCount = 0;
        class Listener {
            onEventTransactional(): void {
                if (!(this instanceof Listener)) throw new Error("listener receiver was lost");
                transactionalCount++;
            }

            onEvent(): void {
                if (!(this instanceof Listener)) throw new Error("listener receiver was lost");
                postCommitCount++;
            }
        }

        const listener = new Listener();
        const catalog = new FakeAppletCatalog();
        const applets = feature(catalog, undefined, { listener });

        await applets.import(ctx, input);

        expect(transactionalCount).toBe(1);
        expect(postCommitCount).toBe(1);
    });

    it("commits staged sources before publishing success and reports commit failures with the event", async () => {
        const catalog = new FakeAppletCatalog();
        const state = {
            staged: [] as string[],
            committed: [] as string[],
            rolledBack: [] as string[],
        };
        const source = importer(state);
        const commitError = new Error("source commit failed");
        const failingImporter: SourceImporter = {
            ...source,
            commit: async () => {
                throw commitError;
            },
        };
        const transactional: AppletEvent[] = [];
        const postCommit: AppletEvent[] = [];
        const failures: Array<{ event: AppletEvent; error: unknown }> = [];
        const applets = feature(catalog, state, {
            importer: failingImporter,
            listener: {
                onEventTransactional: (_ctx, event) => {
                    transactional.push(event);
                },
                onEvent: (_ctx, event) => {
                    postCommit.push(event);
                },
            },
            onPostCommitError: (_ctx, event, error) => {
                failures.push({ event, error });
            },
        });

        await applets.import(ctx, input);
        expect(state.committed).toEqual([]);
        expect(state.rolledBack).toEqual(["operation-1"]);
        expect(transactional).toHaveLength(1);
        expect(postCommit).toEqual([]);
        expect(failures).toHaveLength(1);
        expect(failures[0]!.event).toEqual(transactional[0]);
        expect(failures[0]!.error).toBe(commitError);
    });

    it("uses catalog receipts for explicit public operation IDs and returns the durable remove result on replay", async () => {
        const catalog = new FakeAppletCatalog();
        const applets = feature(catalog);
        const publicInput = { ...input, operationId: "public-create" };

        const created = await applets.import(ctx, publicInput);
        await expect(
            applets.import(ctx, { ...publicInput, path: "source/altered" }),
        ).rejects.toThrow("reused with different input");
        await expect(applets.import(ctx, { ...publicInput, name: "other-applet" })).rejects.toThrow(
            "reused with different input",
        );
        expect(await applets.import(ctx, publicInput)).toEqual(created);

        expect(await applets.remove(ctx, input.name, "public-remove")).toBe(true);
        expect(await applets.remove(ctx, input.name, "public-remove")).toBe(true);
    });

    it("reconciles schema-valid replay receipts with authoritative catalog state", async () => {
        const createCatalog = new FakeAppletCatalog();
        const createApplets = feature(createCatalog);
        const createInput = { ...input, operationId: "receipt-create-authority" };
        await createApplets.import(ctx, createInput);
        const createReceipt = createCatalog.catalogReceipts.get(createInput.operationId)!;
        if (createReceipt.result.operation !== "create") throw new Error("wrong test receipt");
        createReceipt.result.applet.description = "receipt-only description";
        createReceipt.result.applet.updatedAt = 101;
        await expect(createApplets.import(ctx, createInput)).rejects.toThrow("authoritative");

        const updateCatalog = new FakeAppletCatalog();
        const updateApplets = feature(updateCatalog);
        await updateApplets.import(ctx, input);
        const updateInput = {
            path: "source/demo-v2",
            changeDescription: "Second version",
            operationId: "receipt-update-authority",
        };
        await updateApplets.update(ctx, input.name, updateInput);
        const updateReceipt = updateCatalog.catalogReceipts.get(updateInput.operationId)!;
        if (updateReceipt.result.operation !== "update") throw new Error("wrong test receipt");
        updateReceipt.result.applet.versions[0]!.changeDescription = "receipt-only archive";
        await expect(updateApplets.update(ctx, input.name, updateInput)).rejects.toThrow(
            "authoritative",
        );

        const changedCatalog = new FakeAppletCatalog();
        const changedApplets = feature(changedCatalog);
        const changedInput = { ...input, operationId: "receipt-changed-authority" };
        await changedApplets.import(ctx, changedInput);
        const changedReceipt = changedCatalog.catalogReceipts.get(changedInput.operationId)!;
        if (changedReceipt.result.operation !== "create") throw new Error("wrong test receipt");
        changedReceipt.result.changed = false;
        await expect(changedApplets.import(ctx, changedInput)).rejects.toThrow(
            "immutable mutation proof",
        );

        const removeCatalog = new FakeAppletCatalog();
        const removeApplets = feature(removeCatalog);
        await removeApplets.import(ctx, input);
        await removeApplets.remove(ctx, input.name, "receipt-remove-authority");
        const removeReceipt = removeCatalog.catalogReceipts.get("receipt-remove-authority")!;
        if (removeReceipt.result.operation !== "remove") throw new Error("wrong test receipt");
        removeReceipt.result.changed = true;
        removeReceipt.result.removed = false;
        await expect(
            removeApplets.remove(ctx, input.name, "receipt-remove-authority"),
        ).rejects.toThrow("authoritative");
    });

    it("uses durable before-state markers to reject tampered revert and remove replays after restart", async () => {
        const updateCatalog = new FakeAppletCatalog();
        const updateApplets = feature(updateCatalog);
        await updateApplets.import(ctx, input);
        await updateApplets.update(ctx, input.name, {
            path: "source/demo-v2",
            changeDescription: "Second version",
            operationId: "replay-update-marker",
        });
        const updateReceipt = updateCatalog.catalogReceipts.get("replay-update-marker")!;
        expect(updateReceipt.beforeExists).toBe(true);
        expect(updateReceipt.beforeCurrentVersion).toBe(1);
        updateReceipt.beforeCurrentVersion = 99;

        const restartedUpdate = feature(updateCatalog);
        await expect(
            restartedUpdate.update(ctx, input.name, {
                path: "source/demo-v2",
                changeDescription: "Second version",
                operationId: "replay-update-marker",
            }),
        ).rejects.toThrow("immutable mutation proof");

        const revertCatalog = new FakeAppletCatalog();
        const revertApplets = feature(revertCatalog);
        await revertApplets.import(ctx, input);
        await revertApplets.update(ctx, input.name, {
            path: "source/demo-v2",
            changeDescription: "Second version",
        });
        await revertApplets.revert(ctx, input.name, {
            version: 1,
            operationId: "replay-revert-marker",
        });
        const revertReceipt = revertCatalog.catalogReceipts.get("replay-revert-marker")!;
        expect(revertReceipt.beforeExists).toBe(true);
        expect(revertReceipt.beforeCurrentVersion).toBe(2);
        if (revertReceipt.result.operation !== "revert") throw new Error("wrong test receipt");
        revertReceipt.beforeCurrentVersion = 99;

        const restartedRevert = feature(revertCatalog);
        await expect(
            restartedRevert.revert(ctx, input.name, {
                version: 1,
                operationId: "replay-revert-marker",
            }),
        ).rejects.toThrow("immutable mutation proof");
        revertReceipt.beforeCurrentVersion = 2;
        if (revertReceipt.result.operation !== "revert") throw new Error("wrong test receipt");
        revertReceipt.result.changed = false;
        const restartedRevertResult = feature(revertCatalog);
        await expect(
            restartedRevertResult.revert(ctx, input.name, {
                version: 1,
                operationId: "replay-revert-marker",
            }),
        ).rejects.toThrow("immutable mutation proof");

        const removeCatalog = new FakeAppletCatalog();
        const removeApplets = feature(removeCatalog);
        await removeApplets.import(ctx, input);
        await removeApplets.remove(ctx, input.name, "replay-remove-marker");
        const removeReceipt = removeCatalog.catalogReceipts.get("replay-remove-marker")!;
        expect(removeReceipt.beforeExists).toBe(true);
        expect(removeReceipt.beforeCurrentVersion).toBe(1);
        if (removeReceipt.result.operation !== "remove") throw new Error("wrong test receipt");
        removeReceipt.beforeCurrentVersion = 99;

        const restartedRemove = feature(removeCatalog);
        await expect(
            restartedRemove.remove(ctx, input.name, "replay-remove-marker"),
        ).rejects.toThrow("immutable mutation proof");
        removeReceipt.beforeCurrentVersion = 1;
        if (removeReceipt.result.operation !== "remove") throw new Error("wrong test receipt");
        removeReceipt.result.changed = false;
        removeReceipt.result.removed = false;
        const restartedRemoveResult = feature(removeCatalog);
        await expect(
            restartedRemoveResult.remove(ctx, input.name, "replay-remove-marker"),
        ).rejects.toThrow("immutable mutation proof");
    });

    it("rejects malformed pages, non-progressing cursors, and substituted mutation results", async () => {
        const malformedPageCatalog = new FakeAppletCatalog();
        malformedPageCatalog.contract.list = async () =>
            ({
                applets: [makeApplet("one")],
                limit: 1,
                hasMore: true,
                nextCursor: "same",
            }) satisfies AppletListPage;
        const malformedPage = feature(malformedPageCatalog, undefined, { maxListSize: 1 });
        await expect(malformedPage.listPage(ctx, { limit: 1, cursor: "same" })).rejects.toThrow(
            "non-progressing",
        );

        const substitutedCatalog = new FakeAppletCatalog();
        substitutedCatalog.contract.create = async (...args) => {
            const result = await new FakeAppletCatalog().create(...args);
            return { ...result, name: "other-name" };
        };
        const substituted = feature(substitutedCatalog);
        await expect(substituted.import(ctx, input)).rejects.toThrow("wrong applet name");
    });

    it("compares a detached transaction receipt after the catalog adapter returns", async () => {
        const catalog = new FakeAppletCatalog();
        const transaction = catalog.contract.transaction;
        catalog.contract.transaction = async (transactionCtx, work) =>
            await transaction(transactionCtx, async (txCtx) => {
                const change = await work(txCtx);
                (change as { result: Applet }).result.name = "adapter-mutated";
                return change;
            });
        const applets = feature(catalog);

        await expect(applets.import(ctx, input)).rejects.toThrow("substituted result");
        expect(catalog.rows.has(input.name)).toBe(true);
    });

    it("requires exact durable receipts and canonicalizes request property order", async () => {
        const world = agentWorld();
        const persistence = world.storage.persistence("agent-1");
        const durable = new AgentKV(persistence, "call.applet.");
        const callCtx = withAgentKV(ctx, durable);
        const catalog = new FakeAppletCatalog();
        const applets = feature(catalog);

        await durable.write(callCtx, "import", "legacy-operation-id");
        await expect(applets.import(callCtx, input)).rejects.toThrow("receipt is invalid");

        await durable.write(callCtx, "import", {
            id: "operation-1",
            fingerprint: "request",
            extra: true,
        });
        await expect(applets.import(callCtx, input)).rejects.toThrow("receipt is invalid");

        await durable.delete(callCtx, "import");
        await applets.import(callCtx, input);
        const receipt = await durable.read(callCtx, "import");
        expect(receipt).toMatchObject({ id: "operation-1" });
        const reorderedInput = {
            path: input.path,
            purpose: input.purpose,
            description: input.description,
            ...(input.allowedScopes === undefined ? {} : { allowedScopes: input.allowedScopes }),
            authorSessionId: input.authorSessionId,
            name: input.name,
        };
        await expect(applets.import(callCtx, reorderedInput)).resolves.toEqual(
            expect.objectContaining({ name: input.name }),
        );
        await durable.write(callCtx, "import", {
            ...(receipt as Record<string, unknown>),
            fingerprint: "altered-request",
        });
        await expect(applets.import(callCtx, input)).rejects.toThrow("different input");

        await durable.delete(callCtx, "import");
        await applets.remove(callCtx, input.name);
    });

    it("requires receipt and immutable-proof writes to be durably acknowledged", async () => {
        const noReceiptCatalog = new FakeAppletCatalog();
        noReceiptCatalog.contract.writeReceipt = async () => {};
        const noReceipt = feature(noReceiptCatalog);
        await expect(noReceipt.import(ctx, input)).rejects.toThrow("did not durably retain");
        expect(noReceiptCatalog.rows.size).toBe(0);

        const mismatchedReceiptCatalog = new FakeAppletCatalog();
        mismatchedReceiptCatalog.contract.writeReceipt = async (_ctx, receipt) => {
            mismatchedReceiptCatalog.catalogReceipts.set(receipt.operationId, {
                ...structuredClone(receipt),
                name: "other-applet",
            });
        };
        const mismatchedReceipt = feature(mismatchedReceiptCatalog);
        await expect(mismatchedReceipt.import(ctx, input)).rejects.toThrow("receipt");
        expect(mismatchedReceiptCatalog.rows.size).toBe(0);

        const noProofCatalog = new FakeAppletCatalog();
        noProofCatalog.contract.writeMutationProof = async () => {};
        const noProof = feature(noProofCatalog);
        await expect(noProof.import(ctx, input)).rejects.toThrow(
            "did not durably retain the proof",
        );
        expect(noProofCatalog.rows.size).toBe(0);

        const mismatchedProofCatalog = new FakeAppletCatalog();
        mismatchedProofCatalog.contract.writeMutationProof = async (_ctx, proof) => {
            mismatchedProofCatalog.catalogProofs.set(proof.operationId, {
                ...structuredClone(proof),
                name: "other-applet",
            });
        };
        const mismatchedProof = feature(mismatchedProofCatalog);
        await expect(mismatchedProof.import(ctx, input)).rejects.toThrow("proof");
        expect(mismatchedProofCatalog.rows.size).toBe(0);
    });

    it("keeps list cursors and detail identities inside the model output budget", async () => {
        const catalog = new FakeAppletCatalog();
        const names = [
            `${"a".repeat(120)}-one`,
            `${"a".repeat(120)}-two`,
            `${"a".repeat(120)}-three`,
        ];
        for (const name of names) catalog.rows.set(name, makeApplet(name));
        const longDescription = "description ".repeat(166);
        const first = catalog.rows.get(names[0]!)!;
        first.description = longDescription.slice(0, 2_000);
        const applets = feature(catalog, undefined, {
            maxOutputCharacters: 256,
        });

        const page = await applets.listPage(ctx, { limit: 3 });
        const pageText = applets.formatPageForModel(page);
        expect(pageText.length).toBeLessThanOrEqual(256);
        expect(page.applets).toHaveLength(1);
        expect(page.hasMore).toBe(true);
        expect(page.nextCursor).toBe("1");
        expect(pageText).toContain(names[0]!);

        const opaqueCatalog = new FakeAppletCatalog();
        opaqueCatalog.rows.set(names[0]!, makeApplet(names[0]!));
        opaqueCatalog.rows.set(names[1]!, makeApplet(names[1]!));
        const opaqueList = opaqueCatalog.contract.list;
        const boundedOpaqueCursor = "c".repeat(100);
        opaqueCatalog.contract.list = async (listCtx, query) => {
            const result = await opaqueList(listCtx, query);
            return result.hasMore ? { ...result, nextCursor: boundedOpaqueCursor } : result;
        };
        const opaqueApplets = feature(opaqueCatalog, undefined, {
            maxOutputCharacters: 256,
        });
        const opaquePage = await opaqueApplets.listPage(ctx, { limit: 1 });
        const opaqueText = opaqueApplets.formatPageForModel(opaquePage);
        expect(opaqueText.length).toBeLessThanOrEqual(256);
        expect(opaqueText).toContain(names[0]!);
        expect(opaqueText).toContain(boundedOpaqueCursor);

        const skippedCursorCatalog = new FakeAppletCatalog();
        skippedCursorCatalog.contract.list = async () => ({
            applets: [makeApplet("one")],
            limit: 1,
            hasMore: true,
            nextCursor: "2",
        });
        await expect(feature(skippedCursorCatalog).listPage(ctx, { limit: 1 })).rejects.toThrow(
            "visible item count",
        );

        const detail = await applets.get(ctx, names[0]!);
        const detailText = applets.formatAppletForModel(detail);
        expect(detailText.length).toBeLessThanOrEqual(256);
        expect(detailText.startsWith(`${names[0]} v1:`)).toBe(true);

        const longHistory = makeApplet("long-history", 100);
        longHistory.description = "description ".repeat(160);
        catalog.rows.set(longHistory.name, longHistory);
        const longDetailText = applets.formatAppletForModel(
            await applets.get(ctx, longHistory.name),
        );
        expect(longDetailText.length).toBeLessThanOrEqual(256);
        expect(longDetailText).toContain("long-history v100: Versions: 1-100");
        expect(longDetailText.indexOf("Versions: 1-100")).toBeLessThan(
            longDetailText.indexOf("description"),
        );

        const tools = applets.tools(ctx, { agent: { id: "agent-1" } } as never);
        const listed = await tools[2]!.execute(ctx, { limit: 3 });
        const listedText = (tools[2]!.toLLM(listed)[0] as { type: "text"; text: string }).text;
        expect(listedText.length).toBeLessThanOrEqual(256);
    });

    it("rejects malformed mutation semantics instead of trusting schema-valid results", async () => {
        const createCatalog = new FakeAppletCatalog();
        const create = createCatalog.contract.create;
        createCatalog.contract.create = async (...args) => ({
            ...(await create(...args)),
            changed: false,
        });
        await expect(feature(createCatalog).import(ctx, input)).rejects.toThrow(
            "first-version semantics",
        );

        const updateCatalog = new FakeAppletCatalog();
        const updateApplets = feature(updateCatalog);
        await updateApplets.import(ctx, input);
        const update = updateCatalog.contract.update;
        updateCatalog.contract.update = async (updateCtx, updateName, updateInput) => {
            const result = await update(updateCtx, updateName, updateInput);
            if (result.operation !== "update") {
                throw new Error("test catalog returned the wrong operation");
            }
            return {
                ...result,
                applet: {
                    ...result.applet,
                    versions: result.applet.versions.map((version, index) =>
                        index === 0
                            ? { ...version, changeDescription: "archive-tampered" }
                            : version,
                    ),
                },
            };
        };
        await expect(
            updateApplets.update(ctx, input.name, {
                path: "source/demo-v2",
                changeDescription: "Second version",
            }),
        ).rejects.toThrow("append exactly one version");

        const revertCatalog = new FakeAppletCatalog();
        const revertApplets = feature(revertCatalog);
        await revertApplets.import(ctx, input);
        await revertApplets.update(ctx, input.name, {
            path: "source/demo-v2",
            changeDescription: "Second version",
        });
        const revert = revertCatalog.contract.revert;
        revertCatalog.contract.revert = async (revertCtx, revertName, revertInput) => {
            const result = await revert(revertCtx, revertName, revertInput);
            if (result.operation !== "revert") {
                throw new Error("test catalog returned the wrong operation");
            }
            return { ...result, changed: true };
        };
        await expect(revertApplets.revert(ctx, input.name, { version: 2 })).rejects.toThrow(
            "already-current",
        );

        const removeCatalog = new FakeAppletCatalog();
        const removeApplets = feature(removeCatalog);
        await removeApplets.import(ctx, input);
        const remove = removeCatalog.contract.remove;
        removeCatalog.contract.remove = async (...args) => ({
            ...(await remove(...args)),
            applet: makeApplet(input.name),
        });
        await expect(removeApplets.remove(ctx, input.name)).rejects.toThrow(
            "invalid current/target semantics",
        );
    });

    it("requires exact asset identity and encoded byte bounds", async () => {
        const catalog = new FakeAppletCatalog();
        catalog.rows.set(input.name, makeApplet(input.name));
        const mismatched: AppletAsset = {
            name: input.name,
            version: 1,
            path: "other.js",
            contentType: "text/javascript",
            encoding: "utf8",
            content: "é",
            byteLength: 2,
        };
        const applets = new AppletFeature({
            catalog: catalog.contract,
            importer: importer({ staged: [], committed: [], rolledBack: [] }),
            assetReader: assetReader(mismatched),
            maxAssetBytes: 1,
            idFactory: () => "op",
            eventIdFactory: () => "event",
            clock: () => 100,
        });
        await expect(
            applets.readAsset(ctx, { name: input.name, path: "index.js", version: 1 }),
        ).rejects.toThrow("different requested asset");

        const bounded = new AppletFeature({
            catalog: catalog.contract,
            importer: importer({ staged: [], committed: [], rolledBack: [] }),
            assetReader: assetReader({
                ...mismatched,
                path: "index.js",
                byteLength: 1,
            }),
            maxAssetBytes: 1,
            idFactory: () => "op",
            eventIdFactory: () => "event",
            clock: () => 100,
        });
        await expect(
            bounded.readAsset(ctx, { name: input.name, path: "index.js", version: 1 }),
        ).rejects.toThrow("byte limit");
    });

    it("validates exact Promise/void host boundaries and option shape", async () => {
        const catalog = new FakeAppletCatalog();
        const malformed = {
            ...catalog.contract,
            transaction: (() => ({ bad: true })) as unknown as AppletCatalog["transaction"],
        };
        const applets = new AppletFeature({
            catalog: malformed,
            importer: importer({ staged: [], committed: [], rolledBack: [] }),
            assetReader: assetReader(),
            idFactory: () => "op",
            eventIdFactory: () => "event",
            clock: () => 100,
        });
        await expect(applets.import(ctx, input)).rejects.toThrow("must return a Promise");
        expect(
            Value.Check(appletFeatureOptionsSchema, {
                catalog: { ...catalog.contract, unknown: true },
                importer: importer({ staged: [], committed: [], rolledBack: [] }),
                assetReader: assetReader(),
                unknown: true,
            }),
        ).toBe(false);
    });
});
