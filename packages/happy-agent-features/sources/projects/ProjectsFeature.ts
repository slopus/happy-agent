import { createHash } from "node:crypto";

import {
    agentKV,
    type AgentFeature,
    type AgentFeatureScope,
    type AnyAgentTool,
} from "@slopus/happy-agent-base";
import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

import {
    MAX_PROJECT_DETAIL_PAGE_SIZE,
    projectDetailPageSchema,
    projectDetailQuerySchema,
    type ProjectDetailPage,
    type ProjectDetailQuery,
} from "./ProjectDetailPage.js";
import {
    projectAgentIdSchema,
    projectArchiveOptionsSchema,
    projectCreateInputSchema,
    projectEnsureInputSchema,
    projectIdSchema,
    projectOperationFingerprintSchema,
    projectOperationIdSchema,
    projectOperationStateSchema,
    projectRenameInputSchema,
    projectSchema,
    projectEventIdSchema,
    MAX_PROJECT_SETTINGS_DEPTH,
    MAX_PROJECT_SETTINGS_ENCODED_BYTES,
    projectSettingsSchema,
    projectSettingsUpdateInputSchema,
    projectTimestampSchema,
    type Project,
    type ProjectArchiveOptions,
    type ProjectCreateInput,
    type ProjectEnsureInput,
    type ProjectMutationOperation,
    type ProjectOperationFingerprint,
    type ProjectRenameInput,
    type ProjectRenameChanges,
    type ProjectSettings,
    type ProjectSettingsUpdateInput,
} from "./Project.js";
import {
    projectContextSchema,
    projectEventSchema,
    projectFeatureListenerSchema,
    type ProjectEvent,
    type ProjectFeatureListener,
} from "./ProjectEvent.js";
import {
    MAX_PROJECT_PAGE_SIZE,
    projectListSchema,
    projectPageQuerySchema,
    type ProjectPage,
    type ProjectPageQuery,
} from "./ProjectPage.js";
import {
    MAX_PROJECT_SETTINGS_DETAIL_CHARACTERS,
    MAX_PROJECT_SETTINGS_DETAIL_PAGE_SIZE,
    projectSettingsDetailQuerySchema,
    projectSettingsPageSchema,
    type ProjectSettingsDetailQuery,
    type ProjectSettingsPage,
} from "./ProjectSettingsPage.js";
import {
    assertProject,
    assertProjectArchiveResult,
    assertProjectCreateResult,
    assertProjectEnsureResult,
    assertProjectMutationProof,
    assertProjectOperationReceipt,
    assertProjectPage,
    assertProjectRenameResult,
    assertProjectSettingsUpdateResult,
    assertProjectStoreMutationResult,
    assertProjectTransactionChange,
    projectAuthorizationSchema,
    projectEnsureResultSchema,
    projectMutationRequestSchema,
    projectSettingsUpdateResultSchema,
    projectStoreSchema,
    type ProjectArchiveResult,
    type ProjectAuthorization,
    type ProjectAuthorizationAction,
    type ProjectCreateResult,
    type ProjectEnsureResult,
    type ProjectMutationProof,
    type ProjectMutationRequest,
    type ProjectOperationReceipt,
    type ProjectRenameResult,
    type ProjectSettingsUpdateResult,
    type ProjectStore,
    type ProjectStoreArchiveInput,
    type ProjectStoreCreateInput,
    type ProjectStoreEnsureInput,
    type ProjectStoreMutationResult,
    type ProjectStoreRenameInput,
    type ProjectStoreSettingsUpdateInput,
    type ProjectTransactionChange,
} from "./ProjectStore.js";
import {
    archiveProjectTool,
    createProjectTool,
    ensureProjectTool,
    getProjectSettingsTool,
    getProjectTool,
    listProjectsTool,
    renameProjectTool,
    updateProjectSettingsTool,
} from "./tools/index.js";

const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_OUTPUT_CHARACTERS = 12_000;
const CREATE_ID_KEY = "project.create.id";
const CREATE_OPERATION_KEY = "project.create.operation";
const ENSURE_OPERATION_KEY = "project.ensure.operation";
const RENAME_OPERATION_KEY = "project.rename.operation";
const ARCHIVE_OPERATION_KEY = "project.archive.operation";
const SETTINGS_OPERATION_KEY = "project.settings.operation";

export const projectIdFactorySchema = Type.Function(
    [projectContextSchema, projectAgentIdSchema],
    Type.Union([projectIdSchema, Type.Promise(projectIdSchema)]),
);

export const projectEventIdFactorySchema = Type.Function(
    [projectContextSchema, projectAgentIdSchema],
    Type.Union([projectEventIdSchema, Type.Promise(projectEventIdSchema)]),
);

export const projectClockSchema = Type.Function(
    [projectContextSchema, projectAgentIdSchema],
    projectTimestampSchema,
);

export const projectPostCommitErrorSchema = Type.Function(
    [projectContextSchema, projectEventSchema, Type.Unknown()],
    Type.Union([Type.Void(), Type.Promise(Type.Void())]),
);

const projectMaxPageSizeSchema = Type.Integer({
    minimum: 1,
    maximum: MAX_PROJECT_PAGE_SIZE,
});
const projectMaxOutputSchema = Type.Integer({
    minimum: 256,
    maximum: 100_000,
});

export const projectFeatureOptionsSchema = Type.Object(
    {
        store: projectStoreSchema,
        authorization: Type.Optional(projectAuthorizationSchema),
        idFactory: Type.Optional(projectIdFactorySchema),
        eventIdFactory: Type.Optional(projectEventIdFactorySchema),
        clock: Type.Optional(projectClockSchema),
        listener: Type.Optional(projectFeatureListenerSchema),
        maxPageSize: Type.Optional(projectMaxPageSizeSchema),
        maxOutputCharacters: Type.Optional(projectMaxOutputSchema),
        onPostCommitError: Type.Optional(projectPostCommitErrorSchema),
    },
    { additionalProperties: false },
);

export type ProjectFeatureOptions = Static<typeof projectFeatureOptionsSchema>;

type ProjectChange = ProjectTransactionChange;
type ProjectOperation = {
    readonly kind: ProjectMutationOperation;
    readonly operationId: string;
    readonly fingerprint: ProjectOperationFingerprint;
};

export class ProjectsFeature implements AgentFeature {
    readonly name = "projects";

    readonly #store: ProjectStore;
    readonly #authorization: ProjectAuthorization | undefined;
    readonly #idFactory: NonNullable<ProjectFeatureOptions["idFactory"]>;
    readonly #eventIdFactory: NonNullable<ProjectFeatureOptions["eventIdFactory"]>;
    readonly #clock: NonNullable<ProjectFeatureOptions["clock"]>;
    readonly #listener: ProjectFeatureListener | undefined;
    readonly #maxPageSize: number;
    readonly #maxOutputCharacters: number;
    readonly #onPostCommitError: ProjectFeatureOptions["onPostCommitError"];

