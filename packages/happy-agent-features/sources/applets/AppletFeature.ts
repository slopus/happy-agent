import {
    agentKV,
    type AgentFeature,
    type AgentFeatureScope,
    type AnyAgentTool,
} from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

import {
    MAX_APPLET_ASSET_BYTES,
    MAX_APPLET_ASSET_OUTPUT_CHARACTERS,
    MAX_APPLET_LIST_SIZE,
    MAX_APPLET_SOURCE_BYTES,
    MAX_APPLET_SOURCE_FILE_BYTES,
    MAX_APPLET_SOURCE_FILES,
    MAX_APPLET_VERSIONS,
    appletAssetReadInputSchema,
    appletAssetSchema,
    appletChangeDescriptionSchema,
    appletCurrentResultSchema,
    appletFingerprintSchema,
    appletImportInputSchema,
    appletListPageSchema,
    appletListQuerySchema,
    appletNameSchema,
    appletOperationReceiptSchema,
    appletRefSchema,
    appletRevertInputSchema,
    appletSourceImportInputSchema,
    appletSourceImportResultSchema,
    appletTimestampSchema,
    appletToolImportInputSchema,
    appletToolRevertInputSchema,
    appletToolUpdateInputSchema,
    appletUpdateInputSchema,
    appletVersionNumberSchema,
    type Applet,
    type AppletAsset,
    type AppletAssetReadInput,
    type AppletImportInput,
    type AppletListPage,
    type AppletListQuery,
    type AppletOperationReceipt,
    type AppletRevertInput,
    type AppletSourceImportInput,
    type AppletSourceImportResult,
    type AppletToolImportInput,
    type AppletToolRevertInput,
    type AppletToolUpdateInput,
    type AppletUpdateInput,
} from "./Applet.js";
import {
    appletEventIdSchema,
    appletEventSchema,
    appletFeatureListenerSchema,
    type AppletEvent,
    type AppletFeatureListener,
} from "./AppletEvent.js";
import {
    appletCatalogCreateInputSchema,
    appletCatalogMutationResultSchema,
    appletCatalogMutationProofSchema,
    appletCatalogMutationReceiptSchema,
    appletCatalogOperationSchema,
    appletCatalogRevertInputSchema,
    appletCatalogSchema,
    appletCatalogUpdateInputSchema,
    assetReaderSchema,
    assertApplet,
    assertAppletAsset,
    assertAppletCurrent,
    assertAppletMutation,
    assertAppletMutationProof,
    assertAppletMutationReceipt,
    assertAppletPage,
    assertSourceStage,
    sourceImporterSchema,
    type AppletCatalog,
    type AppletCatalogCreateResult,
    type AppletCatalogMutationResult,
    type AppletCatalogMutationProof,
    type AppletCatalogMutationReceipt,
    type AppletCatalogOperation,
    type AppletCatalogRevertResult,
    type AppletCatalogRemoveResult,
    type AppletCatalogUpdateResult,
    type AssetReader,
    type SourceImporter,
} from "./AppletStore.js";
import { createAppletTool } from "./tools/create_applet.js";
import { getAppletTool } from "./tools/get_applet.js";
import { importAppletTool } from "./tools/import_applet.js";
import { listAppletsTool } from "./tools/list_applets.js";
import { readAppletAssetTool } from "./tools/read_applet_asset.js";
import { removeAppletTool } from "./tools/remove_applet.js";
import { revertAppletTool } from "./tools/revert_applet.js";
import { updateAppletTool } from "./tools/update_applet.js";

const opaqueContextSchema = Type.Unsafe<Context>(Type.Object({}, { additionalProperties: true }));
const operationIdSchema = appletRefSchema;
const asyncOperationIdSchema = Type.Union([operationIdSchema, Type.Promise(operationIdSchema)]);
const asyncVoidSchema = Type.Union([Type.Void(), Type.Promise(Type.Void())]);

const appletFeatureOptionsSchema = Type.Object(
    {
        catalog: appletCatalogSchema,
        importer: sourceImporterSchema,
        assetReader: assetReaderSchema,
        listener: Type.Optional(appletFeatureListenerSchema),
        /**
         * Resolves the host's opaque author identity from the agent scope.  A
         * model never supplies this value.
         */
        authorFactory: Type.Optional(
            Type.Function([opaqueContextSchema, appletRefSchema], asyncOperationIdSchema),
        ),
        idFactory: Type.Optional(Type.Function([opaqueContextSchema], asyncOperationIdSchema)),
        eventIdFactory: Type.Optional(Type.Function([opaqueContextSchema], asyncOperationIdSchema)),
        clock: Type.Optional(Type.Function([], appletTimestampSchema)),
        maxListSize: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_APPLET_LIST_SIZE })),
        maxOutputCharacters: Type.Optional(
            Type.Integer({ minimum: 256, maximum: MAX_APPLET_ASSET_OUTPUT_CHARACTERS }),
        ),
        maxSourceFiles: Type.Optional(
            Type.Integer({ minimum: 1, maximum: MAX_APPLET_SOURCE_FILES }),
        ),
        maxSourceBytes: Type.Optional(
            Type.Integer({ minimum: 1, maximum: MAX_APPLET_SOURCE_BYTES }),
        ),
        maxSourceFileBytes: Type.Optional(
            Type.Integer({ minimum: 1, maximum: MAX_APPLET_SOURCE_FILE_BYTES }),
        ),
        maxAssetBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_APPLET_ASSET_BYTES })),
        onPostCommitError: Type.Optional(
            Type.Function(
                [opaqueContextSchema, appletEventSchema, Type.Unknown()],
                asyncVoidSchema,
            ),
        ),
    },
    { additionalProperties: false },
);

export { appletFeatureOptionsSchema };
export type AppletFeatureOptions = Static<typeof appletFeatureOptionsSchema>;

const IMPORT_OPERATION_KEY = "import";
const UPDATE_OPERATION_KEY = "update";
const REVERT_OPERATION_KEY = "revert";
const REMOVE_OPERATION_KEY = "remove";
const DEFAULT_LIST_SIZE = 50;
const DEFAULT_OUTPUT_CHARACTERS = 12_000;

type AppletChange<Result> = {
    readonly result: Result;
    readonly event?: AppletEvent;
};

type AppletOperationKind = AppletCatalogOperation;

const appletOperationSchema = Type.Object(
    {
        kind: appletCatalogOperationSchema,
        operationId: appletRefSchema,
        fingerprint: appletFingerprintSchema,
    },
    { additionalProperties: false },
);

type AppletOperation = Static<typeof appletOperationSchema>;

type StageRegistration = {
    readonly rollbackNow: (ctx: Context) => Promise<void>;
};

/** Coordinates host-owned applet catalog, source staging, and bounded asset reads. */
export class AppletFeature implements AgentFeature {
    readonly name = "applets";
    readonly #catalog: AppletCatalog;
    readonly #importer: SourceImporter;
    readonly #assetReader: AssetReader;
    readonly #listener: AppletFeatureListener | undefined;
    readonly #authorFactory: NonNullable<AppletFeatureOptions["authorFactory"]>;
    readonly #idFactory: NonNullable<AppletFeatureOptions["idFactory"]>;
    readonly #eventIdFactory: NonNullable<AppletFeatureOptions["eventIdFactory"]>;
    readonly #clock: NonNullable<AppletFeatureOptions["clock"]>;
    readonly #maxListSize: number;
    readonly #maxOutputCharacters: number;
    readonly #maxSourceFiles: number;
    readonly #maxSourceBytes: number;
    readonly #maxSourceFileBytes: number;
    readonly #maxAssetBytes: number;
    readonly #onPostCommitError: AppletFeatureOptions["onPostCommitError"];

