import { createId } from "@paralleldrive/cuid2";
import { ensurePrivateDirectory } from "@slopus/happy-agent-compute";
import {
    type AgentModule,
    type AgentModuleHooks,
    type AgentModuleScope,
    type AgentSystemRef,
    type AnyAgentTool,
} from "@slopus/happy-agent-base";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { afterCommit, backoff, delay, type Context } from "@steve.kite/stdlib";

import { BotsModule } from "../bots/index.js";
import { ComputeModule } from "../compute/index.js";
import { ConfigModule } from "../config/index.js";
import { DurableFunctionsModule } from "../durableFunctions/index.js";
import { ProjectsModule } from "../projects/index.js";
import { TasksModule } from "../tasks/index.js";
import { WorkspacesModule } from "../workspaces/index.js";

import {
    ARTIFACT_UPLOAD_EXPIRY_FUNCTION,
    artifactFileInputSchema,
    artifactListQuerySchema,
    artifactSourceInputSchema,
    artifactUploadExpirySchema,
    artifactVersionQuerySchema,
    ArtifactConflictError,
    ArtifactInputError,
    ArtifactNotFoundError,
    createArtifactInputSchema,
    DEFAULT_ARTIFACT_PAGE_SIZE,
    deleteArtifactInputSchema,
    MAX_ARTIFACT_FILES,
    updateArtifactInputSchema,
    type ArtifactAuthor,
    type ArtifactCreation,
    type ArtifactFile,
    type ArtifactFileInput,
    type ArtifactListQuery,
    type ArtifactPage,
    type ArtifactPlacement,
    type ArtifactRecord,
    type ArtifactSource,
    type ArtifactSourceInput,
    type ArtifactStoredFile,
    type ArtifactType,
    type ArtifactUpload,
    type ArtifactVersion,
    type ArtifactVersionPage,
    type ArtifactVersionQuery,
    type ArtifactVersionSelector,
    type CreateArtifactInput,
    type DeleteArtifactInput,
    type UpdateArtifactInput,
} from "./Artifact.js";
import {
    artifactEventSchema,
    type ArtifactEvent,
    type ArtifactEventListener,
    type ArtifactUnsubscribe,
} from "./ArtifactEvent.js";
import { artifactMigrations } from "./ArtifactMigrations.js";
import {
    deleteArtifactUpload,
    insertArtifact,
    insertArtifactUpload,
    insertArtifactVersion,
    queryArtifact,
    queryArtifactContentInUse,
    queryArtifactFile,
    queryArtifactPage,
    queryArtifactUpload,
    queryArtifactVersion,
    queryArtifactVersionForOperation,
    queryArtifactVersionPage,
    updateArtifactDeleted,
    updateArtifactUploadReceived,
} from "./ArtifactStore.js";
import {
    ARTIFACT_UPLOAD_LIFETIME_MS,
    artifactMimeTypeForPath,
    checkArtifactFiles,
    compareArtifactPaths,
    MAX_ARTIFACT_UPLOAD_BYTES,
} from "./ArtifactTypes.js";
import {
    artifactFileExists,
    readArtifactContent,
    receiveArtifactContent,
    removeArtifactFile,
    storeArtifactContent,
    type ArtifactContentSource,
} from "./impl/artifactContentFiles.js";
import { createArtifactTool } from "./tools/create_artifact.js";
import { deleteArtifactTool } from "./tools/delete_artifact.js";
import { listArtifactsTool } from "./tools/list_artifacts.js";
import { readArtifactFileTool } from "./tools/read_artifact_file.js";
import { readArtifactTool } from "./tools/read_artifact.js";
import { updateArtifactTool } from "./tools/update_artifact.js";

/** Who is acting and where, as an agent's own conversation decides it. */
export interface ArtifactActor {
    readonly author: ArtifactAuthor;
    readonly source: ArtifactSource;
}

