import { existsSync } from "node:fs";
import { join } from "node:path";

import {
    withAgentDatabase,
    type AgentDatabase,
    type AgentModule,
    type AgentModuleHooks,
    type AgentModuleScope,
    type AgentSystemRef,
    type AnyAgentTool,
} from "@slopus/happy-agent-base";
import { createId } from "@paralleldrive/cuid2";
import { Value } from "@sinclair/typebox/value";
import {
    afterCommit,
    detach,
    mapAsyncLock,
    type Context,
    type MapAsyncLock,
    type RootContext,
} from "@steve.kite/stdlib";

import { AbortModule } from "../abort/index.js";
import { ConfigModule } from "../config/index.js";
import { GitModule, type GitCredentialRef, type GitRepositoryFacts } from "../git/index.js";
import { ProjectRegistrationError, ProjectsModule, type Project } from "../projects/index.js";

import { WorkspaceLifecycleError } from "./WorkspaceLifecycleError.js";

import { copyProjectFolder } from "./impl/copyProjectFolder.js";

import {
    loadWorkspaceFolderSettings,
    type WorkspaceFolderSettings,
} from "./impl/loadWorkspaceFolderSettings.js";
import { removeWorkspaceDirectory } from "./impl/removeWorkspaceDirectory.js";
import { runWorkspaceSetupCommands } from "./impl/runWorkspaceSetupCommands.js";
import { syncWorkspaceFiles } from "./impl/syncWorkspaceFiles.js";
import { watchWorkspaceSyncPaths } from "./impl/watchWorkspaceSyncPaths.js";
import { withPreservedNumericPrefix } from "./impl/withPreservedNumericPrefix.js";
import {
    gitBranchExists,
    workspaceGitRefSnapshot,
    workspaceStorageKeyExists,
} from "./impl/workspaceGitRefSnapshot.js";
import {
    createWorkspaceRequestSchema,
    type CreateWorkspaceRequest,
    workspaceCreatorOptionsSchema,
    type WorkspaceCreatorOptions,
} from "./WorkspaceProvisioning.js";
import {
    workspaceAgentAttachmentSchema,
    workspaceAgentLookupSchema,
    workspaceAgentReorderInputSchema,
    type WorkspaceAgentAssociation,
    type WorkspaceAgentAttachment,
    type WorkspaceAgentOrder,
    type WorkspaceAgentReorderInput,
} from "./WorkspaceAgent.js";
import {
    workspaceApplyGitFactsInputSchema,
    workspaceApplyProbeInputSchema,
    workspaceArchiveOptionsSchema,
    workspaceChildrenQuerySchema,
    workspaceIdSchema,
    workspaceInheritNameInputSchema,
    workspaceMarkFailedInputSchema,
    workspaceMarkReadyInputSchema,
    workspaceOperationIdSchema,
    workspaceRecordInitializationInputSchema,
    workspaceRenameInputSchema,
    workspaceReorderInputSchema,
    workspaceReserveHooksSchema,
    workspaceReserveInputSchema,
    workspaceSetBranchInputSchema,
    workspaceSchema,
    type Workspace,
    type WorkspaceApplyGitFactsInput,
    type WorkspaceApplyProbeInput,
    type WorkspaceArchiveOptions,
    type WorkspaceChildrenQuery,
    type WorkspaceInheritNameInput,
    type WorkspaceMarkFailedInput,
    type WorkspaceMarkReadyInput,
    type WorkspaceMutationOperation,
    type WorkspaceRecordInitializationInput,
    type WorkspaceRenameInput,
    type WorkspaceReorderInput,
    type WorkspaceReserveHooks,
    type WorkspaceReserveInput,
    type WorkspaceSetBranchInput,
} from "./Workspace.js";
import { assertWorkspaceRecord } from "./WorkspaceRecord.js";
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
import { type WorkspaceEventListener, type WorkspaceUnsubscribe } from "./WorkspaceEvent.js";
import {
    firstBranchMetadataPage,
    firstWorkspaceDetailPage,
    fitPageForModel,
    fitWorkspaceBranchMetadataPage,
    fitWorkspaceDetailPage,
    formatWorkspaceBranchMetadataPage,
    formatWorkspaceDetailPage,
    workspaceBranchMetadataDetailText,
    workspaceDetailText,
    workspaceRow,
} from "./WorkspaceFormat.js";
import { WorkspaceMutations, type WorkspaceEventPayload } from "./WorkspaceMutations.js";
import {
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
    assertWorkspace,
    assertWorkspaceBranchMetadata,
    assertWorkspaceList,
    assertWorkspacePage,
    createWorkspaceStore,
    workspaceMigrations,
    type WorkspaceMutationRequest,
    type WorkspaceMutationResult,
    type WorkspaceStore,
} from "./WorkspaceStore.js";
import { requirePromise } from "./workspaceRuntime.js";
import { archiveWorkspaceTool } from "./tools/archive_workspace.js";
import { createChildWorkspaceTool } from "./tools/create_child_workspace.js";
import { createWorkspaceTool } from "./tools/create_workspace.js";
import { getBranchMetadataTool } from "./tools/get_branch_metadata.js";
import { getWorkspaceTool } from "./tools/get_workspace.js";
import { listWorkspacesTool } from "./tools/list_workspaces.js";
import { renameWorkspaceTool } from "./tools/rename_workspace.js";
import {
    insertWorkspaceAgent,
    readWorkspaceAgent,
    readWorkspaceAgents,
    updateWorkspaceAgentOrder,
} from "./store/workspaceAgents.js";
import { orderKeyBetween } from "./store/workspaceOrdering.js";
import {
    readWorkspaceAncestorIds,
    readWorkspaceChildren,
    touchWorkspace,
} from "./store/workspaceRecords.js";

/** How many workspaces one page may carry, and how much text a page may spend on them. */
export const WORKSPACE_PAGE_SIZE = 50;
export const MAX_WORKSPACE_OUTPUT_CHARACTERS = 12_000;
/** A stored failure is something a person reads, not a stack trace to keep whole. */
const MAX_ERROR_LENGTH = 500;
/** A burst of file events inside this window becomes a single replication pass. */
const WORKSPACE_SYNC_DEBOUNCE_MS = 300;
/** How many interrupted checkouts are carried forward at once on startup. */
const WORKSPACE_INITIALIZATION_CONCURRENCY = 4;

/** What owns a directory: always a project, and a workspace too when the folder is one. */
export interface ResolvedProjectOwnership {
    readonly project: Project;
    readonly workspace?: Workspace;
}

/** What a reservation produced: the workspace, and whether this call is the one that made it. */
export interface WorkspaceReservation {
    readonly created: boolean;
    readonly workspace: Workspace;
}

export class WorkspacesModule implements AgentModule {
    readonly name = "workspaces";
    readonly migrations = workspaceMigrations;

    readonly #store: WorkspaceStore;
    readonly #mutations: WorkspaceMutations;
    readonly #enabled: boolean;
    readonly #cleanupTasks = new Set<Promise<void>>();
    #agents: AgentSystemRef | undefined;

    // --- The catalog's own Git and filesystem work -------------------------------------------

    readonly #abort: AbortModule;
    readonly #config: ConfigModule;
    readonly #git: GitModule;
    readonly #projects: ProjectsModule;
    readonly #projectFolders = new Map<string, { path: string; storageKey: string }>();
    readonly #setupControllers = new Map<string, AbortController>();
    readonly #syncLocks: MapAsyncLock<string> = mapAsyncLock();
    readonly #syncStops = new Map<string, () => void>();
    readonly #syncTimers = new Map<string, NodeJS.Timeout>();
    readonly #tasks = new Set<Promise<void>>();
    readonly #workspaceLocks: MapAsyncLock<string> = mapAsyncLock();
    /** Agent and owner locks serialize permanent attachment and ordering changes. */
    readonly #agentAssociationLocks: MapAsyncLock<string> = mapAsyncLock();
    readonly #workspacesDirectory: string;

    #closed = false;
    #lifetime: RootContext | undefined;
    #storage: AgentDatabase | undefined;

    /**
     * @param config Where workspace folders live and what a folder does when it says nothing itself.
     * @param projects The catalog these workspaces are cut from: a workspace is a branch of a
     * project's repository, in a folder named after it, so the projects catalog owns the folder,
     * the credential, and the repository lock every Git call here goes through.
     * @param git Git itself.
     * @param abort How work standing in a workspace is stopped. Archiving is the moment a folder
     * stops being anybody's, so the decision cancels the agents working in it rather than leaving
     * them running in a checkout that is about to be deleted.
     */
    constructor(
        config: ConfigModule,
        projects: ProjectsModule,
        git: GitModule,
        abort: AbortModule,
    ) {
        this.#abort = abort;
        this.#config = config;
        this.#git = git;
        this.#projects = projects;
        this.#enabled = config.configuration.values.features.workspaces;
        this.#workspacesDirectory = git.normalizeFuturePath(config.workspacesHome);
        this.#store = createWorkspaceStore(this);
        this.#mutations = new WorkspaceMutations(this.#store);

        // Archiving a project archives everything cut from it. The decision belongs to the
        // projects catalog, so this catalog listens for it inside that transaction rather than
        // asking the projects catalog to know about workspaces.
        projects.onEventTransactional(async (txCtx, event) => {
            if (event.type !== "project_archived") return;
            await this.#archiveProjectWorkspaces(txCtx, event.project.id);
        });
    }

    /** Takes a subscriber that runs inside the transaction the change commits in. */
    onEventTransactional(listener: WorkspaceEventListener): WorkspaceUnsubscribe {
        return this.#mutations.onEventTransactional(listener);
    }

    /** Takes a subscriber that runs once the change is durable. */
    onEvent(listener: WorkspaceEventListener): WorkspaceUnsubscribe {
        return this.#mutations.onEvent(listener);
    }

    readonly #hooks: AgentModuleHooks = {
        tools: async (ctx: Context, scope: AgentModuleScope): Promise<readonly AnyAgentTool[]> => {
            if (!this.#enabled) return [];
            const agents = this.#agents;
            if (agents === undefined) {
                throw new Error("The workspaces module was asked for tools before it started.");
            }
            // Workspaces belong to the conversation a person is having. A subagent is one pair of
            // hands inside the task it was given, and stays in the workspace it was started in.
            if ((await agents.parentOf(ctx, scope.agent.id)) !== null) return [];
            return [
                createChildWorkspaceTool(this, scope.agent.id),
                createWorkspaceTool(this, scope.agent.id),
                listWorkspacesTool(this, scope.agent.id),
                getWorkspaceTool(this, scope.agent.id),
                renameWorkspaceTool(this, scope.agent.id),
                archiveWorkspaceTool(this, scope.agent.id),
                getBranchMetadataTool(this, scope.agent.id),
            ];
        },
    };

    readonly beforeStart = (ctx: Context, agents: AgentSystemRef): AgentModuleHooks => {
        this.#agents = agents;
        // The earliest root context the catalog is given, and the one its background work should
        // run on. Taking it here rather than from the first caller keeps a transactional tool from
        // pinning its own transaction facade as the catalog's database.
        this.#pinBackgroundRoot(ctx);
        return this.#hooks;
    };

