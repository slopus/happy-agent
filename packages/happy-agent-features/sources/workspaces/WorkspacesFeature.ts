import { createHash } from "node:crypto";

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
    workspaceAgentIdSchema,
    workspaceArchiveOptionsSchema,
    workspaceCreateInputSchema,
    workspaceIdSchema,
    workspaceOperationFingerprintSchema,
    workspaceOperationIdSchema,
    workspaceOperationStateSchema,
    workspaceTimestampSchema,
    workspaceSchema,
    type Workspace,
    type WorkspaceArchiveOptions,
    type WorkspaceCreateInput,
    type WorkspaceMutationOperation,
    type WorkspaceOperationFingerprint,
} from "./Workspace.js";
import {
    workspaceBranchMetadataSchema,
    type WorkspaceBranchMetadata,
} from "./WorkspaceBranchMetadata.js";
import {
    MAX_WORKSPACE_BRANCH_METADATA_DETAIL_PAGE_SIZE,
    workspaceBranchMetadataDetailQuerySchema,
    workspaceBranchMetadataPageSchema,
    type WorkspaceBranchMetadataDetailQuery,
    type WorkspaceBranchMetadataPage,
} from "./WorkspaceBranchMetadataPage.js";
import {
    workspaceContextSchema,
    workspaceEventIdSchema,
    workspaceEventSchema,
    workspaceFeatureListenerSchema,
    type WorkspaceEvent,
    type WorkspaceFeatureListener,
} from "./WorkspaceEvent.js";
import {
    MAX_WORKSPACE_PAGE_SIZE,
    workspacePageQuerySchema,
    type WorkspacePage,
    type WorkspacePageQuery,
} from "./WorkspacePage.js";
import {
    MAX_WORKSPACE_DETAIL_PAGE_SIZE,
    workspaceDetailPageSchema,
    workspaceDetailQuerySchema,
    type WorkspaceDetailPage,
    type WorkspaceDetailQuery,
} from "./WorkspaceDetailPage.js";
import {
    workspaceTransferInputSchema,
    workspaceTransferResultSchema,
    workspaceTransferStoreResultSchema,
    type WorkspaceProjectTransferInput,
    type WorkspaceSessionTransferInput,
    type WorkspaceTransferInput,
    type WorkspaceTransferResult,
    type WorkspaceTransferWorkspace,
} from "./WorkspaceTransfer.js";
import {
    assertWorkspace,
    assertWorkspaceArchiveResult,
    assertWorkspaceBranchMetadata,
    assertWorkspaceCreateResult,
    assertWorkspaceList,
    assertWorkspaceMutationProof,
    assertWorkspaceOperationReceipt,
    assertWorkspacePage,
    assertWorkspaceStoreMutationResult,
    assertWorkspaceTransactionChange,
    workspaceAuthorizationSchema,
    workspaceMutationRequestSchema,
    workspaceStoreSchema,
    type WorkspaceArchiveResult,
    type WorkspaceAuthorization,
    type WorkspaceAuthorizationAction,
    type WorkspaceCreateResult,
    type WorkspaceMutationProof,
    type WorkspaceMutationRequest,
    type WorkspaceOperationReceipt,
    type WorkspaceStore,
    type WorkspaceStoreArchiveInput,
    type WorkspaceStoreCreateInput,
    type WorkspaceStoreMutationResult,
    type WorkspaceTransactionChange,
} from "./WorkspaceStore.js";
import { archiveWorkspaceTool } from "./tools/archive_workspace.js";
import { createWorkspaceTool } from "./tools/create_workspace.js";
import { getBranchMetadataTool } from "./tools/get_branch_metadata.js";
import { getWorkspaceTool } from "./tools/get_workspace.js";
import { listWorkspacesTool } from "./tools/list_workspaces.js";
import { transferWorkspaceTool } from "./tools/transfer_workspace.js";

const MAX_CANONICAL_DEPTH = 8;
const MAX_CANONICAL_STRING_LENGTH = 4_096;
const MAX_CANONICAL_ARRAY_ITEMS = 512;
const MAX_CANONICAL_OBJECT_PROPERTIES = 512;
const MAX_CANONICAL_BYTES = 64 * 1024;
const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_OUTPUT_CHARACTERS = 12_000;
const CREATE_ID_KEY = "workspace.create.id";
const CREATE_OPERATION_KEY = "workspace.create.operation";
const TRANSFER_OPERATION_KEY = "workspace.transfer.operation";
const ARCHIVE_OPERATION_KEY = "workspace.archive.operation";

export const workspaceIdFactorySchema = Type.Function(
    [workspaceContextSchema, workspaceAgentIdSchema],
    Type.Union([workspaceIdSchema, Type.Promise(workspaceIdSchema)]),
);
export const workspaceEventIdFactorySchema = Type.Function(
    [workspaceContextSchema, workspaceAgentIdSchema],
    Type.Union([workspaceEventIdSchema, Type.Promise(workspaceEventIdSchema)]),
);
export const workspaceClockSchema = Type.Function(
    [workspaceContextSchema, workspaceAgentIdSchema],
    workspaceTimestampSchema,
);
export const workspacePostCommitErrorSchema = Type.Function(
    [workspaceContextSchema, workspaceEventSchema, Type.Unknown()],
    Type.Union([Type.Void(), Type.Promise(Type.Void())]),
);
const workspaceMaxPageSizeSchema = Type.Integer({
    minimum: 1,
    maximum: MAX_WORKSPACE_PAGE_SIZE,
});
const workspaceMaxOutputSchema = Type.Integer({
    minimum: 256,
    maximum: 100_000,
});

export const workspaceFeatureOptionsSchema = Type.Object(
    {
        store: workspaceStoreSchema,
        authorization: Type.Optional(workspaceAuthorizationSchema),
        idFactory: Type.Optional(workspaceIdFactorySchema),
        eventIdFactory: Type.Optional(workspaceEventIdFactorySchema),
        clock: Type.Optional(workspaceClockSchema),
        listener: Type.Optional(workspaceFeatureListenerSchema),
        maxPageSize: Type.Optional(workspaceMaxPageSizeSchema),
        maxOutputCharacters: Type.Optional(workspaceMaxOutputSchema),
        onPostCommitError: Type.Optional(workspacePostCommitErrorSchema),
    },
    { additionalProperties: false },
);

export type WorkspaceFeatureOptions = Static<typeof workspaceFeatureOptionsSchema>;

type WorkspaceChange = WorkspaceTransactionChange;
type WorkspaceOperation = {
    readonly kind: WorkspaceMutationOperation;
    readonly operationId: string;
    readonly fingerprint: WorkspaceOperationFingerprint;
};

export class WorkspacesFeature implements AgentFeature {
    readonly name = "workspaces";

    readonly #store: WorkspaceStore;
    readonly #authorization: WorkspaceAuthorization | undefined;
    readonly #idFactory: NonNullable<WorkspaceFeatureOptions["idFactory"]>;
    readonly #eventIdFactory: NonNullable<WorkspaceFeatureOptions["eventIdFactory"]>;
    readonly #clock: NonNullable<WorkspaceFeatureOptions["clock"]>;
    readonly #listener: WorkspaceFeatureListener | undefined;
    readonly #maxPageSize: number;
    readonly #maxOutputCharacters: number;
    readonly #onPostCommitError: WorkspaceFeatureOptions["onPostCommitError"];

    constructor(options: WorkspaceFeatureOptions) {
        assertWorkspaceFeatureOptions(options);
        this.#store = options.store;
        this.#authorization = options.authorization;
        this.#idFactory =
            options.idFactory ??
            ((_ctx: Context, _agentId: string) => globalThis.crypto.randomUUID());
        this.#eventIdFactory =
            options.eventIdFactory ??
            ((_ctx: Context, _agentId: string) => globalThis.crypto.randomUUID());
        this.#clock = options.clock ?? ((_ctx: Context, _agentId: string) => Date.now());
        this.#listener = options.listener;
        this.#maxPageSize = options.maxPageSize ?? DEFAULT_PAGE_SIZE;
        this.#maxOutputCharacters = options.maxOutputCharacters ?? DEFAULT_OUTPUT_CHARACTERS;
        this.#onPostCommitError = options.onPostCommitError;
    }

    readonly tools = (_ctx: Context, scope: AgentFeatureScope): readonly AnyAgentTool[] => {
        this.#assertAgentId(scope.agent.id);
        return [
            createWorkspaceTool(this, scope.agent.id),
            listWorkspacesTool(this, scope.agent.id),
            getWorkspaceTool(this, scope.agent.id),
            transferWorkspaceTool(this, scope.agent.id),
            archiveWorkspaceTool(this, scope.agent.id),
            getBranchMetadataTool(this, scope.agent.id),
        ];
    };