/**
 * Finished work published to one global catalog: Markdown documents and HTML pages with the files
 * they refer to, images, image series, videos, and documents, with every version kept.
 *
 * Every version is a small tree of files named by path, so an entry's relative references resolve
 * to the files beside it. Content is stored once per digest in the daemon's private artifacts
 * folder, never in a project, and a file a new version keeps is not stored again. Bytes always
 * arrive as an upload first: an upload is recorded, together with the durable call that removes it
 * once it expires, before any of its bytes are written, so content nobody ends up using cannot
 * outlive its upload. Creating and changing an artifact then place uploads at paths inside one
 * database transaction, which makes those operations ordinary transactional work.
 */
export class ArtifactsModule implements AgentModule {
    readonly name = "artifacts";
    readonly migrations = artifactMigrations;

    readonly #config: ConfigModule;
    readonly #durableFunctions: DurableFunctionsModule;
    readonly #compute: ComputeModule;
    readonly #projects: ProjectsModule;
    readonly #workspaces: WorkspacesModule;
    readonly #bots: BotsModule;
    readonly #tasks: TasksModule;
    readonly #listeners = new Set<ArtifactEventListener>();
    #agents: AgentSystemRef | undefined;
    #home: Promise<void> | undefined;

    constructor(
        config: ConfigModule,
        durableFunctions: DurableFunctionsModule,
        compute: ComputeModule,
        projects: ProjectsModule,
        workspaces: WorkspacesModule,
        bots: BotsModule,
        tasks: TasksModule,
    ) {
        this.#config = config;
        this.#durableFunctions = durableFunctions;
        this.#compute = compute;
        this.#projects = projects;
        this.#workspaces = workspaces;
        this.#bots = bots;
        this.#tasks = tasks;
        // An upload's removal is owed from the moment it is recorded. Using it cancels the call;
        // otherwise the call waits out the upload's lifetime, across restarts, and removes it.
        durableFunctions.register({
            name: ARTIFACT_UPLOAD_EXPIRY_FUNCTION,
            argumentsSchema: artifactUploadExpirySchema,
            resultSchema: Type.Null(),
            executor: async (ctx, call) => {
                const remaining = call.arguments.expiresAt - Date.now();
                if (remaining > 0) await delay(ctx, remaining);
                await backoff(ctx, async (attemptCtx) => {
                    await this.#removeUpload(attemptCtx, call.arguments.uploadId);
                });
                return null;
            },
        });
    }