    /**
     * Reserves one workspace: a name, folder key, and branch nothing else has taken, recorded
     * before any Git or filesystem work begins.
     *
     * A tool call that is retried after a crash arrives with the same `operationId`, and that ID
     * is the workspace's identity when the caller did not choose one. Two attempts at one create
     * therefore converge on one row rather than producing a second workspace that nobody asked for.
     */
    async reserve(
        ctx: Context,
        input: WorkspaceReserveInput,
        hooks: WorkspaceReserveHooks = {},
    ): Promise<WorkspaceReservation> {
        this.#assertEnabled();
        this.#assertInput(workspaceReserveInputSchema, input, "workspace reservation");
        if (!Value.Check(workspaceReserveHooksSchema, hooks)) {
            throw new Error("Workspace reservation hooks are invalid.");
        }
        const normalized = structuredClone(input);
        const workspaceId =
            normalized.id ?? normalized.operationId ?? this.#newIdentity(workspaceIdSchema);
        const result = await this.#mutateResult(
            ctx,
            "reserve",
            normalized.operationId,
            workspaceId,
            async (txCtx, request) =>
                await this.#store.reserve(
                    txCtx,
                    {
                        id: workspaceId,
                        projectRef: normalized.projectRef,
                        parentId: normalized.parentId ?? normalized.projectRef,
                        name: normalized.name,
                        nameConfigured: normalized.nameConfigured ?? false,
                        kind: normalized.kind ?? "git_worktree",
                        ...(normalized.baseRef === undefined
                            ? {}
                            : { baseRef: normalized.baseRef }),
                        ...(normalized.baseCommit === undefined
                            ? {}
                            : { baseCommit: normalized.baseCommit }),
                        ...(normalized.gitCommonDir === undefined
                            ? {}
                            : { gitCommonDir: normalized.gitCommonDir }),
                        ...(normalized.creatorSessionId === undefined
                            ? {}
                            : { creatorSessionId: normalized.creatorSessionId }),
                        ...(normalized.storageKeySeed === undefined
                            ? {}
                            : { storageKeySeed: normalized.storageKeySeed }),
                    },
                    hooks,
                    request,
                ),
            (before, after) =>
                before === undefined ? { type: "workspace_created", workspace: after } : undefined,
        );
        return { created: result.changed, workspace: result.workspace };
    }

    /** Renames a workspace on a person's behalf, and moves its branch with the name. */
    async rename(ctx: Context, input: WorkspaceRenameInput): Promise<Workspace> {
        this.#assertEnabled();
        this.#assertInput(workspaceRenameInputSchema, input, "workspace rename");
        const normalized = structuredClone(input);
        let previousBranch: string | undefined;
        const renamed = await this.#mutate(
            ctx,
            "rename",
            normalized.operationId,
            normalized.workspaceId,
            async (txCtx, request) =>
                await this.#store.rename(
                    txCtx,
                    {
                        workspaceId: normalized.workspaceId,
                        name: normalized.name,
                        ...(normalized.expectedVersion === undefined
                            ? {}
                            : { expectedVersion: normalized.expectedVersion }),
                    },
                    request,
                ),
            (before, after) => {
                if (before === undefined || before.name === after.name) return undefined;
                previousBranch = before.branch;
                return {
                    type: "workspace_renamed",
                    workspace: after,
                    previousWorkspace: before,
                    previousName: before.name,
                };
            },
        );
        if (previousBranch === undefined || previousBranch === renamed.branch) return renamed;
        return await this.#moveGitBranch(ctx, renamed, previousBranch);
    }

    /**
     * Gives a workspace the name its first chat arrived at. A workspace someone has already named
     * keeps that name: only a placeholder is replaced.
     */
    async inheritName(ctx: Context, input: WorkspaceInheritNameInput): Promise<Workspace> {
        this.#assertEnabled();
        this.#assertInput(workspaceInheritNameInputSchema, input, "workspace name inheritance");
        const normalized = structuredClone(input);
        let previousBranch: string | undefined;
        const named = await this.#mutate(
            ctx,
            "inherit_name",
            normalized.operationId,
            normalized.workspaceId,
            async (txCtx, request) =>
                await this.#store.inheritName(
                    txCtx,
                    { workspaceId: normalized.workspaceId, name: normalized.name },
                    request,
                ),
            (before, after) => {
                if (before === undefined || before.name === after.name) return undefined;
                previousBranch = before.branch;
                return {
                    type: "workspace_renamed",
                    workspace: after,
                    previousWorkspace: before,
                    previousName: before.name,
                };
            },
        );
        if (previousBranch === undefined || previousBranch === named.branch) return named;
        return await this.#moveGitBranch(ctx, named, previousBranch);
    }

    /** Records the branch a host actually created or renamed to. */
    async setBranch(ctx: Context, input: WorkspaceSetBranchInput): Promise<Workspace> {
        this.#assertEnabled();
        this.#assertInput(workspaceSetBranchInputSchema, input, "workspace branch");
        const normalized = structuredClone(input);
        return await this.#mutate(
            ctx,
            "set_branch",
            normalized.operationId,
            normalized.workspaceId,
            async (txCtx, request) =>
                await this.#store.setBranch(
                    txCtx,
                    { workspaceId: normalized.workspaceId, branch: normalized.branch },
                    request,
                ),
            (before, after) => ({
                type: "workspace_updated",
                change: "set_branch",
                workspace: after,
                previousWorkspace: requirePreviousWorkspace(before),
            }),
        );
    }

    /** Records the base commit, base ref, and shared Git directory the host resolved. */
    async recordInitialization(
        ctx: Context,
        input: WorkspaceRecordInitializationInput,
    ): Promise<Workspace> {
        this.#assertEnabled();
        this.#assertInput(
            workspaceRecordInitializationInputSchema,
            input,
            "workspace initialization",
        );
        const normalized = structuredClone(input);
        return await this.#mutate(
            ctx,
            "record_initialization",
            normalized.operationId,
            normalized.workspaceId,
            async (txCtx, request) =>
                await this.#store.recordInitialization(
                    txCtx,
                    { workspaceId: normalized.workspaceId, facts: normalized.facts },
                    request,
                ),
            (before, after) => ({
                type: "workspace_updated",
                change: "record_initialization",
                workspace: after,
                previousWorkspace: requirePreviousWorkspace(before),
            }),
        );
    }

    /** The workspace is checked out, set up, and ready for someone to work in. */
    async markReady(ctx: Context, input: WorkspaceMarkReadyInput): Promise<Workspace> {
        this.#assertEnabled();
        this.#assertInput(workspaceMarkReadyInputSchema, input, "workspace readiness");
        const normalized = structuredClone(input);
        return await this.#mutate(
            ctx,
            "mark_ready",
            normalized.operationId,
            normalized.workspaceId,
            async (txCtx, request) =>
                await this.#store.markReady(
                    txCtx,
                    { workspaceId: normalized.workspaceId },
                    request,
                ),
            (before, after) => ({
                type: "workspace_updated",
                change: "mark_ready",
                workspace: after,
                previousWorkspace: requirePreviousWorkspace(before),
            }),
        );
    }

    /** A ready workspace stopped working, with a bounded explanation of why. */
    async markFailed(ctx: Context, input: WorkspaceMarkFailedInput): Promise<Workspace> {
        this.#assertEnabled();
        this.#assertInput(workspaceMarkFailedInputSchema, input, "workspace failure");
        const normalized = structuredClone(input);
        return await this.#mutate(
            ctx,
            "mark_failed",
            normalized.operationId,
            normalized.workspaceId,
            async (txCtx, request) =>
                await this.#store.markFailed(
                    txCtx,
                    { workspaceId: normalized.workspaceId, error: normalized.error },
                    request,
                ),
            (before, after) => ({
                type: "workspace_updated",
                change: "mark_failed",
                workspace: after,
                previousWorkspace: requirePreviousWorkspace(before),
            }),
        );
    }

    /** Provisioning never finished. The attempt is counted so a retry can be decided later. */
    async markInitializationFailed(
        ctx: Context,
        input: WorkspaceMarkFailedInput,
    ): Promise<Workspace> {
        this.#assertEnabled();
        this.#assertInput(
            workspaceMarkFailedInputSchema,
            input,
            "workspace initialization failure",
        );
        const normalized = structuredClone(input);
        return await this.#mutate(
            ctx,
            "mark_initialization_failed",
            normalized.operationId,
            normalized.workspaceId,
            async (txCtx, request) =>
                await this.#store.markInitializationFailed(
                    txCtx,
                    { workspaceId: normalized.workspaceId, error: normalized.error },
                    request,
                ),
            (before, after) => ({
                type: "workspace_updated",
                change: "mark_initialization_failed",
                workspace: after,
                previousWorkspace: requirePreviousWorkspace(before),
            }),
        );
    }

    /** Moves a workspace in the main list, placing it after another one or at the top. */
    async reorder(ctx: Context, input: WorkspaceReorderInput): Promise<Workspace> {
        this.#assertEnabled();
        this.#assertInput(workspaceReorderInputSchema, input, "workspace reorder");
        const normalized = structuredClone(input);
        return await this.#mutate(
            ctx,
            "reorder",
            normalized.operationId,
            normalized.workspaceId,
            async (txCtx, request) =>
                await this.#store.reorder(
                    txCtx,
                    {
                        workspaceId: normalized.workspaceId,
                        afterId: normalized.afterId,
                        ...(normalized.expectedVersion === undefined
                            ? {}
                            : { expectedVersion: normalized.expectedVersion }),
                    },
                    request,
                ),
            (before, after) =>
                before === undefined
                    ? undefined
                    : {
                          type: "workspace_reordered",
                          workspace: after,
                          previousWorkspace: before,
                          previousOrderKey: before.orderKey,
                      },
        );
    }

    /**
     * Archives a workspace: the immediate, irreversible logical decision. It leaves the active
     * list at once and never comes back because cleanup went wrong.
     *
     * The decision also stops the work standing in the workspace. Its folder is about to be taken
     * away, so every agent attached to it — with the subagents and background processes below
     * them — has its cancellation prepared in the transaction that records the archival. An
     * archival that succeeds has therefore taken responsibility for the work in it: preparation
     * that fails takes the archival down with it and leaves the workspace active. The signal
     * itself is released after the commit, and attaching an agent to a workspace whose archival
     * has committed is refused, so nothing new arrives behind the decision.
     */
    async beginArchive(
        ctx: Context,
        workspaceId: string,
        options: WorkspaceArchiveOptions = {},
    ): Promise<Workspace> {
        this.#assertEnabled();
        this.#assertId(workspaceId, "workspace");
        this.#assertInput(workspaceArchiveOptionsSchema, options, "workspace archive");
        const normalized = structuredClone(options);
        return await this.#mutate(
            ctx,
            "begin_archive",
            normalized.operationId,
            workspaceId,
            async (txCtx, request) => {
                const result = await this.#store.beginArchive(
                    txCtx,
                    {
                        workspaceId,
                        ...(normalized.expectedVersion === undefined
                            ? {}
                            : { expectedVersion: normalized.expectedVersion }),
                    },
                    request,
                );
                // Only the archival that actually happens stops anything. A repeat of an archive
                // already made leaves the record alone, and must not reach into agents that have
                // since moved on.
                if (result.changed) await this.#abortWorkspaceAgents(txCtx, workspaceId);
                return result;
            },
            (before, after) => ({
                type: "workspace_updated",
                change: "begin_archive",
                workspace: after,
                previousWorkspace: requirePreviousWorkspace(before),
            }),
        );
    }

    /** Records that the host finished taking the workspace's folder or worktree away. */
    async completeArchive(
        ctx: Context,
        workspaceId: string,
        options: WorkspaceArchiveOptions = {},
    ): Promise<Workspace> {
        this.#assertEnabled();
        this.#assertId(workspaceId, "workspace");
        this.#assertInput(workspaceArchiveOptionsSchema, options, "workspace archive completion");
        const normalized = structuredClone(options);
        return await this.#mutate(
            ctx,
            "complete_archive",
            normalized.operationId,
            workspaceId,
            async (txCtx, request) =>
                await this.#store.completeArchive(txCtx, { workspaceId }, request),
            (before, after) => ({
                type: "workspace_archived",
                workspace: after,
                previousWorkspace: requirePreviousWorkspace(before),
            }),
        );
    }

    /**
     * Archives a workspace and hands its folder to the host to remove.
     *
     * The archival is committed here and returned at once: the workspace has left the active list
     * before this call answers. Removing a worktree can take minutes and can fail, so it runs on
     * the module's cleanup lifetime instead of the caller's, and its outcome arrives later as the
     * `workspace_archived` event or as a logged failure. Archival never fails because cleanup did.
     *
     * Cleanup waits for the decision to become durable. A caller that already carries a transaction
     * — the transactional `archive_workspace` tool — has not committed when the nested transaction
     * below returns, and it can still roll back, so deleting the folder eagerly would destroy a
     * checkout whose archival never happened.
     */
    async archive(
        ctx: Context,
        workspaceId: string,
        options: WorkspaceArchiveOptions = {},
    ): Promise<Workspace> {
        const archived = await ctx.inTx(async (txCtx) => {
            const root = await this.get(txCtx, workspaceId);
            if (root === undefined) {
                throw new Error(`Workspace "${workspaceId}" was not found.`);
            }
            const descendants: Workspace[] = [];
            const visit = async (parent: Workspace): Promise<void> => {
                const children = await readWorkspaceChildren(
                    txCtx.db,
                    parent.projectRef,
                    parent.id,
                    false,
                );
                for (const child of children) {
                    await visit(child);
                    descendants.push(child);
                }
            };
            await visit(root);

            const rows: Workspace[] = [];
            for (const descendant of descendants) {
                rows.push(await this.beginArchive(txCtx, descendant.id));
            }
            const begun = await this.beginArchive(txCtx, workspaceId, options);
            rows.push(begun);
            return { begun, rows };
        });
        const cleanup = archived.rows.filter((workspace) => workspace.status === "archiving");
        // Deleting a folder cannot be undone, so the removals wait for the archival the caller may
        // still roll back to be durable. The lifetime they run on is derived here rather than in
        // the callback: a context that carried the transaction cannot be read once it has ended.
        const workerCtx = this.#backgroundLifetime("workspace-cleanup");
        afterCommit(ctx, () => {
            for (const workspace of archived.rows) this.#stopSetup(workspace.id);
            if (cleanup.length === 0) return;
            this.#runCleanup(workerCtx, async () => {
                for (const workspace of cleanup) {
                    await this.removeArchivedWorkspace(
                        workerCtx,
                        workspace.projectRef,
                        workspace.id,
                    );
                }
            });
        });
        return archived.begun;
    }

    // --- Folders, Git, and setup -------------------------------------------------------------
    //
    // Everything below is the work the records describe: managed folders, worktrees and copies,
    // setup commands, file replication, branch moves, folder removal, and the background work that
    // carries a reservation through to a usable checkout. The catalog does it itself.

    /** Where workspace folders are created. */
    get managedWorkspacesDirectory(): string {
        return this.#workspacesDirectory;
    }

    /**
     * The managed path a folder key would take inside a project. Reservation asks this while it is
     * deciding, so it answers from what the catalog already knows rather than from the database.
     */
    pathForStorageKey(projectRef: string, storageKey: string): string {
        return join(this.#workspaceRoot(projectRef), storageKey);
    }

    /** Whether Git already holds this branch in the project's shared repository. */
    isBranchUnavailable(projectRef: string, branch: string): boolean {
        const folder = this.#projectFolders.get(projectRef);
        if (folder === undefined) return false;
        return gitBranchExists(workspaceGitRefSnapshot(folder.path), branch);
    }

    /** Whether this folder key is already taken, on disk or as a worktree Git knows about. */
    isStorageKeyUnavailable(projectRef: string, storageKey: string): boolean {
        const folder = this.#projectFolders.get(projectRef);
        if (folder === undefined) return false;
        return workspaceStorageKeyExists(
            workspaceGitRefSnapshot(folder.path),
            this.#workspaceRoot(projectRef),
            storageKey,
        );
    }

    /**
     * A generated name put where the workspace's current one sits, keeping a leading number.
     *
     * An automatically created workspace is often numbered, and the number is how a person tells
     * one from the next in a list. Naming it after the first message should change what the
     * workspace is about, not where it sits.
     */
    nameWithPreservedPrefix(current: string, generated: string): string {
        return withPreservedNumericPrefix(current, generated);
    }

    /**
     * Picks up whatever the last run left unfinished: workspaces still being created, and the file
     * replication watch for every workspace that is ready.
     *
     * This is also where the catalog's own background lifetime is taken. Opening happens once, from
     * the root context, before anything can reach the catalog through a tool or a request — so the
     * database that later folder removals write through is the root one, never a caller's
     * transaction facade.
     */
    async open(ctx: Context): Promise<void> {
        this.#pinBackgroundRoot(ctx);
        for (const workspace of await this.#allWorkspaces(ctx)) {
            if (workspace.status === "ready") this.#scheduleSync(ctx, workspace.projectRef);
        }
        this.#runInBackground("workspace-initialization", async (workerCtx) => {
            await this.reconcileInitializingWorkspaces(workerCtx);
        });
    }

    /** Stops every background lifetime this catalog started and waits for the ones in flight. */
    async close(_ctx: Context): Promise<void> {
        this.#closed = true;
        for (const controller of this.#setupControllers.values()) {
            controller.abort(new Error("Workspace setup stopped because Happy Agent is closing."));
        }
        this.#setupControllers.clear();
        for (const timer of this.#syncTimers.values()) clearTimeout(timer);
        this.#syncTimers.clear();
        for (const stop of this.#syncStops.values()) stop();
        this.#syncStops.clear();
        await this.whenCleanupSettles();
        while (this.#tasks.size > 0) {
            await Promise.allSettled(this.#tasks);
        }
    }

    /**
     * Creates a named child directly below the workspace that owns the calling agent.
     * Root-workspace agents are owned by their project, whose shared ID is the root workspace ID.
     */
    async createChildWorkspace(
        ctx: Context,
        agentId: string,
        name: string,
        baseRef?: string,
        operationId?: string,
    ): Promise<Workspace> {
        this.#assertEnabled();
        this.#assertInput(workspaceAgentLookupSchema, { agentId }, "agent lookup");

        const currentWorkspaceId = await this.workspaceForAgent(ctx, agentId);
        let projectId: string;
        let parentId: string;
        if (currentWorkspaceId === undefined) {
            const project = await this.#projects.projectForAgent(ctx, agentId);
            if (project === undefined) {
                throw new Error("The calling agent does not belong to a workspace.");
            }
            projectId = project.id;
            parentId = project.id;
        } else {
            const current = await this.get(ctx, currentWorkspaceId);
            if (current === undefined) {
                throw new Error("The calling agent's workspace was not found.");
            }
            projectId = current.projectRef;
            parentId = current.id;
        }

        const workspace = await this.createWorkspace(
            ctx,
            projectId,
            {
                name,
                nameConfigured: true,
                parentId,
                ...(baseRef === undefined ? {} : { baseRef }),
            },
            agentId,
            operationId === undefined ? {} : { operationId },
        );
        if (workspace === undefined) {
            throw new Error("The calling agent's project was not found.");
        }
        return workspace;
    }

    /**
     * Reserves one workspace and starts building it.
     *
     * Reservation is durable and happens first: the name, folder key and branch are decided in the
     * catalog, against a real snapshot of Git's refs and the managed directory, before anything
     * touches the disk. Only then does the checkout begin, in the background, so the caller is not
     * held while Git works.
     */
    async createWorkspace(
        ctx: Context,
        projectId: string,
        request: CreateWorkspaceRequest,
        creatorSessionId?: string,
        options: WorkspaceCreatorOptions = {},
    ): Promise<Workspace | undefined> {
        this.#assertInput(createWorkspaceRequestSchema, request, "workspace creation");
        this.#assertInput(workspaceCreatorOptionsSchema, options, "workspace creator options");
        const normalized = structuredClone(request);
        const projects = this.#projects;
        const project = await this.#project(ctx, projectId);
        if (project === undefined) return undefined;
        if (
            project.status !== "active" ||
            project.initializationStatus !== "ready" ||
            project.presence !== "present" ||
            !existsSync(project.repositoryRef)
        ) {
            throw new Error(
                "The project root must be active and ready before creating a workspace.",
            );
        }
        if (normalized.secret !== undefined && project.remoteSource?.kind !== "github") {
            throw new Error("GitHub credentials can only be used with a GitHub project.");
        }
        const name = projects.validateName(normalized.name);
        const requestedId =
            normalized.id === undefined
                ? undefined
                : projects.validateClientChosenId(normalized.id, "workspace");
        const workspaceId = requestedId ?? options.operationId ?? createId();
        if (workspaceId === project.id) {
            throw new Error("A workspace cannot use its project's implicit root ID.");
        }
        const parent = await this.#provisioningParent(
            ctx,
            project,
            normalized.parentId,
            workspaceId,
        );
        const requestedBaseRef = projects.validateBaseRef(normalized.baseRef);
        // A nested workspace forks the parent branch by default. The durable baseRef makes a
        // delayed or restarted initialization resolve the same checkout relationship.
        const baseRef = requestedBaseRef ?? parent?.branch;
        const creator = options.createdBy;
        if (options.githubToken !== undefined && creator !== undefined) {
            await projects.registerGitCredential(ctx, projectId, creator, options.githubToken);
        }
        if (
            project.requiredSecretKind === "github" &&
            (creator === undefined || projects.gitAuthentication(projectId, creator) === undefined)
        ) {
            throw new Error("GitHub credentials are unavailable for this workspace.");
        }

        const kind = await this.#workspaceKindFor(ctx, project);
        const workspaceRoot = this.#workspaceRoot(projectId);
        const gitRefs = workspaceGitRefSnapshot(project.repositoryRef);
        const fallbackStorageKey = `${projects.storageKeyFor(name).slice(0, 20)}-${workspaceId}`;

        const reserved = await this.reserve(
            ctx,
            {
                id: workspaceId,
                ...(options.operationId === undefined ? {} : { operationId: options.operationId }),
                projectRef: projectId,
                parentId: parent?.id ?? projectId,
                name,
                kind,
                ...(normalized.nameConfigured === undefined
                    ? {}
                    : { nameConfigured: normalized.nameConfigured }),
                ...(baseRef === undefined ? {} : { baseRef }),
                ...(creatorSessionId === undefined ? {} : { creatorSessionId }),
                ...(gitRefs.complete ? {} : { storageKeySeed: fallbackStorageKey }),
            },
            {
                isBranchUnavailable: (branch) => gitBranchExists(gitRefs, branch),
                isStorageKeyUnavailable: (storageKey) =>
                    workspaceStorageKeyExists(gitRefs, workspaceRoot, storageKey),
                pathForStorageKey: (storageKey) => join(workspaceRoot, storageKey),
            },
        );
        if (reserved.created) {
            const workspace = reserved.workspace;
            afterCommit(ctx, () => {
                this.#runInBackground("workspace-initialization", async (workerCtx) => {
                    await this.#initializeWorkspace(workerCtx, workspace);
                });
            });
        }
        return reserved.workspace;
    }

    /**
     * Finds what owns a directory, importing the directory as a project if it is new.
     *
     * A folder that is a workspace answers with both the workspace and its project; any other
     * folder is resolved by the projects catalog alone.
     */
    async resolvePath(
        ctx: Context,
        cwd: string,
        assertedWorkspaceId?: string,
        requestedProjectId?: string,
    ): Promise<ResolvedProjectOwnership> {
        const projects = this.#projects;
        const path = this.#git.normalizeProjectCwd(cwd);
        const workspace = await this.getByPath(ctx, path);
        if (workspace !== undefined) {
            if (workspace.status !== "ready") {
                throw new ProjectRegistrationError(
                    "managed_workspace_unavailable",
                    `The workspace "${workspace.name}" ${workspaceStatusText(workspace.status)}.`,
                );
            }
            if (assertedWorkspaceId !== undefined && assertedWorkspaceId !== workspace.id) {
                throw new Error("The workspace ID does not match the session directory.");
            }
            const project = await this.#project(ctx, workspace.projectRef);
            if (project === undefined) {
                throw new ProjectRegistrationError(
                    "managed_workspace_unavailable",
                    "The workspace's project was not found.",
                );
            }
            return {
                project:
                    project.status === "archived"
                        ? await projects.restore(ctx, project.id)
                        : project,
                workspace,
            };
        }
        if (assertedWorkspaceId !== undefined) {
            throw new Error("The workspace ID does not match the session directory.");
        }
        return {
            project: this.#remember(
                await projects.resolvePath(
                    ctx,
                    path,
                    ...(requestedProjectId === undefined ? [] : [requestedProjectId]),
                ),
            ),
        };
    }

    /**
     * Resolves the explicit durable owner of a new session.
     *
     * Unlike generic path resolution, this accepts a workspace whose folder does not exist yet.
     * The caller has to name both its reserved identity and its exact future path.
     */
    async resolveSessionOwnership(
        ctx: Context,
        cwd: string,
        workspaceId: string,
        assertedProjectId?: string,
    ): Promise<ResolvedProjectOwnership> {
        const projects = this.#projects;
        const path = this.#git.normalizeProjectCwd(cwd);
        const workspace = await this.get(ctx, workspaceId);
        if (workspace === undefined || workspace.path !== path) {
            throw new Error("The workspace ID does not match the session directory.");
        }
        if (assertedProjectId !== undefined && workspace.projectRef !== assertedProjectId) {
            throw new Error("The workspace does not belong to that project.");
        }
        if (workspace.status !== "initializing" && workspace.status !== "ready") {
            throw new ProjectRegistrationError(
                "managed_workspace_unavailable",
                `The workspace "${workspace.name}" ${workspaceStatusText(workspace.status)}.`,
            );
        }
        if (
            workspace.status === "ready" &&
            (workspace.presence !== "present" || !existsSync(workspace.path))
        ) {
            throw new ProjectRegistrationError(
                "managed_workspace_unavailable",
                `The workspace "${workspace.name}" is not available right now.`,
            );
        }
        const project = await this.#project(ctx, workspace.projectRef);
        if (project === undefined) {
            throw new ProjectRegistrationError(
                "managed_workspace_unavailable",
                "The workspace's project was not found.",
            );
        }
        return {
            project:
                project.status === "archived" ? await projects.restore(ctx, project.id) : project,
            workspace,
        };
    }

    /** A project Git cannot cut a worktree from still gets a workspace: a copy of the folder. */
    async #workspaceKindFor(ctx: Context, project: Project): Promise<"git_worktree" | "directory"> {
        if (project.worktreeSupport === "supported") return "git_worktree";
        if (project.worktreeSupport === "unsupported") return "directory";
        const probed = this.#remember(await this.#projects.probe(ctx, project.id));
        return probed.worktreeSupport === "supported" ? "git_worktree" : "directory";
    }

    /**
     * Resolves the file/check-out parent of a new workspace. A project is its own implicit root;
     * every other parent must be a usable workspace in that project.
     */
    async #provisioningParent(
        ctx: Context,
        project: Project,
        requestedParentId: string | undefined,
        workspaceId: string,
    ): Promise<Workspace | undefined> {
        const parentId = requestedParentId ?? project.id;
        if (parentId === project.id) return undefined;
        if (parentId === workspaceId) {
            throw new Error("A workspace cannot be its own parent.");
        }
        const parent = await this.get(ctx, parentId);
        if (parent === undefined) {
            throw new Error(`Workspace parent "${parentId}" was not found.`);
        }
        if (parent.projectRef !== project.id) {
            throw new Error("A workspace parent must belong to the same project.");
        }
        await readWorkspaceAncestorIds(ctx.db, parent);
        this.#assertReadyProvisioningParent(parent);
        return parent;
    }

    #assertReadyProvisioningParent(parent: Workspace): void {
        if (
            parent.status !== "ready" ||
            parent.presence !== "present" ||
            !existsSync(parent.path)
        ) {
            throw new Error("A workspace parent must be active, ready, and available.");
        }
    }

    #workspaceRoot(projectId: string): string {
        const storageKey = this.#projectFolders.get(projectId)?.storageKey ?? projectId;
        return join(this.#workspacesDirectory, storageKey);
    }

    // --- Building a workspace ----------------------------------------------------------------

    /** Carries every workspace that is still being created through to a usable checkout. */
    async reconcileInitializingWorkspaces(ctx: Context): Promise<void> {
        const workspaces = (await this.#allWorkspaces(ctx)).filter(
            (workspace) => workspace.status === "initializing",
        );
        let next = 0;
        const worker = async (): Promise<void> => {
            for (;;) {
                if (this.#closed) return;
                const workspace = workspaces[next++];
                if (workspace === undefined) return;
                await this.#initializeWorkspace(ctx, workspace);
            }
        };
        await Promise.all(
            Array.from(
                { length: Math.min(WORKSPACE_INITIALIZATION_CONCURRENCY, workspaces.length) },
                worker,
            ),
        );
    }

    async #initializeWorkspace(ctx: Context, workspace: Workspace): Promise<void> {
        await this.#workspaceLocks.runInLock(ctx, workspace.id, async () => {
            const project = await this.#project(ctx, workspace.projectRef);
            if (project === undefined) {
                await this.#failInitialization(
                    ctx,
                    workspace.id,
                    "The workspace's project was not found.",
                );
                return;
            }
            try {
                const current = await this.#projects.runInProjectGitLock(
                    ctx,
                    workspace.projectRef,
                    async () => await this.#createContentsLocked(ctx, workspace, project),
                );
                if (current === undefined || this.#closed) return;
                await this.#setupWorkspace(ctx, current);
                if (this.#closed) return;
                await this.markReady(ctx, { workspaceId: current.id });
                this.#scheduleSync(ctx, current.projectRef);
            } catch (error) {
                if (this.#closed) return;
                await this.#failInitialization(ctx, workspace.id, errorToMessage(error));
            }
        });
    }

    /** Everything that must happen while this project's Git lock is held. */
    async #createContentsLocked(
        ctx: Context,
        workspace: Workspace,
        project: Project,
    ): Promise<Workspace | undefined> {
        let locked = await this.#ownedWorkspace(ctx, workspace.projectRef, workspace.id);
        if (locked?.status !== "initializing") return undefined;
        const parent = await this.#initializationParent(ctx, locked);

        if (locked.kind === "directory") {
            if (existsSync(locked.path)) return locked;
            if (this.#closed) return undefined;
            await copyProjectFolder({
                projectPath: parent?.path ?? project.repositoryRef,
                workspacePath: locked.path,
            });
            return locked;
        }

        locked = await this.#prepareInitialization(ctx, locked, project);
        if (locked?.status !== "initializing") return undefined;
        if (existsSync(locked.path)) {
            const adoptable =
                locked.gitCommonDir !== undefined &&
                (await this.#git.isWorktreeAt({
                    commonDir: locked.gitCommonDir,
                    path: locked.path,
                    ...this.#gitOptions(project.id),
                }));
            if (adoptable) return locked;
            // A half-made worktree is cleaned up before creation is tried again. The keep-on-
            // archive settings do not apply: this folder was never a workspace someone worked in.
            await removeWorkspaceDirectory({
                git: this.#git,
                ...this.#gitOptions(project.id),
                keepCopiesOnArchive: false,
                keepWorktreesOnArchive: false,
                project,
                stopped: () => this.#closed,
                workspace: locked,
            });
        }
        if (this.#closed) return undefined;
        // The workspace is anchored to the commit it was reserved on, so an interrupted creation
        // resumes onto exactly the base it was promised.
        if (locked.baseCommit === undefined) {
            throw new Error("The workspace has no base commit to start from.");
        }
        await this.#createCheckoutLocked(ctx, locked, project.repositoryRef, locked.baseCommit);
        return locked;
    }

    /** Revalidates the durable parent immediately before touching its checkout or files. */
    async #initializationParent(
        ctx: Context,
        workspace: Workspace,
    ): Promise<Workspace | undefined> {
        if (workspace.parentId === workspace.projectRef) return undefined;
        const parent = await this.get(ctx, workspace.parentId);
        if (parent === undefined) {
            throw new Error("The workspace's parent was not found.");
        }
        if (parent.projectRef !== workspace.projectRef) {
            throw new Error("The workspace's parent belongs to another project.");
        }
        await readWorkspaceAncestorIds(ctx.db, parent);
        this.#assertReadyProvisioningParent(parent);
        return parent;
    }

    async #prepareInitialization(
        ctx: Context,
        workspace: Workspace,
        project: Project,
    ): Promise<Workspace | undefined> {
        if (workspace.baseCommit !== undefined && workspace.gitCommonDir !== undefined) {
            return workspace;
        }
        const projects = this.#projects;
        const gitOptions = this.#gitOptions(project.id);
        const topLevel = await this.#git.topLevel(project.repositoryRef, gitOptions);
        if (topLevel !== project.repositoryRef) {
            throw new Error("A workspace worktree needs a Git repository project.");
        }
        const defaultBranch =
            workspace.baseRef === undefined
                ? (await projects.resolveDefaultBranch(ctx, project.id)).defaultBranch
                : undefined;
        const gitCommonDir = await this.#git.commonDir(project.repositoryRef, gitOptions);
        const base = await this.#git.resolveWorkspaceBase({
            ...gitOptions,
            ...(defaultBranch === undefined ? {} : { defaultBranch }),
            projectPath: project.repositoryRef,
            ...(workspace.baseRef === undefined ? {} : { requestedRef: workspace.baseRef }),
        });
        if (this.#closed) return undefined;
        return await this.recordInitialization(ctx, {
            workspaceId: workspace.id,
            facts: { baseCommit: base.commit, baseRef: base.ref, gitCommonDir },
        });
    }

    async #createCheckoutLocked(
        ctx: Context,
        workspace: Workspace,
        projectPath: string,
        commit: string,
    ): Promise<void> {
        if (this.#closed) return;
        // The branch may already have followed a rename made while the checkout was reserved.
        const branch =
            (await this.#ownedWorkspace(ctx, workspace.projectRef, workspace.id))?.branch ??
            workspace.branch;
        await this.#git.createWorktree({
            branch,
            commit,
            expectedCommonDir: workspace.gitCommonDir ?? "",
            projectPath,
            workspacePath: workspace.path,
            ...this.#gitOptions(workspace.projectRef),
        });
        // A rename landing during the checkout is not moved by the branch mover, which leaves
        // workspaces that are not ready alone. The branch Git just created is the real one.
        if (this.#closed) return;
        const stored = await this.#ownedWorkspace(ctx, workspace.projectRef, workspace.id);
        if (stored === undefined || stored.branch === branch) return;
        await this.setBranch(ctx, { workspaceId: workspace.id, branch });
        ctx.log.warn(
            { branch, workspaceId: workspace.id },
            "The workspace was renamed while it was being created, so its branch kept the reserved name.",
        );
    }

    async #setupWorkspace(ctx: Context, workspace: Workspace): Promise<void> {
        const controller = new AbortController();
        this.#setupControllers.set(workspace.id, controller);
        try {
            if (
                (await this.#ownedWorkspace(ctx, workspace.projectRef, workspace.id))?.status !==
                "initializing"
            ) {
                return;
            }
            const project = await this.#project(ctx, workspace.projectRef);
            // The first replication runs before the setup commands so they can rely on the shared
            // files being there. The sync list is read from the project root — the same source
            // every later pass uses — so an uncommitted change to it applies immediately.
            if (project !== undefined) {
                const rootSettings = await this.#folderSettings(project.repositoryRef);
                await syncWorkspaceFiles({
                    paths: [...rootSettings.sync, ...rootSettings.protectedSync],
                    projectPath: project.repositoryRef,
                    workspacePath: workspace.path,
                });
            }
            const settings = await this.#folderSettings(workspace.path);
            try {
                await runWorkspaceSetupCommands(ctx, workspace.path, settings.setupCommands, {
                    signal: controller.signal,
                });
            } catch (error) {
                // Setup makes a valid checkout more convenient; it does not decide whether the
                // checkout exists. Preserve explicit cancellation, but keep an otherwise usable
                // workspace when an install or another project-owned command fails.
                controller.signal.throwIfAborted();
                ctx.lifetime?.throwIfAborted();
                ctx.log.warn(
                    { error, workspaceId: workspace.id },
                    "A workspace setup command failed, but the workspace is still usable.",
                );
            }
        } finally {
            if (this.#setupControllers.get(workspace.id) === controller) {
                this.#setupControllers.delete(workspace.id);
            }
        }
    }

    async #failInitialization(ctx: Context, workspaceId: string, message: string): Promise<void> {
        await this.markInitializationFailed(ctx, {
            workspaceId,
            error: boundedWorkspaceError(message),
        });
    }

    async #folderSettings(folder: string): Promise<WorkspaceFolderSettings> {
        return await loadWorkspaceFolderSettings(folder, this.#config.workspaceSettings);
    }

    // --- Archival ----------------------------------------------------------------------------

    /** Cleans up an archived workspace's folder. Failure is logged; archival still stands. */
    async removeArchivedWorkspace(
        ctx: Context,
        projectId: string,
        workspaceId: string,
    ): Promise<Workspace | undefined> {
        await this.#workspaceLocks.runInLock(ctx, workspaceId, async () => {
            const workspace = await this.#ownedWorkspace(ctx, projectId, workspaceId);
            if (workspace === undefined || workspace.status === "archived") return;
            if (workspace.status !== "archiving") {
                throw new Error("That workspace is not being archived.");
            }
            const project = await this.#project(ctx, projectId);
            if (project === undefined) throw new Error("The workspace's project was not found.");
            const settings = await this.#folderSettings(project.repositoryRef);
            try {
                await removeWorkspaceDirectory({
                    git: this.#git,
                    ...this.#gitOptions(projectId),
                    keepCopiesOnArchive: settings.keepCopiesOnArchive,
                    keepWorktreesOnArchive: settings.keepWorktreesOnArchive,
                    project,
                    stopped: () => this.#closed,
                    workspace,
                });
                if (this.#closed) return;
            } catch (error) {
                if (this.#closed) return;
                // The archival is already durable, so a folder Happy Agent could not remove is something
                // to tell someone about rather than a failure to hand back.
                ctx.log.warn(
                    { error, workspaceId },
                    "The archived workspace's folder could not be removed.",
                );
            }
            await this.completeArchive(ctx, workspaceId);
            // The next pass stops the watch when this was the project's last ready workspace.
            this.#scheduleSync(ctx, projectId);
        });
        return await this.#ownedWorkspace(ctx, projectId, workspaceId);
    }

    /**
     * Archives everything cut from a project that has just been archived, inside that project's own
     * transaction, and removes the folders afterwards. A workspace of an archived project is not a
     * workspace anybody has any more, so it leaves the active list at the same moment.
     */
    async #archiveProjectWorkspaces(ctx: Context, projectId: string): Promise<void> {
        if (!this.#enabled) return;
        const active = (await this.#allWorkspaces(ctx, projectId)).filter(
            (workspace) => !isArchivalDecided(workspace),
        );
        const withDepth = await Promise.all(
            active.map(async (workspace) => ({
                workspace,
                depth: (await readWorkspaceAncestorIds(ctx.db, workspace)).length,
            })),
        );
        // Child checkout decisions leave the catalog before their parents. This preserves the
        // same archive boundary as a direct request while archiving an entire project atomically.
        const workspaces = withDepth
            .sort(
                (left, right) =>
                    right.depth - left.depth ||
                    left.workspace.orderKey.localeCompare(right.workspace.orderKey) ||
                    left.workspace.id.localeCompare(right.workspace.id),
            )
            .map(({ workspace }) => workspace);
        for (const workspace of workspaces) {
            await this.beginArchive(ctx, workspace.id);
        }
        if (workspaces.length === 0) return;
        // This runs inside the project's archival transaction, which can still roll back. Stopping
        // setup and deleting folders cannot be undone, so they wait for the decision to be durable.
        // The lifetime they run on is derived while this context still carries a live transaction.
        const workerCtx = this.#backgroundLifetime("workspace-cleanup");
        afterCommit(ctx, () => {
            for (const workspace of workspaces) this.#stopSetup(workspace.id);
            this.#runCleanup(workerCtx, async () => {
                for (const workspace of workspaces) {
                    await this.removeArchivedWorkspace(workerCtx, projectId, workspace.id);
                }
            });
        });
    }

    #stopSetup(workspaceId: string): void {
        this.#setupControllers
            .get(workspaceId)
            ?.abort(new Error("Workspace setup stopped because the workspace was archived."));
    }

    /**
     * Cancels every agent standing in a workspace that is leaving the active list.
     *
     * Only the agents attached to the workspace are named here. Each abort carries the whole
     * subagent tree below it, so a hidden helper working in the same folder stops with the agent
     * that started it, and a managed root belonging to another workspace stops without disturbing
     * the parent that supervises it from elsewhere.
     */
    async #abortWorkspaceAgents(ctx: Context, workspaceId: string): Promise<void> {
        for (const association of await readWorkspaceAgents(ctx.db, workspaceId)) {
            await this.#abort.abort(ctx, association.agentId);
        }
    }

    // --- File replication --------------------------------------------------------------------

    /** Debounces the project's next sync pass, so a burst of file events becomes one copy. */
    #scheduleSync(ctx: Context, projectId: string): void {
        if (this.#closed) return;
        clearTimeout(this.#syncTimers.get(projectId));
        const timer = setTimeout(() => {
            this.#syncTimers.delete(projectId);
            this.#runInBackground("workspace-sync", async (workerCtx) => {
                await this.#syncLocks.runInLock(workerCtx, projectId, async (lockedCtx) => {
                    await this.#runSyncPass(lockedCtx, projectId);
                });
            });
        }, WORKSPACE_SYNC_DEBOUNCE_MS);
        timer.unref?.();
        this.#syncTimers.set(projectId, timer);
    }

    /**
     * Replicates the project root's configured sync paths into every ready workspace, then re-arms
     * the watch from the current configuration. Sync is best-effort: one workspace failing to
     * receive a copy never fails the others, and a project left without ready workspaces simply
     * stops being watched.
     */
    async #runSyncPass(ctx: Context, projectId: string): Promise<void> {
        this.#syncStops.get(projectId)?.();
        this.#syncStops.delete(projectId);
        if (this.#closed) return;
        const project = await this.#project(ctx, projectId);
        const workspaces = (await this.#allWorkspaces(ctx, projectId)).filter(
            (workspace) => workspace.status === "ready",
        );
        if (project === undefined || workspaces.length === 0) return;
        const settings = await this.#folderSettings(project.repositoryRef);
        const syncPaths = [...new Set([...settings.sync, ...settings.protectedSync])];
        if (this.#closed) return;
        // The watch is armed even with nothing to sync: it also observes the project configuration
        // file, so a sync list added later is picked up without a restart.
        this.#syncStops.set(
            projectId,
            watchWorkspaceSyncPaths({
                onChange: () => {
                    this.#scheduleSync(ctx, projectId);
                },
                projectPath: project.repositoryRef,
                recursive: this.#git.supportsRecursiveWorktreeWatch(),
                syncPaths,
            }),
        );
        for (const workspace of workspaces) {
            if (this.#closed) return;
            // Re-read right before copying: a workspace archived while this pass was running must
            // not have its folder written to, much less recreated.
            if ((await this.#ownedWorkspace(ctx, projectId, workspace.id))?.status !== "ready") {
                continue;
            }
            try {
                await syncWorkspaceFiles({
                    paths: syncPaths,
                    projectPath: project.repositoryRef,
                    workspacePath: workspace.path,
                });
            } catch {
                // Best-effort replication: the workspace converges on the next pass.
            }
        }
    }

    // --- Git facts ---------------------------------------------------------------------------

    /** Re-derives presence and Git facts for every workspace someone can work in. */
    async reconcileGitFacts(ctx: Context): Promise<void> {
        for (const workspace of await this.#allWorkspaces(ctx)) {
            if (this.#closed) return;
            if (workspace.status !== "ready") continue;
            const probe = await this.#git.probe(workspace.path);
            if (this.#closed) return;
            await this.applyProbe(ctx, {
                workspaceId: workspace.id,
                presence: probe.presence,
                facts: this.#projects.gitFactsFrom(
                    probe.facts ?? { ahead: 0, behind: 0, detached: false },
                ),
            });
        }
    }

    /** Persists Git facts a live scan observed, so a commit reaches a client that is not watching. */
    async recordGitFacts(
        ctx: Context,
        workspaceId: string,
        facts: GitRepositoryFacts,
    ): Promise<void> {
        await this.applyGitFacts(ctx, {
            workspaceId,
            facts: this.#projects.gitFactsFrom(facts),
        });
    }

    /**
     * Looks at a workspace's branch as Git has it right now.
     *
     * The stored facts are a snapshot of the last scan; this question is asked when someone wants
     * the truth, so the folder is read rather than the row.
     */
    async #readBranchMetadata(ctx: Context, workspaceId: string): Promise<WorkspaceBranchMetadata> {
        const workspace = await this.#mutations.getRequired(ctx, workspaceId);
        const facts =
            workspace.presence === "missing"
                ? undefined
                : (await this.#git.probe(workspace.path)).facts;
        return {
            workspaceId,
            ahead: facts?.ahead ?? 0,
            behind: facts?.behind ?? 0,
            detached: facts?.detached ?? false,
            ...(facts?.branch === undefined ? {} : { branch: facts.branch }),
            ...(facts?.head === undefined ? {} : { head: facts.head }),
            ...(facts?.upstream === undefined ? {} : { upstream: facts.upstream }),
        };
    }

    // --- Internals ---------------------------------------------------------------------------

    /** Every workspace this agent can see, archived ones included. */
    async #allWorkspaces(ctx: Context, projectId?: string): Promise<readonly Workspace[]> {
        return await this.list(ctx, {
            includeArchived: true,
            ...(projectId === undefined ? {} : { projectRef: projectId }),
        });
    }

    /** One workspace, but only if it belongs to the project the caller named. */
    async #ownedWorkspace(
        ctx: Context,
        projectId: string,
        workspaceId: string,
    ): Promise<Workspace | undefined> {
        const workspace = await this.get(ctx, workspaceId);
        return workspace?.projectRef === projectId ? workspace : undefined;
    }

    /** The project a workspace belongs to, remembering its folder for later reservations. */
    async #project(ctx: Context, projectId: string): Promise<Project | undefined> {
        const project = await this.#projects.get(ctx, projectId);
        return project === undefined ? undefined : this.#remember(project);
    }

    /**
     * Remembers where a project lives.
     *
     * Deciding a folder key or a branch has to answer at once, from a snapshot of Git's refs and
     * the managed directory, so the folder cannot be looked up in the database at that moment. What
     * the catalog has already seen is enough: a project it has never read has nothing reserved.
     */
    #remember<T extends Project | undefined>(project: T): T {
        if (project !== undefined) {
            this.#projectFolders.set(project.id, {
                path: project.repositoryRef,
                storageKey: project.storageKey,
            });
        }
        return project;
    }

    /**
     * The credential a Git command against one project must carry. The projects catalog owns who
     * created a project, so it is what names the credential a workspace cut from it inherits.
     */
    #gitOptions(projectId: string): { readonly credential?: GitCredentialRef } {
        const credential = this.#projects.gitCredential(projectId);
        return credential === undefined ? {} : { credential };
    }

    /**
     * The lifetime the catalog's own Git and filesystem work runs on.
     *
     * Cutting a worktree, running setup commands, replicating files, and removing a folder all
     * outlive the call that asked for them, so none of them runs on that call's context. The
     * lifetime is detached from the first context the catalog is used with. A detached context
     * carries no storage — that is what stops work outliving its caller from writing through a
     * transaction facade that has already committed — so the agent database is put back on it
     * deliberately, and nothing else about the request comes along.
     */
    #backgroundLifetime(name: string): Context {
        const lifetime = this.#lifetime;
        const storage = this.#storage;
        if (lifetime === undefined || storage === undefined) {
            throw new Error(
                "The workspaces catalog was asked for background work before it was started.",
            );
        }
        return withAgentDatabase(lifetime.named(name), storage);
    }

    /**
     * Captures the lifetime and database the catalog's own background work runs on.
     *
     * This is taken at startup rather than from whoever happens to ask first, because a caller can
     * be inside a transaction — archiving is reachable from a transactional tool — and that
     * caller's `db` is the transaction's facade, which is dead by the time background work runs.
     * Pinning the root here is what keeps a folder removal deferred to after the commit from
     * writing through a transaction that has ended.
     */
    #pinBackgroundRoot(ctx: Context): void {
        this.#lifetime ??= detach(ctx);
        this.#storage ??= ctx.db;
    }

    /**
     * Starts work that outlives whatever asked for it, on its own named lifetime. The caller's
     * context is deliberately not used: a background checkout must not end when a request does.
     */
    #runInBackground(name: string, work: (workerCtx: Context) => Promise<void>): void {
        if (this.#closed) return;
        const task = work(this.#backgroundLifetime(name))
            .catch(() => undefined)
            .finally(() => {
                this.#tasks.delete(task);
            });
        this.#tasks.add(task);
    }

    /** Waits for the folder removals this module started. Closing and tests both need it. */
    async whenCleanupSettles(): Promise<void> {
        while (this.#cleanupTasks.size > 0) {
            await Promise.allSettled(this.#cleanupTasks);
        }
    }

    /** Persists the Git state the host observed, writing only when something actually changed. */
    async applyGitFacts(ctx: Context, input: WorkspaceApplyGitFactsInput): Promise<Workspace> {
        this.#assertEnabled();
        this.#assertInput(workspaceApplyGitFactsInputSchema, input, "workspace Git facts");
        const normalized = structuredClone(input);
        return await this.#mutate(
            ctx,
            "apply_git_facts",
            normalized.operationId,
            normalized.workspaceId,
            async (txCtx, request) =>
                await this.#store.applyGitFacts(
                    txCtx,
                    { workspaceId: normalized.workspaceId, facts: normalized.facts },
                    request,
                ),
            (before, after) => ({
                type: "workspace_updated",
                change: "apply_git_facts",
                workspace: after,
                previousWorkspace: requirePreviousWorkspace(before),
            }),
        );
    }

    /** The same, plus whether the folder was still there when the host looked. */
    async applyProbe(ctx: Context, input: WorkspaceApplyProbeInput): Promise<Workspace> {
        this.#assertEnabled();
        this.#assertInput(workspaceApplyProbeInputSchema, input, "workspace probe");
        const normalized = structuredClone(input);
        return await this.#mutate(
            ctx,
            "apply_probe",
            normalized.operationId,
            normalized.workspaceId,
            async (txCtx, request) =>
                await this.#store.applyProbe(
                    txCtx,
                    {
                        workspaceId: normalized.workspaceId,
                        presence: normalized.presence,
                        facts: normalized.facts,
                    },
                    request,
                ),
            (before, after) => ({
                type: "workspace_updated",
                change: "apply_probe",
                workspace: after,
                previousWorkspace: requirePreviousWorkspace(before),
            }),
        );
    }

    /**
     * The workspaces someone can still work in. Archived rows are history: they are only listed
     * when a caller asks for them by name, so a list nobody qualified never shows a folder that
     * is already gone.
     */
    async listPage(ctx: Context, query: WorkspacePageQuery = {}): Promise<WorkspacePage> {
        this.#assertEnabled();
        this.#assertInput(workspacePageQuerySchema, query, "workspace page query");
        const limit = query.limit ?? WORKSPACE_PAGE_SIZE;
        if (limit > WORKSPACE_PAGE_SIZE) {
            throw new Error(`Workspace page limit cannot exceed ${String(WORKSPACE_PAGE_SIZE)}.`);
        }
        const normalized = {
            ...structuredClone(query),
            includeArchived: query.includeArchived === true,
            limit,
        };
        const raw = await requirePromise(this.#store.list(ctx, normalized), "Workspace store list");
        assertWorkspacePage(raw);
        this.#assertPage(raw, normalized.cursor ?? 0, limit);
        for (const workspace of raw.workspaces) {
            assertWorkspaceRecord(workspace);
            if (
                normalized.projectRef !== undefined &&
                workspace.projectRef !== normalized.projectRef
            ) {
                throw new Error("Workspace page returned a row outside the requested project.");
            }
            if (
                !normalized.includeArchived &&
                (workspace.status === "archived" || workspace.status === "archiving")
            ) {
                throw new Error("Workspace page returned an archived row without includeArchived.");
            }
        }
        return structuredClone(fitPageForModel(raw, MAX_WORKSPACE_OUTPUT_CHARACTERS));
    }

    async list(ctx: Context, query: WorkspacePageQuery = {}): Promise<Workspace[]> {
        this.#assertEnabled();
        return (await this.listPage(ctx, query)).workspaces;
    }

    /** Lists the direct children of one project's root or workspace in durable sibling order. */
    async listChildren(
        ctx: Context,
        projectRef: string,
        parentId: string = projectRef,
        includeArchived = false,
    ): Promise<readonly Workspace[]> {
        this.#assertEnabled();
        const input = { projectRef, parentId, includeArchived };
        this.#assertInput<WorkspaceChildrenQuery>(
            workspaceChildrenQuerySchema,
            input,
            "workspace children query",
        );
        await this.#assertParentBelongsToProject(ctx, input.projectRef, input.parentId);
        return structuredClone(
            await readWorkspaceChildren(
                ctx.db,
                input.projectRef,
                input.parentId,
                input.includeArchived,
            ),
        );
    }

    async get(ctx: Context, workspaceId: string): Promise<Workspace | undefined> {
        this.#assertEnabled();
        this.#assertId(workspaceId, "workspace");
        const raw = await requirePromise(this.#store.get(ctx, workspaceId), "Workspace store get");
        if (raw === undefined) return undefined;
        assertWorkspace(raw);
        assertWorkspaceRecord(raw);
        if (raw.id !== workspaceId) {
            throw new Error("Workspace store returned a different workspace identity.");
        }
        return structuredClone(raw);
    }

    /** Permanently places one user-controlled root agent in a workspace. */
    async attachAgent(
        ctx: Context,
        workspaceId: string,
        agentId: string,
    ): Promise<WorkspaceAgentAssociation> {
        return await this.#attachAgent(ctx, workspaceId, agentId, false);
    }

    /** Permanently places one agent whose Agent Base parent belongs to another workspace. */
    async attachManagedRootAgent(
        ctx: Context,
        workspaceId: string,
        agentId: string,
    ): Promise<WorkspaceAgentAssociation> {
        return await this.#attachAgent(ctx, workspaceId, agentId, true);
    }

    async #attachAgent(
        ctx: Context,
        workspaceId: string,
        agentId: string,
        managedByAnotherAgent: boolean,
    ): Promise<WorkspaceAgentAssociation> {
        this.#assertEnabled();
        const input = { workspaceId, agentId };
        this.#assertInput<WorkspaceAgentAttachment>(
            workspaceAgentAttachmentSchema,
            input,
            "agent attachment",
        );
        const agents = this.#agents;
        if (agents === undefined) {
            throw new Error(
                "The workspaces module was asked to attach an agent before it started.",
            );
        }
        const parentAgentId = await agents.parentOf(ctx, agentId);
        if (!managedByAnotherAgent && parentAgentId !== null) {
            throw new Error("Only a top-level agent can be attached to a workspace.");
        }
        if (managedByAnotherAgent && parentAgentId === null) {
            throw new Error(
                "Only an agent managed by another agent can be attached as a managed workspace root.",
            );
        }
        return await this.#agentAssociationLocks.runInLock(
            ctx,
            `agent:${input.agentId}`,
            async (agentCtx) => {
                const existing = await readWorkspaceAgent(agentCtx.db, input.agentId);
                if (existing !== undefined && existing.workspaceId !== input.workspaceId) {
                    throw new Error(
                        `Agent "${input.agentId}" is already attached to workspace "${existing.workspaceId}".`,
                    );
                }
                return await this.#withWorkspaceAgentOwnerLocks(
                    agentCtx,
                    [input.workspaceId],
                    async (lockCtx) =>
                        await lockCtx.inTx(async (txCtx) => {
                            const targetBefore = await this.#requireAgentWorkspace(
                                txCtx,
                                input.workspaceId,
                            );
                            // Archiving cancels the agents it can see, in its own transaction. An
                            // attachment that commits after that one would put an agent in a folder
                            // the decision has already scanned past, leaving it running in a
                            // checkout about to be deleted with nothing left to stop it. Reading
                            // the status inside this transaction makes the database settle the
                            // order: whichever commits second sees the first and loses.
                            if (isArchivalDecided(targetBefore)) {
                                throw new WorkspaceLifecycleError(
                                    `Workspace "${input.workspaceId}" is being archived, so no agent can be attached to it.`,
                                );
                            }
                            const current = await readWorkspaceAgent(txCtx.db, input.agentId);
                            if (current?.workspaceId === input.workspaceId) {
                                return structuredClone(current);
                            }
                            if (current !== undefined) {
                                throw new Error(
                                    `Agent "${input.agentId}" is already attached to workspace "${current.workspaceId}".`,
                                );
                            }
                            const siblings = await readWorkspaceAgents(txCtx.db, input.workspaceId);
                            const association: WorkspaceAgentAssociation = {
                                workspaceId: input.workspaceId,
                                agentId: input.agentId,
                                orderKey: orderKeyBetween(siblings.at(-1)?.orderKey ?? null, null),
                            };
                            await insertWorkspaceAgent(txCtx.db, association);
                            const targetAfter = await touchWorkspace(txCtx.db, targetBefore);
                            await this.#mutations.observe(
                                txCtx,
                                this.#mutations.newEvent({
                                    type: "workspace_agent_attached",
                                    association,
                                    workspace: targetAfter,
                                    previousWorkspace: targetBefore,
                                }),
                            );
                            return structuredClone(association);
                        }),
                );
            },
        );
    }

    /** Agent identities in the durable order a person last set for one workspace. */
    async listAgentIds(ctx: Context, workspaceId: string): Promise<readonly string[]> {
        return (await this.listAgents(ctx, workspaceId)).map((association) => association.agentId);
    }

    /** Agent placements in the durable order a person last set for one workspace. */
    async listAgents(ctx: Context, workspaceId: string): Promise<readonly WorkspaceAgentOrder[]> {
        this.#assertEnabled();
        this.#assertId(workspaceId, "workspace");
        return (await readWorkspaceAgents(ctx.db, workspaceId)).map((association) => ({
            agentId: association.agentId,
            orderKey: association.orderKey,
        }));
    }

    /** The workspace that owns an agent's placement, including an archived workspace. */
    async workspaceForAgent(ctx: Context, agentId: string): Promise<string | undefined> {
        this.#assertEnabled();
        this.#assertInput(workspaceAgentLookupSchema, { agentId }, "agent lookup");
        const association = await readWorkspaceAgent(ctx.db, agentId);
        if (association === undefined) return undefined;
        await this.#assertWorkspaceHierarchy(ctx, association.workspaceId);
        return association.workspaceId;
    }

    /** Moves one attached agent after another agent, or to the beginning when `afterAgentId` is null. */
    async reorderAgent(
        ctx: Context,
        workspaceId: string,
        agentId: string,
        afterAgentId: string | null,
    ): Promise<WorkspaceAgentAssociation> {
        this.#assertEnabled();
        const input = { workspaceId, agentId, afterAgentId };
        this.#assertInput<WorkspaceAgentReorderInput>(
            workspaceAgentReorderInputSchema,
            input,
            "agent reorder",
        );
        if (input.agentId === input.afterAgentId) {
            throw new Error("An agent cannot be placed after itself.");
        }
        return await this.#agentAssociationLocks.runInLock(
            ctx,
            `agent:${input.agentId}`,
            async (agentCtx) =>
                await this.#withWorkspaceAgentOwnerLocks(
                    agentCtx,
                    [input.workspaceId],
                    async (lockCtx) =>
                        await lockCtx.inTx(async (txCtx) => {
                            const workspaceBefore = await this.#requireAgentWorkspace(
                                txCtx,
                                input.workspaceId,
                            );
                            const attached = await readWorkspaceAgents(txCtx.db, input.workspaceId);
                            const current = attached.find(
                                (association) => association.agentId === input.agentId,
                            );
                            if (current === undefined) {
                                throw new Error(
                                    `Agent "${input.agentId}" is not attached to that workspace.`,
                                );
                            }
                            const remaining = attached.filter(
                                (association) => association.agentId !== input.agentId,
                            );
                            const afterIndex =
                                input.afterAgentId === null
                                    ? -1
                                    : remaining.findIndex(
                                          (association) =>
                                              association.agentId === input.afterAgentId,
                                      );
                            if (input.afterAgentId !== null && afterIndex === -1) {
                                throw new Error(
                                    "The agent to place after is not attached to that workspace.",
                                );
                            }
                            const orderKey = orderKeyBetween(
                                afterIndex === -1
                                    ? null
                                    : (remaining[afterIndex]?.orderKey ?? null),
                                remaining[afterIndex + 1]?.orderKey ?? null,
                            );
                            if (current.orderKey === orderKey) return structuredClone(current);
                            const reordered = { ...current, orderKey };
                            await updateWorkspaceAgentOrder(
                                txCtx.db,
                                input.workspaceId,
                                input.agentId,
                                orderKey,
                            );
                            const workspaceAfter = await touchWorkspace(txCtx.db, workspaceBefore);
                            await this.#mutations.observe(
                                txCtx,
                                this.#mutations.newEvent({
                                    type: "workspace_agent_reordered",
                                    association: reordered,
                                    previousOrderKey: current.orderKey,
                                    workspace: workspaceAfter,
                                    previousWorkspace: workspaceBefore,
                                }),
                            );
                            return structuredClone(reordered);
                        }),
                ),
        );
    }

    /**
     * Advances the workspace after an attached agent enters or leaves its active public projection.
     *
     * Archival does not remove the durable association or its order key.
     */
    async refreshAgentVisibility(
        ctx: Context,
        workspaceId: string,
        agentId: string,
        visible: boolean,
    ): Promise<void> {
        this.#assertEnabled();
        const input = { workspaceId, agentId };
        this.#assertInput<WorkspaceAgentAttachment>(
            workspaceAgentAttachmentSchema,
            input,
            "agent visibility",
        );
        await this.#agentAssociationLocks.runInLock(
            ctx,
            `agent:${agentId}`,
            async (agentCtx) =>
                await this.#withWorkspaceAgentOwnerLocks(
                    agentCtx,
                    [workspaceId],
                    async (lockCtx) =>
                        await lockCtx.inTx(async (txCtx) => {
                            const before = await this.#requireAgentWorkspace(txCtx, workspaceId);
                            const association = await readWorkspaceAgent(txCtx.db, agentId);
                            if (association?.workspaceId !== workspaceId) {
                                throw new Error(
                                    `Agent "${agentId}" is not attached to that workspace.`,
                                );
                            }
                            const after = await touchWorkspace(txCtx.db, before);
                            await this.#mutations.observe(
                                txCtx,
                                this.#mutations.newEvent({
                                    type: "workspace_agent_visibility_changed",
                                    agentId,
                                    visible,
                                    workspace: after,
                                    previousWorkspace: before,
                                }),
                            );
                        }),
                ),
        );
    }

    async #requireAgentWorkspace(ctx: Context, workspaceId: string): Promise<Workspace> {
        const workspace = await this.get(ctx, workspaceId);
        if (workspace === undefined) {
            throw new Error(`Workspace "${workspaceId}" was not found.`);
        }
        await this.#assertWorkspaceHierarchy(ctx, workspaceId);
        return workspace;
    }

    async #withWorkspaceAgentOwnerLocks<TResult>(
        ctx: Context,
        workspaceIds: readonly string[],
        work: (lockCtx: Context) => Promise<TResult>,
    ): Promise<TResult> {
        const owners = [...new Set(workspaceIds)].sort();
        const acquire = async (index: number, lockCtx: Context): Promise<TResult> => {
            const workspaceId = owners[index];
            if (workspaceId === undefined) return await work(lockCtx);
            return await this.#agentAssociationLocks.runInLock(
                lockCtx,
                `workspace:${workspaceId}`,
                async (nextCtx) => await acquire(index + 1, nextCtx),
            );
        };
        return await acquire(0, ctx);
    }

    async #assertParentBelongsToProject(
        ctx: Context,
        projectRef: string,
        parentId: string,
    ): Promise<void> {
        if (parentId === projectRef) return;
        const parent = await this.get(ctx, parentId);
        if (parent === undefined) {
            throw new Error(`Workspace parent "${parentId}" was not found.`);
        }
        if (parent.projectRef !== projectRef) {
            throw new Error("A workspace parent must belong to the same project.");
        }
        await readWorkspaceAncestorIds(ctx.db, parent);
    }

    async #assertWorkspaceHierarchy(ctx: Context, workspaceId: string): Promise<void> {
        const workspace = await this.get(ctx, workspaceId);
        if (workspace === undefined) {
            throw new Error(`Workspace "${workspaceId}" was not found.`);
        }
        await readWorkspaceAncestorIds(ctx.db, workspace);
    }

    /** Resolves a folder to the workspace that lives in it, for a host resolving a cwd. */
    async getByPath(ctx: Context, path: string): Promise<Workspace | undefined> {
        this.#assertEnabled();
        if (typeof path !== "string" || path.length === 0) {
            throw new Error("Workspace path is invalid.");
        }
        const raw = await requirePromise(
            this.#store.getByPath(ctx, path),
            "Workspace store get by path",
        );
        if (raw === undefined) return undefined;
        assertWorkspace(raw);
        assertWorkspaceRecord(raw);
        if (raw.path !== path) {
            throw new Error("Workspace store returned a workspace with a different path.");
        }
        return structuredClone(raw);
    }

    /** Read one workspace with a bounded, cursor-addressable detail stream. */
    async getPage(
        ctx: Context,
        workspaceId: string,
        query: WorkspaceDetailQuery = {},
    ): Promise<WorkspaceDetailPage> {
        this.#assertEnabled();
        this.#assertId(workspaceId, "workspace");
        if (!Value.Check(workspaceDetailQuerySchema, query)) {
            throw new Error("Workspace detail query is invalid.");
        }
        const workspace = await this.get(ctx, workspaceId);
        if (workspace === undefined) return { workspace: null };
        const detail = workspaceDetailText(workspace);
        const cursor = query.cursor ?? 0;
        const limit = query.limit ?? MAX_WORKSPACE_DETAIL_PAGE_SIZE;
        if (cursor > detail.length) {
            throw new Error("Workspace detail cursor is past the available detail.");
        }
        return fitWorkspaceDetailPage(
            {
                workspace,
                detail: detail.slice(cursor, cursor + limit),
                cursor,
                total: detail.length,
                ...(cursor + limit < detail.length ? { nextCursor: cursor + limit } : {}),
            },
            MAX_WORKSPACE_OUTPUT_CHARACTERS,
        );
    }

    async branchMetadata(ctx: Context, workspaceId: string): Promise<WorkspaceBranchMetadata> {
        this.#assertEnabled();
        this.#assertId(workspaceId, "workspace");
        const raw = await this.#readBranchMetadata(ctx, workspaceId);
        assertWorkspaceBranchMetadata(raw);
        if (raw.workspaceId !== workspaceId) {
            throw new Error("Workspace branch metadata belongs to another workspace.");
        }
        return structuredClone(raw);
    }

    /** Read branch metadata with a bounded, cursor-addressable detail stream. */
    async branchMetadataPage(
        ctx: Context,
        workspaceId: string,
        query: WorkspaceBranchMetadataDetailQuery = {},
    ): Promise<WorkspaceBranchMetadataPage> {
        this.#assertEnabled();
        this.#assertId(workspaceId, "workspace");
        if (!Value.Check(workspaceBranchMetadataDetailQuerySchema, query)) {
            throw new Error("Workspace branch metadata detail query is invalid.");
        }
        const metadata = await this.branchMetadata(ctx, workspaceId);
        const detail = workspaceBranchMetadataDetailText(metadata);
        const cursor = query.cursor ?? 0;
        const limit = query.limit ?? MAX_WORKSPACE_BRANCH_METADATA_DETAIL_PAGE_SIZE;
        if (cursor > detail.length) {
            throw new Error("Workspace branch metadata cursor is past the available detail.");
        }
        return fitWorkspaceBranchMetadataPage(
            {
                ...metadata,
                detail: detail.slice(cursor, cursor + limit),
                cursor,
                total: detail.length,
                ...(cursor + limit < detail.length ? { nextCursor: cursor + limit } : {}),
            },
            MAX_WORKSPACE_OUTPUT_CHARACTERS,
        );
    }

    /** Bounded rows are intentionally compact; get_workspace is the detail path. */
    formatForModel(workspaces: readonly Workspace[]): string {
        assertWorkspaceList(workspaces);
        if (workspaces.length === 0) return "No workspaces.";
        const rows = workspaces.map(workspaceRow);
        const output = rows.join("\n");
        if (output.length <= MAX_WORKSPACE_OUTPUT_CHARACTERS) return output;
        const visible: string[] = [];
        let size = 0;
        for (const row of rows) {
            const next = size + row.length + (visible.length === 0 ? 0 : 1);
            if (next > MAX_WORKSPACE_OUTPUT_CHARACTERS) break;
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
              ? firstWorkspaceDetailPage(page, MAX_WORKSPACE_OUTPUT_CHARACTERS)
              : undefined;
        if (detailPage === undefined) {
            throw new Error("Cannot format an invalid workspace detail page.");
        }
        if (detailPage.workspace === null) return "That workspace does not exist.";
        const output = formatWorkspaceDetailPage(detailPage, MAX_WORKSPACE_OUTPUT_CHARACTERS);
        if (output.length > MAX_WORKSPACE_OUTPUT_CHARACTERS) {
            throw new Error("Workspace detail page exceeds its model-output bound.");
        }
        return output;
    }

    /** Render one bounded mutation result, retaining a cursor when detail needs multiple calls. */
    formatWorkspaceOperationForModel(label: string, workspace: Workspace): string {
        assertWorkspace(workspace);
        const prefix = `${label}\n`;
        if (prefix.length >= MAX_WORKSPACE_OUTPUT_CHARACTERS) {
            throw new Error("Workspace operation label exceeds the model-output bound.");
        }
        const budget = MAX_WORKSPACE_OUTPUT_CHARACTERS - prefix.length;
        const output = `${prefix}${formatWorkspaceDetailPage(
            firstWorkspaceDetailPage(workspace, budget),
            budget,
        )}`;
        if (output.length > MAX_WORKSPACE_OUTPUT_CHARACTERS) {
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
                    firstBranchMetadataPage(page),
                    MAX_WORKSPACE_OUTPUT_CHARACTERS,
                )
              : undefined;
        if (detailPage === undefined) {
            throw new Error("Cannot format invalid workspace branch metadata detail.");
        }
        const output = formatWorkspaceBranchMetadataPage(
            detailPage,
            MAX_WORKSPACE_OUTPUT_CHARACTERS,
        );
        if (output.length > MAX_WORKSPACE_OUTPUT_CHARACTERS) {
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
        const visiblePage = fitPageForModel(page, MAX_WORKSPACE_OUTPUT_CHARACTERS);
        const rows = visiblePage.workspaces.map(workspaceRow);
        const continuation =
            visiblePage.nextCursor === undefined
                ? undefined
                : `More workspaces at cursor ${String(visiblePage.nextCursor)}.`;
        let output = rows.length === 0 ? "No workspaces." : rows.join("\n");
        if (continuation !== undefined) {
            const withContinuation = `${output}\n${continuation}`;
            if (withContinuation.length <= MAX_WORKSPACE_OUTPUT_CHARACTERS)
                output = withContinuation;
        }
        return output;
    }

    /** `#mutateResult` for the callers that only care about the row it produced. */
    async #mutate(
        ctx: Context,
        operation: WorkspaceMutationOperation,
        requestedOperationId: string | undefined,
        workspaceId: string,
        run: (
            txCtx: Context,
            request: WorkspaceMutationRequest,
        ) => Promise<WorkspaceMutationResult>,
        describe: (
            before: Workspace | undefined,
            after: Workspace,
        ) => WorkspaceEventPayload | undefined,
    ): Promise<Workspace> {
        return (
            await this.#mutateResult(
                ctx,
                operation,
                requestedOperationId,
                workspaceId,
                run,
                describe,
            )
        ).workspace;
    }

    async #mutateResult(
        ctx: Context,
        operation: WorkspaceMutationOperation,
        requestedOperationId: string | undefined,
        workspaceId: string,
        run: (
            txCtx: Context,
            request: WorkspaceMutationRequest,
        ) => Promise<WorkspaceMutationResult>,
        describe: (
            before: Workspace | undefined,
            after: Workspace,
        ) => WorkspaceEventPayload | undefined,
    ): Promise<WorkspaceMutationResult> {
        const operationId = requestedOperationId ?? this.#newIdentity(workspaceOperationIdSchema);
        return await this.#mutations.runResult(
            ctx,
            operation,
            operationId,
            workspaceId,
            run,
            describe,
        );
    }

    /**
     * Moves the worktree's branch onto the name the workspace now has, after that name is durable.
     *
     * The rename is Git's work, and Git keeping the old branch is not a failure of the rename the
     * person asked for: the name stands, and the recorded branch goes back to the one Git actually
     * has. Every worktree of a project shares one set of refs, so this takes the project's Git lock
     * the way cutting a worktree does.
     */
    async #moveGitBranch(
        ctx: Context,
        workspace: Workspace,
        previousBranch: string,
    ): Promise<Workspace> {
        if (workspace.branch === previousBranch) return workspace;
        if (workspace.status !== "ready" || workspace.gitCommonDir === undefined) return workspace;
        try {
            await this.#projects.runInProjectGitLock(ctx, workspace.projectRef, async () => {
                await this.#git.renameBranch({
                    expectedCommonDir: workspace.gitCommonDir ?? "",
                    from: previousBranch,
                    to: workspace.branch,
                    workspacePath: workspace.path,
                    ...this.#gitOptions(workspace.projectRef),
                });
            });
            return workspace;
        } catch (error: unknown) {
            // The name the person asked for is already durable. Git keeping the old branch is not
            // a failure of that rename, so the recorded branch goes back to the one Git has.
            ctx.log.warn(
                { branch: workspace.branch, error, workspaceId: workspace.id },
                "The workspace was renamed, but Git kept its old branch.",
            );
            return await this.setBranch(ctx, {
                workspaceId: workspace.id,
                branch: previousBranch,
            });
        }
    }

    /**
     * Starts folder removal on the module's own lifetime. The caller's context is deliberately not
     * used: an archive that has already been committed must not be tied to the request that asked
     * for it, and a failure here cannot reach that caller as an error.
     */
    #runCleanup(workerCtx: Context, work: () => Promise<void>): void {
        const task = work()
            .catch((error: unknown) => {
                workerCtx.log.error("A workspace folder could not be removed.", error);
            })
            .finally(() => {
                this.#cleanupTasks.delete(task);
            });
        this.#cleanupTasks.add(task);
    }

    #assertEnabled(): void {
        if (!this.#enabled) {
            throw new Error("Workspaces are disabled by configuration.");
        }
    }

    #newIdentity(schema: typeof workspaceIdSchema | typeof workspaceOperationIdSchema): string {
        const value = globalThis.crypto.randomUUID();
        if (!Value.Check(schema, value)) {
            throw new Error("The workspaces catalog minted an identity it cannot represent.");
        }
        return value;
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

    #assertPage(page: WorkspacePage, cursor: number, limit: number): void {
        if (page.workspaces.length > limit) {
            throw new Error("Workspace store returned more records than requested.");
        }
        if (page.cursor !== cursor) {
            throw new Error("Workspace page did not answer the requested cursor.");
        }
        const seen = new Set<string>();
        for (const workspace of page.workspaces) {
            if (seen.has(workspace.id)) {
                throw new Error("Workspace page repeated a workspace identity.");
            }
            seen.add(workspace.id);
        }
        if (page.nextCursor === undefined) return;
        if (page.workspaces.length === 0) {
            throw new Error("Workspace page cannot advance an empty page.");
        }
        if (page.nextCursor !== cursor + page.workspaces.length) {
            throw new Error("Workspace page cursor must advance exactly by visible records.");
        }
    }
}

function requirePreviousWorkspace(workspace: Workspace | undefined): Workspace {
    if (workspace === undefined) {
        throw new Error("A workspace update did not have a previous workspace.");
    }
    return workspace;
}

/** Whether the irreversible archival decision has already been made for a workspace. */
function isArchivalDecided(workspace: Workspace): boolean {
    return workspace.status === "archiving" || workspace.status === "archived";
}

/** Why a workspace cannot be worked in, said the way a person would say it. */
function workspaceStatusText(status: Workspace["status"]): string {
    switch (status) {
        case "initializing":
            return "is still being created";
        case "failed":
            return "could not be created";
        case "archiving":
            return "is being archived";
        case "archived":
            return "has been archived";
        default:
            return "is ready";
    }
}

function errorToMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    return typeof error === "string" ? error : JSON.stringify(error);
}

/** A stored failure has to fit in a column and read as a sentence. */
function boundedWorkspaceError(message: string): string {
    const cleaned = message.replaceAll("\u0000", " ").trim();
    return (cleaned.length === 0 ? "Something went wrong." : cleaned).slice(0, MAX_ERROR_LENGTH);
}
