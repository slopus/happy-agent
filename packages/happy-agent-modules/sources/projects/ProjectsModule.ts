import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

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
import { type TSchema } from "@sinclair/typebox";
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
import {
    GitModule,
    type GitAuthentication,
    type GitCredentialRef,
    type GitRepositoryFacts,
    type GitRepositoryProbe,
    type ProjectCreator,
} from "../git/index.js";

import {
    MAX_PROJECT_ERROR_LENGTH,
    MAX_PROJECT_INITIALIZATION_ATTEMPTS,
    projectAdoptRemoteNameInputSchema,
    projectAgentIdSchema,
    projectAvatarAssetSchema,
    projectClearAvatarInputSchema,
    projectCreateInputSchema,
    projectEnsureInputSchema,
    projectGitFactsInputSchema,
    projectIdSchema,
    projectInitializationFailureInputSchema,
    projectProbeInputSchema,
    projectRenameInputSchema,
    projectReorderInputSchema,
    projectRepositoryRefSchema,
    projectSetAvatarInputSchema,
    projectSetDefaultBranchInputSchema,
    type Project,
    type ProjectAdoptRemoteNameInput,
    type ProjectAvatarAsset,
    type ProjectClearAvatarInput,
    type ProjectCreateInput,
    type ProjectEnsureInput,
    type ProjectGitFacts,
    type ProjectGitFactsInput,
    type ProjectInitializationFailureInput,
    type ProjectProbeInput,
    type ProjectRemoteSource,
    type ProjectRenameInput,
    type ProjectReorderInput,
    type ProjectSetAvatarInput,
    type ProjectSetDefaultBranchInput,
} from "./Project.js";
import { projectAgentAttachmentSchema, type ProjectAgentOrder } from "./ProjectAgentAssociation.js";
import {
    type CreateRemoteProjectRequest,
    type ProjectCreatorOptions,
    type ProjectCreatorProfile,
    type RegisterProjectRequest,
} from "./ProjectProvisioning.js";
import { ProjectLifecycleError } from "./ProjectLifecycleError.js";
import { ProjectRegistrationError } from "./ProjectRegistrationError.js";
import { findHostingAvatar, findRepositoryAvatar } from "./impl/findProjectAvatar.js";
import { normalizeProjectAvatar } from "./impl/normalizeProjectAvatar.js";
import {
    clientChosenId,
    clientChosenProjectId,
    requestedBaseRef,
    validateManagedProjectFolderName,
    validateProjectName,
} from "./impl/projectNames.js";
import { validateRegistrationPath } from "./impl/validateRegistrationPath.js";
import { projectGitFactsFrom } from "./projectGitFacts.js";
import { ProjectMutations } from "./ProjectMutations.js";
import {
    fitProjectPage,
    formatPageForModel,
    formatProjectForModel,
    formatSettingsForModel,
} from "./ProjectFormat.js";
import { parseCursor, requirePromise } from "./projectRuntime.js";
import {
    type ProjectEventListener,
    type ProjectStateChangeReason,
    type ProjectUnsubscribe,
} from "./ProjectEvent.js";
import { projectMigrations } from "./ProjectMigrations.js";
import { projectPageQuerySchema, type ProjectPage, type ProjectPageQuery } from "./ProjectPage.js";
import { assertProject } from "./ProjectRow.js";
import {
    projectSettingsUpdateInputSchema,
    type ProjectSettings,
    type ProjectSettingsUpdateInput,
} from "./ProjectSettings.js";
import {
    assertProjectPage,
    assertProjectStoreMutationResult,
    createProjectStore,
    type ProjectEnsureResult,
    type ProjectStateChanges,
    type ProjectSettingsUpdateResult,
    type ProjectStore,
    type ProjectStoreMutationResult,
} from "./ProjectStore.js";
import {
    assertProjectRecord,
    assertProjectSettings,
    assertProjectTransition,
    sameJson,
} from "./ProjectTransition.js";
import { folderProjectName, HOME_PROJECT_NAME, projectStorageKey } from "./projectIdentity.js";
import { listProjectsTool } from "./tools/index.js";
import {
    attachProjectRootAgent,
    listProjectRootAgents,
    projectForProjectRootAgent,
    reorderProjectRootAgent,
} from "./store/projectRootAgents.js";
import { touchProject } from "./store/projectRecords.js";

/** How many projects one page may carry, and how much text a page may spend on them. */
export const PROJECT_PAGE_SIZE = 50;
export const MAX_PROJECT_OUTPUT_CHARACTERS = 12_000;

/**
 * The only profile a single-machine installation can resolve.
 *
 * Profiles are a multi-instance idea: a project created on one machine records who created it so
 * another machine can refuse to clone it with the wrong person's credentials. One local
 * installation has exactly one person behind it, and this is what that person is called here.
 */
const LOCAL_PROFILE_ID = "local";

/** How many attempts a failed project gets before it stops being retried on startup. */
const MAX_PROJECT_INITIALIZATION_RETRIES = 3;

/** How many projects are set up at once. Cloning is network work, and two is enough of it. */
const MAX_CONCURRENT_INITIALIZATIONS = 2;

/** Fields one lifecycle write is allowed to move. */
const PROJECT_STATE_FIELDS = [
    "name",
    "nameSource",
    "presence",
    "worktreeSupport",
    "worktreeUnsupportedReason",
    "defaultBranch",
    "initializationStatus",
    "initializationAttempt",
    "initializationError",
    "gitAhead",
    "gitBehind",
    "gitDetached",
    "gitBranch",
    "gitHead",
    "gitUpstream",
] as const satisfies readonly (keyof Project)[];

/**
 * The catalog of the folders an agent works in, and the Git and filesystem work those records
 * describe: canonical paths, managed folders, clones, repository credentials, probes, avatar bytes,
 * and the background setup that carries a new project through to a usable one.
 *
 * It takes configuration, because configuration owns the paths and the credentials this
 * installation runs against; it takes Git, because Git is what clones a repository and reads a
 * folder; and it takes abort, because stopping an agent and everything below it is that module's.
 * Everything else it does itself.
 */
export class ProjectsModule implements AgentModule {
    readonly name = "projects";
    readonly migrations = projectMigrations;

    readonly #abort: AbortModule;
    readonly #config: ConfigModule;
    readonly #git: GitModule;
    readonly #store: ProjectStore;
    readonly #mutations: ProjectMutations;
    readonly #crossWorkspace: boolean;
    #agents: AgentSystemRef | undefined;

    // --- The catalog's own Git and filesystem work -------------------------------------------

    readonly #creators = new Map<string, ProjectCreator>();
    readonly #homeDirectory: string;
    readonly #initializing = new Set<string>();
    readonly #pendingInitializations: string[] = [];
    readonly #projectLocks: MapAsyncLock<string> = mapAsyncLock();
    readonly #agentAssociationLocks: MapAsyncLock<string> = mapAsyncLock();
    readonly #tasks = new Set<Promise<void>>();

    #activeInitializations = 0;
    #closed = false;
    /** The lifetime the catalog's own background work runs on, derived from the first call. */
    #lifetime: RootContext | undefined;
    #storage: AgentDatabase | undefined;
    /** This machine, as the installation that built the catalog named it. */
    #localInstanceId: string | undefined;

    /**
     * @param abort How the work in a project is stopped. Archiving a project is the moment its
     * folders stop being anybody's, so the decision cancels the root agents attached to it rather
     * than leaving them running in a checkout that is about to be removed.
     */
    constructor(config: ConfigModule, git: GitModule, abort: AbortModule) {
        this.#abort = abort;
        this.#config = config;
        this.#git = git;
        this.#store = createProjectStore();
        this.#mutations = new ProjectMutations(this.#store);
        // The catalog spans every project on the machine, so whether the model may see it at all is
        // a setting rather than something a caller decides per installation.
        this.#crossWorkspace = config.configuration.values.features.crossWorkspace;
        this.#homeDirectory = git.normalizeProjectCwd(homedir());
    }

    /** Takes a subscriber that runs inside the transaction a catalog change commits in. */
    onEventTransactional(listener: ProjectEventListener): ProjectUnsubscribe {
        return this.#mutations.onEventTransactional(listener);
    }

    /** Takes a subscriber that runs once a catalog change is durable. */
    onEvent(listener: ProjectEventListener): ProjectUnsubscribe {
        return this.#mutations.onEvent(listener);
    }