    readonly #hooks: AgentModuleHooks = {
        tools: async (_ctx: Context, scope: AgentModuleScope): Promise<readonly AnyAgentTool[]> => [
            createArtifactTool(this, this.#compute, scope.agent.id),
            updateArtifactTool(this, this.#compute, scope.agent.id),
            listArtifactsTool(this, scope.agent.id),
            readArtifactTool(this),
            readArtifactFileTool(this),
            deleteArtifactTool(this, scope.agent.id),
        ],
    };

    readonly beforeStart = (_ctx: Context, agents: AgentSystemRef): AgentModuleHooks => {
        this.#agents = agents;
        return this.#hooks;
    };

    onEvent(listener: ArtifactEventListener): ArtifactUnsubscribe {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }

    /** One artifact, a tombstone included. */
    async get(ctx: Context, artifactId: string): Promise<ArtifactRecord | undefined> {
        return structuredClone(await queryArtifact(ctx, artifactId));
    }

    /** One page of the catalog, newest created first. */
    async list(ctx: Context, query: ArtifactListQuery = {}): Promise<ArtifactPage> {
        if (!Value.Check(artifactListQuerySchema, query)) {
            throw new ArtifactInputError("The artifact list filter is invalid.");
        }
        if (query.sourceId !== undefined && query.sourceKind === undefined) {
            throw new ArtifactInputError("Filter by a source ID only together with its kind.");
        }
        if (query.authorId !== undefined && query.authorKind === undefined) {
            throw new ArtifactInputError("Filter by an author ID only together with its kind.");
        }
        const page = await queryArtifactPage(ctx, query);
        if (page === undefined) throw new ArtifactInputError("The page cursor is not recognized.");
        const last = page.artifacts.at(-1);
        return structuredClone({
            artifacts: page.artifacts,
            ...(page.hasMore && last !== undefined ? { nextAfter: last.id } : {}),
        });
    }

    /** One page of an active artifact's versions, newest first. */
    async listVersions(
        ctx: Context,
        artifactId: string,
        query: ArtifactVersionQuery = {},
    ): Promise<ArtifactVersionPage> {
        if (!Value.Check(artifactVersionQuerySchema, query)) {
            throw new ArtifactInputError("The artifact version query is invalid.");
        }
        return await ctx.inTx(async (txCtx) => {
            await this.#requiredActive(txCtx, artifactId);
            const page = await queryArtifactVersionPage(
                txCtx,
                artifactId,
                query.before,
                query.limit ?? DEFAULT_ARTIFACT_PAGE_SIZE,
            );
            const last = page.versions.at(-1);
            return structuredClone({
                versions: page.versions,
                ...(page.hasMore && last !== undefined ? { nextBefore: last.number } : {}),
            });
        });
    }

    /**
     * One version of an active artifact with its whole manifest; `latest` is whichever version is
     * latest as this reads.
     */
    async getVersion(
        ctx: Context,
        artifactId: string,
        selector: ArtifactVersionSelector,
    ): Promise<ArtifactVersion> {
        return await ctx.inTx(async (txCtx) => {
            const artifact = await this.#requiredActive(txCtx, artifactId);
            const number = selector === "latest" ? artifact.latestVersion : selector;
            const version = await queryArtifactVersion(txCtx, artifactId, number);
            if (version === undefined)
                throw new ArtifactNotFoundError("The version was not found.");
            return structuredClone(version);
        });
    }

    /**
     * One file of one version of an active artifact, by its exact path, and where its bytes are on
     * this machine, for a caller that streams them. Only a path the version's manifest holds is
     * ever matched, so no path can reach anything else. Stored content never changes.
     */
    async storedFile(
        ctx: Context,
        artifactId: string,
        selector: ArtifactVersionSelector,
        path: string,
    ): Promise<ArtifactStoredFile> {
        return await ctx.inTx(async (txCtx) => {
            const artifact = await this.#requiredActive(txCtx, artifactId);
            const number = selector === "latest" ? artifact.latestVersion : selector;
            const file = await queryArtifactFile(txCtx, artifactId, number, path);
            if (file === undefined) {
                if ((await queryArtifactVersion(txCtx, artifactId, number)) === undefined) {
                    throw new ArtifactNotFoundError("The version was not found.");
                }
                throw new ArtifactNotFoundError(`The version has no file at "${path}".`);
            }
            return {
                file,
                version: number,
                contentPath: this.#config.artifactContentPath(file.sha256),
            };
        });
    }

    /**
     * At most `maxBytes` of one stored file, starting `offset` bytes in, and whether more of the
     * file follows.
     */
    async readFile(
        ctx: Context,
        artifactId: string,
        selector: ArtifactVersionSelector,
        path: string,
        window: { readonly offset?: number; readonly maxBytes: number },
    ): Promise<{
        readonly file: ArtifactFile;
        readonly version: number;
        readonly offset: number;
        readonly bytes: Uint8Array;
        readonly more: boolean;
    }> {
        const stored = await this.storedFile(ctx, artifactId, selector, path);
        const offset = Math.min(Math.max(0, window.offset ?? 0), stored.file.size);
        const bytes = await readArtifactContent(
            stored.contentPath,
            offset,
            Math.max(0, Math.min(window.maxBytes, stored.file.size - offset)),
        );
        return {
            file: stored.file,
            version: stored.version,
            offset,
            bytes,
            more: offset + bytes.byteLength < stored.file.size,
        };
    }

    /**
     * Receive one file's bytes for a later creation or update to place at a path.
     *
     * The upload and the durable call that removes it after `ARTIFACT_UPLOAD_LIFETIME_MS` commit
     * before any byte is written, then the bytes are written, hashed, and recorded, and only then
     * stored under their digest. Each step commits on its own, so call this outside a transaction:
     * inside one, a rollback would leave written bytes that no upload owns.
     */
    async stageUpload(ctx: Context, content: ArtifactContentSource): Promise<ArtifactUpload> {
        const createdAt = Date.now();
        const pending = {
            id: createId(),
            createdAt,
            expiresAt: createdAt + ARTIFACT_UPLOAD_LIFETIME_MS,
        };
        await ctx.inTx(async (txCtx) => {
            await insertArtifactUpload(txCtx, pending);
            await this.#durableFunctions.invoke(txCtx, {
                function: ARTIFACT_UPLOAD_EXPIRY_FUNCTION,
                arguments: { uploadId: pending.id, expiresAt: pending.expiresAt },
                operationId: uploadOperationId(pending.id),
            });
        });
        await this.#ensureHome();
        const uploadPath = this.#config.artifactUploadPath(pending.id);
        let upload: ArtifactUpload;
        try {
            const received = await receiveArtifactContent(
                uploadPath,
                content,
                MAX_ARTIFACT_UPLOAD_BYTES,
            );
            upload = { ...pending, ...received };
            // The digest is recorded before the content is stored under it, so an expiring upload
            // of the same content always sees this one holding it.
            await ctx.inTx(async (txCtx) => {
                await updateArtifactUploadReceived(txCtx, upload);
            });
        } catch (error: unknown) {
            // Refused bytes owe nothing later: the upload, its bytes, and its removal all end now.
            await ctx.inTx(async (txCtx) => {
                await this.#removeUpload(txCtx, pending.id);
                await this.#durableFunctions.cancel(txCtx, uploadOperationId(pending.id));
            });
            throw error;
        }
        await storeArtifactContent(uploadPath, this.#config.artifactContentPath(upload.sha256));
        return structuredClone(upload);
    }