    async create(ctx: Context, agentId: string, input: WorkspaceCreateInput): Promise<Workspace> {
        this.#assertAgentId(agentId);
        this.#assertInput(workspaceCreateInputSchema, input, "workspace creation");
        const normalized = structuredClone(input);
        const fingerprint = operationFingerprint("create", agentId, {
            id: normalized.id,
            projectRef: normalized.projectRef,
            name: normalized.name,
            baseRef: normalized.baseRef,
        });
        let id = normalized.id;
        if (id === undefined && normalized.operationId === undefined) {
            id = await this.#identity(
                ctx,
                agentId,
                CREATE_ID_KEY,
                undefined,
                fingerprint,
                workspaceIdSchema,
            );
        }
        const operationId = await this.#identity(
            ctx,
            agentId,
            CREATE_OPERATION_KEY,
            normalized.operationId,
            fingerprint,
            workspaceOperationIdSchema,
        );
        const operation = this.#operation("create", operationId, fingerprint);

        const change = await this.#runTransaction(ctx, agentId, async (txCtx) => {
            const receipt = await this.#readReceipt(txCtx, agentId, operation);
            if (receipt !== undefined) {
                const receiptResult = this.#assertReceiptResult(
                    receipt,
                    operation,
                    "create",
                ) as WorkspaceCreateResult;
                return await this.#replayCatalogMutation(
                    txCtx,
                    agentId,
                    operation,
                    receipt,
                    "create",
                    id ?? receiptResult.workspace.id,
                );
            }
            await this.#rejectOrphanedProof(txCtx, agentId, operation);
            const workspaceId = id ?? (await this.#newIdentity(ctx, agentId, workspaceIdSchema));
            const request: WorkspaceStoreCreateInput = {
                id: workspaceId,
                ownerAgentId: agentId,
                name: normalized.name,
                ...(normalized.projectRef === undefined
                    ? {}
                    : { projectRef: normalized.projectRef }),
                ...(normalized.baseRef === undefined ? {} : { baseRef: normalized.baseRef }),
            };
            const before = await this.#getRequiredOptional(txCtx, agentId, workspaceId);
            if (before !== undefined) {
                this.#assertOwner(agentId, before);
                if (!sameCreate(before, request)) {
                    throw new Error(
                        `Workspace "${workspaceId}" already exists with different values.`,
                    );
                }
                const result: WorkspaceCreateResult = {
                    operation: "create",
                    agentId,
                    operationId: operation.operationId,
                    fingerprint: operation.fingerprint,
                    changed: false,
                    workspace: structuredClone(before),
                };
                const proof = this.#proof(operation, agentId, workspaceId, before, before, result);
                await this.#persistReceiptAndProof(txCtx, agentId, operation, proof, result);
                return { result };
            }

            const raw = await requirePromise(
                this.#store.create(
                    txCtx,
                    agentId,
                    structuredClone(request),
                    this.#request(operation),
                ),
                "Workspace store create",
            );
            assertWorkspaceCreateResult(raw);
            this.#assertResultIdentity(raw, operation, agentId, "create");
            this.#assertCreatedWorkspace(raw.workspace, request);
            const after = await this.#getRequired(txCtx, agentId, workspaceId);
            if (!sameJson(after, raw.workspace)) {
                throw new Error("Workspace create result does not match authoritative state.");
            }
            const changed = before === undefined && !sameJson(before, after);
            if (raw.changed !== changed) {
                throw new Error("Workspace create changed flag is not authoritative.");
            }
            const result = structuredClone(raw);
            const proof = this.#proof(operation, agentId, workspaceId, before, after, result);
            await this.#persistReceiptAndProof(txCtx, agentId, operation, proof, result);
            if (changed) {
                const event = await this.#newEvent(txCtx, agentId, {
                    type: "workspace_created",
                    agentId,
                    workspace: after,
                });
                await this.#observe(txCtx, event);
                return { result, event };
            }
            return { result };
        });
        return structuredClone(requireWorkspaceFromResult(change.result));
    }

    async listPage(
        ctx: Context,
        agentId: string,
        query: WorkspacePageQuery = {},
    ): Promise<WorkspacePage> {
        this.#assertAgentId(agentId);
        this.#assertInput(workspacePageQuerySchema, query, "workspace page query");
        const limit = query.limit ?? this.#maxPageSize;
        if (limit > this.#maxPageSize) {
            throw new Error(`Workspace page limit cannot exceed ${String(this.#maxPageSize)}.`);
        }
        if (query.cursor !== undefined) parseCursor(query.cursor);
        const normalized = { ...structuredClone(query), limit };
        const raw = await requirePromise(
            this.#store.list(ctx, agentId, normalized),
            "Workspace store list",
        );
        assertWorkspacePage(raw);
        this.#assertPage(raw, normalized.cursor, limit);
        for (const workspace of raw.workspaces) {
            assertWorkspaceRecord(workspace);
            if (
                normalized.projectRef !== undefined &&
                workspace.projectRef !== normalized.projectRef
            ) {
                throw new Error("Workspace page returned a row outside the requested project.");
            }
            if (normalized.includeArchived !== true && workspace.status === "archived") {
                throw new Error("Workspace page returned an archived row without includeArchived.");
            }
            await this.#authorize(ctx, agentId, workspace.ownerAgentId, "list");
        }
        return structuredClone(fitPageForModel(raw, normalized.cursor, this.#maxOutputCharacters));
    }

    async list(
        ctx: Context,
        agentId: string,
        query: WorkspacePageQuery = {},
    ): Promise<Workspace[]> {
        return (await this.listPage(ctx, agentId, query)).workspaces;
    }

    async get(ctx: Context, agentId: string, workspaceId: string): Promise<Workspace | undefined> {
        this.#assertAgentId(agentId);
        this.#assertId(workspaceId, "workspace");
        const raw = await requirePromise(
            this.#store.get(ctx, agentId, workspaceId),
            "Workspace store get",
        );
        if (raw === undefined) return undefined;
        assertWorkspace(raw);
        assertWorkspaceRecord(raw);
        if (raw.id !== workspaceId) {
            throw new Error("Workspace store returned a different workspace identity.");
        }
        await this.#authorize(ctx, agentId, raw.ownerAgentId, "get");
        return structuredClone(raw);
    }

    /** Read one workspace with a bounded, cursor-addressable detail stream. */
    async getPage(
        ctx: Context,
        agentId: string,
        workspaceId: string,
        query: WorkspaceDetailQuery = {},
    ): Promise<WorkspaceDetailPage> {
        this.#assertAgentId(agentId);
        this.#assertId(workspaceId, "workspace");
        if (!Value.Check(workspaceDetailQuerySchema, query)) {
            throw new Error("Workspace detail query is invalid.");
        }
        const workspace = await this.get(ctx, agentId, workspaceId);
        if (workspace === undefined) return { workspace: null };

        const detail = workspaceDetailText(workspace);
        if (
            !Value.Check(workspaceDetailPageSchema, {
                workspace,
                detail: "",
                detailOffset: 0,
                detailTotal: detail.length,
            })
        ) {
            throw new Error("Workspace detail exceeds its bounded traversal length.");
        }
        const detailOffset = query.detailOffset ?? 0;
        const detailLimit = query.detailLimit ?? MAX_WORKSPACE_DETAIL_PAGE_SIZE;
        if (detailOffset > detail.length) {
            throw new Error("Workspace detail offset exceeds the available detail.");
        }
        const page: WorkspaceDetailPage = {
            workspace,
            detail: detail.slice(detailOffset, detailOffset + detailLimit),
            detailOffset,
            detailTotal: detail.length,
            ...(detailOffset + detailLimit < detail.length
                ? { nextDetailOffset: detailOffset + detailLimit }
                : {}),
        };
        return fitWorkspaceDetailPage(page, this.#maxOutputCharacters);
    }

    async transfer(
        ctx: Context,
        agentId: string,
        input: WorkspaceTransferInput,
    ): Promise<WorkspaceTransferResult> {
        this.#assertAgentId(agentId);
        this.#assertInput(workspaceTransferInputSchema, input, "workspace transfer");
        const normalized = structuredClone(input);
        const request = stripOperationId(normalized);
        const fingerprint = operationFingerprint("transfer", agentId, request);
        const requestedOperationId = normalized.operationId;
        const operationId = await this.#identity(
            ctx,
            agentId,
            TRANSFER_OPERATION_KEY,
            requestedOperationId,
            fingerprint,
            workspaceOperationIdSchema,
        );
        const operation = this.#operation("transfer", operationId, fingerprint);
        const subjectId =
            "workspaceId" in request ? request.workspaceId : request.targetWorkspaceId;

        const change = await this.#runTransaction(ctx, agentId, async (txCtx) => {
            const receipt = await this.#readReceipt(txCtx, agentId, operation);
            if (receipt !== undefined) {
                return await this.#replayTransfer(txCtx, agentId, operation, receipt, subjectId);
            }
            await this.#rejectOrphanedProof(txCtx, agentId, operation);

            const before = await this.#getRequiredOptional(txCtx, agentId, subjectId);
            if ("workspaceId" in request) {
                if (before === undefined)
                    throw new Error(`Workspace "${subjectId}" was not found.`);
                this.#assertOwner(agentId, before);
            } else {
                if (before === undefined) {
                    throw new Error(`Target workspace "${subjectId}" was not found.`);
                }
                await this.#authorize(txCtx, agentId, before.ownerAgentId, "transfer");
            }
            if (before === undefined) {
                throw new Error("Workspace transfer has no authoritative before-state.");
            }

            const raw = await requirePromise(
                this.#store.transfer(
                    txCtx,
                    agentId,
                    structuredClone(request),
                    this.#request(operation),
                ),
                "Workspace store transfer",
            );
            const result = normalizeTransferStoreResult(raw, agentId, operation);
            this.#assertTransferResultIdentity(result, operation, agentId);
            assertTransferRequestResult(result, request);
            const requestedResult =
                "targetWorkspaceId" in request &&
                result.state === "transferred" &&
                result.targetWorkspaceId === undefined
                    ? { ...result, targetWorkspaceId: request.targetWorkspaceId }
                    : result;

            const after = await this.#getRequiredOptional(txCtx, agentId, subjectId);
            if (after === undefined) {
                throw new Error("Workspace transfer did not return authoritative state.");
            }
            assertWorkspaceTransferTransition(before, after, request);
            if ("workspaceId" in request && after.projectRef !== request.targetProjectRef) {
                throw new Error(
                    "Workspace project transfer did not reach the requested project reference.",
                );
            }
            let reconciledResult =
                requestedResult.state === "transferred" && requestedResult.workspace !== undefined
                    ? await (async (): Promise<WorkspaceTransferResult> => {
                          const targetId = requestedResult.workspace.id;
                          const target = await this.#getRequired(txCtx, agentId, targetId);
                          await this.#authorize(txCtx, agentId, target.ownerAgentId, "transfer");
                          if (
                              requestedResult.workspace.ownerAgentId !== undefined &&
                              requestedResult.workspace.ownerAgentId !== target.ownerAgentId
                          ) {
                              throw new Error(
                                  "Workspace transfer result changed durable workspace ownership.",
                              );
                          }
                          if (
                              requestedResult.targetWorkspaceId !== undefined &&
                              requestedResult.targetWorkspaceId !== target.id
                          ) {
                              throw new Error(
                                  "Workspace transfer target does not match its result.",
                              );
                          }
                          if (
                              requestedResult.workspace.id !== target.id ||
                              requestedResult.workspace.projectRef !== target.projectRef ||
                              (requestedResult.workspace.ownerAgentId !== undefined &&
                                  requestedResult.workspace.ownerAgentId !== target.ownerAgentId)
                          ) {
                              throw new Error(
                                  "Workspace transfer result does not match authoritative state.",
                              );
                          }
                          if (
                              "workspaceId" in request &&
                              target.projectRef !== request.targetProjectRef
                          ) {
                              throw new Error(
                                  "Workspace project transfer target does not match the requested project.",
                              );
                          }
                          return {
                              ...requestedResult,
                              workspace: compactWorkspace(target),
                          };
                      })()
                    : requestedResult;
            const expectedChanged = !sameJson(before, after);
            if (!Value.Check(workspaceTransferResultSchema, raw)) {
                reconciledResult = { ...reconciledResult, changed: expectedChanged };
            } else if (reconciledResult.changed !== expectedChanged) {
                throw new Error("Workspace transfer changed flag is not authoritative.");
            }
            const proof = this.#proof(
                operation,
                agentId,
                subjectId,
                before,
                after,
                reconciledResult,
            );
            await this.#persistReceiptAndProof(txCtx, agentId, operation, proof, reconciledResult);
            if (reconciledResult.changed) {
                const event =
                    reconciledResult.state === "scheduled"
                        ? await this.#newEvent(txCtx, agentId, {
                              type: "workspace_transfer_scheduled",
                              agentId,
                              targetWorkspaceId: reconciledResult.targetWorkspaceId ?? subjectId,
                          })
                        : await this.#newEvent(txCtx, agentId, {
                              type: "workspace_transferred",
                              agentId,
                              workspace: after!,
                              ...("workspaceId" in request && before !== undefined
                                  ? { previousProjectRef: before.projectRef }
                                  : {}),
                          });
                await this.#observe(txCtx, event);
                return { result: reconciledResult, event };
            }
            return { result: reconciledResult };
        });
        return structuredClone(requireTransferFromResult(change.result));
    }

    async archive(
        ctx: Context,
        agentId: string,
        workspaceId: string,
        options?: WorkspaceArchiveOptions,
    ): Promise<Workspace> {
        this.#assertAgentId(agentId);
        this.#assertId(workspaceId, "workspace");
        if (options !== undefined) {
            this.#assertInput(workspaceArchiveOptionsSchema, options, "workspace archive");
        }
        const normalizedOptions = options === undefined ? {} : structuredClone(options);
        const fingerprint = operationFingerprint("archive", agentId, { workspaceId });
        const operationId = await this.#identity(
            ctx,
            agentId,
            ARCHIVE_OPERATION_KEY,
            normalizedOptions.operationId,
            fingerprint,
            workspaceOperationIdSchema,
        );
        const operation = this.#operation("archive", operationId, fingerprint);
        const request: WorkspaceStoreArchiveInput = { workspaceId };

        const change = await this.#runTransaction(ctx, agentId, async (txCtx) => {
            const receipt = await this.#readReceipt(txCtx, agentId, operation);
            if (receipt !== undefined) {
                return await this.#replayCatalogMutation(
                    txCtx,
                    agentId,
                    operation,
                    receipt,
                    "archive",
                    workspaceId,
                );
            }
            await this.#rejectOrphanedProof(txCtx, agentId, operation);
            const before = await this.#getRequired(txCtx, agentId, workspaceId);
            this.#assertOwner(agentId, before);

            const raw = await requirePromise(
                this.#store.archive(txCtx, agentId, request, this.#request(operation)),
                "Workspace store archive",
            );
            assertWorkspaceArchiveResult(raw);
            this.#assertResultIdentity(raw, operation, agentId, "archive");
            if (raw.workspace.id !== workspaceId) {
                throw new Error("Workspace archive result has a different workspace identity.");
            }
            this.#assertOwner(agentId, raw.workspace);
            const after = await this.#getRequired(txCtx, agentId, workspaceId);
            if (!sameJson(after, raw.workspace)) {
                throw new Error("Workspace archive result does not match authoritative state.");
            }
            const changed = !sameJson(before, after);
            assertWorkspaceArchiveTransition(before, after, raw.workspace, changed);
            if (raw.changed !== changed) {
                throw new Error("Workspace archive changed flag is not authoritative.");
            }
            const result = structuredClone(raw);
            const proof = this.#proof(operation, agentId, workspaceId, before, after, result);
            await this.#persistReceiptAndProof(txCtx, agentId, operation, proof, result);
            if (changed) {
                const event = await this.#newEvent(txCtx, agentId, {
                    type: "workspace_archived",
                    agentId,
                    workspace: after,
                });
                await this.#observe(txCtx, event);
                return { result, event };
            }
            return { result };
        });
        return structuredClone(requireWorkspaceFromResult(change.result));
    }

    async branchMetadata(
        ctx: Context,
        agentId: string,
        workspaceId: string,
    ): Promise<WorkspaceBranchMetadata> {
        this.#assertAgentId(agentId);
        this.#assertId(workspaceId, "workspace");
        const workspace = await this.#getRequired(ctx, agentId, workspaceId);
        await this.#authorize(ctx, agentId, workspace.ownerAgentId, "branch_metadata");
        const raw = await requirePromise(
            this.#store.branchMetadata(ctx, agentId, workspaceId),
            "Workspace store branch metadata",
        );
        assertWorkspaceBranchMetadata(raw);
        if (raw.workspaceId !== workspaceId) {
            throw new Error("Workspace branch metadata belongs to another workspace.");
        }
        return structuredClone(raw);
    }

    async getBranchMetadata(
        ctx: Context,
        agentId: string,
        workspaceId: string,
    ): Promise<WorkspaceBranchMetadata> {
        return await this.branchMetadata(ctx, agentId, workspaceId);
    }

    /** Read branch metadata with a bounded, cursor-addressable detail stream. */
    async branchMetadataPage(
        ctx: Context,
        agentId: string,
        workspaceId: string,
        query: WorkspaceBranchMetadataDetailQuery = {},
    ): Promise<WorkspaceBranchMetadataPage> {
        this.#assertAgentId(agentId);
        this.#assertId(workspaceId, "workspace");
        if (!Value.Check(workspaceBranchMetadataDetailQuerySchema, query)) {
            throw new Error("Workspace branch metadata detail query is invalid.");
        }
        const metadata = await this.branchMetadata(ctx, agentId, workspaceId);
        const detail = workspaceBranchMetadataDetailText(metadata);
        if (
            !Value.Check(workspaceBranchMetadataPageSchema, {
                ...metadata,
                detail: "",
                detailOffset: 0,
                detailTotal: detail.length,
            })
        ) {
            throw new Error("Workspace branch metadata exceeds its bounded traversal length.");
        }
        const detailOffset = query.detailOffset ?? 0;
        const detailLimit = query.detailLimit ?? MAX_WORKSPACE_BRANCH_METADATA_DETAIL_PAGE_SIZE;
        if (detailOffset > detail.length) {
            throw new Error("Workspace branch metadata offset exceeds the available detail.");
        }
        const page: WorkspaceBranchMetadataPage = {
            ...metadata,
            detail: detail.slice(detailOffset, detailOffset + detailLimit),
            detailOffset,
            detailTotal: detail.length,
            ...(detailOffset + detailLimit < detail.length
                ? { nextDetailOffset: detailOffset + detailLimit }
                : {}),
        };
        return fitWorkspaceBranchMetadataPage(page, this.#maxOutputCharacters);
    }

    async getBranchMetadataPage(
        ctx: Context,
        agentId: string,
        workspaceId: string,
        query: WorkspaceBranchMetadataDetailQuery = {},
    ): Promise<WorkspaceBranchMetadataPage> {
        return await this.branchMetadataPage(ctx, agentId, workspaceId, query);
    }

    /** Bounded rows are intentionally compact; get_workspace is the detail path. */
    formatForModel(workspaces: readonly Workspace[]): string {
        assertWorkspaceList(workspaces);
        if (workspaces.length === 0) return "No workspaces.";
        const rows = workspaces.map(workspaceRow);
        const output = rows.join("\n");
        if (output.length <= this.#maxOutputCharacters) return output;
        const visible: string[] = [];
        let size = 0;
        for (const row of rows) {
            const next = size + row.length + (visible.length === 0 ? 0 : 1);
            if (next > this.#maxOutputCharacters) break;
            visible.push(row);
            size = next;
        }
        if (visible.length === 0) {
            throw new Error("Workspace model output cannot fit a complete identity.");
        }
        return visible.join("\n");
    }

    /** Render one complete workspace detail page without silently dropping fields. */
    formatDetailPageForModel(page: WorkspaceDetailPage | Workspace): string {
        const detailPage = Value.Check(workspaceDetailPageSchema, page)
            ? page
            : Value.Check(workspaceSchema, page)
              ? fitWorkspaceDetailPage(
                    {
                        workspace: structuredClone(page),
                        detail: workspaceDetailText(page).slice(0, MAX_WORKSPACE_DETAIL_PAGE_SIZE),
                        detailOffset: 0,
                        detailTotal: workspaceDetailText(page).length,
                        ...(workspaceDetailText(page).length > MAX_WORKSPACE_DETAIL_PAGE_SIZE
                            ? { nextDetailOffset: MAX_WORKSPACE_DETAIL_PAGE_SIZE }
                            : {}),
                    },
                    this.#maxOutputCharacters,
                )
              : undefined;
        if (detailPage === undefined) {
            throw new Error("Cannot format an invalid workspace detail page.");
        }
        if (detailPage.workspace === null) return "That workspace does not exist.";
        const output = formatWorkspaceDetailPage(detailPage, this.#maxOutputCharacters);
        if (output.length > this.#maxOutputCharacters) {
            throw new Error("Workspace detail page exceeds its model-output bound.");
        }
        return output;
    }

    /** Render one bounded mutation result, retaining a cursor when detail needs multiple calls. */
    formatWorkspaceOperationForModel(label: string, workspace: Workspace): string {
        assertWorkspace(workspace);
        const prefix = `${label}\n`;
        if (prefix.length >= this.#maxOutputCharacters) {
            throw new Error("Workspace operation label exceeds the model-output bound.");
        }
        const detail = workspaceDetailText(workspace);
        const page = fitWorkspaceDetailPage(
            {
                workspace: structuredClone(workspace),
                detail: detail.slice(0, Math.min(detail.length, MAX_WORKSPACE_DETAIL_PAGE_SIZE)),
                detailOffset: 0,
                detailTotal: detail.length,
                ...(detail.length > MAX_WORKSPACE_DETAIL_PAGE_SIZE
                    ? { nextDetailOffset: MAX_WORKSPACE_DETAIL_PAGE_SIZE }
                    : {}),
            },
            this.#maxOutputCharacters - prefix.length,
        );
        const output = `${prefix}${formatWorkspaceDetailPage(
            page,
            this.#maxOutputCharacters - prefix.length,
        )}`;
        if (output.length > this.#maxOutputCharacters) {
            throw new Error("Workspace operation output exceeds its model-output bound.");
        }
        return output;
    }

    formatWorkspaceForModel(workspace: Workspace): string {
        return this.formatWorkspaceOperationForModel("Workspace:", workspace);
    }

    /** Render one branch metadata detail page without silently truncating Git values. */
    formatBranchMetadataDetailPageForModel(
        page: WorkspaceBranchMetadataPage | WorkspaceBranchMetadata,
    ): string {
        const detailPage = Value.Check(workspaceBranchMetadataPageSchema, page)
            ? page
            : Value.Check(workspaceBranchMetadataSchema, page)
              ? fitWorkspaceBranchMetadataPage(
                    {
                        ...structuredClone(page),
                        detail: workspaceBranchMetadataDetailText(page).slice(
                            0,
                            MAX_WORKSPACE_BRANCH_METADATA_DETAIL_PAGE_SIZE,
                        ),
                        detailOffset: 0,
                        detailTotal: workspaceBranchMetadataDetailText(page).length,
                        ...(workspaceBranchMetadataDetailText(page).length >
                        MAX_WORKSPACE_BRANCH_METADATA_DETAIL_PAGE_SIZE
                            ? {
                                  nextDetailOffset: MAX_WORKSPACE_BRANCH_METADATA_DETAIL_PAGE_SIZE,
                              }
                            : {}),
                    },
                    this.#maxOutputCharacters,
                )
              : undefined;
        if (detailPage === undefined) {
            throw new Error("Cannot format invalid workspace branch metadata detail.");
        }
        const output = formatWorkspaceBranchMetadataPage(detailPage, this.#maxOutputCharacters);
        if (output.length > this.#maxOutputCharacters) {
            throw new Error("Workspace branch metadata detail exceeds its model-output bound.");
        }
        return output;
    }

    formatBranchMetadataForModel(
        page: WorkspaceBranchMetadataPage | WorkspaceBranchMetadata,
    ): string {
        return this.formatBranchMetadataDetailPageForModel(page);
    }

    formatPageForModel(page: WorkspacePage): string {
        assertWorkspacePage(page);
        const start =
            page.nextCursor === undefined
                ? undefined
                : String(Math.max(0, parseCursor(page.nextCursor) - page.workspaces.length));
        const visiblePage = fitPageForModel(page, start, this.#maxOutputCharacters);
        const rows = visiblePage.workspaces.map(workspaceRow);
        const continuation =
            visiblePage.nextCursor === undefined
                ? undefined
                : `More workspaces at cursor ${visiblePage.nextCursor}.`;
        let output = rows.length === 0 ? "No workspaces." : rows.join("\n");
        if (continuation !== undefined) {
            const withContinuation = `${output}\n${continuation}`;
            if (withContinuation.length <= this.#maxOutputCharacters) output = withContinuation;
        }
        return output;
    }

    async #runTransaction(
        ctx: Context,
        agentId: string,
        work: (txCtx: Context) => Promise<WorkspaceChange>,
    ): Promise<WorkspaceChange> {
        let expected: WorkspaceChange | undefined;
        const raw = await requirePromise(
            this.#store.transaction(ctx, agentId, async (txCtx) => {
                const change = await work(txCtx);
                expected = deepFreeze(structuredClone(change));
                return structuredClone(expected);
            }),
            "Workspace store transaction",
        );
        assertWorkspaceTransactionChange(raw);
        if (expected === undefined || !sameJson(raw, expected)) {
            throw new Error("Workspace transaction returned a substituted change.");
        }
        return raw;
    }

    async #identity(
        ctx: Context,
        agentId: string,
        key: string,
        requested: string | undefined,
        fingerprint: WorkspaceOperationFingerprint,
        schema: typeof workspaceIdSchema | typeof workspaceOperationIdSchema,
    ): Promise<string> {
        if (requested !== undefined) {
            if (!Value.Check(schema, requested)) {
                throw new Error("Workspace operation identity is invalid.");
            }
            return requested;
        }
        const kv = agentKV(ctx);
        if (kv === undefined) {
            throw new Error("A host-facing workspace mutation must provide an operation identity.");
        }
        const state = await kv.update(ctx, key, async (current) => {
            if (current !== undefined) {
                if (
                    !Value.Check(workspaceOperationStateSchema, current) ||
                    !Value.Check(schema, current.id)
                ) {
                    throw new Error("Stored workspace operation identity is invalid.");
                }
                if (current.fingerprint !== fingerprint) {
                    throw new Error(
                        "The workspace durable operation identity was reused with different input.",
                    );
                }
                return current;
            }
            const id = await this.#newIdentity(ctx, agentId, schema);
            return { id, fingerprint };
        });
        if (
            !Value.Check(workspaceOperationStateSchema, state) ||
            !Value.Check(schema, state.id) ||
            state.fingerprint !== fingerprint
        ) {
            throw new Error("Workspace durable operation identity is invalid.");
        }
        return state.id;
    }

    async #newIdentity(
        ctx: Context,
        agentId: string,
        schema: typeof workspaceIdSchema | typeof workspaceOperationIdSchema,
    ): Promise<string> {
        const raw = this.#idFactory(ctx, agentId);
        const value = isPromiseLike(raw) ? await raw : raw;
        if (!Value.Check(schema, value)) {
            throw new Error("Workspace identity factory returned an invalid identity.");
        }
        return value;
    }

    #operation(
        kind: WorkspaceMutationOperation,
        operationId: string,
        fingerprint: WorkspaceOperationFingerprint,
    ): WorkspaceOperation {
        const operation = { kind, operationId, fingerprint };
        if (!Value.Check(workspaceMutationRequestSchema, toMutationRequest(operation))) {
            throw new Error("Workspace feature created an invalid operation.");
        }
        return operation;
    }

    #request(operation: WorkspaceOperation): WorkspaceMutationRequest {
        return toMutationRequest(operation);
    }

    async #readReceipt(
        ctx: Context,
        agentId: string,
        operation: WorkspaceOperation,
    ): Promise<WorkspaceOperationReceipt | undefined> {
        const raw = await requirePromise(
            this.#store.readReceipt(ctx, agentId, operation.operationId),
            "Workspace store read receipt",
        );
        if (raw === undefined) return undefined;
        assertWorkspaceOperationReceipt(raw);
        this.#assertReceiptIdentity(raw, operation, agentId);
        return structuredClone(raw);
    }

    async #readProof(
        ctx: Context,
        agentId: string,
        operation: WorkspaceOperation,
    ): Promise<WorkspaceMutationProof | undefined> {
        const raw = await requirePromise(
            this.#store.readMutationProof(ctx, agentId, operation.operationId),
            "Workspace store read mutation proof",
        );
        if (raw === undefined) return undefined;
        assertWorkspaceMutationProof(raw);
        if (raw.before !== null) assertWorkspaceRecord(raw.before);
        if (raw.after !== null) assertWorkspaceRecord(raw.after);
        this.#assertProofIdentity(raw, operation, agentId);
        return structuredClone(raw);
    }

    async #rejectOrphanedProof(
        ctx: Context,
        agentId: string,
        operation: WorkspaceOperation,
    ): Promise<void> {
        const proof = await this.#readProof(ctx, agentId, operation);
        if (proof !== undefined) {
            throw new Error("Workspace operation has an immutable proof but no receipt.");
        }
    }

    async #persistReceiptAndProof(
        ctx: Context,
        agentId: string,
        operation: WorkspaceOperation,
        proof: WorkspaceMutationProof,
        result: WorkspaceStoreMutationResult,
    ): Promise<void> {
        const receipt: WorkspaceOperationReceipt = {
            agentId,
            operation: operation.kind,
            operationId: operation.operationId,
            fingerprint: operation.fingerprint,
            result: structuredClone(result),
        };
        assertWorkspaceOperationReceipt(receipt);
        assertWorkspaceMutationProof(proof);

        const proofWriteResult = await requirePromise(
            this.#store.writeMutationProof(ctx, agentId, structuredClone(proof)),
            "Workspace store write mutation proof",
        );
        if (proofWriteResult !== undefined) {
            throw new Error("Workspace store writeMutationProof must resolve to undefined.");
        }
        const persistedProof = await this.#readProof(ctx, agentId, operation);
        if (persistedProof === undefined || !sameJson(persistedProof, proof)) {
            throw new Error("Workspace immutable proof write-back did not match.");
        }

        const receiptWriteResult = await requirePromise(
            this.#store.writeReceipt(ctx, agentId, structuredClone(receipt)),
            "Workspace store write receipt",
        );
        if (receiptWriteResult !== undefined) {
            throw new Error("Workspace store writeReceipt must resolve to undefined.");
        }
        const persistedReceipt = await this.#readReceipt(ctx, agentId, operation);
        if (persistedReceipt === undefined || !sameJson(persistedReceipt, receipt)) {
            throw new Error("Workspace operation receipt write-back did not match.");
        }
    }

    async #replayCatalogMutation(
        ctx: Context,
        agentId: string,
        operation: WorkspaceOperation,
        receipt: WorkspaceOperationReceipt,
        kind: "create" | "archive",
        workspaceId: string,
    ): Promise<WorkspaceChange> {
        const receiptResult = this.#assertReceiptResult(receipt, operation, kind) as
            | WorkspaceCreateResult
            | WorkspaceArchiveResult;
        const proof = await this.#readProof(ctx, agentId, operation);
        if (proof === undefined) {
            throw new Error("Workspace operation receipt has no immutable proof.");
        }
        if (
            proof.subjectId !== workspaceId ||
            proof.changed !== receiptResult.changed ||
            !sameJson(proof.result, receiptResult) ||
            !("workspace" in receiptResult) ||
            !sameJson(proof.after, receiptResult.workspace) ||
            proof.changed !== !sameJson(proof.before, proof.after)
        ) {
            throw new Error("Workspace receipt and immutable proof disagree.");
        }
        if (kind === "archive") {
            if (!("workspace" in receiptResult)) {
                throw new Error("Workspace archive receipt has no authoritative workspace.");
            }
            assertWorkspaceArchiveTransition(
                proof.before,
                proof.after,
                receiptResult.workspace,
                receiptResult.changed,
            );
        }
        const current = await this.#getRequired(ctx, agentId, workspaceId);
        this.#assertOwner(agentId, current);
        if (
            !("workspace" in receiptResult) ||
            receiptResult.workspace.id !== workspaceId ||
            receiptResult.workspace.ownerAgentId !== current.ownerAgentId
        ) {
            throw new Error("Workspace operation receipt has a different authoritative identity.");
        }
        if (kind === "archive") {
            assertWorkspaceArchiveState(current);
        }
        const result =
            kind === "create"
                ? {
                      ...receiptResult,
                      operation: "create" as const,
                      workspace: structuredClone(current),
                  }
                : {
                      ...receiptResult,
                      operation: "archive" as const,
                      workspace: structuredClone(current),
                  };
        return { result };
    }

    async #replayTransfer(
        ctx: Context,
        agentId: string,
        operation: WorkspaceOperation,
        receipt: WorkspaceOperationReceipt,
        subjectId: string,
    ): Promise<WorkspaceChange> {
        const receiptResult = this.#assertReceiptResult(
            receipt,
            operation,
            "transfer",
        ) as WorkspaceTransferResult;
        const proof = await this.#readProof(ctx, agentId, operation);
        if (proof === undefined) {
            throw new Error("Workspace transfer receipt has no immutable proof.");
        }
        if (
            proof.subjectId !== subjectId ||
            proof.changed !== receiptResult.changed ||
            !sameJson(proof.result, receiptResult)
        ) {
            throw new Error("Workspace transfer receipt and proof disagree.");
        }
        if (
            proof.before !== null &&
            proof.after !== null &&
            proof.before.ownerAgentId !== proof.after.ownerAgentId
        ) {
            throw new Error("Workspace transfer proof changed durable workspace ownership.");
        }
        if (receiptResult.state === "transferred") {
            const provenAfter = proof.after;
            if (
                provenAfter === null ||
                proof.changed !== !sameJson(proof.before, provenAfter) ||
                provenAfter.id !== subjectId ||
                provenAfter.id !== receiptResult.workspace.id ||
                provenAfter.projectRef !== receiptResult.workspace.projectRef ||
                (receiptResult.workspace.ownerAgentId !== undefined &&
                    provenAfter.ownerAgentId !== receiptResult.workspace.ownerAgentId) ||
                (receiptResult.targetWorkspaceId !== undefined &&
                    receiptResult.targetWorkspaceId !== subjectId)
            ) {
                throw new Error("Workspace transfer receipt and proof disagree.");
            }
        } else {
            if (
                proof.after === null ||
                proof.after.id !== subjectId ||
                proof.changed !== !sameJson(proof.before, proof.after) ||
                receiptResult.targetWorkspaceId !== subjectId
            ) {
                throw new Error("Workspace transfer receipt and proof disagree.");
            }
            // A scheduled transfer is a historical outcome. Once its proof and
            // receipt agree, replay must not read or reconcile the mutable
            // workspace again: the target may legitimately have been changed
            // or removed by a later operation, and replay must not authorize,
            // mutate, or publish anything for that newer state.
            return { result: structuredClone(receiptResult) };
        }
        const current = await this.#getRequiredOptional(ctx, agentId, subjectId);
        if (current === undefined) {
            throw new Error("Workspace transfer receipt has no authoritative subject.");
        }
        await this.#authorize(ctx, agentId, current.ownerAgentId, "transfer");
        if (proof.after !== null && current.ownerAgentId !== proof.after.ownerAgentId) {
            throw new Error("Workspace transfer changed durable workspace ownership.");
        }
        let result = structuredClone(receiptResult);
        if (result.state === "transferred" && result.workspace !== undefined) {
            const currentTarget = await this.#getRequired(ctx, agentId, result.workspace.id);
            await this.#authorize(ctx, agentId, currentTarget.ownerAgentId, "transfer");
            result = {
                ...result,
                workspace: compactWorkspace(currentTarget),
                targetWorkspaceId: result.targetWorkspaceId ?? subjectId,
            };
        }
        return { result };
    }

    #proof(
        operation: WorkspaceOperation,
        agentId: string,
        subjectId: string,
        before: Workspace | undefined,
        after: Workspace | undefined,
        result: WorkspaceStoreMutationResult,
    ): WorkspaceMutationProof {
        const proof: WorkspaceMutationProof = {
            agentId,
            operation: operation.kind,
            operationId: operation.operationId,
            fingerprint: operation.fingerprint,
            subjectId,
            before: before === undefined ? null : structuredClone(before),
            after: after === undefined ? null : structuredClone(after),
            changed: result.changed,
            result: structuredClone(result),
        };
        assertWorkspaceMutationProof(proof);
        return deepFreeze(proof);
    }

    async #newEvent(
        ctx: Context,
        agentId: string,
        payload:
            | {
                  readonly type: "workspace_created";
                  readonly agentId: string;
                  readonly workspace: Workspace;
              }
            | {
                  readonly type: "workspace_transferred";
                  readonly agentId: string;
                  readonly workspace: Workspace;
                  readonly previousProjectRef?: string;
              }
            | {
                  readonly type: "workspace_archived";
                  readonly agentId: string;
                  readonly workspace: Workspace;
              }
            | {
                  readonly type: "workspace_transfer_scheduled";
                  readonly agentId: string;
                  readonly targetWorkspaceId: string;
              },
    ): Promise<WorkspaceEvent> {
        const rawId = this.#eventIdFactory(ctx, agentId);
        const eventId = isPromiseLike(rawId) ? await rawId : rawId;
        if (!Value.Check(workspaceEventIdSchema, eventId)) {
            throw new Error("Workspace event ID factory returned an invalid ID.");
        }
        const at = this.#clock(ctx, agentId);
        if (!Value.Check(workspaceTimestampSchema, at)) {
            throw new Error("Workspace clock must return a non-negative integer.");
        }
        const event = { ...payload, eventId, at };
        if (!Value.Check(workspaceEventSchema, event)) {
            throw new Error("Workspace feature created an invalid event.");
        }
        return deepFreeze(structuredClone(event)) as WorkspaceEvent;
    }

    async #observe(ctx: Context, event: WorkspaceEvent): Promise<void> {
        if (!Value.Check(workspaceEventSchema, event) || !isDeepFrozen(event)) {
            throw new Error("Workspace feature created an invalid unfrozen event.");
        }
        const transactional = this.#listener?.onEventTransactional;
        if (transactional !== undefined) {
            await transactional.call(this.#listener, ctx, event);
        }
        const registration = this.#store.afterCommit(ctx, event.agentId, (postCommitCtx) =>
            this.#notifyPostCommit(postCommitCtx, event),
        );
        if (registration !== undefined) {
            throw new Error("Workspace store afterCommit must register synchronously.");
        }
    }

    async #notifyPostCommit(ctx: Context, event: WorkspaceEvent): Promise<void> {
        const listener = this.#listener?.onEvent;
        if (listener !== undefined) {
            await this.#notifyObserver(ctx, event, () => listener.call(this.#listener, ctx, event));
        }
    }

    async #notifyObserver(
        ctx: Context,
        event: WorkspaceEvent,
        observer: () => void | Promise<void>,
    ): Promise<void> {
        try {
            await observer();
        } catch (error: unknown) {
            try {
                await this.#onPostCommitError?.(ctx, event, safeError(error));
            } catch {
                // Observer reporting is advisory after durable state has settled.
            }
        }
    }

    async #getRequired(ctx: Context, agentId: string, workspaceId: string): Promise<Workspace> {
        const workspace = await this.#getRequiredOptional(ctx, agentId, workspaceId);
        if (workspace === undefined) {
            throw new Error(`Workspace "${workspaceId}" was not found.`);
        }
        return workspace;
    }

    async #getRequiredOptional(
        ctx: Context,
        agentId: string,
        workspaceId: string,
    ): Promise<Workspace | undefined> {
        const raw = await requirePromise(
            this.#store.get(ctx, agentId, workspaceId),
            "Workspace store get",
        );
        if (raw === undefined) return undefined;
        assertWorkspace(raw);
        assertWorkspaceRecord(raw);
        if (raw.id !== workspaceId) {
            throw new Error("Workspace store returned a different workspace identity.");
        }
        return structuredClone(raw);
    }

    async #authorize(
        ctx: Context,
        actingAgentId: string,
        ownerAgentId: string,
        action: WorkspaceAuthorizationAction,
    ): Promise<void> {
        if (actingAgentId === ownerAgentId) return;
        const authorization = this.#authorization;
        if (authorization === undefined) {
            throw new Error(
                `Agent "${actingAgentId}" is not authorized to ${action} workspace data owned by "${ownerAgentId}".`,
            );
        }
        const raw = authorization(ctx, actingAgentId, ownerAgentId, action);
        const allowed = isPromiseLike(raw) ? await raw : raw;
        if (typeof allowed !== "boolean") {
            throw new Error("Workspace authorization returned an invalid result.");
        }
        if (!allowed) {
            throw new Error(
                `Agent "${actingAgentId}" is not authorized to ${action} workspace data owned by "${ownerAgentId}".`,
            );
        }
    }

    #assertOwner(agentId: string, workspace: Workspace): void {
        if (workspace.ownerAgentId !== agentId) {
            throw new Error(`Agent "${agentId}" is not the owner of workspace "${workspace.id}".`);
        }
    }

    #assertAgentId(agentId: string): void {
        if (!Value.Check(workspaceAgentIdSchema, agentId)) {
            throw new Error("Workspace agent ID is invalid.");
        }
    }

    #assertId(id: string, label: string): void {
        if (!Value.Check(workspaceIdSchema, id)) {
            throw new Error(`Workspace ${label} ID is invalid.`);
        }
    }

    #assertInput<T>(
        schema: Parameters<typeof Value.Check>[0],
        value: unknown,
        label: string,
    ): asserts value is T {
        if (!Value.Check(schema, value)) {
            throw new Error(`Workspace ${label} input is invalid.`);
        }
    }

    #assertPage(page: WorkspacePage, cursor: string | undefined, limit: number): void {
        if (page.workspaces.length > limit) {
            throw new Error("Workspace store returned more records than requested.");
        }
        for (let index = 1; index < page.workspaces.length; index += 1) {
            const previous = page.workspaces[index - 1]!;
            const current = page.workspaces[index]!;
            if (current.id <= previous.id) {
                throw new Error(
                    "Workspace page identities must be unique and ordered by ascending ID.",
                );
            }
        }
        if (page.nextCursor === undefined) return;
        if (page.workspaces.length === 0) {
            throw new Error("Workspace page cannot advance an empty page.");
        }
        const start = cursor === undefined ? 0 : parseCursor(cursor);
        const next = parseCursor(page.nextCursor);
        if (next !== start + page.workspaces.length) {
            throw new Error("Workspace page cursor must advance exactly by visible records.");
        }
    }

    #assertResultIdentity(
        result: WorkspaceCreateResult | WorkspaceArchiveResult,
        operation: WorkspaceOperation,
        agentId: string,
        kind: "create" | "archive",
    ): void {
        if (
            result.agentId !== agentId ||
            result.operation !== kind ||
            result.operationId !== operation.operationId ||
            result.fingerprint !== operation.fingerprint
        ) {
            throw new Error("Workspace mutation result identity does not match the request.");
        }
    }

    #assertTransferResultIdentity(
        result: WorkspaceTransferResult,
        operation: WorkspaceOperation,
        agentId: string,
    ): void {
        if (
            result.agentId !== agentId ||
            result.operationId !== operation.operationId ||
            result.fingerprint !== operation.fingerprint
        ) {
            throw new Error("Workspace transfer result identity does not match the request.");
        }
    }

    #assertCreatedWorkspace(workspace: Workspace, request: WorkspaceStoreCreateInput): void {
        assertWorkspace(workspace);
        if (
            workspace.id !== request.id ||
            workspace.ownerAgentId !== request.ownerAgentId ||
            workspace.name !== request.name ||
            (request.projectRef !== undefined && workspace.projectRef !== request.projectRef) ||
            (request.baseRef !== undefined && workspace.baseRef !== request.baseRef)
        ) {
            throw new Error("Workspace create result does not match the requested identity.");
        }
    }

    #assertReceiptIdentity(
        receipt: WorkspaceOperationReceipt,
        operation: WorkspaceOperation,
        agentId: string,
    ): void {
        if (
            receipt.agentId !== agentId ||
            receipt.operation !== operation.kind ||
            receipt.operationId !== operation.operationId ||
            receipt.fingerprint !== operation.fingerprint
        ) {
            throw new Error("Workspace operation identity was reused with different input.");
        }
        assertWorkspaceStoreMutationResult(receipt.result);
        if (receipt.result.agentId !== agentId) {
            throw new Error("Workspace receipt result belongs to another agent.");
        }
    }

    #assertProofIdentity(
        proof: WorkspaceMutationProof,
        operation: WorkspaceOperation,
        agentId: string,
    ): void {
        if (
            proof.agentId !== agentId ||
            proof.operation !== operation.kind ||
            proof.operationId !== operation.operationId ||
            proof.fingerprint !== operation.fingerprint
        ) {
            throw new Error("Workspace immutable proof has a different operation identity.");
        }
        assertWorkspaceStoreMutationResult(proof.result);
        if (proof.result.agentId !== agentId) {
            throw new Error("Workspace immutable proof belongs to another agent.");
        }
    }

    #assertReceiptResult(
        receipt: WorkspaceOperationReceipt,
        operation: WorkspaceOperation,
        kind: WorkspaceMutationOperation,
    ): WorkspaceStoreMutationResult {
        this.#assertReceiptIdentity(receipt, operation, receipt.agentId);
        if (kind === "transfer") {
            if (!Value.Check(workspaceTransferResultSchema, receipt.result)) {
                throw new Error("Workspace transfer receipt has the wrong mutation kind.");
            }
            return receipt.result as WorkspaceTransferResult;
        }
        if (!("operation" in receipt.result) || receipt.result.operation !== kind) {
            throw new Error("Workspace operation receipt has the wrong mutation kind.");
        }
        return receipt.result;
    }
}