    constructor(options: ProjectFeatureOptions) {
        assertProjectFeatureOptions(options);
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
            listProjectsTool(this, scope.agent.id),
            getProjectTool(this, scope.agent.id),
            createProjectTool(this, scope.agent.id),
            ensureProjectTool(this, scope.agent.id),
            renameProjectTool(this, scope.agent.id),
            archiveProjectTool(this, scope.agent.id),
            getProjectSettingsTool(this, scope.agent.id),
            updateProjectSettingsTool(this, scope.agent.id),
        ];
    };

    async create(ctx: Context, agentId: string, input: ProjectCreateInput): Promise<Project> {
        this.#assertAgentId(agentId);
        this.#assertInput(projectCreateInputSchema, input, "project creation");
        const normalized = structuredClone(input);
        const request = {
            ...(normalized.id === undefined ? {} : { id: normalized.id }),
            repositoryRef: normalized.repositoryRef,
            name: normalized.name,
            ...(normalized.description === undefined
                ? {}
                : { description: normalized.description }),
        };
        const fingerprint = operationFingerprint("create", agentId, request);
        let id = normalized.id;
        if (id === undefined && normalized.operationId === undefined) {
            id = await this.#identity(
                ctx,
                agentId,
                CREATE_ID_KEY,
                undefined,
                fingerprint,
                projectIdSchema,
            );
        }
        const operationId = await this.#identity(
            ctx,
            agentId,
            CREATE_OPERATION_KEY,
            normalized.operationId,
            fingerprint,
            projectOperationIdSchema,
        );
        const operation = this.#operation("create", operationId, fingerprint);

        const change = await this.#runTransaction(ctx, agentId, async (txCtx) => {
            const receipt = await this.#readReceipt(txCtx, agentId, operation);
            if (receipt !== undefined) {
                return await this.#replayProjectMutation(
                    txCtx,
                    agentId,
                    operation,
                    receipt,
                    "create",
                    id ?? this.#receiptProjectId(receipt),
                );
            }
            await this.#rejectOrphanedProof(txCtx, agentId, operation);
            const projectId = id ?? (await this.#newIdentity(ctx, agentId, projectIdSchema));
            const storeInput: ProjectStoreCreateInput = {
                id: projectId,
                ownerAgentId: agentId,
                repositoryRef: normalized.repositoryRef,
                name: normalized.name,
                ...(normalized.description === undefined
                    ? {}
                    : { description: normalized.description }),
            };
            const before = await this.#getOptional(txCtx, agentId, projectId);
            if (before !== undefined) {
                await this.#authorize(txCtx, agentId, before.ownerAgentId, "create");
                if (!sameCreate(before, storeInput)) {
                    throw new Error(`Project "${projectId}" already exists with different values.`);
                }
                const result: ProjectCreateResult = {
                    operation: "create",
                    agentId,
                    operationId: operation.operationId,
                    fingerprint: operation.fingerprint,
                    changed: false,
                    project: structuredClone(before),
                };
                const proof = this.#proof(operation, agentId, projectId, before, before, result);
                await this.#persistReceiptAndProof(txCtx, agentId, operation, proof, result);
                return { result };
            }

            const raw = await requirePromise(
                this.#store.create(
                    txCtx,
                    agentId,
                    structuredClone(storeInput),
                    this.#request(operation),
                ),
                "Project store create",
            );
            assertProjectCreateResult(raw);
            this.#assertMutationIdentity(raw, operation, agentId, "create");
            this.#assertCreatedProject(raw.project, storeInput);
            const after = await this.#getRequired(txCtx, agentId, projectId);
            if (!sameJson(after, raw.project)) {
                throw new Error("Project create result does not match authoritative state.");
            }
            const changed = before === undefined && !sameJson(before, after);
            if (raw.changed !== changed) {
                throw new Error("Project create changed flag is not authoritative.");
            }
            const result = structuredClone(raw);
            const proof = this.#proof(operation, agentId, projectId, before, after, result);
            await this.#persistReceiptAndProof(txCtx, agentId, operation, proof, result);
            if (!changed) return { result };
            const event = await this.#newEvent(txCtx, agentId, {
                type: "project_created",
                agentId,
                project: after,
            });
            await this.#observe(txCtx, event);
            return { result, event };
        });
        return structuredClone(requireProjectFromResult(change.result));
    }

    async ensure(
        ctx: Context,
        agentId: string,
        input: ProjectEnsureInput,
    ): Promise<ProjectEnsureResult> {
        this.#assertAgentId(agentId);
        this.#assertInput(projectEnsureInputSchema, input, "project ensure");
        const normalized = structuredClone(input);
        const request = {
            repositoryRef: normalized.repositoryRef,
            ...(normalized.name === undefined ? {} : { name: normalized.name }),
            ...(normalized.description === undefined
                ? {}
                : { description: normalized.description }),
        };
        const fingerprint = operationFingerprint("ensure", agentId, request);
        const operationId = await this.#identity(
            ctx,
            agentId,
            ENSURE_OPERATION_KEY,
            normalized.operationId,
            fingerprint,
            projectOperationIdSchema,
        );
        const operation = this.#operation("ensure", operationId, fingerprint);

        const change = await this.#runTransaction(ctx, agentId, async (txCtx) => {
            const receipt = await this.#readReceipt(txCtx, agentId, operation);
            if (receipt !== undefined) {
                return await this.#replayEnsure(txCtx, agentId, operation, receipt);
            }
            await this.#rejectOrphanedProof(txCtx, agentId, operation);
            const candidateId = await this.#newIdentity(ctx, agentId, projectIdSchema);
            const storeInput: ProjectStoreEnsureInput = {
                id: candidateId,
                ownerAgentId: agentId,
                repositoryRef: normalized.repositoryRef,
                ...(normalized.name === undefined ? {} : { name: normalized.name }),
                ...(normalized.description === undefined
                    ? {}
                    : { description: normalized.description }),
            };
            const before = await this.#findByRepositoryRef(
                txCtx,
                agentId,
                normalized.repositoryRef,
            );
            if (before !== undefined) {
                await this.#authorize(txCtx, agentId, before.ownerAgentId, "ensure");
            }
            const raw = await requirePromise(
                this.#store.ensure(
                    txCtx,
                    agentId,
                    structuredClone(storeInput),
                    this.#request(operation),
                ),
                "Project store ensure",
            );
            assertProjectEnsureResult(raw);
            this.#assertMutationIdentity(raw, operation, agentId, "ensure");
            this.#assertEnsureProject(raw.project, storeInput, before === undefined);
            const after = await this.#getRequired(txCtx, agentId, raw.project.id);
            if (!sameJson(after, raw.project)) {
                throw new Error("Project ensure result does not match authoritative state.");
            }
            if (before !== undefined && after.id !== before.id) {
                throw new Error("Project ensure changed the identity of an existing project.");
            }
            const created = before === undefined;
            const changed = !sameJson(before, after);
            if (raw.created !== created || raw.changed !== changed) {
                throw new Error("Project ensure changed flag is not authoritative.");
            }
            if (!created && changed) {
                throw new Error("Project ensure modified an existing project.");
            }
            const result: ProjectEnsureResult = {
                ...structuredClone(raw),
                created,
                changed,
                project: structuredClone(after),
            };
            const proof = this.#proof(operation, agentId, after.id, before, after, result);
            await this.#persistReceiptAndProof(txCtx, agentId, operation, proof, result);
            if (!changed) return { result };
            const event = await this.#newEvent(txCtx, agentId, {
                type: "project_created",
                agentId,
                project: after,
            });
            await this.#observe(txCtx, event);
            return { result, event };
        });
        if (!Value.Check(projectEnsureResultSchema, change.result)) {
            throw new Error("Project ensure did not return a valid result.");
        }
        return structuredClone(change.result);
    }

    async listPage(
        ctx: Context,
        agentId: string,
        query: ProjectPageQuery = {},
    ): Promise<ProjectPage> {
        this.#assertAgentId(agentId);
        this.#assertInput(projectPageQuerySchema, query, "project page query");
        const limit = query.limit ?? this.#maxPageSize;
        if (limit > this.#maxPageSize) {
            throw new Error(`Project page limit cannot exceed ${String(this.#maxPageSize)}.`);
        }
        if (query.cursor !== undefined) parseCursor(query.cursor);
        const normalized = { ...structuredClone(query), limit };
        const raw = await requirePromise(
            this.#store.list(ctx, agentId, normalized),
            "Project store list",
        );
        assertProjectPage(raw);
        this.#assertPage(raw, normalized.cursor, limit);
        for (const project of raw.projects) {
            assertProjectRecord(project);
            if (normalized.status !== undefined && project.status !== normalized.status) {
                throw new Error("Project page returned a row outside the requested status.");
            }
            if (
                normalized.status === undefined &&
                normalized.includeArchived !== true &&
                project.status === "archived"
            ) {
                throw new Error("Project page returned an archived row without includeArchived.");
            }
            await this.#authorize(ctx, agentId, project.ownerAgentId, "list");
        }
        return structuredClone(fitPageForModel(raw, normalized.cursor, this.#maxOutputCharacters));
    }

    async list(ctx: Context, agentId: string, query: ProjectPageQuery = {}): Promise<Project[]> {
        return (await this.listPage(ctx, agentId, query)).projects;
    }

    async get(ctx: Context, agentId: string, projectId: string): Promise<Project | undefined> {
        this.#assertAgentId(agentId);
        this.#assertId(projectId);
        const project = await this.#getOptional(ctx, agentId, projectId);
        if (project === undefined) return undefined;
        await this.#authorize(ctx, agentId, project.ownerAgentId, "get");
        return structuredClone(project);
    }

    async getPage(
        ctx: Context,
        agentId: string,
        projectId: string,
        query: ProjectDetailQuery = {},
    ): Promise<ProjectDetailPage> {
        this.#assertAgentId(agentId);
        this.#assertId(projectId);
        this.#assertInput(projectDetailQuerySchema, query, "project detail query");
        const project = await this.get(ctx, agentId, projectId);
        if (project === undefined) return { project: null };
        const detail = projectDetailText(project);
        const detailOffset = query.detailOffset ?? 0;
        const detailLimit = query.detailLimit ?? MAX_PROJECT_DETAIL_PAGE_SIZE;
        if (detailOffset > detail.length) {
            throw new Error("Project detail offset exceeds the available detail.");
        }
        const page: ProjectDetailPage = {
            project,
            detail: detail.slice(detailOffset, detailOffset + detailLimit),
            detailOffset,
            detailTotal: detail.length,
            ...(detailOffset + detailLimit < detail.length
                ? { nextDetailOffset: detailOffset + detailLimit }
                : {}),
        };
        if (
            !Value.Check(projectDetailPageSchema, {
                project,
                detail: "",
                detailOffset: 0,
                detailTotal: detail.length,
            })
        ) {
            throw new Error("Project detail exceeds its bounded traversal length.");
        }
        return fitProjectDetailPage(page, this.#maxOutputCharacters);
    }

    async readSettings(ctx: Context, agentId: string, projectId: string): Promise<ProjectSettings> {
        this.#assertAgentId(agentId);
        this.#assertId(projectId);
        const project = await this.#getRequired(ctx, agentId, projectId);
        await this.#authorize(ctx, agentId, project.ownerAgentId, "settings_read");
        const raw = await requirePromise(
            this.#store.readSettings(ctx, agentId, projectId),
            "Project store read settings",
        );
        assertProjectSettings(raw);
        return structuredClone(raw);
    }

    async readSettingsPage(
        ctx: Context,
        agentId: string,
        projectId: string,
        query: ProjectSettingsDetailQuery = {},
    ): Promise<ProjectSettingsPage> {
        this.#assertInput(projectSettingsDetailQuerySchema, query, "project settings detail query");
        const settings = await this.readSettings(ctx, agentId, projectId);
        const detail = settingsDetailText(settings);
        const detailOffset = query.detailOffset ?? 0;
        const detailLimit = query.detailLimit ?? MAX_PROJECT_SETTINGS_DETAIL_PAGE_SIZE;
        if (detailOffset > detail.length) {
            throw new Error("Project settings detail offset exceeds the available detail.");
        }
        const page: ProjectSettingsPage = {
            projectId,
            settings,
            detail: detail.slice(detailOffset, detailOffset + detailLimit),
            detailOffset,
            detailTotal: detail.length,
            ...(detailOffset + detailLimit < detail.length
                ? { nextDetailOffset: detailOffset + detailLimit }
                : {}),
        };
        assertProjectSettingsPage(page);
        return fitSettingsPage(page, this.#maxOutputCharacters);
    }

    async rename(ctx: Context, agentId: string, input: ProjectRenameInput): Promise<Project>;
    async rename(
        ctx: Context,
        agentId: string,
        projectId: string,
        changes: ProjectRenameChanges,
    ): Promise<Project>;
    async rename(
        ctx: Context,
        agentId: string,
        inputOrProjectId: ProjectRenameInput | string,
        changes?: ProjectRenameChanges,
    ): Promise<Project> {
        this.#assertAgentId(agentId);
        const input: ProjectRenameInput =
            typeof inputOrProjectId === "string"
                ? ({
                      projectId: inputOrProjectId,
                      ...(changes === undefined ? {} : changes),
                  } as ProjectRenameInput)
                : inputOrProjectId;
        this.#assertInput(projectRenameInputSchema, input, "project rename");
        const normalized = structuredClone(input);
        const request = { projectId: normalized.projectId, name: normalized.name };
        const fingerprint = operationFingerprint("rename", agentId, request);
        const operationId = await this.#identity(
            ctx,
            agentId,
            RENAME_OPERATION_KEY,
            normalized.operationId,
            fingerprint,
            projectOperationIdSchema,
        );
        const operation = this.#operation("rename", operationId, fingerprint);

        const change = await this.#runTransaction(ctx, agentId, async (txCtx) => {
            const receipt = await this.#readReceipt(txCtx, agentId, operation);
            if (receipt !== undefined) {
                return await this.#replayProjectMutation(
                    txCtx,
                    agentId,
                    operation,
                    receipt,
                    "rename",
                    normalized.projectId,
                );
            }
            await this.#rejectOrphanedProof(txCtx, agentId, operation);
            const before = await this.#getRequired(txCtx, agentId, normalized.projectId);
            await this.#authorize(txCtx, agentId, before.ownerAgentId, "rename");
            const storeInput: ProjectStoreRenameInput = {
                projectId: normalized.projectId,
                name: normalized.name,
            };
            const raw = await requirePromise(
                this.#store.rename(
                    txCtx,
                    agentId,
                    structuredClone(storeInput),
                    this.#request(operation),
                ),
                "Project store rename",
            );
            assertProjectRenameResult(raw);
            this.#assertMutationIdentity(raw, operation, agentId, "rename");
            if (raw.project.id !== normalized.projectId || raw.project.name !== normalized.name) {
                throw new Error("Project rename result does not match the requested project.");
            }
            const after = await this.#getRequired(txCtx, agentId, normalized.projectId);
            if (!sameJson(after, raw.project)) {
                throw new Error("Project rename result does not match authoritative state.");
            }
            assertProjectRenameTransition(before, after, normalized.name);
            const changed = !sameJson(before, after);
            if (raw.changed !== changed) {
                throw new Error("Project rename changed flag is not authoritative.");
            }
            const result = structuredClone(raw);
            const proof = this.#proof(
                operation,
                agentId,
                normalized.projectId,
                before,
                after,
                result,
            );
            await this.#persistReceiptAndProof(txCtx, agentId, operation, proof, result);
            if (!changed) return { result };
            const event = await this.#newEvent(txCtx, agentId, {
                type: "project_renamed",
                agentId,
                project: after,
                previousName: before.name,
            });
            await this.#observe(txCtx, event);
            return { result, event };
        });
        return structuredClone(requireProjectFromResult(change.result));
    }

    async archive(
        ctx: Context,
        agentId: string,
        projectId: string,
        options?: ProjectArchiveOptions,
    ): Promise<Project> {
        this.#assertAgentId(agentId);
        this.#assertId(projectId);
        if (options !== undefined) {
            this.#assertInput(projectArchiveOptionsSchema, options, "project archive");
        }
        const normalizedOptions = options === undefined ? {} : structuredClone(options);
        const fingerprint = operationFingerprint("archive", agentId, { projectId });
        const operationId = await this.#identity(
            ctx,
            agentId,
            ARCHIVE_OPERATION_KEY,
            normalizedOptions.operationId,
            fingerprint,
            projectOperationIdSchema,
        );
        const operation = this.#operation("archive", operationId, fingerprint);

        const change = await this.#runTransaction(ctx, agentId, async (txCtx) => {
            const receipt = await this.#readReceipt(txCtx, agentId, operation);
            if (receipt !== undefined) {
                return await this.#replayProjectMutation(
                    txCtx,
                    agentId,
                    operation,
                    receipt,
                    "archive",
                    projectId,
                );
            }
            await this.#rejectOrphanedProof(txCtx, agentId, operation);
            const before = await this.#getRequired(txCtx, agentId, projectId);
            await this.#authorize(txCtx, agentId, before.ownerAgentId, "archive");
            const storeInput: ProjectStoreArchiveInput = { projectId };
            const raw = await requirePromise(
                this.#store.archive(txCtx, agentId, storeInput, this.#request(operation)),
                "Project store archive",
            );
            assertProjectArchiveResult(raw);
            this.#assertMutationIdentity(raw, operation, agentId, "archive");
            if (raw.project.id !== projectId) {
                throw new Error("Project archive result has a different project identity.");
            }
            const after = await this.#getRequired(txCtx, agentId, projectId);
            if (!sameJson(after, raw.project)) {
                throw new Error("Project archive result does not match authoritative state.");
            }
            assertProjectArchiveTransition(before, after);
            const changed = !sameJson(before, after);
            if (raw.changed !== changed) {
                throw new Error("Project archive changed flag is not authoritative.");
            }
            const result = structuredClone(raw);
            const proof = this.#proof(operation, agentId, projectId, before, after, result);
            await this.#persistReceiptAndProof(txCtx, agentId, operation, proof, result);
            if (!changed) return { result };
            const event = await this.#newEvent(txCtx, agentId, {
                type: "project_archived",
                agentId,
                project: after,
            });
            await this.#observe(txCtx, event);
            return { result, event };
        });
        return structuredClone(requireProjectFromResult(change.result));
    }

    async updateSettings(
        ctx: Context,
        agentId: string,
        input: ProjectSettingsUpdateInput,
    ): Promise<ProjectSettingsUpdateResult>;
    async updateSettings(
        ctx: Context,
        agentId: string,
        projectId: string,
        settings: ProjectSettings,
        options?: ProjectArchiveOptions,
    ): Promise<ProjectSettingsUpdateResult>;
    async updateSettings(
        ctx: Context,
        agentId: string,
        inputOrProjectId: ProjectSettingsUpdateInput | string,
        settings?: ProjectSettings,
        options?: ProjectArchiveOptions,
    ): Promise<ProjectSettingsUpdateResult> {
        this.#assertAgentId(agentId);
        const input: ProjectSettingsUpdateInput =
            typeof inputOrProjectId === "string"
                ? {
                      projectId: inputOrProjectId,
                      settings: settings as ProjectSettings,
                      ...(options?.operationId === undefined
                          ? {}
                          : { operationId: options.operationId }),
                  }
                : inputOrProjectId;
        this.#assertInput(projectSettingsUpdateInputSchema, input, "project settings update");
        assertProjectSettings(input.settings);
        const normalized = structuredClone(input);
        const request = { projectId: normalized.projectId, settings: normalized.settings };
        const fingerprint = operationFingerprint("update_settings", agentId, request);
        const operationId = await this.#identity(
            ctx,
            agentId,
            SETTINGS_OPERATION_KEY,
            normalized.operationId,
            fingerprint,
            projectOperationIdSchema,
        );
        const operation = this.#operation("update_settings", operationId, fingerprint);

        const change = await this.#runTransaction(ctx, agentId, async (txCtx) => {
            const receipt = await this.#readReceipt(txCtx, agentId, operation);
            if (receipt !== undefined) {
                return await this.#replaySettingsMutation(
                    txCtx,
                    agentId,
                    operation,
                    receipt,
                    normalized.projectId,
                );
            }
            await this.#rejectOrphanedProof(txCtx, agentId, operation);
            const beforeProject = await this.#getRequired(txCtx, agentId, normalized.projectId);
            await this.#authorize(txCtx, agentId, beforeProject.ownerAgentId, "settings_update");
            const beforeSettings = await this.#readSettingsInTransaction(
                txCtx,
                agentId,
                normalized.projectId,
            );
            const storeInput: ProjectStoreSettingsUpdateInput = {
                projectId: normalized.projectId,
                settings: structuredClone(normalized.settings),
            };
            const raw = await requirePromise(
                this.#store.updateSettings(
                    txCtx,
                    agentId,
                    structuredClone(storeInput),
                    this.#request(operation),
                ),
                "Project store update settings",
            );
            assertProjectSettingsUpdateResult(raw);
            this.#assertMutationIdentity(raw, operation, agentId, "update_settings");
            if (raw.projectId !== normalized.projectId) {
                throw new Error("Project settings result has a different project identity.");
            }
            assertProjectSettings(raw.settings);
            if (!sameJson(raw.settings, normalized.settings)) {
                throw new Error("Project settings result does not match the requested settings.");
            }
            const afterProject = await this.#getRequired(txCtx, agentId, normalized.projectId);
            const afterSettings = await this.#readSettingsInTransaction(
                txCtx,
                agentId,
                normalized.projectId,
            );
            if (!sameJson(afterSettings, raw.settings)) {
                throw new Error("Project settings result does not match authoritative settings.");
            }
            assertProjectSettingsTransition(beforeProject, afterProject);
            const changed = !sameJson(beforeSettings, afterSettings);
            if (raw.changed !== changed) {
                throw new Error("Project settings changed flag is not authoritative.");
            }
            if (!changed && !sameJson(beforeProject, afterProject)) {
                throw new Error("Unchanged project settings modified the project row.");
            }
            const result = structuredClone(raw);
            const proof = this.#proof(
                operation,
                agentId,
                normalized.projectId,
                beforeProject,
                afterProject,
                result,
                beforeSettings,
                afterSettings,
            );
            await this.#persistReceiptAndProof(txCtx, agentId, operation, proof, result);
            if (!changed) return { result };
            const event = await this.#newEvent(txCtx, agentId, {
                type: "project_settings_updated",
                agentId,
                projectId: normalized.projectId,
                settings: afterSettings,
            });
            await this.#observe(txCtx, event);
            return { result, event };
        });
        if (!Value.Check(projectSettingsUpdateResultSchema, change.result)) {
            throw new Error("Project settings update did not return a valid result.");
        }
        return structuredClone(change.result);
    }

    formatForModel(projects: readonly Project[]): string {
        if (!Value.Check(projectListSchema, projects)) {
            throw new Error("Cannot format invalid projects.");
        }
        if (projects.length === 0) return "No projects.";
        const rows = projects.map(projectRow);
        const visible: string[] = [];
        let size = 0;
        for (const row of rows) {
            const next = size + row.length + (visible.length === 0 ? 0 : 1);
            if (next > this.#maxOutputCharacters) break;
            visible.push(row);
            size = next;
        }
        if (visible.length === 0) {
            throw new Error("Project model output cannot fit a complete identity.");
        }
        return visible.join("\n");
    }

    formatPageForModel(page: ProjectPage): string {
        assertProjectPage(page);
        const start =
            page.nextCursor === undefined
                ? undefined
                : String(Math.max(0, parseCursor(page.nextCursor) - page.projects.length));
        const visiblePage = fitPageForModel(page, start, this.#maxOutputCharacters);
        let output =
            visiblePage.projects.length === 0
                ? "No projects."
                : visiblePage.projects.map(projectRow).join("\n");
        if (visiblePage.nextCursor !== undefined) {
            const continuation = `More projects at cursor ${visiblePage.nextCursor}.`;
            if (`${output}\n${continuation}`.length <= this.#maxOutputCharacters) {
                output = `${output}\n${continuation}`;
            }
        }
        return output;
    }

    formatDetailPageForModel(page: ProjectDetailPage | Project): string {
        const detailPage = Value.Check(projectDetailPageSchema, page)
            ? page
            : Value.Check(projectSchema, page)
              ? fitProjectDetailPage(
                    {
                        project: structuredClone(page),
                        detail: projectDetailText(page).slice(0, MAX_PROJECT_DETAIL_PAGE_SIZE),
                        detailOffset: 0,
                        detailTotal: projectDetailText(page).length,
                        ...(projectDetailText(page).length > MAX_PROJECT_DETAIL_PAGE_SIZE
                            ? { nextDetailOffset: MAX_PROJECT_DETAIL_PAGE_SIZE }
                            : {}),
                    },
                    this.#maxOutputCharacters,
                )
              : undefined;
        if (detailPage === undefined) {
            throw new Error("Cannot format an invalid project detail page.");
        }
        if (detailPage.project === null) return "That project does not exist.";
        const output = formatProjectDetailPage(detailPage, this.#maxOutputCharacters);
        if (output.length > this.#maxOutputCharacters) {
            throw new Error("Project detail page exceeds its model-output bound.");
        }
        return output;
    }

    formatProjectOperationForModel(label: string, project: Project): string {
        assertProject(project);
        const prefix = `${label}\n`;
        if (prefix.length >= this.#maxOutputCharacters) {
            throw new Error("Project operation label exceeds the model-output bound.");
        }
        const detail = projectDetailText(project);
        const page = fitProjectDetailPage(
            {
                project: structuredClone(project),
                detail: detail.slice(0, MAX_PROJECT_DETAIL_PAGE_SIZE),
                detailOffset: 0,
                detailTotal: detail.length,
                ...(detail.length > MAX_PROJECT_DETAIL_PAGE_SIZE
                    ? { nextDetailOffset: MAX_PROJECT_DETAIL_PAGE_SIZE }
                    : {}),
            },
            this.#maxOutputCharacters - prefix.length,
        );
        const output = `${prefix}${formatProjectDetailPage(
            page,
            this.#maxOutputCharacters - prefix.length,
        )}`;
        if (output.length > this.#maxOutputCharacters) {
            throw new Error("Project operation output exceeds its model-output bound.");
        }
        return output;
    }

    formatProjectForModel(project: Project): string {
        return this.formatProjectOperationForModel("Project:", project);
    }

    formatSettingsPageForModel(page: ProjectSettingsPage): string {
        assertProjectSettingsPage(page);
        const output = formatSettingsPage(page, this.#maxOutputCharacters);
        if (output.length > this.#maxOutputCharacters) {
            throw new Error("Project settings output exceeds its model-output bound.");
        }
        return output;
    }

    formatSettingsForModel(
        settings: ProjectSettings | ProjectSettingsPage,
        projectId = "project",
    ): string {
        const isPageCandidate =
            settings !== null &&
            typeof settings === "object" &&
            typeof (settings as { projectId?: unknown }).projectId === "string";
        if (isPageCandidate && Value.Check(projectSettingsPageSchema, settings)) {
            return this.formatSettingsPageForModel(settings);
        }
        assertProjectSettings(settings);
        const detail = settingsDetailText(settings);
        const page: ProjectSettingsPage = {
            projectId,
            settings: structuredClone(settings),
            detail: detail.slice(0, MAX_PROJECT_SETTINGS_DETAIL_PAGE_SIZE),
            detailOffset: 0,
            detailTotal: detail.length,
            ...(detail.length > MAX_PROJECT_SETTINGS_DETAIL_PAGE_SIZE
                ? { nextDetailOffset: MAX_PROJECT_SETTINGS_DETAIL_PAGE_SIZE }
                : {}),
        };
        return this.formatSettingsPageForModel(fitSettingsPage(page, this.#maxOutputCharacters));
    }

    async #runTransaction(
        ctx: Context,
        agentId: string,
        work: (txCtx: Context) => Promise<ProjectChange>,
    ): Promise<ProjectChange> {
        let expected: ProjectChange | undefined;
        const raw = await requirePromise(
            this.#store.transaction(ctx, agentId, async (txCtx) => {
                const change = await work(txCtx);
                expected = deepFreeze(structuredClone(change));
                return structuredClone(expected);
            }),
            "Project store transaction",
        );
        assertProjectTransactionChange(raw);
        if (expected === undefined || !sameJson(raw, expected)) {
            throw new Error("Project transaction returned a substituted change.");
        }
        return raw;
    }

    async #identity(
        ctx: Context,
        agentId: string,
        key: string,
        requested: string | undefined,
        fingerprint: ProjectOperationFingerprint,
        schema: typeof projectIdSchema | typeof projectOperationIdSchema,
    ): Promise<string> {
        if (requested !== undefined) {
            if (!Value.Check(schema, requested)) {
                throw new Error("Project operation identity is invalid.");
            }
            return requested;
        }
        const kv = agentKV(ctx);
        if (kv === undefined) {
            throw new Error("A host-facing project mutation must provide an operation identity.");
        }
        const state = await kv.update(ctx, key, async (current) => {
            if (current !== undefined) {
                if (
                    !Value.Check(projectOperationStateSchema, current) ||
                    !Value.Check(schema, current.id) ||
                    current.fingerprint !== fingerprint
                ) {
                    throw new Error(
                        "The project durable operation identity was reused with different input.",
                    );
                }
                return current;
            }
            const id = await this.#newIdentity(ctx, agentId, schema);
            return { id, fingerprint };
        });
        if (
            !Value.Check(projectOperationStateSchema, state) ||
            !Value.Check(schema, state.id) ||
            state.fingerprint !== fingerprint
        ) {
            throw new Error("Project durable operation identity is invalid.");
        }
        return state.id;
    }

    async #newIdentity(
        ctx: Context,
        agentId: string,
        schema: typeof projectIdSchema | typeof projectOperationIdSchema,
    ): Promise<string> {
        const raw = this.#idFactory(ctx, agentId);
        const value = isPromiseLike(raw) ? await raw : raw;
        if (!Value.Check(schema, value)) {
            throw new Error("Project identity factory returned an invalid identity.");
        }
        return value;
    }

    #operation(
        kind: ProjectMutationOperation,
        operationId: string,
        fingerprint: ProjectOperationFingerprint,
    ): ProjectOperation {
        const operation = { kind, operationId, fingerprint };
        if (!Value.Check(projectMutationRequestSchema, toMutationRequest(operation))) {
            throw new Error("Project feature created an invalid operation.");
        }
        return operation;
    }

    #request(operation: ProjectOperation): ProjectMutationRequest {
        return toMutationRequest(operation);
    }

    async #readReceipt(
        ctx: Context,
        agentId: string,
        operation: ProjectOperation,
    ): Promise<ProjectOperationReceipt | undefined> {
        const raw = await requirePromise(
            this.#store.readReceipt(ctx, agentId, operation.operationId),
            "Project store read receipt",
        );
        if (raw === undefined) return undefined;
        assertProjectOperationReceipt(raw);
        this.#assertReceiptIdentity(raw, operation, agentId);
        return structuredClone(raw);
    }

    async #readProof(
        ctx: Context,
        agentId: string,
        operation: ProjectOperation,
    ): Promise<ProjectMutationProof | undefined> {
        const raw = await requirePromise(
            this.#store.readMutationProof(ctx, agentId, operation.operationId),
            "Project store read mutation proof",
        );
        if (raw === undefined) return undefined;
        assertProjectMutationProof(raw);
        if (raw.before !== null) assertProjectRecord(raw.before);
        if (raw.after !== null) assertProjectRecord(raw.after);
        if (raw.settingsBefore !== undefined && raw.settingsBefore !== null) {
            assertProjectSettings(raw.settingsBefore);
        }
        if (raw.settingsAfter !== undefined && raw.settingsAfter !== null) {
            assertProjectSettings(raw.settingsAfter);
        }
        if (raw.operation === "update_settings") {
            if (
                raw.settingsBefore === undefined ||
                raw.settingsBefore === null ||
                raw.settingsAfter === undefined ||
                raw.settingsAfter === null
            ) {
                throw new Error("Project settings proof is missing before/after settings.");
            }
        } else if (raw.settingsBefore !== undefined || raw.settingsAfter !== undefined) {
            throw new Error("Project proof contains settings for a non-settings mutation.");
        }
        this.#assertProofIdentity(raw, operation, agentId);
        return structuredClone(raw);
    }

    async #rejectOrphanedProof(
        ctx: Context,
        agentId: string,
        operation: ProjectOperation,
    ): Promise<void> {
        const proof = await this.#readProof(ctx, agentId, operation);
        if (proof !== undefined) {
            throw new Error("Project operation has an immutable proof but no receipt.");
        }
    }

    async #persistReceiptAndProof(
        ctx: Context,
        agentId: string,
        operation: ProjectOperation,
        proof: ProjectMutationProof,
        result: ProjectStoreMutationResult,
    ): Promise<void> {
        const receipt: ProjectOperationReceipt = {
            agentId,
            operation: operation.kind,
            operationId: operation.operationId,
            fingerprint: operation.fingerprint,
            result: structuredClone(result),
        };
        assertProjectOperationReceipt(receipt);
        assertProjectMutationProof(proof);

        const proofWriteResult = await requirePromise(
            this.#store.writeMutationProof(ctx, agentId, structuredClone(proof)),
            "Project store write mutation proof",
        );
        if (proofWriteResult !== undefined) {
            throw new Error("Project store writeMutationProof must resolve to undefined.");
        }
        const persistedProof = await this.#readProof(ctx, agentId, operation);
        if (persistedProof === undefined || !sameJson(persistedProof, proof)) {
            throw new Error("Project immutable proof write-back did not match.");
        }

        const receiptWriteResult = await requirePromise(
            this.#store.writeReceipt(ctx, agentId, structuredClone(receipt)),
            "Project store write receipt",
        );
        if (receiptWriteResult !== undefined) {
            throw new Error("Project store writeReceipt must resolve to undefined.");
        }
        const persistedReceipt = await this.#readReceipt(ctx, agentId, operation);
        if (persistedReceipt === undefined || !sameJson(persistedReceipt, receipt)) {
            throw new Error("Project operation receipt write-back did not match.");
        }
    }

    async #replayProjectMutation(
        ctx: Context,
        agentId: string,
        operation: ProjectOperation,
        receipt: ProjectOperationReceipt,
        kind: "create" | "rename" | "archive",
        projectId: string,
    ): Promise<ProjectChange> {
        const receiptResult = this.#assertReceiptResult(receipt, operation, kind) as
            | ProjectCreateResult
            | ProjectRenameResult
            | ProjectArchiveResult;
        const proof = await this.#readProof(ctx, agentId, operation);
        if (proof === undefined) {
            throw new Error("Project operation receipt has no immutable proof.");
        }
        if (
            proof.subjectId !== projectId ||
            proof.changed !== receiptResult.changed ||
            !sameJson(proof.result, receiptResult) ||
            proof.after === null ||
            proof.after.id !== projectId ||
            !sameJson(proof.after, receiptResult.project) ||
            proof.changed !== !sameJson(proof.before, proof.after)
        ) {
            throw new Error("Project receipt and immutable proof disagree.");
        }
        assertProjectCatalogReplayTransition(
            kind,
            proof.before,
            proof.after,
            receiptResult.changed,
        );
        const current = await this.#getRequired(ctx, agentId, projectId);
        await this.#authorize(ctx, agentId, current.ownerAgentId, kind);
        if (
            current.ownerAgentId !== proof.after.ownerAgentId ||
            current.repositoryRef !== proof.after.repositoryRef
        ) {
            throw new Error("Project operation receipt has a different authoritative identity.");
        }
        if (kind === "archive") assertProjectArchiveState(current);
        const result = {
            ...receiptResult,
            project: structuredClone(current),
        } as ProjectCreateResult | ProjectRenameResult | ProjectArchiveResult;
        return { result };
    }

    async #replayEnsure(
        ctx: Context,
        agentId: string,
        operation: ProjectOperation,
        receipt: ProjectOperationReceipt,
    ): Promise<ProjectChange> {
        const receiptResult = this.#assertReceiptResult(
            receipt,
            operation,
            "ensure",
        ) as ProjectEnsureResult;
        const proof = await this.#readProof(ctx, agentId, operation);
        if (proof === undefined) {
            throw new Error("Project ensure receipt has no immutable proof.");
        }
        if (
            proof.changed !== receiptResult.changed ||
            proof.subjectId !== receiptResult.project.id ||
            !sameJson(proof.result, receiptResult) ||
            receiptResult.changed !== receiptResult.created ||
            proof.after === null ||
            proof.after.id !== receiptResult.project.id ||
            !sameJson(proof.after, receiptResult.project) ||
            proof.after.repositoryRef !== receiptResult.project.repositoryRef ||
            proof.changed !== !sameJson(proof.before, proof.after)
        ) {
            throw new Error("Project ensure receipt and immutable proof disagree.");
        }
        assertProjectEnsureReplayTransition(
            proof.before,
            proof.after,
            receiptResult.created,
            receiptResult.changed,
        );
        const current = await this.#getRequired(ctx, agentId, receiptResult.project.id);
        await this.#authorize(ctx, agentId, current.ownerAgentId, "ensure");
        if (
            current.ownerAgentId !== proof.after.ownerAgentId ||
            current.repositoryRef !== proof.after.repositoryRef
        ) {
            throw new Error("Project ensure receipt has a different authoritative repository.");
        }
        return {
            result: {
                ...receiptResult,
                project: structuredClone(current),
            },
        };
    }

    async #replaySettingsMutation(
        ctx: Context,
        agentId: string,
        operation: ProjectOperation,
        receipt: ProjectOperationReceipt,
        projectId: string,
    ): Promise<ProjectChange> {
        const receiptResult = this.#assertReceiptResult(
            receipt,
            operation,
            "update_settings",
        ) as ProjectSettingsUpdateResult;
        const proof = await this.#readProof(ctx, agentId, operation);
        if (
            proof === undefined ||
            proof.subjectId !== projectId ||
            receiptResult.projectId !== projectId ||
            proof.changed !== receiptResult.changed ||
            !sameJson(proof.result, receiptResult) ||
            proof.before === null ||
            proof.after === null ||
            proof.settingsAfter === undefined ||
            proof.settingsAfter === null ||
            proof.settingsBefore === undefined ||
            proof.settingsBefore === null ||
            !sameJson(proof.settingsAfter, receiptResult.settings)
        ) {
            throw new Error("Project settings receipt and immutable proof disagree.");
        }
        if (
            proof.before.id !== projectId ||
            proof.after.id !== projectId ||
            proof.changed !== !sameJson(proof.settingsBefore, proof.settingsAfter) ||
            (!proof.changed && !sameJson(proof.before, proof.after))
        ) {
            throw new Error("Project settings receipt and immutable proof disagree.");
        }
        assertProjectSettingsTransition(proof.before, proof.after);
        const currentProject = await this.#getRequired(ctx, agentId, projectId);
        await this.#authorize(ctx, agentId, currentProject.ownerAgentId, "settings_update");
        if (
            currentProject.ownerAgentId !== proof.after.ownerAgentId ||
            currentProject.repositoryRef !== proof.after.repositoryRef
        ) {
            throw new Error("Project settings receipt has a different authoritative identity.");
        }
        const currentSettings = await this.#readSettingsInTransaction(ctx, agentId, projectId);
        return {
            result: {
                ...receiptResult,
                settings: structuredClone(currentSettings),
            },
        };
    }

    #proof(
        operation: ProjectOperation,
        agentId: string,
        subjectId: string,
        before: Project | undefined,
        after: Project | undefined,
        result: ProjectStoreMutationResult,
        settingsBefore?: ProjectSettings,
        settingsAfter?: ProjectSettings,
    ): ProjectMutationProof {
        const proof: ProjectMutationProof = {
            agentId,
            operation: operation.kind,
            operationId: operation.operationId,
            fingerprint: operation.fingerprint,
            subjectId,
            before: before === undefined ? null : structuredClone(before),
            after: after === undefined ? null : structuredClone(after),
            ...(settingsBefore === undefined
                ? {}
                : { settingsBefore: structuredClone(settingsBefore) }),
            ...(settingsAfter === undefined
                ? {}
                : { settingsAfter: structuredClone(settingsAfter) }),
            changed: result.changed,
            result: structuredClone(result),
        };
        assertProjectMutationProof(proof);
        return deepFreeze(proof);
    }

    async #newEvent(
        ctx: Context,
        agentId: string,
        payload:
            | {
                  readonly type: "project_created";
                  readonly agentId: string;
                  readonly project: Project;
              }
            | {
                  readonly type: "project_renamed";
                  readonly agentId: string;
                  readonly project: Project;
                  readonly previousName: string;
              }
            | {
                  readonly type: "project_archived";
                  readonly agentId: string;
                  readonly project: Project;
              }
            | {
                  readonly type: "project_settings_updated";
                  readonly agentId: string;
                  readonly projectId: string;
                  readonly settings: ProjectSettings;
              },
    ): Promise<ProjectEvent> {
        const rawId = this.#eventIdFactory(ctx, agentId);
        const eventId = isPromiseLike(rawId) ? await rawId : rawId;
        if (!Value.Check(projectEventIdSchema, eventId)) {
            throw new Error("Project event ID factory returned an invalid ID.");
        }
        const at = this.#clock(ctx, agentId);
        if (!Value.Check(projectTimestampSchema, at)) {
            throw new Error("Project clock must return a non-negative integer.");
        }
        const event = { ...payload, eventId, at };
        if (!Value.Check(projectEventSchema, event)) {
            throw new Error("Project feature created an invalid event.");
        }
        return deepFreeze(structuredClone(event)) as ProjectEvent;
    }

    async #observe(ctx: Context, event: ProjectEvent): Promise<void> {
        if (!Value.Check(projectEventSchema, event) || !isDeepFrozen(event)) {
            throw new Error("Project feature created an invalid unfrozen event.");
        }
        const transactional = this.#listener?.onEventTransactional;
        if (transactional !== undefined) {
            await transactional.call(this.#listener, ctx, event);
        }
        const registration = this.#store.afterCommit.call(
            this.#store,
            ctx,
            event.agentId,
            (postCommitCtx) => this.#notifyPostCommit(postCommitCtx, event),
        );
        if (registration !== undefined) {
            throw new Error("Project store afterCommit must register synchronously.");
        }
    }

    async #notifyPostCommit(ctx: Context, event: ProjectEvent): Promise<void> {
        const listener = this.#listener?.onEvent;
        if (listener !== undefined) {
            await this.#notifyObserver(ctx, event, () => listener.call(this.#listener, ctx, event));
        }
    }

    async #notifyObserver(
        ctx: Context,
        event: ProjectEvent,
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

    async #getOptional(
        ctx: Context,
        agentId: string,
        projectId: string,
    ): Promise<Project | undefined> {
        const raw = await requirePromise(
            this.#store.get(ctx, agentId, projectId),
            "Project store get",
        );
        if (raw === undefined) return undefined;
        assertProject(raw);
        assertProjectRecord(raw);
        if (raw.id !== projectId) {
            throw new Error("Project store returned a different project identity.");
        }
        return structuredClone(raw);
    }

    async #getRequired(ctx: Context, agentId: string, projectId: string): Promise<Project> {
        const project = await this.#getOptional(ctx, agentId, projectId);
        if (project === undefined) throw new Error(`Project "${projectId}" was not found.`);
        return project;
    }

    async #findByRepositoryRef(
        ctx: Context,
        agentId: string,
        repositoryRef: string,
    ): Promise<Project | undefined> {
        const raw = await requirePromise(
            this.#store.findByRepositoryRef(ctx, agentId, repositoryRef),
            "Project store find by repository reference",
        );
        if (raw === undefined) return undefined;
        assertProject(raw);
        assertProjectRecord(raw);
        if (raw.repositoryRef !== repositoryRef) {
            throw new Error("Project store returned a different repository reference.");
        }
        return structuredClone(raw);
    }

    async #readSettingsInTransaction(
        ctx: Context,
        agentId: string,
        projectId: string,
    ): Promise<ProjectSettings> {
        const raw = await requirePromise(
            this.#store.readSettings(ctx, agentId, projectId),
            "Project store read settings",
        );
        assertProjectSettings(raw);
        return structuredClone(raw);
    }

    async #authorize(
        ctx: Context,
        actingAgentId: string,
        ownerAgentId: string,
        action: ProjectAuthorizationAction,
    ): Promise<void> {
        if (actingAgentId === ownerAgentId) return;
        const authorization = this.#authorization;
        if (authorization === undefined) {
            throw new Error(
                `Agent "${actingAgentId}" is not authorized to ${action} project data owned by "${ownerAgentId}".`,
            );
        }
        const raw = authorization(ctx, actingAgentId, ownerAgentId, action);
        const allowed = isPromiseLike(raw) ? await raw : raw;
        if (typeof allowed !== "boolean") {
            throw new Error("Project authorization returned an invalid result.");
        }
        if (!allowed) {
            throw new Error(
                `Agent "${actingAgentId}" is not authorized to ${action} project data owned by "${ownerAgentId}".`,
            );
        }
    }

    #assertAgentId(agentId: string): void {
        if (!Value.Check(projectAgentIdSchema, agentId)) {
            throw new Error("Project agent ID is invalid.");
        }
    }

    #assertId(projectId: string): void {
        if (!Value.Check(projectIdSchema, projectId)) {
            throw new Error("Project ID is invalid.");
        }
    }

    #assertInput<T>(schema: TSchema, value: unknown, label: string): asserts value is T {
        if (!Value.Check(schema, value)) {
            throw new Error(`Project ${label} input is invalid.`);
        }
    }

    #assertPage(page: ProjectPage, cursor: string | undefined, limit: number): void {
        if (page.projects.length > limit) {
            throw new Error("Project store returned more records than requested.");
        }
        for (let index = 1; index < page.projects.length; index += 1) {
            const previous = page.projects[index - 1]!;
            const current = page.projects[index]!;
            if (current.id <= previous.id) {
                throw new Error(
                    "Project page identities must be unique and ordered by ascending ID.",
                );
            }
        }
        if (page.nextCursor === undefined) return;
        if (page.projects.length === 0) {
            throw new Error("Project page cannot advance an empty page.");
        }
        const start = cursor === undefined ? 0 : parseCursor(cursor);
        const next = parseCursor(page.nextCursor);
        if (next !== start + page.projects.length) {
            throw new Error("Project page cursor must advance exactly by visible records.");
        }
    }

    #assertMutationIdentity(
        result:
            | ProjectCreateResult
            | ProjectEnsureResult
            | ProjectRenameResult
            | ProjectArchiveResult
            | ProjectSettingsUpdateResult,
        operation: ProjectOperation,
        agentId: string,
        kind: ProjectMutationOperation,
    ): void {
        if (
            result.agentId !== agentId ||
            result.operation !== kind ||
            result.operationId !== operation.operationId ||
            result.fingerprint !== operation.fingerprint
        ) {
            throw new Error("Project mutation result identity does not match the request.");
        }
    }

    #assertCreatedProject(project: Project, request: ProjectStoreCreateInput): void {
        assertProject(project);
        assertProjectRecord(project);
        if (
            project.id !== request.id ||
            project.ownerAgentId !== request.ownerAgentId ||
            project.repositoryRef !== request.repositoryRef ||
            project.name !== request.name ||
            project.description !== request.description ||
            project.status !== "active" ||
            project.archivedAt !== undefined ||
            project.createdAt !== project.updatedAt
        ) {
            throw new Error("Project create result does not match the requested created state.");
        }
    }

    #assertEnsureProject(
        project: Project,
        request: ProjectStoreEnsureInput,
        created: boolean,
    ): void {
        assertProject(project);
        if (project.repositoryRef !== request.repositoryRef) {
            throw new Error("Project ensure result does not match the requested repository.");
        }
        if (!created) return;
        assertProjectRecord(project);
        if (
            project.ownerAgentId !== request.ownerAgentId ||
            project.id !== request.id ||
            (request.name !== undefined && project.name !== request.name) ||
            project.description !== request.description ||
            project.status !== "active" ||
            project.archivedAt !== undefined ||
            project.createdAt !== project.updatedAt
        ) {
            throw new Error("Project ensure result does not match the requested created state.");
        }
    }

    #assertReceiptIdentity(
        receipt: ProjectOperationReceipt,
        operation: ProjectOperation,
        agentId: string,
    ): void {
        if (
            receipt.agentId !== agentId ||
            receipt.operation !== operation.kind ||
            receipt.operationId !== operation.operationId ||
            receipt.fingerprint !== operation.fingerprint
        ) {
            throw new Error("Project operation identity was reused with different input.");
        }
        assertProjectStoreMutationResult(receipt.result);
        assertProjectMutationResultSemantics(receipt.result);
        if (
            receipt.result.agentId !== agentId ||
            receipt.result.operation !== operation.kind ||
            receipt.result.operationId !== operation.operationId ||
            receipt.result.fingerprint !== operation.fingerprint
        ) {
            throw new Error("Project receipt result belongs to another agent.");
        }
    }

    #assertProofIdentity(
        proof: ProjectMutationProof,
        operation: ProjectOperation,
        agentId: string,
    ): void {
        if (
            proof.agentId !== agentId ||
            proof.operation !== operation.kind ||
            proof.operationId !== operation.operationId ||
            proof.fingerprint !== operation.fingerprint
        ) {
            throw new Error("Project immutable proof has a different operation identity.");
        }
        assertProjectStoreMutationResult(proof.result);
        assertProjectMutationResultSemantics(proof.result);
        if (
            proof.result.agentId !== agentId ||
            proof.result.operation !== operation.kind ||
            proof.result.operationId !== operation.operationId ||
            proof.result.fingerprint !== operation.fingerprint
        ) {
            throw new Error("Project immutable proof belongs to another agent.");
        }
    }

    #assertReceiptResult(
        receipt: ProjectOperationReceipt,
        operation: ProjectOperation,
        kind: ProjectMutationOperation,
    ): ProjectStoreMutationResult {
        this.#assertReceiptIdentity(receipt, operation, receipt.agentId);
        if (receipt.result.operation !== kind) {
            throw new Error("Project operation receipt has the wrong mutation kind.");
        }
        return receipt.result;
    }

    #receiptProjectId(receipt: ProjectOperationReceipt): string {
        if ("project" in receipt.result) return receipt.result.project.id;
        return receipt.result.projectId;
    }
}