    constructor(options: AppletFeatureOptions) {
        assertAppletFeatureOptions(options);
        this.#catalog = options.catalog;
        this.#importer = options.importer;
        this.#assetReader = options.assetReader;
        this.#listener = options.listener;
        this.#authorFactory =
            options.authorFactory ??
            ((_, agentId) => {
                return agentId;
            });
        this.#idFactory = options.idFactory ?? (() => globalThis.crypto.randomUUID());
        this.#eventIdFactory = options.eventIdFactory ?? (() => globalThis.crypto.randomUUID());
        this.#clock = options.clock ?? (() => Date.now());
        this.#maxListSize = options.maxListSize ?? DEFAULT_LIST_SIZE;
        this.#maxOutputCharacters = options.maxOutputCharacters ?? DEFAULT_OUTPUT_CHARACTERS;
        this.#maxSourceFiles = options.maxSourceFiles ?? MAX_APPLET_SOURCE_FILES;
        this.#maxSourceBytes = options.maxSourceBytes ?? MAX_APPLET_SOURCE_BYTES;
        this.#maxSourceFileBytes = options.maxSourceFileBytes ?? MAX_APPLET_SOURCE_FILE_BYTES;
        this.#maxAssetBytes = options.maxAssetBytes ?? MAX_APPLET_ASSET_BYTES;
        this.#onPostCommitError = options.onPostCommitError;
    }

    async import(ctx: Context, input: AppletImportInput): Promise<Applet> {
        assertInput(appletImportInputSchema, input, "applet import");
        const operation = await this.#operation(
            ctx,
            "create",
            IMPORT_OPERATION_KEY,
            input.operationId,
            fingerprint(normalizeImportInput(input)),
        );
        return await this.#runTransaction(ctx, "import", async (txCtx) => {
            const receipt = await this.#readReceipt(txCtx, operation, input.name, input);
            if (receipt !== undefined) {
                return { result: mutationApplet(receipt.result) };
            }
            const existing = await this.#get(txCtx, input.name);
            if (existing !== undefined) {
                throw new Error(`Applet "${input.name}" already exists.`);
            }