export function assertWorkspaceFeatureOptions(
    value: unknown,
): asserts value is WorkspaceFeatureOptions {
    if (!Value.Check(workspaceFeatureOptionsSchema, value)) {
        throw new Error("Workspace feature options are invalid.");
    }
}

function stripOperationId(
    input: WorkspaceTransferInput,
): WorkspaceSessionTransferInput | WorkspaceProjectTransferInput {
    if ("targetWorkspaceId" in input) {
        return { targetWorkspaceId: input.targetWorkspaceId };
    }
    return { workspaceId: input.workspaceId, targetProjectRef: input.targetProjectRef };
}

function assertTransferRequestResult(
    result: WorkspaceTransferResult,
    request: WorkspaceSessionTransferInput | WorkspaceProjectTransferInput,
): void {
    if ("targetWorkspaceId" in request) {
        if (
            result.targetWorkspaceId !== undefined &&
            result.targetWorkspaceId !== request.targetWorkspaceId
        ) {
            throw new Error("Workspace session transfer target does not match the request.");
        }
        if (
            result.state === "scheduled" &&
            result.targetWorkspaceId !== request.targetWorkspaceId
        ) {
            throw new Error("Workspace scheduled transfer target does not match the request.");
        }
        if (result.state === "transferred" && result.workspace.id !== request.targetWorkspaceId) {
            throw new Error(
                "Workspace session transfer result does not match the requested workspace.",
            );
        }
        return;
    }

    if (result.state !== "transferred") {
        throw new Error("Workspace project transfer must return a transferred result.");
    }
    if (result.workspace.id !== request.workspaceId) {
        throw new Error("Workspace project transfer changed the workspace identity.");
    }
    if (result.workspace.projectRef !== request.targetProjectRef) {
        throw new Error(
            "Workspace project transfer result does not match the requested project reference.",
        );
    }
}