export function assertProjectFeatureOptions(
    value: unknown,
): asserts value is ProjectFeatureOptions {
    if (!Value.Check(projectFeatureOptionsSchema, value)) {
        throw new Error("Project feature options are invalid.");
    }
}

export function assertProjectSettings(value: unknown): asserts value is ProjectSettings {
    if (!Value.Check(projectSettingsSchema, value) || !validProjectSettings(value)) {
        throw new Error("Project settings are invalid or exceed their bounds.");
    }
    const encoded = canonicalJson(value);
    if (Buffer.byteLength(encoded, "utf8") > MAX_PROJECT_SETTINGS_ENCODED_BYTES) {
        throw new Error("Project settings exceed their encoded-byte bound.");
    }
}

function validProjectSettings(value: unknown, depth = 0): boolean {
    if (depth > MAX_PROJECT_SETTINGS_DEPTH) return false;
    if (value === null || typeof value === "boolean") return true;
    if (typeof value === "number") {
        return Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER;
    }
    if (typeof value === "string") return value.length <= 4_096;
    if (Array.isArray(value)) {
        return value.length <= 64 && value.every((entry) => validProjectSettings(entry, depth + 1));
    }
    if (typeof value === "object") {
        if (!isPlainJsonObject(value)) return false;
        const entries = Object.entries(value as Record<string, unknown>);
        return (
            entries.length <= 64 &&
            entries.every(
                ([key, entry]) => key.length <= 128 && validProjectSettings(entry, depth + 1),
            )
        );
    }
    return false;
}