            const initialTimestamp = this.#now();
            const stage = await this.#stage(txCtx, {
                name: input.name,
                version: 1,
                sourcePath: input.path,
                ...(input.iconPath === undefined ? {} : { iconPath: input.iconPath }),
                operationId: operation.operationId,
            });
            let registration: StageRegistration | undefined;
            try {
                const mutation = await this.#catalogCreate(txCtx, {
                    name: input.name,
                    description: input.description,
                    purpose: input.purpose,
                    authorSessionId: input.authorSessionId,
                    allowedScopes: input.allowedScopes ?? ["global"],
                    ...(input.sourceDescription === undefined
                        ? {}
                        : { sourceDescription: input.sourceDescription }),
                    ...(input.iconPath === undefined ? {} : { iconPath: input.iconPath }),
                    initialVersion: {
                        version: 1,
                        changeDescription: "Initial import",
                        createdAt: initialTimestamp,
                        operationId: operation.operationId,
                    },
                    operationId: operation.operationId,
                });
                this.#assertMutation(mutation, operation, input.name, input, {
                    initialTimestamp,
                });
                await this.#writeReceipt(txCtx, operation, input.name, mutation);
                await this.#writeMutationProof(txCtx, operation, input.name, mutation);
                const event = await this.#event(
                    { type: "applet_imported", applet: mutation.applet },
                    txCtx,
                );
                const observedEvent = await this.#observeTransactional(txCtx, event);
                registration = await this.#registerStage(txCtx, stage, observedEvent);
                return { result: mutation.applet, event };
            } catch (error: unknown) {
                await registration?.rollbackNow(txCtx);
                if (registration === undefined) {
                    await this.#rollbackStage(txCtx, stage);
                }
                throw error;
            }
        });
    }

    async create(ctx: Context, input: AppletImportInput): Promise<Applet> {
        return await this.import(ctx, input);
    }

    async importForAgent(
        ctx: Context,
        agentId: string,
        input: AppletToolImportInput,
    ): Promise<Applet> {
        assertInput(appletToolImportInputSchema, input, "applet import tool");
        return await this.import(ctx, {
            ...input,
            authorSessionId: await this.#author(ctx, agentId),
        });
    }

    async createForAgent(
        ctx: Context,
        agentId: string,
        input: AppletToolImportInput,
    ): Promise<Applet> {
        return await this.importForAgent(ctx, agentId, input);
    }

    async listPage(ctx: Context, query: AppletListQuery = {}): Promise<AppletListPage> {
        assertInput(appletListQuerySchema, query, "applet list query");
        const limit = query.limit ?? this.#maxListSize;
        if (limit > this.#maxListSize) {
            throw new Error(`Applet list limit cannot exceed ${this.#maxListSize}.`);
        }
        let requestedLimit = limit;
        for (let attempt = 0; attempt <= limit; attempt++) {
            const returned = await requirePromise(
                this.#catalog.list(ctx, {
                    limit: requestedLimit,
                    ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
                }),
                "Applet catalog list",
            );
            this.#assertListPage(returned, requestedLimit, query.cursor);

            const fittingCount = this.#fittingListCount(returned);
            if (fittingCount === returned.applets.length) {
                const page = structuredClone(returned);
                this.formatPageForModel(page);
                return page;
            }
            if (fittingCount < 1) {
                throw new Error(
                    "Applet list output budget cannot fit a complete applet identity and cursor.",
                );
            }
            requestedLimit = fittingCount;
        }
        throw new Error("Applet list could not make output-aware page progress.");
    }

    async list(ctx: Context, query: AppletListQuery = {}): Promise<readonly Applet[]> {
        return (await this.listPage(ctx, query)).applets;
    }

    async get(ctx: Context, name: string): Promise<Applet | undefined> {
        assertName(name);
        const result = await this.#get(ctx, name);
        return result === undefined ? undefined : structuredClone(result);
    }

    async current(
        ctx: Context,
        agentId: string,
        name: string,
    ): Promise<Static<typeof appletCurrentResultSchema>> {
        assertOperationId(agentId);
        assertName(name);
        const applet = await this.#get(ctx, name);
        const result = await requirePromise(
            this.#catalog.current(ctx, name),
            "Applet catalog current",
        );
        assertAppletCurrent(result);
        if (applet === undefined) {
            if (result !== undefined) {
                throw new Error("Applet catalog current returned an unrelated applet version.");
            }
            return undefined;
        }
        if (result === undefined) {
            throw new Error("Applet catalog current did not return the authoritative version.");
        }
        const expected = applet.versions.find(
            (version) => version.version === applet.currentVersion,
        );
        if (expected === undefined || !sameValue(result, expected)) {
            throw new Error("Applet catalog current returned a stale or unrelated version.");
        }
        return structuredClone(result);
    }

    async update(ctx: Context, name: string, input: AppletUpdateInput): Promise<Applet> {
        assertName(name);
        assertInput(appletUpdateInputSchema, input, "applet update");
        const operation = await this.#operation(
            ctx,
            "update",
            UPDATE_OPERATION_KEY,
            input.operationId,
            fingerprint(normalizeUpdateInput(name, input)),
        );
        return await this.#runTransaction(ctx, "update", async (txCtx) => {
            const receipt = await this.#readReceipt(txCtx, operation, name, input);
            if (receipt !== undefined) {
                return { result: mutationApplet(receipt.result) };
            }
            const existing = await this.#requireApplet(txCtx, name);
            if (
                existing.versions.some((version) => version.operationId === operation.operationId)
            ) {
                throw new Error("Applet catalog is missing the durable mutation receipt.");
            }
            // Reverts change the current pointer but never reclaim a version
            // number.  The next import is always one beyond the archive.
            const targetVersion = existing.versions.length + 1;
            if (targetVersion > MAX_APPLET_VERSIONS) {
                throw new Error("Applet has reached the maximum version count.");
            }
            const versionTimestamp = this.#now();
            const stage = await this.#stage(txCtx, {
                name,
                version: targetVersion,
                sourcePath: input.path,
                ...(input.iconPath === undefined ? {} : { iconPath: input.iconPath }),
                operationId: operation.operationId,
            });
            let registration: StageRegistration | undefined;
            try {
                const mutation = await this.#catalogUpdate(txCtx, name, {
                    version: targetVersion,
                    changeDescription: input.changeDescription,
                    createdAt: versionTimestamp,
                    ...(input.allowedScopes === undefined
                        ? {}
                        : { allowedScopes: input.allowedScopes }),
                    ...(input.description === undefined ? {} : { description: input.description }),
                    ...(input.purpose === undefined ? {} : { purpose: input.purpose }),
                    ...(input.sourceDescription === undefined
                        ? {}
                        : { sourceDescription: input.sourceDescription }),
                    ...(input.iconPath === undefined ? {} : { iconPath: input.iconPath }),
                    operationId: operation.operationId,
                });
                this.#assertMutation(mutation, operation, name, input, {
                    before: existing,
                    targetVersion,
                    versionTimestamp,
                });
                await this.#writeReceipt(txCtx, operation, name, mutation, existing);
                await this.#writeMutationProof(txCtx, operation, name, mutation, existing);
                const event = await this.#event(
                    { type: "applet_updated", applet: mutation.applet },
                    txCtx,
                );
                const observedEvent = await this.#observeTransactional(txCtx, event);
                registration = await this.#registerStage(txCtx, stage, observedEvent);
                return { result: mutation.applet, event };
            } catch (error: unknown) {
                await registration?.rollbackNow(txCtx);
                if (registration === undefined) {
                    await this.#rollbackStage(txCtx, stage);
                }
                throw error;
            }
        });
    }

    async updateForAgent(
        ctx: Context,
        agentId: string,
        name: string,
        input: AppletToolUpdateInput,
    ): Promise<Applet> {
        assertInput(appletToolUpdateInputSchema, input, "applet update tool");
        return await this.update(ctx, name, input);
    }

    async revert(ctx: Context, name: string, input: AppletRevertInput): Promise<Applet> {
        assertName(name);
        assertInput(appletRevertInputSchema, input, "applet revert");
        const operation = await this.#operation(
            ctx,
            "revert",
            REVERT_OPERATION_KEY,
            input.operationId,
            fingerprint(normalizeRevertInput(name, input)),
        );
        return await this.#runTransaction(ctx, "revert", async (txCtx) => {
            const receipt = await this.#readReceipt(txCtx, operation, name, input);
            if (receipt !== undefined) {
                return { result: mutationApplet(receipt.result) };
            }
            const existing = await this.#requireApplet(txCtx, name);
            if (!existing.versions.some((version) => version.version === input.version)) {
                throw new Error(`Applet version ${input.version} does not exist.`);
            }
            const mutation = await this.#catalogRevert(txCtx, name, {
                version: input.version,
                operationId: operation.operationId,
            });
            this.#assertMutation(mutation, operation, name, input, {
                before: existing,
                targetVersion: input.version,
            });
            await this.#writeReceipt(txCtx, operation, name, mutation, existing);
            await this.#writeMutationProof(txCtx, operation, name, mutation, existing);
            if (mutation.changed) {
                if (existing.currentVersion === input.version) {
                    throw new Error("Applet revert changed result has no previous version.");
                }
                const event = await this.#event(
                    {
                        type: "applet_reverted",
                        applet: mutation.applet,
                        previousVersion: existing.currentVersion,
                    },
                    txCtx,
                );
                await this.#observe(txCtx, event);
                return { result: mutation.applet, event };
            }
            return { result: mutation.applet };
        });
    }

    async revertForAgent(
        ctx: Context,
        _agentId: string,
        name: string,
        input: AppletToolRevertInput,
    ): Promise<Applet> {
        assertInput(appletToolRevertInputSchema, input, "applet revert tool");
        return await this.revert(ctx, name, input);
    }

    async remove(ctx: Context, name: string, requestedOperationId?: string): Promise<boolean> {
        assertName(name);
        if (requestedOperationId !== undefined) assertOperationId(requestedOperationId);
        const operation = await this.#operation(
            ctx,
            "remove",
            REMOVE_OPERATION_KEY,
            requestedOperationId,
            fingerprint({ name }),
        );
        return await this.#runTransaction(ctx, "remove", async (txCtx) => {
            const receipt = await this.#readReceipt(txCtx, operation, name, undefined);
            if (receipt !== undefined) {
                return { result: mutationRemoved(receipt.result) };
            }
            const existing = await this.#get(txCtx, name);
            const mutation = await this.#catalogRemove(txCtx, name, operation.operationId);
            this.#assertMutation(mutation, operation, name, undefined, {
                ...(existing === undefined ? {} : { before: existing }),
                targetVersion: 0,
            });
            await this.#writeReceipt(txCtx, operation, name, mutation, existing);
            await this.#writeMutationProof(txCtx, operation, name, mutation, existing);
            if (mutation.changed !== (mutation.removed ?? false)) {
                throw new Error("Applet remove result changed/removed state is inconsistent.");
            }
            if (!mutation.changed) return { result: mutation.removed };
            if (existing === undefined) {
                throw new Error("Applet catalog removed an applet that was not present.");
            }
            const event = await this.#event({ type: "applet_removed", name }, txCtx);
            await this.#observe(txCtx, event);
            return { result: true, event };
        });
    }

    async removeForAgent(ctx: Context, _agentId: string, name: string): Promise<boolean> {
        return await this.remove(ctx, name);
    }

    async readAsset(ctx: Context, input: AppletAssetReadInput): Promise<AppletAsset | undefined> {
        assertInput(appletAssetReadInputSchema, input, "applet asset read");
        const applet = await this.#get(ctx, input.name);
        if (applet === undefined) return undefined;
        const expectedVersion = input.version ?? applet.currentVersion;
        if (!applet.versions.some((version) => version.version === expectedVersion)) {
            throw new Error("Requested applet asset version does not exist.");
        }
        const result = await requirePromise(
            this.#assetReader.readAsset(ctx, {
                ...input,
                version: expectedVersion,
                maxBytes: this.#maxAssetBytes,
            }),
            "Applet asset reader",
        );
        if (result === undefined || result === null) return undefined;
        assertAppletAsset(result);
        if (
            result.name !== input.name ||
            result.path !== input.path ||
            result.version !== expectedVersion
        ) {
            throw new Error("Applet asset reader returned a different requested asset.");
        }
        const encodedBytes = encodedByteLength(result);
        if (encodedBytes !== result.byteLength || encodedBytes > this.#maxAssetBytes) {
            throw new Error("Applet asset exceeds the configured byte limit.");
        }
        return structuredClone(result);
    }

    formatForModel(applets: readonly Applet[]): string {
        const text = this.#formatAppletRows(applets);
        if (text.length > this.#maxOutputCharacters) {
            throw new Error(
                "Applet model output would hide an applet identity; request a smaller page.",
            );
        }
        return text;
    }

    formatPageForModel(page: AppletListPage): string {
        assertAppletPage(page);
        const text = this.#formatListPage(page);
        if (text.length > this.#maxOutputCharacters) {
            throw new Error(
                "Applet model output would hide an applet identity or cursor; request a smaller page.",
            );
        }
        return text;
    }

    formatAppletForModel(applet: Applet | undefined): string {
        if (applet === undefined) return "Applet not found.";
        assertApplet(applet);
        const firstVersion = applet.versions[0]!.version;
        const lastVersion = applet.versions[applet.versions.length - 1]!.version;
        const versionRange =
            firstVersion === lastVersion ? `${firstVersion}` : `${firstVersion}-${lastVersion}`;
        const identity = `${applet.name} v${applet.currentVersion}: Versions: ${versionRange}`;
        if (identity.length > this.#maxOutputCharacters) {
            throw new Error("Applet model output cannot fit the complete applet identity.");
        }
        const details = ` ${applet.description}`;
        return `${identity}${truncateText(details, this.#maxOutputCharacters - identity.length, "\n[details truncated]")}`;
    }

    formatOperationForModel(label: string, applet: Applet): string {
        assertApplet(applet);
        const text = `${label}: ${applet.name} v${applet.currentVersion}`;
        if (text.length > this.#maxOutputCharacters) {
            throw new Error("Applet model output cannot fit the complete applet identity.");
        }
        return text;
    }

    formatRemovalForModel(removed: boolean): string {
        const text = removed ? "Applet removed." : "Applet was not found.";
        if (text.length > this.#maxOutputCharacters) {
            throw new Error("Applet model output exceeds the configured budget.");
        }
        return text;
    }

    formatAssetForModel(asset: AppletAsset | undefined): string {
        if (asset === undefined) return "Applet asset not found.";
        assertAppletAsset(asset);
        const header = `${asset.name} v${asset.version} ${asset.path} (${asset.contentType})\n`;
        if (header.length >= this.#maxOutputCharacters) {
            throw new Error("Applet asset identity exceeds the model output budget.");
        }
        const remaining = this.#maxOutputCharacters - header.length;
        if (asset.content.length <= remaining) return `${header}${asset.content}`;
        const marker = "[asset content truncated]";
        if (remaining <= marker.length + 1) return header;
        return `${header}${asset.content.slice(0, remaining - marker.length - 1)}\n${marker}`;
    }

    readonly tools = (_ctx: Context, scope: AgentFeatureScope): readonly AnyAgentTool[] => [
        createAppletTool(this, scope.agent.id),
        importAppletTool(this, scope.agent.id),
        listAppletsTool(this, scope.agent.id),
        getAppletTool(this, scope.agent.id),
        updateAppletTool(this, scope.agent.id),
        revertAppletTool(this, scope.agent.id),
        removeAppletTool(this, scope.agent.id),
        readAppletAssetTool(this, scope.agent.id),
    ];

    #assertListPage(
        value: unknown,
        limit: number,
        requestedCursor: string | undefined,
    ): asserts value is AppletListPage {
        assertAppletPage(value);
        const page = value as AppletListPage;
        if (page.limit !== limit || page.applets.length > limit) {
            throw new Error("Applet catalog returned a page outside the requested bounds.");
        }
        if (page.hasMore) {
            if (
                page.nextCursor === undefined ||
                page.nextCursor === requestedCursor ||
                !cursorProgressed(requestedCursor, page.nextCursor)
            ) {
                throw new Error("Applet catalog returned a non-progressing cursor.");
            }
            const requestedOffset =
                requestedCursor === undefined ? undefined : offsetCursor(requestedCursor);
            const nextOffset = offsetCursor(page.nextCursor);
            if (nextOffset !== undefined) {
                if (requestedCursor !== undefined && requestedOffset === undefined) {
                    throw new Error("Applet catalog changed from an opaque cursor to an offset.");
                }
                const expectedOffset = (requestedOffset ?? 0) + page.applets.length;
                if (nextOffset !== expectedOffset) {
                    throw new Error(
                        "Applet catalog offset cursor must advance by the visible item count.",
                    );
                }
            } else if (requestedCursor !== undefined && requestedOffset !== undefined) {
                throw new Error(
                    "Applet catalog changed from an offset cursor to an opaque cursor.",
                );
            }
        } else if (page.nextCursor !== undefined) {
            throw new Error("Applet catalog returned a cursor for a terminal page.");
        }
    }

    #fittingListCount(page: AppletListPage): number {
        for (let count = page.applets.length; count >= 1; count--) {
            const candidate = {
                ...page,
                applets: page.applets.slice(0, count),
            };
            if (this.#formatListPage(candidate).length <= this.#maxOutputCharacters) {
                return count;
            }
        }
        return 0;
    }

    #formatAppletRows(applets: readonly Applet[]): string {
        const lines = applets.map((applet) => {
            assertApplet(applet);
            // Keep every source identity visible. Descriptions and versions
            // are available through get_applet; including them here would let
            // one long description hide the cursor-bearing rows.
            return `${applet.name} v${applet.currentVersion}`;
        });
        return lines.length === 0 ? "No applets." : lines.join("\n");
    }

    #formatListPage(page: AppletListPage): string {
        const rows = this.#formatAppletRows(page.applets);
        return page.nextCursor === undefined ? rows : `${rows}\nNext cursor: ${page.nextCursor}`;
    }

    async #runTransaction<Result>(
        ctx: Context,
        operation: string,
        work: (txCtx: Context) => Promise<AppletChange<Result>>,
    ): Promise<Result> {
        let expected: AppletChange<Result> | undefined;
        const transactionResult = await requirePromise(
            this.#catalog.transaction(ctx, async (txCtx) => {
                const callbackResult = work(txCtx);
                const change = await requirePromise<AppletChange<Result>>(
                    callbackResult,
                    `Applet ${operation} transaction callback`,
                );
                expected = deepFreeze(structuredClone(change));
                return change;
            }),
            `Applet catalog ${operation} transaction`,
        );
        if (expected === undefined || !sameValue(transactionResult, expected)) {
            throw new Error(`Applet ${operation} transaction returned a substituted result.`);
        }
        return structuredClone(expected.result);
    }

    async #get(ctx: Context, name: string): Promise<Applet | undefined> {
        const result = await requirePromise(this.#catalog.get(ctx, name), "Applet catalog get");
        if (result === undefined) return undefined;
        assertApplet(result);
        if (result.name !== name) {
            throw new Error("Applet catalog get returned a different applet name.");
        }
        return structuredClone(result);
    }

    async #requireApplet(ctx: Context, name: string): Promise<Applet> {
        const result = await this.#get(ctx, name);
        if (result === undefined) throw new Error(`Applet "${name}" was not found.`);
        return result;
    }

    async #readReceipt(
        ctx: Context,
        operation: AppletOperation,
        name: string,
        input: AppletImportInput | AppletUpdateInput | AppletRevertInput | undefined,
    ): Promise<AppletCatalogMutationReceipt | undefined> {
        const raw = await requirePromise(
            this.#catalog.readReceipt(ctx, operation.operationId),
            "Applet catalog readReceipt",
        );
        const proof = await requirePromise(
            this.#catalog.readMutationProof(ctx, operation.operationId),
            "Applet catalog readMutationProof",
        );
        if (raw === undefined) {
            if (proof !== undefined) {
                throw new Error("Applet catalog has a mutation proof without its receipt.");
            }
            return undefined;
        }
        assertAppletMutationReceipt(raw);
        if (proof === undefined) {
            throw new Error("Applet catalog is missing the immutable mutation proof.");
        }
        assertAppletMutationProof(proof);
        if (
            raw.operation !== operation.kind ||
            raw.name !== name ||
            raw.operationId !== operation.operationId ||
            raw.fingerprint !== operation.fingerprint
        ) {
            throw new Error("Applet operation identity was reused with different input.");
        }
        if (!sameValue(raw, proof)) {
            throw new Error(
                "Applet replay receipt does not match the immutable mutation proof or authoritative catalog state.",
            );
        }
        const authoritative = await this.#get(ctx, name);
        this.#assertReplayMutation(raw, operation, name, input, authoritative);
        return structuredClone(raw);
    }

    async #writeReceipt(
        ctx: Context,
        operation: AppletOperation,
        name: string,
        mutation: AppletCatalogMutationResult,
        before?: Applet,
    ): Promise<void> {
        const receipt = {
            operation: operation.kind,
            name,
            operationId: operation.operationId,
            fingerprint: operation.fingerprint,
            beforeExists: before !== undefined,
            beforeCurrentVersion: before?.currentVersion ?? 0,
            result: structuredClone(mutation),
        } satisfies AppletCatalogMutationReceipt;
        if (!Value.Check(appletCatalogMutationReceiptSchema, receipt)) {
            throw new Error("Applet feature created an invalid mutation receipt.");
        }
        const expected = deepFreeze(structuredClone(receipt));
        const returned = await requirePromise(
            this.#catalog.writeReceipt(ctx, expected),
            "Applet catalog writeReceipt",
        );
        if (returned !== undefined) {
            throw new Error("Applet catalog writeReceipt must resolve to undefined.");
        }
        const retained = await requirePromise(
            this.#catalog.readReceipt(ctx, expected.operationId),
            "Applet catalog readReceipt after write",
        );
        if (retained === undefined) {
            throw new Error("Applet catalog writeReceipt did not durably retain the receipt.");
        }
        assertAppletMutationReceipt(retained);
        if (!sameValue(retained, expected)) {
            throw new Error("Applet catalog writeReceipt returned a mismatched receipt.");
        }
    }

    async #writeMutationProof(
        ctx: Context,
        operation: AppletOperation,
        name: string,
        mutation: AppletCatalogMutationResult,
        before?: Applet,
    ): Promise<void> {
        const proof = {
            operation: operation.kind,
            name,
            operationId: operation.operationId,
            fingerprint: operation.fingerprint,
            beforeExists: before !== undefined,
            beforeCurrentVersion: before?.currentVersion ?? 0,
            result: structuredClone(mutation),
        } satisfies AppletCatalogMutationProof;
        if (!Value.Check(appletCatalogMutationProofSchema, proof)) {
            throw new Error("Applet feature created an invalid mutation proof.");
        }
        const expected = deepFreeze(structuredClone(proof));
        const returned = await requirePromise(
            this.#catalog.writeMutationProof(ctx, expected),
            "Applet catalog writeMutationProof",
        );
        if (returned !== undefined) {
            throw new Error("Applet catalog writeMutationProof must resolve to undefined.");
        }
        const retained = await requirePromise(
            this.#catalog.readMutationProof(ctx, expected.operationId),
            "Applet catalog readMutationProof after write",
        );
        if (retained === undefined) {
            throw new Error("Applet catalog writeMutationProof did not durably retain the proof.");
        }
        assertAppletMutationProof(retained);
        if (!sameValue(retained, expected)) {
            throw new Error("Applet catalog writeMutationProof returned a mismatched proof.");
        }
    }

    async #catalogCreate(
        ctx: Context,
        input: Static<typeof appletCatalogCreateInputSchema>,
    ): Promise<AppletCatalogCreateResult> {
        const raw = await requirePromise(this.#catalog.create(ctx, input), "Applet catalog create");
        assertAppletMutation(raw);
        if (raw.operation !== "create") {
            throw new Error("Applet catalog create returned the wrong operation.");
        }
        return raw;
    }

    async #catalogUpdate(
        ctx: Context,
        name: string,
        input: Static<typeof appletCatalogUpdateInputSchema>,
    ): Promise<AppletCatalogUpdateResult> {
        const raw = await requirePromise(
            this.#catalog.update(ctx, name, input),
            "Applet catalog update",
        );
        assertAppletMutation(raw);
        if (raw.operation !== "update") {
            throw new Error("Applet catalog update returned the wrong operation.");
        }
        return raw;
    }

    async #catalogRevert(
        ctx: Context,
        name: string,
        input: Static<typeof appletCatalogRevertInputSchema>,
    ): Promise<AppletCatalogRevertResult> {
        const raw = await requirePromise(
            this.#catalog.revert(ctx, name, input),
            "Applet catalog revert",
        );
        assertAppletMutation(raw);
        if (raw.operation !== "revert") {
            throw new Error("Applet catalog revert returned the wrong operation.");
        }
        return raw;
    }

    async #catalogRemove(
        ctx: Context,
        name: string,
        operationId: string,
    ): Promise<AppletCatalogRemoveResult> {
        const raw = await requirePromise(
            this.#catalog.remove(ctx, name, operationId),
            "Applet catalog remove",
        );
        assertAppletMutation(raw);
        if (raw.operation !== "remove") {
            throw new Error("Applet catalog remove returned the wrong operation.");
        }
        return raw as AppletCatalogRemoveResult;
    }

    async #stage(
        ctx: Context,
        input: Omit<AppletSourceImportInput, "maxFiles" | "maxBytes" | "maxFileBytes">,
    ): Promise<AppletSourceImportResult> {
        const raw = await requirePromise(
            this.#importer.stage(ctx, {
                ...input,
                maxFiles: this.#maxSourceFiles,
                maxBytes: this.#maxSourceBytes,
                maxFileBytes: this.#maxSourceFileBytes,
            }),
            "Applet source importer stage",
        );
        assertSourceStage(raw);
        if (
            raw.name !== input.name ||
            raw.version !== input.version ||
            raw.operationId !== input.operationId ||
            raw.fileCount > this.#maxSourceFiles ||
            raw.byteCount > this.#maxSourceBytes
        ) {
            throw new Error("Applet source stage does not match the requested import.");
        }
        return structuredClone(raw);
    }

    async #registerStage(
        ctx: Context,
        stage: AppletSourceImportResult,
        event: AppletEvent,
    ): Promise<StageRegistration> {
        let settled = false;
        const rollbackNow = async (rollbackCtx: Context): Promise<void> => {
            if (settled) return;
            settled = true;
            await this.#rollbackStage(rollbackCtx, stage);
        };
        const rollbackRegistration: unknown = this.#catalog.onRollback(ctx, (rollbackCtx) =>
            rollbackNow(rollbackCtx),
        );
        assertSynchronousRegistration(rollbackRegistration, "Applet catalog onRollback");
        const commitRegistration: unknown = this.#catalog.afterCommit(
            ctx,
            async (postCommitCtx) => {
                if (settled) return;
                try {
                    const result = this.#importer.commit(postCommitCtx, stage);
                    await invokePromiseVoid(result, "Applet source importer commit");
                    settled = true;
                    await this.#notifyPostCommit(postCommitCtx, event);
                } catch (error: unknown) {
                    await rollbackNow(postCommitCtx);
                    await this.#reportPostCommitError(postCommitCtx, event, error);
                }
            },
        );
        try {
            assertSynchronousRegistration(commitRegistration, "Applet catalog afterCommit");
        } catch (error: unknown) {
            await rollbackNow(ctx);
            throw error;
        }
        return { rollbackNow };
    }

    async #rollbackStage(ctx: Context, stage: AppletSourceImportResult): Promise<void> {
        try {
            await invokePromiseVoid(
                this.#importer.rollback(ctx, stage),
                "Applet source importer rollback",
            );
        } catch {
            // Preserve the original catalog/listener failure; cleanup is
            // retried by the host's own staging policy if necessary.
        }
    }

    async #observeTransactional(ctx: Context, event: AppletEvent): Promise<AppletEvent> {
        if (!Object.isFrozen(event)) {
            throw new Error("Applet event must be deeply frozen before observation.");
        }
        await invokeListener(
            this.#listener,
            "onEventTransactional",
            ctx,
            event,
            "Applet transactional listener",
        );
        // #event creates the detached, deeply frozen instance. Keep that exact
        // object for post-commit delivery so observers share one stable event.
        return event;
    }

    async #observe(ctx: Context, event: AppletEvent): Promise<void> {
        const frozen = await this.#observeTransactional(ctx, event);
        // Registering the callback is synchronous; its body may be async.
        const returned: unknown = this.#catalog.afterCommit(ctx, (postCommitCtx) =>
            this.#notifyPostCommit(postCommitCtx, frozen),
        );
        assertSynchronousRegistration(returned, "Applet catalog afterCommit");
    }

    async #notifyPostCommit(ctx: Context, event: AppletEvent): Promise<void> {
        try {
            await invokeListener(
                this.#listener,
                "onEvent",
                ctx,
                event,
                "Applet post-commit listener",
            );
        } catch (error: unknown) {
            await this.#reportPostCommitError(ctx, event, error);
        }
    }

    async #reportPostCommitError(
        ctx: Context,
        event: AppletEvent | undefined,
        error: unknown,
    ): Promise<void> {
        if (event === undefined || this.#onPostCommitError === undefined) return;
        try {
            await invokeVoidOrPromise(
                this.#onPostCommitError(ctx, event, error),
                "Applet post-commit error handler",
            );
        } catch {
            // Reporting is advisory after durable state has settled.
        }
    }

    async #author(ctx: Context, agentId: string): Promise<string> {
        assertOperationId(agentId);
        const raw = this.#authorFactory(ctx, agentId);
        const value = raw instanceof Promise ? await raw : raw;
        assertOperationId(value);
        return value;
    }

    async #operation(
        ctx: Context,
        kind: AppletOperationKind,
        key: string,
        requested: string | undefined,
        requestFingerprint: string,
    ): Promise<AppletOperation> {
        if (!Value.Check(appletFingerprintSchema, requestFingerprint)) {
            throw new Error("Applet operation fingerprint is invalid.");
        }
        const operationId = await this.#operationId(ctx, key, requested, requestFingerprint);
        const operation = { kind, operationId, fingerprint: requestFingerprint };
        assertInput(appletOperationSchema, operation, "applet operation");
        return operation;
    }

    async #operationId(
        ctx: Context,
        key: string,
        requested: string | undefined,
        requestFingerprint: string,
    ): Promise<string> {
        if (requested !== undefined) {
            assertOperationId(requested);
            return requested;
        }
        const kv = agentKV(ctx);
        if (kv === undefined) {
            return await this.#newOperationId(ctx);
        }
        return await kv.transaction(ctx, async (scope, txCtx) => {
            const current = await scope.read(txCtx, key);
            if (current !== undefined) {
                if (!Value.Check(appletOperationReceiptSchema, current)) {
                    throw new Error("Stored applet operation receipt is invalid.");
                }
                const receipt = current as AppletOperationReceipt;
                if (receipt.fingerprint !== requestFingerprint) {
                    throw new Error(
                        "The applet operation identity was already used for different input.",
                    );
                }
                return receipt.id;
            }
            const operationId = await this.#newOperationId(txCtx);
            await scope.write(txCtx, key, {
                id: operationId,
                fingerprint: requestFingerprint,
            } satisfies AppletOperationReceipt);
            return operationId;
        });
    }

    async #newOperationId(ctx: Context): Promise<string> {
        const raw = this.#idFactory(ctx);
        const id = raw instanceof Promise ? await raw : raw;
        assertOperationId(id);
        return id;
    }

    async #event(
        payload:
            | { readonly type: "applet_imported"; readonly applet: Applet }
            | { readonly type: "applet_updated"; readonly applet: Applet }
            | {
                  readonly type: "applet_reverted";
                  readonly applet: Applet;
                  readonly previousVersion: number;
              }
            | { readonly type: "applet_removed"; readonly name: string },
        ctx: Context,
    ): Promise<AppletEvent> {
        const raw = this.#eventIdFactory(ctx);
        const eventId = raw instanceof Promise ? await raw : raw;
        assertEventId(eventId);
        const event = { ...payload, eventId, at: this.#now() };
        if (!Value.Check(appletEventSchema, event)) {
            throw new Error("Applet feature created an invalid event.");
        }
        if ("applet" in event) assertApplet(event.applet);
        return deepFreeze(structuredClone(event));
    }

    #assertMutation(
        mutation: AppletCatalogMutationResult,
        operation: AppletOperation,
        name: string,
        input: AppletImportInput | AppletUpdateInput | AppletRevertInput | undefined,
        details: {
            readonly before?: Applet;
            readonly initialTimestamp?: number;
            readonly targetVersion?: number;
            readonly versionTimestamp?: number;
        },
    ): void {
        assertAppletMutation(mutation);
        if (
            mutation.operation !== operation.kind ||
            mutation.name !== name ||
            mutation.operationId !== operation.operationId
        ) {
            throw new Error("Applet catalog returned a different requested operation.");
        }
        if (mutation.operation === "remove") {
            const before = details.before;
            if (
                mutation.currentVersion !== 0 ||
                mutation.targetVersion !== 0 ||
                mutation.removed !== mutation.changed ||
                mutation.applet !== undefined ||
                mutation.changed !== (before !== undefined)
            ) {
                throw new Error("Applet remove result has invalid current/target semantics.");
            }
            return;
        }

        const applet = mutation.applet;
        const targetVersion = details.targetVersion ?? mutation.targetVersion;
        if (
            mutation.currentVersion !== applet.currentVersion ||
            mutation.currentVersion === 0 ||
            mutation.targetVersion !== targetVersion ||
            !applet.versions.some((version) => version.version === targetVersion)
        ) {
            throw new Error("Applet mutation returned invalid current/target semantics.");
        }
        if (!mutation.changed && operation.kind !== "revert") {
            throw new Error(
                operation.kind === "create"
                    ? "Applet create result has invalid first-version semantics."
                    : "A new applet mutation must report changed=true.",
            );
        }

        if (operation.kind === "create") {
            if (details.before !== undefined) {
                throw new Error("Applet create result has invalid first-version semantics.");
            }
            const requested = requireImportInput(input);
            const initial = applet.versions[0];
            const expectedScopes = requested.allowedScopes ?? ["global"];
            if (
                targetVersion !== 1 ||
                mutation.currentVersion !== 1 ||
                applet.versions.length !== 1 ||
                initial?.version !== 1 ||
                initial.changeDescription !== "Initial import" ||
                initial.operationId !== operation.operationId ||
                initial.createdAt !== details.initialTimestamp ||
                applet.name !== requested.name ||
                applet.authorSessionId !== requested.authorSessionId ||
                applet.description !== requested.description ||
                applet.purpose !== requested.purpose ||
                !sameValue(applet.allowedScopes, expectedScopes) ||
                !sameOptionalField(applet, "sourceDescription", requested.sourceDescription) ||
                applet.createdAt !== details.initialTimestamp ||
                applet.updatedAt !== details.initialTimestamp
            ) {
                throw new Error(
                    "Applet create result does not match the requested normalized input.",
                );
            }
            return;
        }

        const before = details.before;
        if (before === undefined) {
            throw new Error("Applet mutation is missing its pre-mutation catalog snapshot.");
        }
        assertImmutableAppletFields(applet, before);
        if (applet.updatedAt < before.updatedAt) {
            throw new Error("Applet mutation moved its updated timestamp backwards.");
        }

        if (operation.kind === "update") {
            if (details.versionTimestamp === undefined) {
                throw new Error("Applet update result is missing its normalized input.");
            }
            const requested = requireUpdateInput(input);
            const expectedVersion = before.versions.length + 1;
            const appended = applet.versions[applet.versions.length - 1];
            if (
                targetVersion !== expectedVersion ||
                applet.versions.length !== before.versions.length + 1 ||
                !sameValue(applet.versions.slice(0, before.versions.length), before.versions) ||
                appended?.version !== expectedVersion ||
                appended.changeDescription !== requested.changeDescription ||
                appended.operationId !== operation.operationId ||
                appended.createdAt !== details.versionTimestamp ||
                mutation.currentVersion !== expectedVersion ||
                applet.updatedAt !== details.versionTimestamp ||
                applet.description !== (requested.description ?? before.description) ||
                applet.purpose !== (requested.purpose ?? before.purpose) ||
                !sameValue(applet.allowedScopes, requested.allowedScopes ?? before.allowedScopes) ||
                !sameOptionalField(
                    applet,
                    "sourceDescription",
                    requested.sourceDescription,
                    before,
                ) ||
                (requested.iconPath === undefined &&
                    (!sameOptionalField(applet, "iconThumbhash", undefined, before) ||
                        !sameOptionalField(applet, "iconUrl", undefined, before)))
            ) {
                throw new Error(
                    "Applet update result did not append exactly one version or apply the exact normalized input.",
                );
            }
            return;
        }

        const requested = requireRevertInput(input);
        const target = applet.versions.find((version) => version.version === requested.version);
        if (
            target === undefined ||
            !sameValue(applet.versions, before.versions) ||
            applet.description !== before.description ||
            applet.purpose !== before.purpose ||
            !sameValue(applet.allowedScopes, before.allowedScopes) ||
            !sameOptionalField(applet, "sourceDescription", undefined, before) ||
            !sameOptionalField(applet, "iconThumbhash", undefined, before) ||
            !sameOptionalField(applet, "iconUrl", undefined, before) ||
            applet.currentVersion !== requested.version ||
            mutation.currentVersion !== requested.version ||
            mutation.changed !== (before.currentVersion !== requested.version)
        ) {
            throw new Error(
                before.currentVersion === requested.version
                    ? "Applet revert marked an already-current version as changed."
                    : "Applet revert result changed the requested target or archive.",
            );
        }
        if (!mutation.changed && applet.updatedAt !== before.updatedAt) {
            throw new Error("Applet revert no-op changed the catalog timestamp.");
        }
    }

    #assertReplayMutation(
        receipt: AppletCatalogMutationReceipt,
        operation: AppletOperation,
        name: string,
        input: AppletImportInput | AppletUpdateInput | AppletRevertInput | undefined,
        authoritative: Applet | undefined,
    ): void {
        const mutation = receipt.result;
        assertAppletMutation(mutation);
        if (
            mutation.operation !== operation.kind ||
            mutation.name !== name ||
            mutation.operationId !== operation.operationId
        ) {
            throw new Error("Applet catalog replay returned a different operation.");
        }
        if (
            (!receipt.beforeExists && receipt.beforeCurrentVersion !== 0) ||
            (receipt.beforeExists && receipt.beforeCurrentVersion < 1)
        ) {
            throw new Error("Applet replay has an invalid before-state marker.");
        }
        if (mutation.operation === "remove") {
            if (
                mutation.targetVersion !== 0 ||
                mutation.currentVersion !== 0 ||
                mutation.applet !== undefined ||
                mutation.changed !== receipt.beforeExists ||
                mutation.removed !== receipt.beforeExists ||
                authoritative !== undefined
            ) {
                throw new Error(
                    "Applet remove replay did not match the authoritative catalog state.",
                );
            }
            return;
        }
        const applet = mutation.applet;
        if (
            mutation.targetVersion < 1 ||
            mutation.currentVersion !== applet.currentVersion ||
            !applet.versions.some((version) => version.version === mutation.targetVersion)
        ) {
            throw new Error("Applet replay returned invalid current/target semantics.");
        }
        if (authoritative === undefined || !sameValue(applet, authoritative)) {
            throw new Error("Applet replay did not match the authoritative catalog state.");
        }
        if (operation.kind === "create") {
            const requested = requireImportInput(input);
            const initial = applet.versions[0];
            if (!mutation.changed) {
                throw new Error("Applet create replay has invalid first-version semantics.");
            }
            if (
                receipt.beforeExists ||
                receipt.beforeCurrentVersion !== 0 ||
                mutation.targetVersion !== 1 ||
                mutation.currentVersion !== 1 ||
                applet.versions.length !== 1 ||
                initial?.changeDescription !== "Initial import" ||
                initial.operationId !== operation.operationId ||
                applet.name !== requested.name ||
                applet.authorSessionId !== requested.authorSessionId ||
                applet.description !== requested.description ||
                applet.purpose !== requested.purpose ||
                !sameValue(applet.allowedScopes, requested.allowedScopes ?? ["global"]) ||
                !sameOptionalField(applet, "sourceDescription", requested.sourceDescription)
            ) {
                throw new Error("Applet create replay returned a different durable result.");
            }
            return;
        }
        if (operation.kind === "update") {
            const requested = requireUpdateInput(input);
            const appended = applet.versions.find(
                (version) => version.version === mutation.targetVersion,
            );
            if (
                !receipt.beforeExists ||
                receipt.beforeCurrentVersion < 1 ||
                !mutation.changed ||
                mutation.targetVersion !== applet.versions.length ||
                mutation.currentVersion !== mutation.targetVersion ||
                appended === undefined ||
                appended.operationId !== operation.operationId ||
                appended.changeDescription !== requested.changeDescription ||
                applet.description !== (requested.description ?? applet.description) ||
                applet.purpose !== (requested.purpose ?? applet.purpose) ||
                !sameValue(applet.allowedScopes, requested.allowedScopes ?? applet.allowedScopes) ||
                (requested.sourceDescription !== undefined &&
                    !sameOptionalField(applet, "sourceDescription", requested.sourceDescription))
            ) {
                throw new Error("Applet update replay returned a different durable result.");
            }
            return;
        }
        const requested = requireRevertInput(input);
        if (
            !receipt.beforeExists ||
            receipt.beforeCurrentVersion < 1 ||
            mutation.targetVersion !== requested.version ||
            applet.currentVersion !== requested.version ||
            mutation.changed !== (receipt.beforeCurrentVersion !== requested.version)
        ) {
            throw new Error("Applet revert replay returned a different durable result.");
        }
    }

    #now(): number {
        const at = this.#clock();
        if (!Value.Check(appletTimestampSchema, at)) {
            throw new Error("Applet clock must return a non-negative integer.");
        }
        return at;
    }
}