function assertWorkspaceTransferTransition(
    before: Workspace,
    after: Workspace,
    request: WorkspaceSessionTransferInput | WorkspaceProjectTransferInput,
): void {
    if (before.id !== after.id || before.ownerAgentId !== after.ownerAgentId) {
        throw new Error("Workspace transfer changed durable identity or ownership.");
    }
    if (
        before.name !== after.name ||
        before.baseRef !== after.baseRef ||
        before.status !== after.status ||
        before.createdAt !== after.createdAt ||
        before.archivedAt !== after.archivedAt
    ) {
        throw new Error("Workspace transfer changed fields outside the requested transition.");
    }
    if ("workspaceId" in request) {
        if (after.projectRef !== request.targetProjectRef) {
            throw new Error(
                "Workspace project transfer did not reach the requested project reference.",
            );
        }
        if (after.projectRef === before.projectRef) {
            if (after.updatedAt !== before.updatedAt) {
                throw new Error(
                    "Workspace project transfer changed updatedAt without changing projectRef.",
                );
            }
        } else if (after.updatedAt <= before.updatedAt) {
            throw new Error(
                "Workspace project transfer must advance updatedAt for a project change.",
            );
        }
    } else if (before.projectRef !== after.projectRef) {
        throw new Error("Workspace session transfer changed the project reference.");
    }
    if (after.updatedAt < before.updatedAt) {
        throw new Error("Workspace transfer moved updatedAt backwards.");
    }
}