function assertProjectSettingsPage(value: unknown): asserts value is ProjectSettingsPage {
    if (!Value.Check(projectSettingsPageSchema, value)) {
        throw new Error("Project settings page is invalid.");
    }
    assertProjectSettings(value.settings);
    if (value.detailTotal > MAX_PROJECT_SETTINGS_DETAIL_CHARACTERS) {
        throw new Error("Project settings detail exceeds its bounded traversal length.");
    }
    if (value.detailOffset + value.detail.length > value.detailTotal) {
        throw new Error("Project settings detail page exceeds its total.");
    }
    if (
        value.nextDetailOffset !== undefined &&
        value.nextDetailOffset !== value.detailOffset + value.detail.length
    ) {
        throw new Error("Project settings detail cursor does not advance by visible characters.");
    }
}

function assertProjectRecord(project: Project): void {
    if (project.updatedAt < project.createdAt) {
        throw new Error("Project timestamps are not ordered.");
    }
    if (project.status === "archived") {
        if (project.archivedAt === undefined) {
            throw new Error("Archived project is missing archivedAt.");
        }
        if (project.archivedAt < project.createdAt || project.archivedAt > project.updatedAt) {
            throw new Error("Project archivedAt is inconsistent with its timestamps.");
        }
    } else if (project.archivedAt !== undefined) {
        throw new Error("Active project has archivedAt.");
    }
}