    /** Receive one text file's whole text, stored as UTF-8. */
    async stageText(ctx: Context, text: string): Promise<ArtifactUpload> {
        return await this.stageUpload(ctx, new TextEncoder().encode(text));
    }

    /**
     * Turn files as a caller describes them — whole texts or staged uploads at paths — into
     * placements of staged uploads, staging each text. Like `stageUpload`, call this outside a
     * transaction.
     */
    async stageFiles(
        ctx: Context,
        files: readonly ArtifactFileInput[],
    ): Promise<ArtifactPlacement[]> {
        if (files.length > MAX_ARTIFACT_FILES) {
            throw new ArtifactInputError(
                `A version holds at most ${String(MAX_ARTIFACT_FILES)} files.`,
            );
        }
        for (const file of files) {
            if (!Value.Check(artifactFileInputSchema, file)) {
                throw new ArtifactInputError(
                    "Each artifact file names its path and either its text or an upload.",
                );
            }
        }
        // Checked before any text is staged, so a refused request leaves no uploads behind.
        if (new Set(files.map((file) => file.path)).size !== files.length) {
            throw new ArtifactInputError("Each path can be written only once per version.");
        }
        const placements: ArtifactPlacement[] = [];
        for (const file of files) {
            placements.push(
                "uploadId" in file
                    ? { path: file.path, uploadId: file.uploadId }
                    : { path: file.path, uploadId: (await this.stageText(ctx, file.text)).id },
            );
        }
        return placements;
    }