function encodedByteLength(asset: AppletAsset): number {
    if (asset.encoding === "utf8") {
        return new TextEncoder().encode(asset.content).byteLength;
    }
    if (
        asset.content.length % 4 !== 0 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(asset.content)
    ) {
        throw new Error("Applet asset contains invalid base64 content.");
    }
    const padding = asset.content.endsWith("==") ? 2 : asset.content.endsWith("=") ? 1 : 0;
    return (asset.content.length / 4) * 3 - padding;
}

function deepFreeze<T>(value: T): T {
    if (value !== null && typeof value === "object") {
        for (const nested of Object.values(value as Record<string, unknown>)) {
            deepFreeze(nested);
        }
        Object.freeze(value);
    }
    return value;
}

function sameValue(left: unknown, right: unknown): boolean {
    if (Object.is(left, right)) return true;
    if (left === null || right === null || typeof left !== "object" || typeof right !== "object") {
        return false;
    }
    if (Array.isArray(left) || Array.isArray(right)) {
        if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
            return false;
        }
        return left.every((value, index) => sameValue(value, right[index]));
    }
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const leftKeys = Object.keys(leftRecord);
    const rightKeys = Object.keys(rightRecord);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every(
        (key) =>
            Object.prototype.hasOwnProperty.call(rightRecord, key) &&
            sameValue(leftRecord[key], rightRecord[key]),
    );
}