function assertWorkspaceArchiveState(workspace: Workspace): void {
    if (workspace.status !== "archived") {
        throw new Error("Workspace archive authoritative state is not archived.");
    }
    if (workspace.archivedAt === undefined) {
        throw new Error("Archived workspace is missing archivedAt.");
    }
    if (workspace.archivedAt < workspace.createdAt || workspace.archivedAt > workspace.updatedAt) {
        throw new Error("Archived workspace archivedAt is inconsistent with its timestamps.");
    }
}

function assertWorkspaceRecord(workspace: Workspace): void {
    if (workspace.updatedAt < workspace.createdAt) {
        throw new Error("Workspace timestamps are not ordered.");
    }
    if (workspace.archivedAt === undefined) {
        if (workspace.status === "archived") {
            throw new Error("Archived workspace is missing archivedAt.");
        }
        return;
    }
    if (workspace.status !== "archived") {
        throw new Error("Non-archived workspace has archivedAt.");
    }
    if (workspace.archivedAt < workspace.createdAt || workspace.archivedAt > workspace.updatedAt) {
        throw new Error("Workspace archivedAt is inconsistent with its timestamps.");
    }
}

function assertWorkspaceArchiveTransition(
    before: Workspace | null,
    after: Workspace | null,
    result: Workspace,
    changed: boolean,
): void {
    if (after === null) {
        throw new Error("Workspace archive has no authoritative after-state.");
    }
    if (!sameJson(after, result)) {
        throw new Error("Workspace archive result does not match authoritative state.");
    }
    assertWorkspaceArchiveState(after);
    assertWorkspaceArchiveState(result);
    if (before === null) {
        throw new Error("Workspace archive has no authoritative before-state.");
    }
    if (before.id !== after.id || before.ownerAgentId !== after.ownerAgentId) {
        throw new Error("Workspace archive changed durable workspace identity.");
    }
    if (before.status === "archived") {
        if (before.archivedAt === undefined || before.archivedAt !== after.archivedAt) {
            throw new Error("Workspace archive changed an already archived timestamp.");
        }
        if (changed || !sameJson(before, after)) {
            throw new Error("Workspace archive changed an already archived workspace.");
        }
        return;
    }
    if (before.archivedAt !== undefined) {
        throw new Error("Workspace archive before-state has an archivedAt before archival.");
    }
    if (!changed) {
        throw new Error("Workspace archive reported an unchanged non-archived state.");
    }
    if (
        before.projectRef !== after.projectRef ||
        before.baseRef !== after.baseRef ||
        before.name !== after.name ||
        before.createdAt !== after.createdAt
    ) {
        throw new Error("Workspace archive changed fields outside the archival transition.");
    }
    if (after.archivedAt === undefined || after.archivedAt < before.updatedAt) {
        throw new Error("Workspace archive archivedAt is inconsistent with the transition.");
    }
}