function assertProjectMutationResultSemantics(result: ProjectStoreMutationResult): void {
    if ("project" in result) assertProjectRecord(result.project);
    if ("settings" in result) assertProjectSettings(result.settings);
}

function assertProjectArchiveState(project: Project): void {
    assertProjectRecord(project);
    if (project.status !== "archived" || project.archivedAt === undefined) {
        throw new Error("Project archive authoritative state is not archived.");
    }
}

function assertProjectRenameTransition(
    before: Project,
    after: Project,
    requestedName: string,
): void {
    if (after.id !== before.id || after.ownerAgentId !== before.ownerAgentId) {
        throw new Error("Project rename changed durable identity or ownership.");
    }
    if (
        after.repositoryRef !== before.repositoryRef ||
        after.status !== before.status ||
        after.createdAt !== before.createdAt ||
        after.archivedAt !== before.archivedAt ||
        after.description !== before.description ||
        after.name !== requestedName
    ) {
        throw new Error("Project rename changed fields outside the requested transition.");
    }
    if (after.name === before.name) {
        if (!sameJson(before, after)) {
            throw new Error("Project rename changed an unchanged name.");
        }
    } else if (after.updatedAt <= before.updatedAt) {
        throw new Error("Project rename must advance updatedAt for a name change.");
    }
}