function fingerprint(value: unknown): string {
    const encoded = JSON.stringify(canonicalizeFingerprint(value));
    if (encoded === undefined || encoded.length === 0 || encoded.length > 16_000) {
        throw new Error("Applet operation input exceeds the durable receipt bound.");
    }
    return encoded;
}

function normalizeImportInput(input: AppletImportInput): unknown {
    return {
        name: input.name,
        description: input.description,
        purpose: input.purpose,
        authorSessionId: input.authorSessionId,
        path: input.path,
        ...(input.iconPath === undefined ? {} : { iconPath: input.iconPath }),
        allowedScopes: input.allowedScopes ?? ["global"],
        ...(input.sourceDescription === undefined
            ? {}
            : { sourceDescription: input.sourceDescription }),
    };
}

function normalizeUpdateInput(name: string, input: AppletUpdateInput): unknown {
    return {
        name,
        path: input.path,
        changeDescription: input.changeDescription,
        ...(input.allowedScopes === undefined ? {} : { allowedScopes: input.allowedScopes }),
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.purpose === undefined ? {} : { purpose: input.purpose }),
        ...(input.sourceDescription === undefined
            ? {}
            : { sourceDescription: input.sourceDescription }),
        ...(input.iconPath === undefined ? {} : { iconPath: input.iconPath }),
    };
}