function operationFingerprint(
    kind: WorkspaceMutationOperation,
    agentId: string,
    request: unknown,
): WorkspaceOperationFingerprint {
    const canonical = canonicalJson({ agentId, kind, request });
    const digest = createHash("sha256").update(canonical, "utf8").digest("hex");
    if (!Value.Check(workspaceOperationFingerprintSchema, digest)) {
        throw new Error("Workspace operation fingerprint is invalid.");
    }
    return digest;
}

function toMutationRequest(operation: WorkspaceOperation): WorkspaceMutationRequest {
    return {
        operation: operation.kind,
        operationId: operation.operationId,
        fingerprint: operation.fingerprint,
    };
}

function sameCreate(workspace: Workspace, request: WorkspaceStoreCreateInput): boolean {
    return (
        workspace.id === request.id &&
        workspace.ownerAgentId === request.ownerAgentId &&
        workspace.name === request.name &&
        (request.projectRef === undefined || workspace.projectRef === request.projectRef) &&
        (request.baseRef === undefined || workspace.baseRef === request.baseRef)
    );
}

function normalizeTransferStoreResult(
    raw: Static<typeof workspaceTransferStoreResultSchema>,
    agentId: string,
    operation: WorkspaceOperation,
): WorkspaceTransferResult {
    if (Value.Check(workspaceTransferResultSchema, raw)) return structuredClone(raw);
    assertWorkspace(raw);
    assertWorkspaceRecord(raw);
    return {
        agentId,
        operationId: operation.operationId,
        fingerprint: operation.fingerprint,
        changed: true,
        state: "transferred",
        targetWorkspaceId: raw.id,
        workspace: compactWorkspace(raw),
    };
}