    readonly #hooks: AgentModuleHooks = {
        tools: async (ctx: Context, scope: AgentModuleScope): Promise<readonly AnyAgentTool[]> => {
            // The catalog spans every project on the machine, which is exactly what looking
            // outside the current one means, so the user's setting decides whether it exists at
            // all. A subagent works inside the task it was handed and never gets it.
            if (!this.#crossWorkspace) return [];
            const agents = this.#agents;
            if (agents === undefined) {
                throw new Error("The projects module was asked for tools before it started.");
            }
            if ((await agents.parentOf(ctx, scope.agent.id)) !== null) return [];
            return [listProjectsTool(this, scope.agent.id)];
        },
    };

    readonly beforeStart = (_ctx: Context, agents: AgentSystemRef): AgentModuleHooks => {
        this.#agents = agents;
        return this.#hooks;
    };

    async list(ctx: Context, query: ProjectPageQuery = {}): Promise<ProjectPage> {
        this.#assertInput(projectPageQuerySchema, query, "page query");
        const limit = query.limit ?? PROJECT_PAGE_SIZE;
        if (limit > PROJECT_PAGE_SIZE) {
            throw new Error(`A project page cannot exceed ${String(PROJECT_PAGE_SIZE)} rows.`);
        }
        if (query.cursor !== undefined) parseCursor(query.cursor);
        const normalized = { ...structuredClone(query), limit };
        const raw = await requirePromise(this.#store.list(ctx, normalized), "Project store list");
        assertProjectPage(raw);
        this.#assertPage(raw, normalized.cursor, limit);
        for (const project of raw.projects) {
            assertProjectRecord(project);
            if (normalized.status !== undefined && project.status !== normalized.status) {
                throw new Error("The project page returned a row outside the requested status.");
            }
            if (
                normalized.status === undefined &&
                normalized.includeArchived !== true &&
                project.status === "archived"
            ) {
                throw new Error(
                    "The project page returned an archived row that was not asked for.",
                );
            }
        }
        return structuredClone(
            fitProjectPage(raw, normalized.cursor, MAX_PROJECT_OUTPUT_CHARACTERS),
        );
    }

    async get(ctx: Context, projectId: string): Promise<Project | undefined> {
        this.#assertId(projectId);
        const project = await this.#mutations.getOptional(ctx, projectId);
        if (project === undefined) return undefined;
        return structuredClone(project);
    }

    /** Attaches one user-controlled root agent to this project. */
    async attachAgent(ctx: Context, projectId: string, agentId: string): Promise<void> {
        await this.#attachAgent(ctx, projectId, agentId, false);
    }

    /** Attaches one agent whose Agent Base parent belongs to another workspace. */
    async attachManagedRootAgent(ctx: Context, projectId: string, agentId: string): Promise<void> {
        await this.#attachAgent(ctx, projectId, agentId, true);
    }

    async #attachAgent(
        ctx: Context,
        projectId: string,
        agentId: string,
        managedByAnotherAgent: boolean,
    ): Promise<void> {
        const attachment = { projectId, agentId };
        this.#assertInput(projectAgentAttachmentSchema, attachment, "agent attachment");
        const agents = this.#agents;
        if (agents === undefined) {
            throw new Error("The projects module was asked to attach an agent before it started.");
        }
        const parentAgentId = await agents.parentOf(ctx, agentId);
        if (!managedByAnotherAgent && parentAgentId !== null) {
            throw new Error("Only a root agent can be attached to a project.");
        }
        if (managedByAnotherAgent && parentAgentId === null) {
            throw new Error(
                "Only an agent managed by another agent can be attached as a managed project root.",
            );
        }
        await this.#agentAssociationLocks.runInLock(
            ctx,
            `agent:${agentId}`,
            async (agentCtx) =>
                await this.#agentAssociationLocks.runInLock(
                    agentCtx,
                    `project:${projectId}`,
                    async (lockCtx) =>
                        await lockCtx.inTx(async (txCtx) => {
                            const before = await this.#mutations.getRequired(txCtx, projectId);
                            // Archiving cancels the root agents it can see, in its own transaction.
                            // An attachment that commits after that one would leave an agent
                            // running in a project the decision has already scanned past. Reading
                            // the status inside this transaction makes the database settle the
                            // order: whichever commits second sees the first and loses.
                            if (before.status === "archived") {
                                throw new ProjectLifecycleError(
                                    `Project "${projectId}" is archived, so no agent can be attached to it.`,
                                );
                            }
                            const association = await attachProjectRootAgent(txCtx, attachment);
                            if (association === undefined) return;
                            const after = await touchProject(
                                txCtx.db,
                                before,
                                "The project changed while its agent was being attached.",
                            );
                            assertProjectTransition(before, after, []);
                            await this.#mutations.observeMutation(
                                ctx,
                                txCtx,
                                this.#mutations.newEvent({
                                    type: "project_agent_attached",
                                    association,
                                    project: after,
                                    previousProject: before,
                                }),
                            );
                        }),
                ),
        );
    }

    /**
     * Cancels every root agent of a project that is leaving the active catalog.
     *
     * Only the project's own attachments are named here. Each abort carries the whole subagent tree
     * below it, so a helper spawned by a root agent stops with the agent that started it.
     */
    async #abortRootAgents(ctx: Context, projectId: string): Promise<void> {
        for (const agentId of await this.listAgentIds(ctx, projectId)) {
            await this.#abort.abort(ctx, agentId);
        }
    }

    /** Root-agent IDs in durable attachment order, including agents archived by Agent Base. */
    async listAgentIds(ctx: Context, projectId: string): Promise<readonly string[]> {
        return (await this.listAgents(ctx, projectId)).map((association) => association.agentId);
    }

    /** Root-agent order in durable order, including agents archived by Agent Base. */
    async listAgents(ctx: Context, projectId: string): Promise<readonly ProjectAgentOrder[]> {
        this.#assertId(projectId);
        return (await listProjectRootAgents(ctx, projectId)).map((association) => ({
            agentId: association.agentId,
            orderKey: association.orderKey,
        }));
    }

    /** The project an attached root agent belongs to, or undefined when it is not project-owned. */
    async projectForAgent(ctx: Context, agentId: string): Promise<Project | undefined> {
        const project = await projectForProjectRootAgent(ctx, agentId);
        if (project === undefined) return undefined;
        assertProject(project);
        assertProjectRecord(project);
        return structuredClone(project);
    }

    /** Moves a top-level agent within this project's root-agent order. */
    async reorderAgent(
        ctx: Context,
        projectId: string,
        agentId: string,
        afterAgentId: string | null,
    ): Promise<void> {
        this.#assertId(projectId);
        if (!Value.Check(projectAgentIdSchema, agentId)) {
            throw new Error("The project agent ID is invalid.");
        }
        if (afterAgentId !== null && !Value.Check(projectAgentIdSchema, afterAgentId)) {
            throw new Error("The project agent ID to place after is invalid.");
        }
        await this.#agentAssociationLocks.runInLock(
            ctx,
            `agent:${agentId}`,
            async (agentCtx) =>
                await this.#agentAssociationLocks.runInLock(
                    agentCtx,
                    `project:${projectId}`,
                    async (lockCtx) =>
                        await lockCtx.inTx(async (txCtx) => {
                            const before = await this.#mutations.getRequired(txCtx, projectId);
                            const previousOrderKey = (
                                await listProjectRootAgents(txCtx, projectId)
                            ).find((entry) => entry.agentId === agentId)?.orderKey;
                            const association = await reorderProjectRootAgent(
                                txCtx,
                                projectId,
                                agentId,
                                afterAgentId,
                            );
                            if (association === undefined) return;
                            if (previousOrderKey === undefined) {
                                throw new Error(
                                    `Agent "${agentId}" does not belong to project "${projectId}".`,
                                );
                            }
                            const after = await touchProject(
                                txCtx.db,
                                before,
                                "The project changed while its agent was being reordered.",
                            );
                            assertProjectTransition(before, after, []);
                            await this.#mutations.observeMutation(
                                ctx,
                                txCtx,
                                this.#mutations.newEvent({
                                    type: "project_agent_reordered",
                                    association,
                                    previousOrderKey,
                                    project: after,
                                    previousProject: before,
                                }),
                            );
                        }),
                ),
        );
    }

    /**
     * Advances the project after an attached agent enters or leaves its active public projection.
     *
     * Archival does not remove the durable association or its order key.
     */
    async refreshAgentVisibility(
        ctx: Context,
        projectId: string,
        agentId: string,
        visible: boolean,
    ): Promise<void> {
        this.#assertId(projectId);
        if (!Value.Check(projectAgentIdSchema, agentId)) {
            throw new Error("The project agent ID is invalid.");
        }
        await this.#agentAssociationLocks.runInLock(
            ctx,
            `agent:${agentId}`,
            async (agentCtx) =>
                await this.#agentAssociationLocks.runInLock(
                    agentCtx,
                    `project:${projectId}`,
                    async (lockCtx) =>
                        await lockCtx.inTx(async (txCtx) => {
                            const before = await this.#mutations.getRequired(txCtx, projectId);
                            const association = (
                                await listProjectRootAgents(txCtx, projectId)
                            ).find((entry) => entry.agentId === agentId);
                            if (association === undefined) {
                                throw new Error(
                                    `Agent "${agentId}" does not belong to project "${projectId}".`,
                                );
                            }
                            const after = await touchProject(
                                txCtx.db,
                                before,
                                "The project changed while its active agent list was being updated.",
                            );
                            assertProjectTransition(before, after, []);
                            await this.#mutations.observeMutation(
                                ctx,
                                txCtx,
                                this.#mutations.newEvent({
                                    type: "project_agent_visibility_changed",
                                    agentId,
                                    visible,
                                    project: after,
                                    previousProject: before,
                                }),
                            );
                        }),
                ),
        );
    }

    /**
     * Resolves a canonical folder path to its project. This is the catalog's
     * path-keyed identity: a host that knows only a working directory finds the
     * owning project here.
     */
    async getByPath(ctx: Context, repositoryRef: string): Promise<Project | undefined> {
        if (!Value.Check(projectRepositoryRefSchema, repositoryRef)) {
            throw new Error("A project folder must be an absolute path.");
        }
        const project = await this.#mutations.findByPath(ctx, repositoryRef);
        if (project === undefined) return undefined;
        return structuredClone(project);
    }

    async readSettings(ctx: Context, projectId: string): Promise<ProjectSettings> {
        this.#assertId(projectId);
        await this.#mutations.getRequired(ctx, projectId);
        return await this.#mutations.readSettings(ctx, projectId);
    }

    async create(ctx: Context, input: ProjectCreateInput): Promise<Project> {
        this.#assertInput(projectCreateInputSchema, input, "creation");
        const normalized = structuredClone(input);
        const projectId = normalized.id ?? this.#newIdentity();
        const kind = normalized.kind ?? "regular";
        const result = await this.#mutations.run(ctx, {
            changeable: [],
            event: (after) => ({ type: "project_created", project: after }),
            run: async (txCtx) => {
                if (
                    (await this.#mutations.findByPath(txCtx, normalized.repositoryRef)) !==
                    undefined
                ) {
                    throw new Error(
                        `The folder "${normalized.repositoryRef}" is already a project. Use ensure_project instead.`,
                    );
                }
                if ((await this.#mutations.getOptional(txCtx, projectId)) !== undefined) {
                    throw new Error(`Project "${projectId}" already exists.`);
                }
                return await requirePromise(
                    this.#store.create(txCtx, {
                        id: projectId,
                        repositoryRef: normalized.repositoryRef,
                        kind,
                        name:
                            kind === "home"
                                ? HOME_PROJECT_NAME
                                : validateProjectName(normalized.name),
                        nameSource: normalized.nameSource ?? "folder",
                        ...(normalized.description === undefined
                            ? {}
                            : { description: normalized.description }),
                        ...(normalized.remoteSource === undefined
                            ? {}
                            : { remoteSource: normalized.remoteSource }),
                        ...(normalized.requiredSecretKind === undefined
                            ? {}
                            : { requiredSecretKind: normalized.requiredSecretKind }),
                    }),
                    "Project store create",
                );
            },
        });
        return requireProjectFromResult(result);
    }

    /**
     * Converges on one project for a folder. A repeated call returns the
     * existing project, and an archived project comes back to the active
     * catalog rather than becoming a second row for the same folder.
     */
    async ensure(ctx: Context, input: ProjectEnsureInput): Promise<ProjectEnsureResult> {
        this.#assertInput(projectEnsureInputSchema, input, "ensure");
        const normalized = structuredClone(input);
        const candidateId = this.#newIdentity();
        const kind = normalized.kind ?? "regular";
        const result = await this.#mutations.run(ctx, {
            changeable: ["status", "archivedAt"],
            event: (after, before) =>
                before === undefined
                    ? { type: "project_created", project: after }
                    : {
                          type: "project_restored",
                          project: after,
                          previousProject: before,
                      },
            run: async (txCtx) =>
                await requirePromise(
                    this.#store.ensure(txCtx, {
                        id: candidateId,
                        repositoryRef: normalized.repositoryRef,
                        kind,
                        name:
                            kind === "home"
                                ? HOME_PROJECT_NAME
                                : (normalized.name ?? folderProjectName(normalized.repositoryRef)),
                        nameSource: normalized.nameSource ?? "folder",
                        ...(normalized.description === undefined
                            ? {}
                            : { description: normalized.description }),
                        ...(normalized.remoteSource === undefined
                            ? {}
                            : { remoteSource: normalized.remoteSource }),
                        ...(normalized.requiredSecretKind === undefined
                            ? {}
                            : { requiredSecretKind: normalized.requiredSecretKind }),
                    }),
                    "Project store ensure",
                ),
            beforeByPath: normalized.repositoryRef,
        });
        if (result.operation !== "ensure") {
            throw new Error("Project ensure returned another operation.");
        }
        return structuredClone(result);
    }

    async rename(ctx: Context, input: ProjectRenameInput): Promise<Project> {
        this.#assertInput(projectRenameInputSchema, input, "rename");
        // A display name someone typed is trimmed and bounded here, at the boundary it enters the
        // catalog through. The schema only keeps the column honest; what a person may call a project
        // is a narrower question, and it has to be the same answer whichever door the name came in.
        const normalized = { ...structuredClone(input), name: validateProjectName(input.name) };
        const result = await this.#mutations.run(ctx, {
            changeable: ["name", "nameSource"],
            projectId: normalized.projectId,
            event: (after, before) => ({
                type: "project_renamed",
                project: after,
                previousProject: requirePreviousProject(before),
                previousName: requirePreviousProject(before).name,
            }),
            run: async (txCtx) =>
                await requirePromise(
                    this.#store.rename(txCtx, {
                        projectId: normalized.projectId,
                        name: normalized.name,
                        ...(normalized.expectedVersion === undefined
                            ? {}
                            : { expectedVersion: normalized.expectedVersion }),
                    }),
                    "Project store rename",
                ),
        });
        return requireProjectFromResult(result);
    }

    /**
     * Archives a project, and with it every workspace cut from it.
     *
     * The decision also stops the work standing in the project. Its root agents — with the
     * subagents and background processes below them — have their cancellation prepared in the
     * transaction that records the archival, so an archival that succeeds has taken responsibility
     * for that work, and preparation that fails leaves the project active rather than archived with
     * work still going. The signal itself is released after the commit. The workspaces catalog
     * prepares the agents of each workspace it archives in the same transaction, because a
     * project's root agents and a workspace's agents are two separate attachments and neither
     * catalog can see the other's.
     */
    async archive(ctx: Context, projectId: string): Promise<Project> {
        this.#assertId(projectId);
        const result = await this.#mutations.run(ctx, {
            changeable: ["status", "archivedAt"],
            projectId,
            event: (after, before) => ({
                type: "project_archived",
                project: after,
                previousProject: requirePreviousProject(before),
            }),
            run: async (txCtx, before) => {
                const archived = await requirePromise(
                    this.#store.archive(txCtx, { projectId }),
                    "Project store archive",
                );
                // Only the archival that actually happens stops anything. A repeat of an archive
                // already made must not reach into agents that have since moved on.
                if (before !== undefined && before.status !== "archived") {
                    await this.#abortRootAgents(txCtx, projectId);
                }
                return archived;
            },
        });
        const project = requireProjectFromResult(result);
        if (project.status !== "archived") {
            throw new Error("Project archival did not leave the project archived.");
        }
        // Nobody works in this project any more, so the credential it was cloned with stops being
        // available to anything that still asks. Revoking cannot be undone, so it waits until the
        // archival the caller may still roll back is durable.
        afterCommit(ctx, () => this.#git.revokeCredentials(projectId));
        return project;
    }

    /** Brings an archived project back. Restoring an active project changes nothing. */
    async restore(ctx: Context, projectId: string): Promise<Project> {
        this.#assertId(projectId);
        const result = await this.#mutations.run(ctx, {
            changeable: ["status", "archivedAt"],
            projectId,
            event: (after, before) => ({
                type: "project_restored",
                project: after,
                previousProject: requirePreviousProject(before),
            }),
            run: async (txCtx) =>
                await requirePromise(
                    this.#store.restore(txCtx, { projectId }),
                    "Project store restore",
                ),
        });
        const project = requireProjectFromResult(result);
        if (project.status !== "active") {
            throw new Error("Project restoration did not leave the project active.");
        }
        return project;
    }

    async reorder(ctx: Context, input: ProjectReorderInput): Promise<Project> {
        this.#assertInput(projectReorderInputSchema, input, "reorder");
        const normalized = structuredClone(input);
        const result = await this.#mutations.run(ctx, {
            changeable: ["orderKey"],
            projectId: normalized.projectId,
            event: (after, before) => ({
                type: "project_reordered",
                previousOrderKey: requirePreviousProject(before).orderKey,
                project: after,
                previousProject: requirePreviousProject(before),
            }),
            run: async (txCtx) =>
                await requirePromise(
                    this.#store.reorder(txCtx, normalized),
                    "Project store reorder",
                ),
        });
        return requireProjectFromResult(result);
    }

    async setAvatar(ctx: Context, input: ProjectSetAvatarInput): Promise<Project> {
        this.#assertInput(projectSetAvatarInputSchema, input, "avatar");
        const normalized = structuredClone(input);
        const image = await normalizeProjectAvatar(normalized.bytes, normalized.contentType);
        const avatar = {
            kind: "image" as const,
            source: normalized.source,
            thumbhash: image.thumbhash,
        };
        const asset: ProjectAvatarAsset = {
            bytes: new Uint8Array(image.bytes),
            contentHash: image.contentHash,
            contentType: image.contentType,
            etag: `"${image.contentHash}"`,
            height: image.height,
            thumbhash: image.thumbhash,
            width: image.width,
        };
        const result = await this.#mutations.run(ctx, {
            changeable: ["avatar"],
            projectId: normalized.projectId,
            event: (after, before) => ({
                type: "project_avatar_updated",
                project: after,
                previousProject: requirePreviousProject(before),
            }),
            run: async (txCtx) =>
                await requirePromise(
                    this.#store.setAvatar(txCtx, {
                        asset,
                        avatar,
                        projectId: normalized.projectId,
                        ...(normalized.expectedVersion === undefined
                            ? {}
                            : { expectedVersion: normalized.expectedVersion }),
                    }),
                    "Project store set avatar",
                ),
        });
        const project = requireProjectFromResult(result);
        if (!sameJson(project.avatar, avatar)) {
            throw new Error("The stored avatar does not match the one that was requested.");
        }
        return project;
    }

    async clearAvatar(ctx: Context, input: ProjectClearAvatarInput): Promise<Project> {
        this.#assertInput(projectClearAvatarInputSchema, input, "avatar clear");
        const normalized = structuredClone(input);
        const result = await this.#mutations.run(ctx, {
            changeable: ["avatar"],
            projectId: normalized.projectId,
            event: (after, before) => ({
                type: "project_avatar_cleared",
                project: after,
                previousProject: requirePreviousProject(before),
            }),
            run: async (txCtx) =>
                await requirePromise(
                    this.#store.clearAvatar(txCtx, normalized),
                    "Project store clear avatar",
                ),
        });
        const project = requireProjectFromResult(result);
        if (project.avatar !== undefined) {
            throw new Error("The project still has an avatar after it was cleared.");
        }
        return project;
    }

    async avatarAsset(ctx: Context, projectId: string): Promise<ProjectAvatarAsset | undefined> {
        this.#assertId(projectId);
        const project = await this.#mutations.getRequired(ctx, projectId);
        if (project.avatar === undefined) return undefined;
        const raw = await this.#store.readAvatar(ctx, projectId);
        if (raw === undefined) {
            throw new Error("Project avatar metadata points at missing image bytes.");
        }
        assertProjectAvatarAsset(raw);
        if (raw.thumbhash !== project.avatar.thumbhash) {
            throw new Error("The stored project avatar does not match the one asked for.");
        }
        return structuredClone(raw);
    }

    async updateSettings(
        ctx: Context,
        input: ProjectSettingsUpdateInput,
    ): Promise<ProjectSettingsUpdateResult> {
        this.#assertInput(projectSettingsUpdateInputSchema, input, "settings update");
        assertProjectSettings(input.settings);
        const normalized = structuredClone(input);
        return await ctx.inTx(async (txCtx) => {
            const before = await this.#mutations.getRequired(txCtx, normalized.projectId);
            const beforeSettings = await this.#mutations.readSettings(txCtx, normalized.projectId);
            const raw = await requirePromise(
                this.#store.updateSettings(txCtx, normalized),
                "Project store update settings",
            );
            assertProjectStoreMutationResult(raw);
            if (raw.operation !== "update_settings" || raw.projectId !== normalized.projectId) {
                throw new Error("The settings result does not match the requested project.");
            }
            assertProjectSettings(raw.settings);
            const after = await this.#mutations.getRequired(txCtx, normalized.projectId);
            const afterSettings = await this.#mutations.readSettings(txCtx, normalized.projectId);
            if (!sameJson(afterSettings, normalized.settings)) {
                throw new Error("The stored settings do not match the ones that were requested.");
            }
            if (raw.version !== after.version) {
                throw new Error("The settings result carries a stale project version.");
            }
            assertProjectTransition(before, after, []);
            const changed = !sameJson(beforeSettings, afterSettings);
            if (raw.changed !== changed) {
                throw new Error("The settings result reports the wrong change.");
            }
            if (changed) {
                await this.#mutations.observeMutation(
                    ctx,
                    txCtx,
                    this.#mutations.newEvent({
                        type: "project_settings_updated",
                        projectId: normalized.projectId,
                        project: after,
                        previousProject: before,
                        settings: afterSettings,
                    }),
                );
            }
            return structuredClone(raw);
        });
    }

    /**
     * Looks at the project folder and records what it found: whether it is still there, whether a
     * workspace can be cut from it, and where its Git state stands.
     */
    async probe(ctx: Context, projectId: string): Promise<Project> {
        const project = await this.#lookAt(ctx, projectId);
        return await this.#applyProjectProbe(
            ctx,
            projectId,
            await this.#git.probe(project.repositoryRef, {
                isHome: project.kind === "home",
                ...this.#gitOptions(projectId),
            }),
        );
    }

    /**
     * Decides the trunk from the repository itself. Git resolves upward from a folder, so this
     * only asks when the folder is a repository root: a plain directory inside somebody else's
     * repository must not inherit their branch.
     */
    async resolveDefaultBranch(ctx: Context, projectId: string): Promise<Project> {
        const project = await this.#lookAt(ctx, projectId);
        if (project.defaultBranch !== undefined) return project;
        if (!(await this.#isRepositoryRoot(project))) return project;
        const branch = await this.#git.defaultBranch(
            project.repositoryRef,
            this.#gitOptions(projectId),
        );
        if (branch === undefined) return project;
        return await this.setDefaultBranch(ctx, { projectId, branch });
    }

    /**
     * Takes the name the remote repository gives itself. A name a person chose is left alone, and
     * so is a folder that is not a repository root or has no usable remote.
     */
    async resolveRemoteName(ctx: Context, projectId: string): Promise<Project> {
        const project = await this.#lookAt(ctx, projectId);
        if (project.nameSource !== "folder") return project;
        if (!(await this.#isRepositoryRoot(project))) return project;
        const remote = await this.#git.selectRemoteUrl(
            project.repositoryRef,
            this.#gitOptions(projectId),
        );
        const name = remote === undefined ? undefined : this.#git.remoteProjectName(remote);
        if (name === undefined) return project;
        return await this.adoptRemoteName(ctx, { projectId, name });
    }

    /** Records what a host probe of the project folder observed. */
    async applyProbe(ctx: Context, input: ProjectProbeInput): Promise<Project> {
        this.#assertInput(projectProbeInputSchema, input, "probe");
        const normalized = structuredClone(input);
        return await this.#changeState(ctx, normalized.projectId, "probe", () => ({
            presence: normalized.presence,
            worktreeSupport: normalized.worktreeSupport,
            worktreeUnsupportedReason: normalized.worktreeUnsupportedReason ?? null,
            ...(normalized.git === undefined ? {} : gitChanges(normalized.git)),
        }));
    }

    /** Records the branch, head, upstream and divergence a host read from Git. */
    async applyGitFacts(ctx: Context, input: ProjectGitFactsInput): Promise<Project> {
        this.#assertInput(projectGitFactsInputSchema, input, "Git facts");
        const normalized = structuredClone(input);
        return await this.#changeState(ctx, normalized.projectId, "git_facts", () =>
            gitChanges(normalized.git),
        );
    }

    /**
     * Records the trunk this project's workspaces are cut from. It is decided
     * once, so a project that later sits on another branch does not silently
     * start forking from somewhere else.
     */
    async setDefaultBranch(ctx: Context, input: ProjectSetDefaultBranchInput): Promise<Project> {
        this.#assertInput(projectSetDefaultBranchInputSchema, input, "default branch");
        const normalized = structuredClone(input);
        return await this.#changeState(ctx, normalized.projectId, "default_branch", (project) =>
            project.defaultBranch === undefined ? { defaultBranch: normalized.branch } : undefined,
        );
    }

    /** Replaces a folder-derived name with the remote's. A name a person chose stays. */
    async adoptRemoteName(ctx: Context, input: ProjectAdoptRemoteNameInput): Promise<Project> {
        this.#assertInput(projectAdoptRemoteNameInputSchema, input, "remote name");
        const normalized = structuredClone(input);
        return await this.#changeState(ctx, normalized.projectId, "remote_name", (project) =>
            project.nameSource === "folder"
                ? { name: normalized.name, nameSource: "remote" }
                : undefined,
        );
    }

    /** The clone has landed, so the folder now exists. */
    async markCloneReady(ctx: Context, projectId: string): Promise<Project> {
        return await this.#changeState(ctx, projectId, "clone_ready", (project) =>
            project.initializationStatus === "initializing" ? { presence: "present" } : undefined,
        );
    }

    async markInitializationReady(ctx: Context, projectId: string): Promise<Project> {
        return await this.#changeState(ctx, projectId, "initialization_ready", (project) =>
            project.initializationStatus === "initializing"
                ? {
                      initializationStatus: "ready",
                      initializationAttempt: nextAttempt(project),
                      initializationError: null,
                  }
                : undefined,
        );
    }

    async markInitializationFailed(
        ctx: Context,
        input: ProjectInitializationFailureInput,
    ): Promise<Project> {
        this.#assertInput(projectInitializationFailureInputSchema, input, "initialization failure");
        const normalized = structuredClone(input);
        return await this.#changeState(
            ctx,
            normalized.projectId,
            "initialization_failed",
            (project) =>
                project.initializationStatus === "initializing"
                    ? {
                          initializationStatus: "failed",
                          initializationAttempt: nextAttempt(project),
                          initializationError: normalized.error,
                      }
                    : undefined,
        );
    }

    /** Puts a failed project back in line for another initialization attempt. */
    async retryInitialization(ctx: Context, projectId: string): Promise<Project> {
        return await this.#changeState(ctx, projectId, "initialization_retried", (project) =>
            project.initializationStatus === "failed"
                ? { initializationStatus: "initializing", initializationError: null }
                : undefined,
        );
    }

    /**
     * Puts a project back in line for setup. Nothing initializes the home project, so for `home`
     * this is a no-op that returns the row untouched, like every other guarded lifecycle write.
     */
    async refresh(ctx: Context, projectId: string): Promise<Project> {
        return await this.#changeState(ctx, projectId, "refresh", (project) =>
            project.kind === "home"
                ? undefined
                : {
                      initializationStatus: "initializing",
                      initializationAttempt: nextAttempt(project),
                      initializationError: null,
                  },
        );
    }

    /**
     * Asks for a project to be set up again, whatever state it reached, and starts that setup.
     *
     * This is the whole operation a person asks for, so unlike `refresh` it refuses the home project
     * outright rather than quietly doing nothing: somebody who pressed a button deserves to be told
     * there was nothing to press it for.
     */
    async setUpAgain(ctx: Context, projectId: string): Promise<Project> {
        if ((await this.#lookAt(ctx, projectId)).kind === "home") {
            throw new Error("The Home project does not need to be set up.");
        }
        const refreshed = await this.refresh(ctx, projectId);
        await this.scheduleInitialization(ctx, projectId);
        return refreshed;
    }

    // --- Folders, Git, and setup -------------------------------------------------------------
    //
    // Everything below is the work the records describe: canonical paths, managed folders, clones,
    // credentials, probes, avatar bytes, and the background setup that carries a new project
    // through to a usable one. The catalog does it itself; nothing is handed to a host.

    /** Where projects Happy Agent cloned for someone live. */
    get managedProjectsDirectory(): string {
        return this.#git.normalizeFuturePath(this.#config.projectsHome);
    }

    /** The folder that is this machine's Home project. */
    get homeDirectory(): string {
        return this.#homeDirectory;
    }

    // --- What a project's own vocabulary means -----------------------------------------------
    //
    // A workspace is a branch of a project, in a folder named after it. It therefore names things
    // the way a project does, and asks the catalog that owns those rules rather than repeating
    // them.

    /** A display name a person typed: trimmed, bounded, and free of invisible characters. */
    validateName(value: string): string {
        return validateProjectName(value);
    }

    /**
     * An identity a client chose for something it is creating, so a retry lands on what the first
     * attempt made rather than making a second one.
     */
    validateClientChosenId(value: string, entity: string): string {
        return clientChosenId(value, entity);
    }

    /** An explicitly requested base reference, held to something Git can be handed safely. */
    validateBaseRef(value: string | undefined): string | undefined {
        return requestedBaseRef(value);
    }

    /** The folder-safe key a name reduces to, the same way a project folder is named. */
    storageKeyFor(name: string): string {
        return projectStorageKey(name);
    }

    /** What a catalog row keeps of everything Git said, dropping what it has no column for. */
    gitFactsFrom(facts: GitRepositoryFacts): ProjectGitFacts {
        return projectGitFactsFrom(facts);
    }

    /**
     * The credential a Git command against one project must carry, when that project has one.
     *
     * A workspace cut from a private repository needs the same credential the clone used, so the
     * catalog that knows who created a project is what names it. Git holds the token itself.
     */
    gitCredential(projectId: string): GitCredentialRef | undefined {
        const creator = this.#creators.get(projectId) ?? this.#localCreator;
        if (creator === undefined) return undefined;
        return { creator, projectId };
    }

    /** The same, shaped as the options every Git method takes. */
    #gitOptions(projectId: string): { readonly credential?: GitCredentialRef } {
        const credential = this.gitCredential(projectId);
        return credential === undefined ? {} : { credential };
    }

    /** Who a project belongs to when the caller named nobody: this machine, and its one person. */
    get #localCreator(): ProjectCreator | undefined {
        const instanceId = this.#localInstanceId;
        if (instanceId === undefined) return undefined;
        return { instanceId, profileId: LOCAL_PROFILE_ID };
    }

    /**
     * Picks up whatever the last run left unfinished: projects still being set up, failures worth
     * another try.
     */
    async open(ctx: Context, localInstanceId: string): Promise<void> {
        this.#localInstanceId = localInstanceId;
        for (const project of await this.#allProjects(ctx)) {
            if (project.kind !== "regular" || project.status === "archived") continue;
            if (project.initializationStatus === "initializing") {
                await this.scheduleInitialization(ctx, project.id);
            } else if (
                project.initializationStatus === "failed" &&
                project.initializationAttempt < MAX_PROJECT_INITIALIZATION_RETRIES &&
                existsSync(project.repositoryRef)
            ) {
                await this.retryInitialization(ctx, project.id);
                await this.scheduleInitialization(ctx, project.id);
            }
        }
    }

    /** Stops every background lifetime the catalog started and waits for the ones in flight. */
    async close(_ctx: Context): Promise<void> {
        this.#closed = true;
        this.#pendingInitializations.length = 0;
        while (this.#tasks.size > 0) {
            await Promise.allSettled(this.#tasks);
        }
    }

    /**
     * Runs work while this project's Git lock is held.
     *
     * Every worktree of a project shares one set of refs and reflogs, so the catalog that owns the
     * project owns that lock, and the workspaces catalog takes it through here rather than keeping
     * a second lock over the same repository.
     */
    async runInProjectGitLock<T>(
        ctx: Context,
        projectId: string,
        work: (lockedCtx: Context) => Promise<T>,
    ): Promise<T> {
        return await this.#projectLocks.runInLock(ctx, projectId, work);
    }

    /**
     * Finds the project a folder belongs to, importing the folder as a project if it is new.
     *
     * `requestedProjectId` names that import. A project is a folder, so a folder Happy Agent already knows
     * keeps the identity it has and the request is simply answered with it; the requested identity
     * only takes effect for a folder that becomes a project now.
     */
    async resolvePath(ctx: Context, cwd: string, requestedProjectId?: string): Promise<Project> {
        const path = this.#git.normalizeProjectCwd(cwd);
        const importedId =
            requestedProjectId === undefined
                ? undefined
                : clientChosenId(requestedProjectId, "project");
        const existing = await this.getByPath(ctx, path);
        if (existing !== undefined) {
            // A project is only a folder, so working in it again is what brings it back: starting
            // a session restores an archived project instead of asking someone to unarchive it.
            if (importedId !== undefined && importedId !== existing.id) {
                await this.#assertUnusedProjectId(ctx, importedId, path);
            }
            return existing.status === "archived" ? await this.restore(ctx, existing.id) : existing;
        }
        if (importedId !== undefined) {
            await this.#assertUnusedProjectId(ctx, importedId, path);
        }

        const kind = path === this.#homeDirectory ? "home" : "regular";
        const project = await this.create(ctx, {
            ...(importedId === undefined ? {} : { id: importedId }),
            repositoryRef: path,
            kind,
            name: kind === "home" ? HOME_PROJECT_NAME : folderProjectName(path),
        });
        if (kind === "regular") await this.scheduleInitialization(ctx, project.id);
        return project;
    }

    /**
     * Adds one explicit project without starting a session. A Git folder must be the canonical
     * working-tree root; an ordinary readable directory is valid and gets copied workspaces.
     */
    async register(ctx: Context, request: RegisterProjectRequest): Promise<Project> {
        if (!isAbsolute(request.path)) {
            throw new ProjectRegistrationError(
                "invalid_request",
                "The project path must be absolute.",
            );
        }
        if (request.projectId !== undefined) clientChosenProjectId(request.projectId);
        const path = await validateRegistrationPath(this.#git, request.path);
        return await this.resolvePath(
            ctx,
            path,
            ...(request.projectId === undefined ? [] : [request.projectId]),
        );
    }

    /** Refuses a client-chosen project identity that already names another folder. */
    async #assertUnusedProjectId(ctx: Context, id: string, path: string): Promise<void> {
        const known = await this.get(ctx, id);
        if (known !== undefined && known.repositoryRef !== path) {
            throw new ProjectRegistrationError(
                "project_id_conflict",
                "That project ID already names another folder.",
            );
        }
    }

    /** Every project this agent can see, archived ones included. */
    async #allProjects(ctx: Context): Promise<readonly Project[]> {
        return (await this.list(ctx, { includeArchived: true })).projects;
    }

    // --- Setting a project up ----------------------------------------------------------------

    /** Queues the project's setup, if it is not already queued or running. */
    async scheduleInitialization(ctx: Context, projectId: string): Promise<void> {
        if (this.#closed || this.#initializing.has(projectId)) return;
        const project = await this.get(ctx, projectId);
        if (project === undefined) return;
        if (!existsSync(project.repositoryRef) && project.remoteSource === undefined) {
            await this.#failInitialization(ctx, projectId, "The project folder is not available.");
            return;
        }
        this.#initializing.add(projectId);
        this.#pendingInitializations.push(projectId);
        // The lifetime is taken now, while there is still a context to derive it from; the work
        // itself starts on the next tick so the write that asked for it commits first.
        const lifetime = this.#backgroundLifetime(ctx, "project-initialization");
        setImmediate(() => {
            this.#drainInitializations(lifetime);
        });
    }

    #drainInitializations(lifetime: Context): void {
        if (this.#closed) return;
        while (this.#activeInitializations < MAX_CONCURRENT_INITIALIZATIONS) {
            const pending = this.#pendingInitializations.shift();
            if (pending === undefined) return;
            this.#activeInitializations += 1;
            this.#runInBackground(lifetime, "project-initialization", async (workerCtx) => {
                try {
                    await this.#initializeProject(workerCtx, pending);
                } finally {
                    this.#activeInitializations -= 1;
                    this.#initializing.delete(pending);
                    const current = this.#closed ? undefined : await this.get(workerCtx, pending);
                    if (current?.initializationStatus === "initializing") {
                        await this.scheduleInitialization(workerCtx, pending);
                    }
                    if (!this.#closed) this.#drainInitializations(lifetime);
                }
            });
        }
    }

    async #initializeProject(ctx: Context, projectId: string): Promise<void> {
        if (this.#closed) return;
        const project = await this.get(ctx, projectId);
        if (
            project === undefined ||
            project.kind === "home" ||
            project.initializationStatus !== "initializing"
        ) {
            return;
        }
        try {
            if (project.remoteSource !== undefined) {
                await this.#cloneRemoteProject(ctx, project);
                if (this.#closed) return;
            }
            // A new project learns its presence and worktree capability here rather than waiting
            // for the next start, because a client offers "Create workspace" immediately.
            await this.probe(ctx, projectId);
            if (this.#closed) return;

            let remote: string | undefined;
            const repositoryTopLevel = await this.#isRepositoryRoot(project);
            if (repositoryTopLevel) {
                try {
                    remote = await this.#git.selectRemoteUrl(
                        project.repositoryRef,
                        this.#gitOptions(projectId),
                    );
                } catch {
                    // A repository without a usable remote is a perfectly good project.
                }
            }
            if (this.#closed) return;

            // The trunk is decided while the project is being added, so every later workspace has
            // a branch to fork without re-deciding it under someone's request.
            if (repositoryTopLevel) await this.resolveDefaultBranch(ctx, projectId);
            if (this.#closed) return;

            const detectedName =
                remote === undefined ? undefined : this.#git.remoteProjectName(remote);
            const current = await this.get(ctx, projectId);
            if (current === undefined) return;
            if (detectedName !== undefined && current.nameSource === "folder") {
                await this.adoptRemoteName(ctx, { projectId, name: detectedName });
            }

            if ((await this.get(ctx, projectId))?.avatar === undefined) {
                const repositoryAvatar = repositoryTopLevel
                    ? await findRepositoryAvatar(project.repositoryRef)
                    : undefined;
                const hostingAvatar =
                    repositoryAvatar === undefined && remote !== undefined
                        ? await findHostingAvatar(this.#git, remote)
                        : undefined;
                const candidate = repositoryAvatar ?? hostingAvatar;
                if (this.#closed) return;
                if (
                    candidate !== undefined &&
                    (await this.get(ctx, projectId))?.avatar === undefined
                ) {
                    await this.setAvatar(ctx, {
                        bytes: candidate,
                        projectId,
                        source: "generated",
                    });
                }
            }
            if (this.#closed) return;

            await this.markInitializationReady(ctx, projectId);
        } catch (error) {
            if (this.#closed) return;
            // The record says the setup failed and will be tried again; this is the only place the
            // reason itself is readable, so it is logged rather than reported to a caller that has
            // already been answered.
            ctx.log.warn(
                "Setting a project up failed; the record says so and it will be tried again.",
                { projectId },
                error,
            );
            await this.#failInitialization(ctx, projectId, errorToMessage(error));
        }
    }

    async #failInitialization(ctx: Context, projectId: string, message: string): Promise<void> {
        await this.markInitializationFailed(ctx, {
            projectId,
            error: boundedReason(message),
        });
    }

    // --- Remote projects and credentials -----------------------------------------------------

    /** Adds a project whose folder Happy Agent has still to clone from a remote repository. */
    async createRemote(
        ctx: Context,
        request: CreateRemoteProjectRequest,
        options: ProjectCreatorOptions = {},
    ): Promise<Project> {
        const name = validateManagedProjectFolderName(request.name);
        const creator = options.createdBy ?? this.#localCreator;
        if (creator === undefined) {
            throw new ProjectRegistrationError(
                "invalid_request",
                "A person's profile is required to create a managed project.",
            );
        }
        if (request.secret !== undefined && request.source.kind !== "github") {
            throw new ProjectRegistrationError(
                "unsupported_git_source",
                "GitHub credentials can only be used with a GitHub repository.",
            );
        }
        const id =
            request.projectId === undefined ? createId() : clientChosenProjectId(request.projectId);
        const path = this.#git.normalizeFuturePath(join(this.managedProjectsDirectory, name));
        const githubToken =
            options.githubToken ??
            (request.secret?.kind === "github" && creator.instanceId === this.#localInstanceId
                ? this.#config.githubToken
                : undefined);
        if (githubToken !== undefined && request.source.kind !== "github") {
            throw new ProjectRegistrationError(
                "unsupported_git_source",
                "GitHub credentials can only be used with a GitHub repository.",
            );
        }
        const registerCredential = async (): Promise<void> => {
            if (githubToken === undefined || request.source.kind !== "github") return;
            await this.#git.registerCredential({
                creator,
                projectId: id,
                repository: request.source.repository,
                token: githubToken,
            });
        };

        const retried = await this.#retriedRemoteProject(ctx, id, path, request, creator);
        if (retried !== undefined) {
            this.#creators.set(id, creator);
            await registerCredential();
            const canRetry =
                retried.requiredSecretKind !== "github" ||
                this.gitAuthentication(retried.id, creator) !== undefined;
            if (retried.initializationStatus === "failed" && !canRetry) return retried;
            if (retried.initializationStatus === "failed") {
                await this.retryInitialization(ctx, id);
            }
            if (retried.initializationStatus !== "ready" && canRetry) {
                await this.scheduleInitialization(ctx, id);
            }
            return (await this.get(ctx, id)) ?? retried;
        }
        if ((await this.getByPath(ctx, path)) !== undefined) {
            throw new ProjectRegistrationError(
                "project_path_conflict",
                "That managed project folder already belongs to another project.",
            );
        }
        if (existsSync(path)) {
            throw new ProjectRegistrationError(
                "project_path_conflict",
                "That managed project folder already exists.",
            );
        }
        await mkdir(this.managedProjectsDirectory, { recursive: true });
        this.#creators.set(id, creator);
        await registerCredential();
        try {
            const project = await this.create(ctx, {
                id,
                repositoryRef: path,
                kind: "regular",
                name,
                remoteSource: request.source,
                ...(request.secret === undefined
                    ? {}
                    : { requiredSecretKind: request.secret.kind }),
            });
            await this.scheduleInitialization(ctx, id);
            return project;
        } catch (error) {
            const raced = await this.#retriedRemoteProject(ctx, id, path, request, creator);
            if (raced !== undefined) {
                if (raced.initializationStatus !== "ready") {
                    await this.scheduleInitialization(ctx, id);
                }
                return raced;
            }
            this.#git.revokeCredentials(id);
            this.#creators.delete(id);
            if ((await this.getByPath(ctx, path)) !== undefined) {
                throw new ProjectRegistrationError(
                    "project_path_conflict",
                    "That managed project folder already belongs to another project.",
                );
            }
            throw error;
        }
    }

    async #retriedRemoteProject(
        ctx: Context,
        id: string,
        path: string,
        request: CreateRemoteProjectRequest,
        creator: ProjectCreator,
    ): Promise<Project | undefined> {
        const project = await this.get(ctx, id);
        if (project === undefined) return undefined;
        const recordedCreator = this.#creators.get(id);
        if (
            project.repositoryRef !== path ||
            !remoteProjectSourcesEqual(project.remoteSource, request.source) ||
            project.requiredSecretKind !== request.secret?.kind ||
            (recordedCreator !== undefined &&
                (recordedCreator.instanceId !== creator.instanceId ||
                    recordedCreator.profileId !== creator.profileId))
        ) {
            throw new ProjectRegistrationError(
                "project_id_conflict",
                "That project ID already names a different project.",
            );
        }
        return project;
    }

    async #cloneRemoteProject(ctx: Context, project: Project): Promise<void> {
        if (project.remoteSource === undefined) return;
        if (existsSync(project.repositoryRef)) {
            // The folder is already there: either a previous clone landed and the record did not
            // catch up, or something else took the name. Only the right repository counts.
            const topLevel = await this.#git.topLevel(
                project.repositoryRef,
                this.#gitOptions(project.id),
            );
            if (topLevel !== project.repositoryRef) {
                throw new Error("The managed project folder is not the expected Git repository.");
            }
            const origin = await this.#git.run(
                project.repositoryRef,
                ["remote", "get-url", "origin"],
                this.#gitOptions(project.id),
            );
            if (!this.#remoteSourceUrlMatches(origin.stdout.trim(), project.remoteSource)) {
                throw new Error("The managed project folder has a different origin repository.");
            }
            await this.markCloneReady(ctx, project.id);
            return;
        }
        const creator = this.#creators.get(project.id) ?? this.#localCreator;
        if (creator === undefined) {
            throw new Error(
                "This project has no known creator, so its repository cannot be cloned. Add it again from the machine that created it.",
            );
        }
        const profile = await this.#resolveProfile(creator.profileId, creator.instanceId);
        if (profile !== undefined && profile.parentInstanceId !== creator.instanceId) {
            throw new Error("The project creator's profile is unavailable.");
        }
        const credential: GitCredentialRef = { creator, projectId: project.id };
        if (
            project.requiredSecretKind === "github" &&
            this.#git.daemonAuthentication(project.id, creator) === undefined
        ) {
            throw new Error(
                "GitHub credentials are unavailable. Try this project again once GitHub is connected.",
            );
        }
        // Git clones through its own staging directory and renames the finished checkout into
        // place, so a failed or interrupted clone never leaves half a project behind.
        await this.#git.clone({
            credential,
            destination: project.repositoryRef,
            source: project.remoteSource,
            ...(profile === undefined
                ? {}
                : { gitIdentity: { email: profile.email, name: profile.name } }),
        });
        await this.markCloneReady(ctx, project.id);
    }

    /**
     * Who a profile is.
     *
     * One installation acts for one person, so the only profile it can resolve is its own, and who
     * that person is comes from Git: a clone made on their behalf writes commits, and the commits
     * carry the same name and address their own already do.
     */
    async #resolveProfile(
        profileId: string,
        instanceId: string,
    ): Promise<ProjectCreatorProfile | undefined> {
        if (profileId !== LOCAL_PROFILE_ID || instanceId !== this.#localInstanceId)
            return undefined;
        const identity = await this.#git.localIdentity();
        if (identity === undefined) return undefined;
        return { email: identity.email, name: identity.name, parentInstanceId: instanceId };
    }

    async registerGitCredential(
        ctx: Context,
        projectId: string,
        creator: ProjectCreator,
        githubToken: string,
    ): Promise<GitAuthentication> {
        const project = await this.get(ctx, projectId);
        if (project?.remoteSource?.kind !== "github") {
            throw new Error("GitHub credentials can only be used with a GitHub project.");
        }
        this.#creators.set(projectId, creator);
        return await this.#git.registerCredential({
            creator,
            projectId,
            repository: project.remoteSource.repository,
            token: githubToken,
        });
    }

    async refreshGitCredential(
        ctx: Context,
        projectId: string,
        creator: ProjectCreator,
        githubToken: string,
    ): Promise<GitAuthentication> {
        const project = await this.get(ctx, projectId);
        if (project?.remoteSource?.kind !== "github") {
            throw new Error("That profile does not own a managed GitHub project.");
        }
        const recorded = this.#creators.get(projectId);
        if (
            recorded !== undefined &&
            (recorded.instanceId !== creator.instanceId || recorded.profileId !== creator.profileId)
        ) {
            throw new Error("That profile does not own a managed GitHub project.");
        }
        const authentication = await this.registerGitCredential(
            ctx,
            projectId,
            creator,
            githubToken,
        );
        if (project.initializationStatus === "failed") {
            await this.retryInitialization(ctx, projectId);
            await this.scheduleInitialization(ctx, projectId);
        }
        return authentication;
    }

    /** The leaseable credential a command someone runs in this project may carry. */
    gitAuthentication(
        projectId: string,
        creator: ProjectCreator,
    ): ReturnType<GitModule["commandAuthentication"]> {
        return this.#git.commandAuthentication(projectId, creator);
    }

    /** Re-registers the local credential for every managed project and retries what failed. */
    async retryRemoteProjects(ctx: Context, kind: "github"): Promise<void> {
        if (kind !== "github") return;
        const token = this.#config.githubToken;
        if (token === undefined) return;
        for (const project of await this.#allProjects(ctx)) {
            if (project.requiredSecretKind !== kind) continue;
            if (project.remoteSource?.kind !== "github") continue;
            const creator = this.#creators.get(project.id) ?? this.#localCreator;
            if (creator === undefined || creator.instanceId !== this.#localInstanceId) continue;
            try {
                await this.#git.registerCredential({
                    creator,
                    projectId: project.id,
                    repository: project.remoteSource.repository,
                    token,
                });
            } catch {
                continue;
            }
            if (this.#closed) return;
            if (project.initializationStatus === "failed") {
                await this.retryInitialization(ctx, project.id);
            }
            await this.scheduleInitialization(ctx, project.id);
        }
    }

    // --- Git facts ---------------------------------------------------------------------------

    /** Re-derives presence, worktree capability, and Git facts for every live project. */
    async reconcileGitFacts(ctx: Context): Promise<void> {
        for (const project of await this.#allProjects(ctx)) {
            if (this.#closed) return;
            // An archived project is hidden, so re-deriving its Git facts is wasted work.
            if (project.status === "archived") continue;
            await this.probe(ctx, project.id);
        }
    }

    /**
     * Persists Git facts observed by a live scan. Branch, HEAD and upstream are durable state, so
     * a commit or a checkout has to reach clients that are not watching the live stream.
     */
    async recordGitFacts(
        ctx: Context,
        projectId: string,
        facts: GitRepositoryFacts,
    ): Promise<void> {
        await this.applyGitFacts(ctx, {
            projectId,
            git: projectGitFactsFrom(facts),
        });
    }

    async #applyProjectProbe(
        ctx: Context,
        projectId: string,
        probe: GitRepositoryProbe,
    ): Promise<Project> {
        return await this.applyProbe(ctx, {
            projectId,
            presence: probe.presence,
            worktreeSupport: probe.worktreeSupport,
            ...(probe.worktreeSupportReason === undefined
                ? {}
                : { worktreeUnsupportedReason: boundedReason(probe.worktreeSupportReason) }),
            ...(probe.facts === undefined ? {} : { git: projectGitFactsFrom(probe.facts) }),
        });
    }

    /**
     * The lifetime the catalog's own Git and filesystem work runs on.
     *
     * A clone or setup pass outlives the call that asked for it, so it never runs on that call's
     * context. The lifetime is detached from the first context the catalog is
     * used with. A detached context carries no storage — that is what stops work outliving its
     * caller from writing through a transaction facade that has already committed — so the agent
     * database is put back on it deliberately, and nothing else about the request comes along.
     */
    #backgroundLifetime(ctx: Context, name: string): Context {
        this.#lifetime ??= detach(ctx);
        this.#storage ??= ctx.db;
        return withAgentDatabase(this.#lifetime.named(name), this.#storage);
    }

    /**
     * Starts work that outlives whatever asked for it, on its own named lifetime. The caller's
     * context is deliberately not used: a clone must not end when a request does.
     */
    #runInBackground(ctx: Context, name: string, work: (ctx: Context) => Promise<void>): void {
        if (this.#closed) return;
        const task = work(this.#backgroundLifetime(ctx, name))
            .catch(() => undefined)
            .finally(() => {
                this.#tasks.delete(task);
            });
        this.#tasks.add(task);
    }

    formatProjectForModel(label: string, project: Project): string {
        assertProject(project);
        return formatProjectForModel(label, project, MAX_PROJECT_OUTPUT_CHARACTERS);
    }

    formatPageForModel(page: ProjectPage): string {
        assertProjectPage(page);
        return formatPageForModel(page, MAX_PROJECT_OUTPUT_CHARACTERS);
    }

    formatSettingsForModel(projectId: string, settings: ProjectSettings): string {
        assertProjectSettings(settings);
        return formatSettingsForModel(projectId, settings, MAX_PROJECT_OUTPUT_CHARACTERS);
    }

    /** The project this operation names, or a refusal saying it is not in the catalog. */
    async #lookAt(ctx: Context, projectId: string): Promise<Project> {
        this.#assertId(projectId);
        return await this.#mutations.getRequired(ctx, projectId);
    }

    /**
     * Whether Git considers this exact folder a repository root, rather than somewhere inside one.
     */
    async #isRepositoryRoot(project: Project): Promise<boolean> {
        if (project.kind === "home") return false;
        try {
            return (
                (await this.#git.topLevel(project.repositoryRef, this.#gitOptions(project.id))) ===
                project.repositoryRef
            );
        } catch {
            // A regular folder without Git is a perfectly good project.
            return false;
        }
    }

    async #changeState(
        ctx: Context,
        projectId: string,
        reason: ProjectStateChangeReason,
        compute: (project: Project) => ProjectStateChanges | undefined,
    ): Promise<Project> {
        this.#assertId(projectId);
        const result = await this.#mutations.run(ctx, {
            changeable: PROJECT_STATE_FIELDS,
            projectId,
            event: (after, before) => ({
                type: "project_state_changed",
                reason,
                project: after,
                previousProject: requirePreviousProject(before),
            }),
            run: async (txCtx, before) => {
                if (before === undefined) throw new Error(`Project "${projectId}" was not found.`);
                // Archiving is the terminal decision about a project. A clone, a probe, a setup
                // result, or a refresh that was already running when it was made describes a
                // project nobody has any more, and changes nothing about it. Restoring is how a
                // project comes back, and it does not go through here.
                const changes = before.status === "archived" ? undefined : compute(before);
                if (changes === undefined) {
                    return {
                        operation: "state_change" as const,
                        changed: false,
                        project: before,
                    };
                }
                return await requirePromise(
                    this.#store.applyState(txCtx, { projectId, changes }),
                    "Project store state change",
                );
            },
        });
        return requireProjectFromResult(result);
    }

    /** A fresh project identity, minted by this module. */
    #newIdentity(): string {
        const value = createId();
        if (!Value.Check(projectIdSchema, value)) {
            throw new Error("The project catalog minted an identity it cannot represent.");
        }
        return value;
    }

    #assertId(projectId: string): void {
        if (!Value.Check(projectIdSchema, projectId)) {
            throw new Error("The project ID is invalid.");
        }
    }

    #assertInput<T>(schema: TSchema, value: unknown, label: string): asserts value is T {
        if (!Value.Check(schema, value)) {
            throw new Error(`The project ${label} input is invalid.`);
        }
    }

    /** Whether the origin a folder already has is the remote this project was created for. */
    #remoteSourceUrlMatches(actual: string, source: ProjectRemoteSource): boolean {
        try {
            const expected = this.#git.remoteUrlForSource(source);
            const normalizedActual =
                source.kind === "github"
                    ? this.#git.remoteUrlForSource({
                          kind: "github",
                          repository: githubRepositoryFromUrl(actual),
                      })
                    : new URL(actual).toString();
            return source.kind === "github"
                ? normalizedActual.toLowerCase() === expected.toLowerCase()
                : normalizedActual === expected;
        } catch {
            return false;
        }
    }

    #assertPage(page: ProjectPage, cursor: string | undefined, limit: number): void {
        if (page.projects.length > limit) {
            throw new Error("The project store returned more records than requested.");
        }
        for (let index = 1; index < page.projects.length; index += 1) {
            const previous = page.projects[index - 1]!;
            const current = page.projects[index]!;
            if (
                current.orderKey < previous.orderKey ||
                (current.orderKey === previous.orderKey && current.id <= previous.id)
            ) {
                throw new Error("Project page rows must be unique and in catalog order.");
            }
        }
        if (page.nextCursor === undefined) return;
        if (page.projects.length === 0) {
            throw new Error("An empty project page cannot advance its cursor.");
        }
        const start = cursor === undefined ? 0 : parseCursor(cursor);
        const next = parseCursor(page.nextCursor);
        if (next !== start + page.projects.length) {
            throw new Error("A project page cursor must advance by exactly the visible rows.");
        }
    }
}