function normalizeRevertInput(name: string, input: AppletRevertInput): unknown {
    return { name, version: input.version };
}

function requireImportInput(value: unknown): AppletImportInput {
    assertInput<AppletImportInput>(appletImportInputSchema, value, "applet import");
    return value;
}

function requireUpdateInput(value: unknown): AppletUpdateInput {
    assertInput<AppletUpdateInput>(appletUpdateInputSchema, value, "applet update");
    return value;
}

function requireRevertInput(value: unknown): AppletRevertInput {
    assertInput<AppletRevertInput>(appletRevertInputSchema, value, "applet revert");
    return value;
}

function mutationApplet(mutation: AppletCatalogMutationResult): Applet {
    if (mutation.operation === "remove") {
        throw new Error("Applet mutation does not contain an applet result.");
    }
    return mutation.applet;
}

function mutationRemoved(mutation: AppletCatalogMutationResult): boolean {
    if (mutation.operation !== "remove") {
        throw new Error("Applet mutation does not contain a removal result.");
    }
    return mutation.removed;
}

function canonicalizeFingerprint(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((item) => canonicalizeFingerprint(item));
    if (value !== null && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
                .filter(([, item]) => item !== undefined)
                .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
                .map(([key, item]) => [key, canonicalizeFingerprint(item)]),
        );
    }
    return value;
}