function assertProjectArchiveTransition(before: Project, after: Project): void {
    assertProjectArchiveState(after);
    if (before.id !== after.id || before.ownerAgentId !== after.ownerAgentId) {
        throw new Error("Project archive changed durable identity or ownership.");
    }
    if (before.status === "archived") {
        if (!sameJson(before, after)) {
            throw new Error("Project archive changed an already archived project.");
        }
        return;
    }
    if (
        before.repositoryRef !== after.repositoryRef ||
        before.name !== after.name ||
        before.description !== after.description ||
        before.createdAt !== after.createdAt
    ) {
        throw new Error("Project archive changed fields outside the archival transition.");
    }
    if (after.archivedAt === undefined || after.archivedAt < before.updatedAt) {
        throw new Error("Project archive archivedAt is inconsistent with the transition.");
    }
}

function assertProjectSettingsTransition(before: Project, after: Project): void {
    if (
        before.id !== after.id ||
        before.ownerAgentId !== after.ownerAgentId ||
        before.repositoryRef !== after.repositoryRef ||
        before.name !== after.name ||
        before.description !== after.description ||
        before.status !== after.status ||
        before.createdAt !== after.createdAt ||
        before.archivedAt !== after.archivedAt
    ) {
        throw new Error("Project settings changed fields outside the settings transition.");
    }
    if (after.updatedAt < before.updatedAt) {
        throw new Error("Project settings moved updatedAt backwards.");
    }
}