export function assertProjectAvatarAsset(value: unknown): asserts value is ProjectAvatarAsset {
    if (!Value.Check(projectAvatarAssetSchema, value)) {
        throw new Error("The project avatar asset is invalid.");
    }
}

/** Fits an observed reason into the one bounded sentence a project row keeps. */
function boundedReason(reason: string): string {
    const text = reason.trim().replace(/\s+/gu, " ");
    if (text.length === 0) return "No reason was recorded.";
    return text.length <= MAX_PROJECT_ERROR_LENGTH
        ? text
        : `${text.slice(0, MAX_PROJECT_ERROR_LENGTH - 1)}…`;
}

function gitChanges(git: ProjectGitFacts): ProjectStateChanges {
    return {
        gitAhead: git.ahead,
        gitBehind: git.behind,
        gitBranch: git.branch ?? null,
        gitDetached: git.detached,
        gitHead: git.head ?? null,
        gitUpstream: git.upstream ?? null,
    };
}

function nextAttempt(project: Project): number {
    return Math.min(project.initializationAttempt + 1, MAX_PROJECT_INITIALIZATION_ATTEMPTS);
}

function requireProjectFromResult(result: ProjectStoreMutationResult): Project {
    if (!("project" in result)) {
        throw new Error("A project mutation did not return a project.");
    }
    assertProject(result.project);
    return structuredClone(result.project);
}

function requirePreviousProject(project: Project | undefined): Project {
    if (project === undefined) {
        throw new Error("A project update did not have a previous project.");
    }
    return project;
}

function errorToMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    return typeof error === "string" ? error : JSON.stringify(error);
}

function remoteProjectSourcesEqual(
    left: ProjectRemoteSource | undefined,
    right: ProjectRemoteSource,
): boolean {
    if (left?.kind === "github") {
        return right.kind === "github" && left.repository === right.repository;
    }
    return left?.kind === "git" && right.kind === "git" && left.url === right.url;
}

function githubRepositoryFromUrl(value: string): string {
    const url = new URL(value);
    if (
        url.protocol !== "https:" ||
        url.hostname.toLowerCase() !== "github.com" ||
        url.username.length > 0 ||
        url.password.length > 0
    ) {
        throw new Error("The GitHub origin is invalid.");
    }
    const parts = url.pathname
        .replace(/\.git$/u, "")
        .split("/")
        .filter(Boolean);
    if (parts.length !== 2) throw new Error("The GitHub origin is invalid.");
    return `${parts[0] ?? ""}/${parts[1] ?? ""}`;
}