function assertImmutableAppletFields(left: Applet, right: Applet): void {
    if (
        left.name !== right.name ||
        left.authorSessionId !== right.authorSessionId ||
        left.createdAt !== right.createdAt
    ) {
        throw new Error("Applet mutation changed immutable catalog metadata.");
    }
}

function sameOptionalField(
    actual: Applet,
    key: string,
    expected: unknown,
    previous?: Applet,
): boolean {
    const actualRecord = actual as unknown as Record<string, unknown>;
    const actualHas = Object.prototype.hasOwnProperty.call(actualRecord, key);
    const expectedRecord = previous as unknown as Record<string, unknown> | undefined;
    const expectedHas =
        expected === undefined
            ? expectedRecord !== undefined &&
              Object.prototype.hasOwnProperty.call(expectedRecord, key)
            : true;
    if (actualHas !== expectedHas) return false;
    if (!expectedHas) return true;
    const expectedValue =
        expected === undefined && expectedRecord !== undefined ? expectedRecord[key] : expected;
    return sameValue(actualRecord[key], expectedValue);
}

function cursorProgressed(previous: string | undefined, next: string): boolean {
    if (previous === undefined) return true;
    const previousNumber = Number(previous);
    const nextNumber = Number(next);
    if (
        Number.isSafeInteger(previousNumber) &&
        Number.isSafeInteger(nextNumber) &&
        previous.trim() !== "" &&
        next.trim() !== ""
    ) {
        return nextNumber > previousNumber;
    }
    return next !== previous;
}