function compactWorkspace(workspace: Workspace): WorkspaceTransferWorkspace {
    return {
        id: workspace.id,
        projectRef: workspace.projectRef,
        ownerAgentId: workspace.ownerAgentId,
    };
}

function requireWorkspaceFromResult(result: WorkspaceStoreMutationResult): Workspace {
    if (!("workspace" in result) || result.workspace === undefined) {
        throw new Error("Workspace mutation did not return a workspace.");
    }
    assertWorkspace(result.workspace);
    return result.workspace;
}

function requireTransferFromResult(result: WorkspaceStoreMutationResult): WorkspaceTransferResult {
    if (!Value.Check(workspaceTransferResultSchema, result)) {
        throw new Error("Workspace transfer did not return a valid transfer result.");
    }
    return result;
}

function fitPageForModel(
    page: WorkspacePage,
    cursor: string | undefined,
    maxOutputCharacters: number,
): WorkspacePage {
    if (page.workspaces.length === 0) return page;
    const start = cursor === undefined ? 0 : parseCursor(cursor);
    const continuationLength = (next: number): number =>
        `More workspaces at cursor ${String(next)}.`.length + 1;
    const visible: Workspace[] = [];
    let size = 0;
    for (const workspace of page.workspaces) {
        const row = workspaceRow(workspace);
        const nextSize = size + row.length + (visible.length === 0 ? 0 : 1);
        const candidateCount = visible.length + 1;
        const needsContinuation =
            page.nextCursor !== undefined || candidateCount < page.workspaces.length;
        const continuation = needsContinuation ? continuationLength(start + candidateCount) : 0;
        if (nextSize + continuation > maxOutputCharacters) break;
        visible.push(workspace);
        size = nextSize;
    }
    if (visible.length === 0) {
        throw new Error(
            "Workspace page cannot expose a complete identity within the output budget.",
        );
    }
    const consumedAll = visible.length === page.workspaces.length;
    const nextCursor =
        consumedAll && page.nextCursor === undefined ? undefined : String(start + visible.length);
    return {
        workspaces: visible,
        ...(nextCursor === undefined ? {} : { nextCursor }),
    };
}