function assertProjectCatalogReplayTransition(
    kind: "create" | "rename" | "archive",
    before: Project | null,
    after: Project,
    changed: boolean,
): void {
    if (changed !== !sameJson(before, after)) {
        throw new Error("Project replay proof changed flag is not authoritative.");
    }
    if (kind === "create") {
        if (changed) {
            if (before !== null) {
                throw new Error("Project create replay proof has a before-state.");
            }
        } else if (before === null || !sameJson(before, after)) {
            throw new Error("Project create replay proof has an invalid no-op state.");
        }
        return;
    }
    if (before === null) {
        throw new Error("Project replay proof is missing its subject before-state.");
    }
    if (kind === "rename") {
        assertProjectRenameTransition(before, after, after.name);
        return;
    }
    assertProjectArchiveTransition(before, after);
}

function assertProjectEnsureReplayTransition(
    before: Project | null,
    after: Project,
    created: boolean,
    changed: boolean,
): void {
    if (created !== (before === null) || changed !== !sameJson(before, after)) {
        throw new Error("Project ensure replay proof flags are not authoritative.");
    }
    if (created) {
        if (!changed || before !== null) {
            throw new Error("Project ensure creation proof has an invalid before-state.");
        }
        return;
    }
    if (before === null || changed || !sameJson(before, after)) {
        throw new Error("Project ensure existing proof has a changed state.");
    }
}

function operationFingerprint(
    kind: ProjectMutationOperation,
    agentId: string,
    request: unknown,
): ProjectOperationFingerprint {
    const canonical = canonicalJson({ agentId, kind, request });
    const digest = createHash("sha256").update(canonical, "utf8").digest("hex");
    if (!Value.Check(projectOperationFingerprintSchema, digest)) {
        throw new Error("Project operation fingerprint is invalid.");
    }
    return digest;
}

function toMutationRequest(operation: ProjectOperation): ProjectMutationRequest {
    return {
        operation: operation.kind,
        operationId: operation.operationId,
        fingerprint: operation.fingerprint,
    };
}