function offsetCursor(value: string | undefined): number | undefined {
    if (value === undefined) return 0;
    if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) return undefined;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function truncateText(text: string, maximum: number, marker: string): string {
    if (maximum <= 0) return "";
    if (text.length <= maximum) return text;
    if (maximum <= marker.length) return text.slice(0, maximum);
    return `${text.slice(0, maximum - marker.length)}${marker}`;
}

async function requirePromise<T>(value: unknown, operation: string): Promise<T> {
    if (!(value instanceof Promise)) {
        throw new Error(`${operation} must return a Promise.`);
    }
    return await value;
}

async function invokePromiseVoid(value: unknown, operation: string): Promise<void> {
    const resolved = await requirePromise<unknown>(value, operation);
    if (resolved !== undefined) {
        throw new Error(`${operation} Promise must resolve to undefined.`);
    }
}

async function invokeListener(
    listener: AppletFeatureListener | undefined,
    method: "onEventTransactional" | "onEvent",
    ctx: Context,
    event: AppletEvent,
    operation: string,
): Promise<void> {
    const callback = listener?.[method];
    if (callback === undefined) return;
    await invokeVoidOrPromise(callback.call(listener, ctx, event), operation);
}

async function invokeVoidOrPromise(value: unknown, operation: string): Promise<void> {
    if (value === undefined) return;
    await invokePromiseVoid(value, operation);
}

function assertSynchronousRegistration(value: unknown, operation: string): void {
    if (value === undefined) return;
    if (value instanceof Promise) void value.catch(() => undefined);
    throw new Error(`${operation} must register synchronously and return undefined.`);
}

function assertInput<T>(schema: unknown, value: unknown, label: string): asserts value is T {
    if (!Value.Check(schema as Parameters<typeof Value.Check>[0], value)) {
        throw new Error(`Invalid ${label} input.`);
    }
}

function assertName(value: string): void {
    if (!Value.Check(appletNameSchema, value)) throw new Error("Applet name is invalid.");
}

function assertOperationId(value: unknown): asserts value is string {
    if (!Value.Check(operationIdSchema, value)) {
        throw new Error("Applet operation ID is invalid.");
    }
}

function assertEventId(value: unknown): asserts value is string {
    if (!Value.Check(appletEventIdSchema, value)) throw new Error("Applet event ID is invalid.");
}

export function assertAppletFeatureOptions(value: unknown): asserts value is AppletFeatureOptions {
    if (!Value.Check(appletFeatureOptionsSchema, value)) {
        throw new Error("Applet feature options are invalid.");
    }
}

void appletListPageSchema;
void appletCatalogMutationResultSchema;
void appletCatalogUpdateInputSchema;
void appletCatalogRevertInputSchema;
void appletSourceImportInputSchema;
void appletSourceImportResultSchema;
void appletAssetSchema;
void appletVersionNumberSchema;
void appletChangeDescriptionSchema;