function workspaceRow(workspace: Workspace): string {
    const prefix = `${workspace.id} [${workspace.status}]`;
    const remaining = Math.max(0, 160 - prefix.length - 1);
    return `${prefix} ${workspace.name.slice(0, remaining)}`;
}

function workspaceDetailText(workspace: Workspace): string {
    return [
        `Workspace ID: ${workspace.id}`,
        `Name: ${workspace.name}`,
        `Status: ${workspace.status}`,
        `Project ref: ${workspace.projectRef}`,
        `Base ref: ${workspace.baseRef ?? "(none)"}`,
        `Owner agent: ${workspace.ownerAgentId}`,
        `Created at: ${String(workspace.createdAt)}`,
        `Updated at: ${String(workspace.updatedAt)}`,
        ...(workspace.archivedAt === undefined
            ? []
            : [`Archived at: ${String(workspace.archivedAt)}`]),
    ].join("\n");
}

function workspaceBranchMetadataDetailText(metadata: WorkspaceBranchMetadata): string {
    return [
        `Workspace ID: ${metadata.workspaceId}`,
        `Branch: ${metadata.branch ?? "(detached or unavailable)"}`,
        `Head: ${metadata.head ?? "(unavailable)"}`,
        `Upstream: ${metadata.upstream ?? "(none)"}`,
        `Ahead: ${String(metadata.ahead)}`,
        `Behind: ${String(metadata.behind)}`,
        `Detached: ${String(metadata.detached)}`,
    ].join("\n");
}

function fitWorkspaceDetailPage(
    page: Extract<WorkspaceDetailPage, { readonly workspace: Workspace }>,
    maxOutputCharacters: number,
): Extract<WorkspaceDetailPage, { readonly workspace: Workspace }> {
    let detail = page.detail;
    for (;;) {
        const candidate: Extract<WorkspaceDetailPage, { readonly workspace: Workspace }> = {
            workspace: page.workspace,
            detail,
            detailOffset: page.detailOffset,
            detailTotal: page.detailTotal,
            ...(page.detailOffset + detail.length < page.detailTotal
                ? { nextDetailOffset: page.detailOffset + detail.length }
                : {}),
        };
        if (
            formatWorkspaceDetailPage(candidate, maxOutputCharacters).length <= maxOutputCharacters
        ) {
            return candidate;
        }
        if (detail.length <= 1) {
            throw new Error("Workspace detail cannot fit the configured model-output bound.");
        }
        const excess = Math.max(
            1,
            formatWorkspaceDetailPage(candidate, maxOutputCharacters).length - maxOutputCharacters,
        );
        detail = detail.slice(0, Math.max(1, detail.length - excess));
    }
}

function formatWorkspaceDetailPage(
    page: Extract<WorkspaceDetailPage, { readonly workspace: Workspace }>,
    maxOutputCharacters: number,
): string {
    const header = `${page.workspace.id} [${page.workspace.status}]`;
    const full = [
        header,
        `Detail [${page.detailOffset}/${page.detailTotal}]: ${page.detail}`,
        ...(page.nextDetailOffset === undefined
            ? []
            : [`More detail starts at offset ${page.nextDetailOffset}.`]),
    ].join("\n");
    if (full.length <= maxOutputCharacters) return full;

    const compact = [
        page.workspace.id,
        `Detail: ${page.detail}`,
        ...(page.nextDetailOffset === undefined ? [] : [`More detail: ${page.nextDetailOffset}.`]),
    ].join("\n");
    if (compact.length <= maxOutputCharacters) return compact;

    return [
        `Detail: ${page.detail}`,
        ...(page.nextDetailOffset === undefined ? [] : [`More detail: ${page.nextDetailOffset}.`]),
    ].join("\n");
}

function fitWorkspaceBranchMetadataPage(
    page: WorkspaceBranchMetadataPage,
    maxOutputCharacters: number,
): WorkspaceBranchMetadataPage {
    let detail = page.detail;
    for (;;) {
        const candidate = {
            ...page,
            detail,
        };
        if (page.detailOffset + detail.length < page.detailTotal) {
            candidate.nextDetailOffset = page.detailOffset + detail.length;
        } else {
            delete candidate.nextDetailOffset;
        }
        if (
            formatWorkspaceBranchMetadataPage(candidate, maxOutputCharacters).length <=
            maxOutputCharacters
        ) {
            return candidate;
        }
        if (detail.length <= 1) {
            throw new Error(
                "Workspace branch metadata cannot fit the configured model-output bound.",
            );
        }
        const excess = Math.max(
            1,
            formatWorkspaceBranchMetadataPage(candidate, maxOutputCharacters).length -
                maxOutputCharacters,
        );
        detail = detail.slice(0, Math.max(1, detail.length - excess));
    }
}

function formatWorkspaceBranchMetadataPage(
    page: WorkspaceBranchMetadataPage,
    maxOutputCharacters: number,
): string {
    const full = [
        `${page.workspaceId}${page.detached ? " [detached]" : ""}`,
        `Detail [${page.detailOffset}/${page.detailTotal}]: ${page.detail}`,
        ...(page.nextDetailOffset === undefined
            ? []
            : [`More detail starts at offset ${page.nextDetailOffset}.`]),
    ].join("\n");
    if (full.length <= maxOutputCharacters) return full;

    const compact = [
        page.workspaceId,
        `Detail: ${page.detail}`,
        ...(page.nextDetailOffset === undefined ? [] : [`More detail: ${page.nextDetailOffset}.`]),
    ].join("\n");
    if (compact.length <= maxOutputCharacters) return compact;

    return [
        `Detail: ${page.detail}`,
        ...(page.nextDetailOffset === undefined ? [] : [`More detail: ${page.nextDetailOffset}.`]),
    ].join("\n");
}

function parseCursor(cursor: string): number {
    const value = Number(cursor);
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error("Workspace cursor is not a bounded integer.");
    }
    return value;
}

function canonicalJson(value: unknown, depth = 0): string {
    if (depth > MAX_CANONICAL_DEPTH) {
        throw new Error("Workspace operation input is too deeply nested.");
    }
    let result: string;
    if (value === null) {
        result = "null";
    } else if (typeof value === "string") {
        if (value.length > MAX_CANONICAL_STRING_LENGTH) {
            throw new Error("Workspace operation input contains an oversized string.");
        }
        result = JSON.stringify(value);
    } else if (typeof value === "number") {
        if (!Number.isFinite(value))
            throw new Error("Workspace operation input has an invalid number.");
        result = JSON.stringify(value);
    } else if (typeof value === "boolean") {
        result = value ? "true" : "false";
    } else if (Array.isArray(value)) {
        if (value.length > MAX_CANONICAL_ARRAY_ITEMS) {
            throw new Error("Workspace operation input contains too many items.");
        }
        result = `[${value.map((entry) => canonicalJson(entry, depth + 1)).join(",")}]`;
    } else if (typeof value === "object") {
        const entries = Object.entries(value as Record<string, unknown>).filter(
            ([, entry]) => entry !== undefined,
        );
        if (entries.length > MAX_CANONICAL_OBJECT_PROPERTIES) {
            throw new Error("Workspace operation input contains too many properties.");
        }
        result = `{${entries
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry, depth + 1)}`)
            .join(",")}}`;
    } else {
        throw new Error("Workspace operation input contains an unsupported value.");
    }
    if (Buffer.byteLength(result, "utf8") > MAX_CANONICAL_BYTES) {
        throw new Error("Workspace operation input is too large to fingerprint.");
    }
    return result;
}

function sameJson(left: unknown, right: unknown): boolean {
    try {
        return canonicalJson(left) === canonicalJson(right);
    } catch {
        return false;
    }
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
    if (value !== null && typeof value === "object") {
        if (seen.has(value)) return value;
        seen.add(value);
        for (const child of Object.values(value as Record<string, unknown>)) {
            deepFreeze(child, seen);
        }
        Object.freeze(value);
    }
    return value;
}

function isDeepFrozen(value: unknown, seen = new WeakSet<object>()): boolean {
    if (value === null || typeof value !== "object") return true;
    if (!Object.isFrozen(value)) return false;
    if (seen.has(value)) return true;
    seen.add(value);
    return Object.values(value as Record<string, unknown>).every((child) =>
        isDeepFrozen(child, seen),
    );
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
    return (
        typeof value === "object" &&
        value !== null &&
        "then" in value &&
        typeof (value as { then?: unknown }).then === "function"
    );
}

function requirePromise<T>(value: T | Promise<T>, label: string): Promise<T> {
    if (!isPromiseLike(value)) {
        throw new Error(`${label} must return a promise.`);
    }
    return value;
}

function safeError(error: unknown): string {
    try {
        const message =
            error instanceof Error
                ? error.message
                : typeof error === "string"
                  ? error
                  : String(error);
        return message.slice(0, 512) || "Unknown workspace observer error.";
    } catch {
        return "Unknown workspace observer error.";
    }
}