function sameCreate(project: Project, request: ProjectStoreCreateInput): boolean {
    return (
        project.id === request.id &&
        project.ownerAgentId === request.ownerAgentId &&
        project.repositoryRef === request.repositoryRef &&
        project.name === request.name &&
        (request.description === undefined || project.description === request.description)
    );
}

function requireProjectFromResult(result: ProjectStoreMutationResult): Project {
    if (!("project" in result)) {
        throw new Error("Project mutation did not return a project.");
    }
    assertProject(result.project);
    return result.project;
}

function fitPageForModel(
    page: ProjectPage,
    cursor: string | undefined,
    maxOutputCharacters: number,
): ProjectPage {
    if (page.projects.length === 0) return page;
    const start = cursor === undefined ? 0 : parseCursor(cursor);
    const visible: Project[] = [];
    let size = 0;
    for (const project of page.projects) {
        const row = projectRow(project);
        const nextSize = size + row.length + (visible.length === 0 ? 0 : 1);
        const candidateCount = visible.length + 1;
        const needsContinuation =
            page.nextCursor !== undefined || candidateCount < page.projects.length;
        const continuation = needsContinuation
            ? `More projects at cursor ${String(start + candidateCount)}.`.length + 1
            : 0;
        if (nextSize + continuation > maxOutputCharacters) break;
        visible.push(project);
        size = nextSize;
    }
    if (visible.length === 0) {
        throw new Error("Project page cannot expose a complete identity within the output budget.");
    }
    const consumedAll = visible.length === page.projects.length;
    const nextCursor =
        consumedAll && page.nextCursor === undefined ? undefined : String(start + visible.length);
    return {
        projects: visible,
        ...(nextCursor === undefined ? {} : { nextCursor }),
    };
}

function projectRow(project: Project): string {
    const full = [
        `Project ID: ${project.id}`,
        `Name: ${project.name}`,
        `Repository ref: ${project.repositoryRef}`,
        `Status: ${project.status}`,
        ...(project.description === undefined ? [] : [`Description: ${project.description}`]),
        `Created: ${String(project.createdAt)}`,
        `Updated: ${String(project.updatedAt)}`,
        ...(project.archivedAt === undefined ? [] : [`Archived: ${String(project.archivedAt)}`]),
    ].join(" | ");
    if (full.length <= 360) return full;
    const compact = `${project.id} [${project.status}] ${project.name}`;
    if (compact.length <= 220) return compact;
    return `${project.id} [${project.status}]`;
}

function projectDetailText(project: Project): string {
    return [
        `Project ID: ${project.id}`,
        `Name: ${project.name}`,
        `Repository ref: ${project.repositoryRef}`,
        `Status: ${project.status}`,
        `Owner agent: ${project.ownerAgentId}`,
        ...(project.description === undefined ? [] : [`Description: ${project.description}`]),
        `Created at: ${String(project.createdAt)}`,
        `Updated at: ${String(project.updatedAt)}`,
        ...(project.archivedAt === undefined ? [] : [`Archived at: ${String(project.archivedAt)}`]),
    ].join("\n");
}

function fitProjectDetailPage(
    page: Extract<ProjectDetailPage, { readonly project: Project }>,
    maxOutputCharacters: number,
): Extract<ProjectDetailPage, { readonly project: Project }> {
    let detail = page.detail;
    for (;;) {
        const candidate: Extract<ProjectDetailPage, { readonly project: Project }> = {
            project: page.project,
            detail,
            detailOffset: page.detailOffset,
            detailTotal: page.detailTotal,
            ...(page.detailOffset + detail.length < page.detailTotal
                ? { nextDetailOffset: page.detailOffset + detail.length }
                : {}),
        };
        if (formatProjectDetailPage(candidate, maxOutputCharacters).length <= maxOutputCharacters) {
            return candidate;
        }
        if (detail.length <= 1) {
            throw new Error("Project detail cannot fit the configured model-output bound.");
        }
        const excess = Math.max(
            1,
            formatProjectDetailPage(candidate, maxOutputCharacters).length - maxOutputCharacters,
        );
        detail = detail.slice(0, Math.max(1, detail.length - excess));
    }
}

function formatProjectDetailPage(
    page: Extract<ProjectDetailPage, { readonly project: Project }>,
    maxOutputCharacters: number,
): string {
    const full = [
        `${page.project.id} [${page.project.status}]`,
        `Detail [${page.detailOffset}/${page.detailTotal}]: ${page.detail}`,
        ...(page.nextDetailOffset === undefined
            ? []
            : [`More detail starts at offset ${page.nextDetailOffset}.`]),
    ].join("\n");
    if (full.length <= maxOutputCharacters) return full;
    const compact = [
        page.project.id,
        `Detail: ${page.detail}`,
        ...(page.nextDetailOffset === undefined ? [] : [`More detail: ${page.nextDetailOffset}.`]),
    ].join("\n");
    if (compact.length <= maxOutputCharacters) return compact;
    const identityOnly = [
        page.project.id,
        `Detail: ${page.detail}`,
        ...(page.nextDetailOffset === undefined ? [] : [`More detail: ${page.nextDetailOffset}.`]),
    ].join("\n");
    if (identityOnly.length <= maxOutputCharacters) return identityOnly;
    return [
        `Detail: ${page.detail}`,
        ...(page.nextDetailOffset === undefined ? [] : [`More detail: ${page.nextDetailOffset}.`]),
    ].join("\n");
}

function fitSettingsPage(
    page: ProjectSettingsPage,
    maxOutputCharacters: number,
): ProjectSettingsPage {
    let detail = page.detail;
    for (;;) {
        const candidate: ProjectSettingsPage = {
            ...page,
            detail,
            ...(page.detailOffset + detail.length < page.detailTotal
                ? { nextDetailOffset: page.detailOffset + detail.length }
                : {}),
        };
        if (formatSettingsPage(candidate, maxOutputCharacters).length <= maxOutputCharacters) {
            return candidate;
        }
        if (detail.length <= 1) {
            throw new Error("Project settings cannot fit the configured model-output bound.");
        }
        const excess = Math.max(
            1,
            formatSettingsPage(candidate, maxOutputCharacters).length - maxOutputCharacters,
        );
        detail = detail.slice(0, Math.max(1, detail.length - excess));
    }
}

function formatSettingsPage(page: ProjectSettingsPage, maxOutputCharacters: number): string {
    const full = [
        `Project ${page.projectId} settings`,
        `Detail [${page.detailOffset}/${page.detailTotal}]: ${page.detail}`,
        ...(page.nextDetailOffset === undefined
            ? []
            : [`More settings detail starts at offset ${page.nextDetailOffset}.`]),
    ].join("\n");
    if (full.length <= maxOutputCharacters) return full;
    const compact = [
        page.projectId,
        `Settings: ${page.detail}`,
        ...(page.nextDetailOffset === undefined
            ? []
            : [`More settings: ${page.nextDetailOffset}.`]),
    ].join("\n");
    if (compact.length <= maxOutputCharacters) return compact;
    return [
        `Settings: ${page.detail}`,
        ...(page.nextDetailOffset === undefined
            ? []
            : [`More settings: ${page.nextDetailOffset}.`]),
    ].join("\n");
}

function settingsDetailText(settings: ProjectSettings): string {
    return canonicalJson(settings);
}

function parseCursor(cursor: string): number {
    const value = Number(cursor);
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error("Project cursor is not a bounded integer.");
    }
    return value;
}

function canonicalJson(value: unknown, depth = 0): string {
    if (depth > MAX_PROJECT_SETTINGS_DEPTH) {
        throw new Error("Project value is too deeply nested.");
    }
    let result: string;
    if (value === null) result = "null";
    else if (typeof value === "string") result = JSON.stringify(value);
    else if (typeof value === "number") {
        if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) {
            throw new Error("Project value has an invalid number.");
        }
        result = JSON.stringify(value);
    } else if (typeof value === "boolean") result = value ? "true" : "false";
    else if (Array.isArray(value)) {
        if (value.length > 64) throw new Error("Project array is too large.");
        result = `[${value.map((entry) => canonicalJson(entry, depth + 1)).join(",")}]`;
    } else if (typeof value === "object") {
        if (!isPlainJsonObject(value)) {
            throw new Error("Project value is not a plain JSON object.");
        }
        const entries = Object.entries(value as Record<string, unknown>).filter(
            ([, entry]) => entry !== undefined,
        );
        if (entries.length > 64) throw new Error("Project object has too many properties.");
        result = `{${entries
            .sort(([left], [right]) => compareCodeUnitStrings(left, right))
            .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry, depth + 1)}`)
            .join(",")}}`;
    } else {
        throw new Error("Project value contains an unsupported type.");
    }
    return result;
}

function isPlainJsonObject(value: object): boolean {
    try {
        const prototype = Object.getPrototypeOf(value);
        return prototype === Object.prototype || prototype === null;
    } catch {
        return false;
    }
}

function compareCodeUnitStrings(left: string, right: string): number {
    const length = Math.min(left.length, right.length);
    for (let index = 0; index < length; index += 1) {
        const difference = left.charCodeAt(index) - right.charCodeAt(index);
        if (difference !== 0) return difference;
    }
    return left.length - right.length;
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
    if (!isPromiseLike(value)) throw new Error(`${label} must return a promise.`);
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
        return message.slice(0, 512) || "Unknown project observer error.";
    } catch {
        return "Unknown project observer error.";
    }
}