    /**
     * Create an artifact and its first version from staged uploads placed at paths, in one
     * transaction that uses the uploads up. An existing artifact with the requested ID is
     * returned unchanged.
     */
    async create(ctx: Context, input: CreateArtifactInput): Promise<ArtifactCreation> {
        if (!Value.Check(createArtifactInputSchema, input)) {
            throw new ArtifactInputError(
                "The artifact creation request is invalid. Check its title, type, and file paths.",
            );
        }
        return await ctx.inTx(async (txCtx) => {
            if (input.id !== undefined) {
                const existing = await queryArtifact(txCtx, input.id);
                if (existing !== undefined) {
                    return { artifact: structuredClone(existing), created: false };
                }
            }
            const { files, entry } = await this.#placeFiles(txCtx, input.type, [], input.files);
            const now = Date.now();
            const artifact: ArtifactRecord = {
                id: input.id ?? createId(),
                type: input.type,
                title: input.title,
                status: "active",
                latestVersion: 1,
                entry,
                fileCount: files.length,
                size: totalSize(files),
                ...(input.source === undefined ? {} : { source: input.source }),
                createdBy: input.author,
                createdAt: now,
                updatedBy: input.author,
                ...(input.source === undefined ? {} : { updatedSource: input.source }),
                updatedAt: now,
                revision: 1,
            };
            const version: ArtifactVersion = {
                artifactId: artifact.id,
                number: 1,
                title: input.title,
                entry,
                files,
                createdBy: input.author,
                ...(input.source === undefined ? {} : { source: input.source }),
                createdAt: now,
            };
            await insertArtifact(txCtx, artifact, version);
            this.#publish(txCtx, {
                eventId: globalThis.crypto.randomUUID(),
                at: now,
                type: "artifact_created",
                artifact,
                version,
            });
            return { artifact: structuredClone(artifact), created: true };
        });
    }

    /**
     * Make a new version from the latest one's files, or from none with `replaceAll`: `files`
     * adds or replaces paths and `remove` takes paths out, so unchanged files carry over without
     * being sent again. An omitted title keeps the current title. A version already made under
     * the same `operationId` is not made again.
     */
    async update(ctx: Context, input: UpdateArtifactInput): Promise<ArtifactRecord> {
        if (!Value.Check(updateArtifactInputSchema, input)) {
            throw new ArtifactInputError(
                "The artifact update is invalid. Check its title and file paths.",
            );
        }
        if (
            input.title === undefined &&
            input.files === undefined &&
            input.remove === undefined &&
            input.replaceAll === undefined
        ) {
            throw new ArtifactInputError("Change the title, the files, or both.");
        }
        return await ctx.inTx(async (txCtx) => {
            const current = await this.#required(txCtx, input.artifactId);
            if (
                input.operationId !== undefined &&
                (await queryArtifactVersionForOperation(txCtx, current.id, input.operationId)) !==
                    undefined
            ) {
                return current;
            }
            if (current.status === "deleted") {
                throw new ArtifactConflictError(
                    "The artifact was deleted, so it cannot change.",
                    current,
                );
            }
            this.#assertRevision(current, input.expectedRevision);
            const latest = await queryArtifactVersion(txCtx, current.id, current.latestVersion);
            if (latest === undefined) throw new Error("Artifact storage lost the latest version.");
            const kept = new Map(
                input.replaceAll === true ? [] : latest.files.map((file) => [file.path, file]),
            );
            const written = new Set((input.files ?? []).map((placement) => placement.path));
            for (const path of input.remove ?? []) {
                if (written.has(path)) {
                    throw new ArtifactInputError(`"${path}" cannot be both written and removed.`);
                }
                if (!kept.delete(path)) {
                    throw new ArtifactInputError(`The artifact has no file at "${path}".`);
                }
            }
            const { files, entry } = await this.#placeFiles(
                txCtx,
                current.type,
                [...kept.values()],
                input.files ?? [],
            );
            const now = Math.max(Date.now(), current.updatedAt + 1);
            const title = input.title ?? current.title;
            const next: ArtifactRecord = {
                ...current,
                title,
                entry,
                fileCount: files.length,
                size: totalSize(files),
                latestVersion: current.latestVersion + 1,
                updatedBy: input.author,
                updatedAt: now,
                revision: current.revision + 1,
            };
            delete next.updatedSource;
            if (input.source !== undefined) next.updatedSource = input.source;
            const version: ArtifactVersion = {
                artifactId: current.id,
                number: next.latestVersion,
                title,
                entry,
                files,
                createdBy: input.author,
                ...(input.source === undefined ? {} : { source: input.source }),
                createdAt: now,
            };
            await insertArtifactVersion(txCtx, next, version, current.revision, input.operationId);
            this.#publish(txCtx, {
                eventId: globalThis.crypto.randomUUID(),
                at: now,
                type: "artifact_updated",
                artifact: next,
                previousArtifact: current,
                version,
            });
            return structuredClone(next);
        });
    }

    /**
     * Leave a tombstone. The record stays readable, the versions and files stop being served, and
     * the stored content stays on disk. Deleting a tombstone again changes nothing.
     */
    async delete(ctx: Context, input: DeleteArtifactInput): Promise<ArtifactRecord> {
        if (!Value.Check(deleteArtifactInputSchema, input)) {
            throw new ArtifactInputError("The artifact deletion is invalid.");
        }
        return await ctx.inTx(async (txCtx) => {
            const current = await this.#required(txCtx, input.artifactId);
            if (current.status === "deleted") return current;
            this.#assertRevision(current, input.expectedRevision);
            const now = Math.max(Date.now(), current.updatedAt + 1);
            const next: ArtifactRecord = {
                ...current,
                status: "deleted",
                deletedBy: input.author,
                deletedAt: now,
                updatedBy: input.author,
                updatedAt: now,
                revision: current.revision + 1,
            };
            delete next.updatedSource;
            delete next.deletedSource;
            if (input.source !== undefined) {
                next.updatedSource = input.source;
                next.deletedSource = input.source;
            }
            await updateArtifactDeleted(txCtx, next, current.revision);
            this.#publish(txCtx, {
                eventId: globalThis.crypto.randomUUID(),
                at: now,
                type: "artifact_deleted",
                artifact: next,
                previousArtifact: current,
            });
            return structuredClone(next);
        });
    }

    /**
     * The author and source an agent's change is recorded with. Starting at the agent and
     * following its parents, the first agent that is a bot's or a task's, or that belongs to a
     * workspace or a project root, decides the place; the conversation stays the acting agent.
     */
    async actorFor(ctx: Context, agentId: string): Promise<ArtifactActor> {
        const agents = this.#requireAgents();
        let current = agentId;
        for (let depth = 0; depth < 64; depth += 1) {
            const bot = await this.#bots.forAgent(ctx, current);
            if (bot !== undefined) {
                return {
                    author: { kind: "agent", agentId, botId: bot.id },
                    source: { kind: "bot", botId: bot.id, agentId },
                };
            }
            const task = await this.#tasks.forAgent(ctx, current);
            if (task !== undefined) {
                return {
                    author: { kind: "agent", agentId },
                    source: { kind: "task", taskId: task.id, agentId },
                };
            }
            const place = await this.#placeOf(ctx, current, agentId);
            if (place !== undefined) return { author: { kind: "agent", agentId }, source: place };
            const parent = await agents.parentOf(ctx, current);
            if (parent === null) break;
            current = parent;
        }
        return { author: { kind: "agent", agentId }, source: { kind: "agent", agentId } };
    }

    /**
     * A source a person names, checked against what exists. A workspace's project is filled in
     * from the workspace.
     */
    async resolveSource(ctx: Context, input: ArtifactSourceInput): Promise<ArtifactSource> {
        if (!Value.Check(artifactSourceInputSchema, input)) {
            throw new ArtifactInputError("The artifact source is invalid.");
        }
        if (
            input.agentId !== undefined &&
            (await this.#requireAgents().config(ctx, input.agentId)) === undefined
        ) {
            throw new ArtifactInputError("The source names an agent that does not exist.");
        }
        switch (input.kind) {
            case "bot":
                if ((await this.#bots.get(ctx, input.botId)) === undefined) {
                    throw new ArtifactInputError("The source names a bot that does not exist.");
                }
                return structuredClone(input);
            case "task":
                if ((await this.#tasks.get(ctx, input.taskId)) === undefined) {
                    throw new ArtifactInputError("The source names a task that does not exist.");
                }
                return structuredClone(input);
            case "project":
                if ((await this.#projects.get(ctx, input.projectId)) === undefined) {
                    throw new ArtifactInputError("The source names a project that does not exist.");
                }
                return structuredClone(input);
            case "workspace": {
                const workspace = this.#workspacesEnabled
                    ? await this.#workspaces.get(ctx, input.workspaceId)
                    : undefined;
                if (workspace === undefined) {
                    throw new ArtifactInputError(
                        "The source names a workspace that does not exist.",
                    );
                }
                if (input.projectId !== undefined && input.projectId !== workspace.projectRef) {
                    throw new ArtifactInputError("The workspace belongs to a different project.");
                }
                return {
                    kind: "workspace",
                    workspaceId: input.workspaceId,
                    projectId: workspace.projectRef,
                    ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
                };
            }
            case "agent":
                return structuredClone(input);
        }
    }

    get #workspacesEnabled(): boolean {
        return this.#config.configuration.values.features.workspaces;
    }

    /** The project or workspace one agent belongs to, as a source naming the acting agent. */
    async #placeOf(
        ctx: Context,
        agentId: string,
        actingAgentId: string,
    ): Promise<ArtifactSource | undefined> {
        const workspaceId = this.#workspacesEnabled
            ? await this.#workspaces.workspaceForAgent(ctx, agentId)
            : undefined;
        if (workspaceId !== undefined) {
            // A project's ID is its root workspace's ID, so the root reads as the project.
            if ((await this.#projects.get(ctx, workspaceId)) !== undefined) {
                return { kind: "project", projectId: workspaceId, agentId: actingAgentId };
            }
            const workspace = await this.#workspaces.get(ctx, workspaceId);
            if (workspace !== undefined) {
                return {
                    kind: "workspace",
                    workspaceId,
                    projectId: workspace.projectRef,
                    agentId: actingAgentId,
                };
            }
        }
        const project = await this.#projects.projectForAgent(ctx, agentId);
        if (project !== undefined) {
            return { kind: "project", projectId: project.id, agentId: actingAgentId };
        }
        return undefined;
    }

    /**
     * A version's files: the kept ones with staged uploads placed over them, checked against the
     * type's rules, in path order. The uploads are used up in the caller's transaction, and only
     * once everything checks out. Every upload must exist, be received, be unexpired, and still
     * have its content stored.
     */
    async #placeFiles(
        ctx: Context,
        type: ArtifactType,
        kept: readonly ArtifactFile[],
        placements: readonly ArtifactPlacement[],
    ): Promise<{ readonly files: ArtifactFile[]; readonly entry: ArtifactFile }> {
        if (new Set(placements.map((placement) => placement.path)).size !== placements.length) {
            throw new ArtifactInputError("Each path can be written only once per version.");
        }
        if (new Set(placements.map((placement) => placement.uploadId)).size !== placements.length) {
            throw new ArtifactInputError("Each upload can be placed only once.");
        }
        const byPath = new Map(kept.map((file) => [file.path, file]));
        const notUtf8 = new Set<string>();
        const now = Date.now();
        for (const placement of placements) {
            const upload = (await queryArtifactUpload(ctx, placement.uploadId))?.received;
            if (upload === undefined || upload.expiresAt <= now) {
                throw new ArtifactNotFoundError(
                    `The upload for "${placement.path}" was not found. It may have expired or been used already; upload the file again.`,
                );
            }
            if (!(await artifactFileExists(this.#config.artifactContentPath(upload.sha256)))) {
                throw new ArtifactNotFoundError(
                    `The content uploaded for "${placement.path}" is missing; upload the file again.`,
                );
            }
            if (!upload.utf8) notUtf8.add(placement.path);
            byPath.set(placement.path, {
                path: placement.path,
                mimeType: artifactMimeTypeForPath(placement.path),
                size: upload.size,
                sha256: upload.sha256,
            });
        }
        const files = [...byPath.values()].sort((left, right) =>
            compareArtifactPaths(left.path, right.path),
        );
        const entry = checkArtifactFiles(type, files, notUtf8);
        for (const placement of placements) {
            await deleteArtifactUpload(ctx, placement.uploadId);
            await this.#durableFunctions.cancel(ctx, uploadOperationId(placement.uploadId));
        }
        return { files, entry };
    }

    /**
     * Remove one upload and its bytes unless something still holds them. This runs in one
     * transaction, so a creation using the same content either commits first and keeps it, or
     * finds it gone.
     */
    async #removeUpload(ctx: Context, uploadId: string): Promise<void> {
        await ctx.inTx(async (txCtx) => {
            const upload = await queryArtifactUpload(txCtx, uploadId);
            if (upload === undefined) return;
            await deleteArtifactUpload(txCtx, uploadId);
            await removeArtifactFile(this.#config.artifactUploadPath(uploadId));
            const received = upload.received;
            if (
                received !== undefined &&
                !(await queryArtifactContentInUse(txCtx, received.sha256, uploadId))
            ) {
                await removeArtifactFile(this.#config.artifactContentPath(received.sha256));
            }
        });
    }

    #ensureHome(): Promise<void> {
        this.#home ??= ensurePrivateDirectory(this.#config.artifactsHome).catch(
            (error: unknown) => {
                this.#home = undefined;
                throw error;
            },
        );
        return this.#home;
    }

    async #required(ctx: Context, artifactId: string): Promise<ArtifactRecord> {
        const artifact = await queryArtifact(ctx, artifactId);
        if (artifact === undefined) throw new ArtifactNotFoundError();
        return artifact;
    }

    async #requiredActive(ctx: Context, artifactId: string): Promise<ArtifactRecord> {
        const artifact = await this.#required(ctx, artifactId);
        if (artifact.status === "deleted") {
            throw new ArtifactNotFoundError("The artifact was deleted.");
        }
        return artifact;
    }

    #assertRevision(artifact: ArtifactRecord, expectedRevision: number | undefined): void {
        if (expectedRevision !== undefined && artifact.revision !== expectedRevision) {
            throw new ArtifactConflictError("The artifact has changed.", artifact);
        }
    }

    #publish(ctx: Context, event: ArtifactEvent): void {
        if (!Value.Check(artifactEventSchema, event)) {
            throw new Error("The artifact event is invalid.");
        }
        const frozen = deepFreeze(structuredClone(event));
        afterCommit(ctx, async (eventCtx) => {
            for (const listener of [...this.#listeners]) {
                try {
                    await listener(eventCtx, frozen);
                } catch (error: unknown) {
                    eventCtx.log.error(
                        "An artifact subscriber failed.",
                        { eventId: frozen.eventId },
                        error,
                    );
                }
            }
        });
    }

    #requireAgents(): AgentSystemRef {
        if (this.#agents === undefined) throw new Error("The artifacts module has not started.");
        return this.#agents;
    }
}

/** The durable removal of one upload, cancelled when the upload is used. */
function uploadOperationId(uploadId: string): string {
    return `artifact-upload:${uploadId}`;
}

function totalSize(files: readonly ArtifactFile[]): number {
    return files.reduce((total, file) => total + file.size, 0);
}

function deepFreeze<Value>(value: Value): Value {
    if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
    for (const child of Object.values(value)) deepFreeze(child);
    return Object.freeze(value);
}
