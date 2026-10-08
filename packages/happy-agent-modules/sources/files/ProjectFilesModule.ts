import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { AgentModule } from "@slopus/happy-agent-base";
import {
    computePermissions,
    RunnerUnavailableError,
    type Compute,
} from "@slopus/happy-agent-compute";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { createRootContext, detach, type Context, type RootContext } from "@steve.kite/stdlib";
import { GitRevisionFileTooLargeError, type GitModule } from "../git/index.js";
import type { BotsModule } from "../bots/index.js";
import type { ProjectsModule } from "../projects/index.js";
import { LocalExecutionDisabledError, type RunnersModule } from "../runners/index.js";
import type { WorkspacesModule } from "../workspaces/index.js";
import { MachineFileIndex } from "./impl/MachineFileIndex.js";
import { ProjectFileWatcher } from "./ProjectFileWatcher.js";
import { WorkspaceFileIndex } from "./WorkspaceFileIndex.js";

/** Folder files are the product's own work, so the agent sandbox does not apply to them. */
const PRODUCT = computePermissions("full_access");

const MAX_FILE_BYTES = 44 * 1024 * 1024;
const MAX_CHANGED_PATHS = 256;
const MAX_SEARCH_RESULTS = 50;
const MAX_TREE_ENTRIES = 500;

export const relativeFilePathSchema = Type.String({
    maxLength: 16_384,
    pattern: "^(?!/)(?!.*\\\\)(?!.*\\u0000)(?:[^/]+(?:/[^/]+)*)?$",
});
export const fileSearchQuerySchema = Type.Object(
    {
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_SEARCH_RESULTS })),
        query: Type.String({ maxLength: 512 }),
    },
    { additionalProperties: false },
);
export const fileTreeQuerySchema = Type.Object(
    {
        cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_TREE_ENTRIES })),
        path: Type.Optional(relativeFilePathSchema),
    },
    { additionalProperties: false },
);
export const fileReadQuerySchema = Type.Object(
    { path: relativeFilePathSchema },
    { additionalProperties: false },
);
const fileReadInputSchema = Type.Object(
    { path: Type.String({ minLength: 1, maxLength: 16_384, pattern: "^[^\\u0000]+$" }) },
    { additionalProperties: false },
);
const fileReadLimitSchema = Type.Integer({ minimum: 1, maximum: MAX_FILE_BYTES });
export const fileRevisionQuerySchema = Type.Object(
    {
        path: relativeFilePathSchema,
        revision: Type.String({
            minLength: 1,
            maxLength: 256,
            pattern: "^(?!-)[A-Za-z0-9_./:~^{}@-]+$",
        }),
    },
    { additionalProperties: false },
);
export const fileWriteSchema = Type.Object(
    {
        content: Type.String({ maxLength: MAX_FILE_BYTES * 2 }),
        expectedHash: Type.Union([
            Type.Null(),
            Type.String({ minLength: 64, maxLength: 64, pattern: "^[0-9a-f]{64}$" }),
        ]),
        path: relativeFilePathSchema,
    },
    { additionalProperties: false },
);
export const projectFileCurrentHashSchema = Type.Union([
    Type.Null(),
    Type.String({ minLength: 64, maxLength: 64, pattern: "^[0-9a-f]{64}$" }),
]);
export const projectFilesEventSchema = Type.Object(
    {
        at: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
        eventId: Type.String({ minLength: 1, maxLength: 128 }),
        paths: Type.Union([
            Type.Null(),
            Type.Array(relativeFilePathSchema, {
                maxItems: MAX_CHANGED_PATHS,
                uniqueItems: true,
            }),
        ]),
        type: Type.Literal("files_changed"),
        workspaceId: Type.String({ minLength: 1, maxLength: 128 }),
    },
    { additionalProperties: false },
);

export type FileTreeQuery = Static<typeof fileTreeQuerySchema>;
export type FileSearchQuery = Static<typeof fileSearchQuerySchema>;
export type FileReadQuery = Static<typeof fileReadQuerySchema>;
export type FileRevisionQuery = Static<typeof fileRevisionQuerySchema>;
export type FileWriteInput = Static<typeof fileWriteSchema>;
export type ProjectFileCurrentHash = Static<typeof projectFileCurrentHashSchema>;
export type ProjectFilesEvent = Static<typeof projectFilesEventSchema>;
export type ProjectFilesEventListener = (
    ctx: Context,
    event: ProjectFilesEvent,
) => Promise<void> | void;
export type ProjectFilesUnsubscribe = () => void;

export interface ProjectFileRoot {
    readonly projectId: string;
    readonly workspaceId?: string;
    readonly root: string;
    /** The runner holding the folder, when it is not on this machine. */
    readonly runnerId?: string;
}

export interface FileTreeResult {
    readonly entries: readonly {
        readonly modified: number;
        readonly name: string;
        readonly path: string;
        readonly size: number;
        readonly type: "directory" | "file" | "other" | "symlink";
    }[];
    readonly nextCursor: string | null;
    readonly path: string;
}

export interface FileSearchResult {
    readonly files: readonly { readonly fileName: string; readonly path: string }[];
}

export interface FileReadResult {
    readonly content: string;
    readonly hash: string;
}

export interface FileWriteResult {
    readonly hash: string;
}

interface ComparedWriteResult extends FileWriteResult {
    readonly created: boolean;
}

export class ProjectFileError extends Error {
    readonly code: "conflict" | "forbidden" | "invalid" | "missing" | "too_large" | "unavailable";
    /** The file hash observed by the failed compare-and-swap, or null when it was absent. */
    readonly currentHash: ProjectFileCurrentHash;
    readonly status: 400 | 403 | 404 | 409 | 413 | 503;

    constructor(
        status: ProjectFileError["status"],
        code: ProjectFileError["code"],
        message: string,
        currentHash: ProjectFileCurrentHash = null,
    ) {
        super(message);
        if (!Value.Check(projectFileCurrentHashSchema, currentHash)) {
            throw new Error("The project file conflict hash is invalid.");
        }
        this.name = "ProjectFileError";
        this.code = code;
        this.currentHash = currentHash;
        this.status = status;
    }
}

export class ProjectFilesModule implements AgentModule {
    readonly name = "files";

    readonly #git: GitModule;
    readonly #bots: BotsModule | undefined;
    readonly #listeners = new Set<ProjectFilesEventListener>();
    readonly #projects: ProjectsModule;
    readonly #index: WorkspaceFileIndex;
    readonly #machineIndex: MachineFileIndex;
    readonly #runners: RunnersModule;
    readonly #workspaces: WorkspacesModule;
    readonly #writeLocks = new Map<string, Promise<void>>();
    #closed = false;
    #lifetime: RootContext | undefined;
    #watcher: ProjectFileWatcher | undefined;

    /**
     * @param runners The owner of the machines folders live on. Every read, listing, and write runs
     * on the folder's machine — this one, or the runner holding it — through the same calls.
     */
    constructor(
        projects: ProjectsModule,
        workspaces: WorkspacesModule,
        git: GitModule,
        runners: RunnersModule,
        bots?: BotsModule,
    ) {
        this.#bots = bots;
        this.#git = git;
        this.#index = new WorkspaceFileIndex(git);
        this.#machineIndex = new MachineFileIndex(git);
        this.#projects = projects;
        this.#runners = runners;
        this.#workspaces = workspaces;
    }

    /** Adopts the collection lifetime for filesystem watches that outlive one API request. */
    readonly beforeStart = (ctx: Context): void => {
        this.#lifetime ??= detach(ctx);
    };

    onEvent(listener: ProjectFilesEventListener): ProjectFilesUnsubscribe {
        if (typeof listener !== "function") {
            throw new Error("A project files subscriber must be a function.");
        }
        this.#listeners.add(listener);
        return () => {
            this.#listeners.delete(listener);
        };
    }

    async close(): Promise<void> {
        if (this.#closed) return;
        this.#closed = true;
        this.#listeners.clear();
        this.#index.close();
        this.#machineIndex.close();
        await this.#watcher?.close();
        this.#watcher = undefined;
    }

    async resolveRoot(
        ctx: Context,
        projectId: string,
        workspaceId?: string,
    ): Promise<ProjectFileRoot> {
        const project = await this.#projects.get(ctx, projectId);
        if (project === undefined) {
            throw new ProjectFileError(404, "missing", "The project was not found.");
        }
        if (workspaceId === undefined) {
            const { path, runnerId } = this.#projects.location(project);
            return { projectId, ...(await this.#canonicalRoot(runnerId, path)) };
        }
        const workspace = await this.#workspaces.get(ctx, workspaceId);
        if (workspace === undefined || workspace.projectRef !== projectId) {
            throw new ProjectFileError(404, "missing", "The workspace was not found.");
        }
        if (workspace.status !== "ready") {
            throw new ProjectFileError(
                409,
                "conflict",
                "Only ready, available workspaces can access files.",
            );
        }
        // The workspace record says where it lives. A managed worktree sits in the agent's
        // workspaces directory, not inside the project, so deriving a path from the project would
        // name a folder that does not exist and hide the one that does.
        try {
            return {
                projectId,
                workspaceId,
                ...(await this.#canonicalRoot(workspace.runnerId, workspace.path)),
            };
        } catch (error) {
            if (error instanceof ProjectFileError && error.status === 403) throw error;
            if (isMachineRefusal(error)) throw error;
            throw new ProjectFileError(
                409,
                "conflict",
                "Only ready, available workspaces can access files.",
            );
        }
    }

    /** Resolve one unlisted bot workspace through the catalog that owns its physical folder. */
    async resolveBotRoot(ctx: Context, workspaceId: string): Promise<ProjectFileRoot> {
        const bot = await this.#bots?.forWorkspace(ctx, workspaceId);
        if (bot === undefined) {
            throw new ProjectFileError(404, "missing", "The workspace was not found.");
        }
        if (bot.status !== "active") {
            throw new ProjectFileError(409, "conflict", "The workspace is not available.");
        }
        return {
            projectId: bot.id,
            workspaceId: bot.workspaceId,
            ...(await this.#canonicalRoot(bot.runnerId, bot.path)),
        };
    }

    async search(root: ProjectFileRoot, query: FileSearchQuery): Promise<FileSearchResult> {
        assertSchema(fileSearchQuerySchema, query, "file search query");
        const limit = query.limit ?? MAX_SEARCH_RESULTS;
        try {
            // The native index reads this machine's disk; a runner lists its folder itself.
            if (root.runnerId === undefined) {
                return { files: await this.#index.search(root.root, query.query, limit) };
            }
            const machine = await this.#machine(root);
            const folder = { root: root.root, runnerId: root.runnerId };
            this.#watcherInstance().watchTree({ ...root, runnerId: root.runnerId }, machine);
            return {
                files: await this.#machineIndex.search(
                    machine,
                    folder,
                    query.query,
                    limit,
                    this.#watcherInstance().watchingTree(root),
                ),
            };
        } catch (error) {
            if (isMachineRefusal(error)) throw error;
            throw new ProjectFileError(
                503,
                "unavailable",
                "Workspace files could not be indexed. Try again shortly.",
            );
        }
    }

    async tree(root: ProjectFileRoot, query: FileTreeQuery): Promise<FileTreeResult> {
        assertSchema(fileTreeQuerySchema, query, "file tree query");
        const path = query.path ?? "";
        const offset = parseCursor(query.cursor);
        const limit = query.limit ?? 100;
        const machine = await this.#machine(root);
        const directory = await this.#resolveExisting(machine, root.root, path, true);
        this.#watch(root, machine, path, directory);
        const names = [...(await machine.fs.readdir(PRODUCT, directory))].sort((left, right) =>
            left.localeCompare(right),
        );
        const selected = names.slice(offset, offset + limit);
        const information = await machine.fs.lstatMany(
            PRODUCT,
            selected.map((name) => join(directory, name)),
        );
        // A name that disappeared between listing and inspecting it is simply gone.
        const entries = selected.flatMap((name, index) => {
            const entry = information[index];
            if (entry === undefined) return [];
            return [
                {
                    modified: Math.trunc(entry.mtimeMs),
                    name,
                    path: path === "" ? name : `${path}/${name}`,
                    size: entry.isFile ? entry.size : 0,
                    type: entry.isDirectory
                        ? ("directory" as const)
                        : entry.isFile
                          ? ("file" as const)
                          : entry.isSymbolicLink
                            ? ("symlink" as const)
                            : ("other" as const),
                },
            ];
        });
        return {
            entries,
            nextCursor:
                offset + selected.length < names.length ? String(offset + selected.length) : null,
            path,
        };
    }

    /** Smaller transports may lower the ordinary file limit. HTTP paths remain relative. */
    async read(
        root: ProjectFileRoot,
        query: FileReadQuery,
        maximumBytes = MAX_FILE_BYTES,
    ): Promise<FileReadResult> {
        assertSchema(fileReadInputSchema, query, "file read query");
        assertSchema(fileReadLimitSchema, maximumBytes, "file read limit");
        if (query.path.split(/[\\/]/).some((part) => part === "..")) {
            throw new ProjectFileError(
                400,
                "invalid",
                "The path must not contain parent-directory traversal.",
            );
        }
        let relativePath = query.path;
        if (isAbsolute(relativePath)) {
            this.#assertWithinRoot(relativePath, root.root);
            relativePath = relative(root.root, relativePath).split(sep).join("/");
        }
        const machine = await this.#machine(root);
        const path = await this.#resolveExisting(machine, root.root, relativePath, false);
        const information = await machine.fs.lstat(PRODUCT, path);
        // Checking first is what keeps a FIFO or a device from being opened and read at all.
        if (!information.isFile)
            throw new ProjectFileError(400, "invalid", "The requested path is not a regular file.");
        this.#assertSize(information.size, maximumBytes);
        let bytes: Buffer;
        try {
            // The final component must not have become a link since it was resolved.
            bytes = Buffer.from(
                await machine.fs.readFileBuffer(PRODUCT, path, {
                    maxBytes: maximumBytes,
                    noFollow: true,
                }),
            );
        } catch (error) {
            if (isMachineRefusal(error)) throw error;
            if (errorCode(error) === "ELOOP") throw locationChanged();
            const grown = await machine.fs.lstat(PRODUCT, path).catch(() => undefined);
            if (grown !== undefined) this.#assertSize(grown.size, maximumBytes);
            throw error;
        }
        this.#assertSize(bytes.byteLength, maximumBytes);
        // A parent folder swapped for a link during the read would have served another tree.
        if ((await this.#resolveExisting(machine, root.root, relativePath, false)) !== path) {
            throw locationChanged();
        }
        const relativeDirectory = dirname(relativePath);
        this.#watch(
            root,
            machine,
            relativeDirectory === "." ? "" : relativeDirectory,
            dirname(path),
        );
        if (root.runnerId === undefined) this.#index.ensure(root.root, relativePath);
        return { content: bytes.toString("base64"), hash: sha256(bytes) };
    }

    /** Strict callers distinguish missing paths from failed reads; HTTP keeps its preview default. */
    async readRevision(
        root: ProjectFileRoot,
        query: FileRevisionQuery,
        options: { maximumBytes?: number; strict?: boolean } = {},
    ): Promise<{ readonly content: string | null; readonly hash: string | null }> {
        const maximumBytes = options.maximumBytes ?? MAX_FILE_BYTES;
        assertSchema(fileRevisionQuerySchema, query, "file revision query");
        assertSchema(fileReadLimitSchema, maximumBytes, "file read limit");
        if (query.path.length === 0)
            throw new ProjectFileError(400, "invalid", "A file path is required.");
        this.#assertRelativePath(query.path);
        try {
            const file = await this.#git.readFileAtRevision({
                maximumBytes,
                path: root.root,
                relativePath: query.path,
                revision: query.revision,
                ...(root.runnerId === undefined ? {} : { runnerId: root.runnerId }),
            });
            if (!file.found) return { content: null, hash: null };
            const bytes = Buffer.from(file.content);
            return { content: bytes.toString("base64"), hash: sha256(bytes) };
        } catch (error) {
            if (!options.strict) return { content: null, hash: null };
            if (error instanceof GitRevisionFileTooLargeError)
                throw new ProjectFileError(
                    413,
                    "too_large",
                    "The file exceeds the viewer size limit.",
                );
            throw error;
        }
    }

    async write(root: ProjectFileRoot, input: FileWriteInput): Promise<FileWriteResult> {
        assertSchema(fileWriteSchema, input, "file write request");
        if (input.path.length === 0) {
            throw new ProjectFileError(400, "invalid", "A file path is required.");
        }
        this.#assertRelativePath(input.path);
        const bytes = decodeBase64(input.content);
        this.#assertSize(bytes.byteLength);
        const machine = await this.#machine(root);
        const target = await this.#resolveWritePath(machine, root.root, input.path);
        this.#assertWithinRoot(target, root.root);
        const result = await this.#withWriteLock(
            `${root.runnerId ?? ""}\0${target}`,
            async () => await this.#writeCompared(machine, target, input, bytes),
        );
        if (root.runnerId === undefined) {
            // Live Git state and the native index follow folders on this machine only.
            this.#git.invalidate(root.root);
            this.#git.markChanged({
                path: root.root,
                projectId: root.projectId,
                ...(root.workspaceId === undefined ? {} : { workspaceId: root.workspaceId }),
            });
            if (result.created) this.#index.refresh(root.root);
        } else if (result.created) {
            this.#machineIndex.refresh(root.runnerId, root.root);
        }
        this.#watcherInstance().changed(root, input.path);
        return { hash: result.hash };
    }

    async #writeCompared(
        machine: Compute,
        target: string,
        input: FileWriteInput,
        bytes: Buffer,
    ): Promise<ComparedWriteResult> {
        let current: Buffer | undefined;
        try {
            current = Buffer.from(await machine.fs.readFileBuffer(PRODUCT, target));
        } catch (error) {
            if (errorCode(error) !== "ENOENT") throw error;
        }
        if (input.expectedHash === null && current !== undefined) {
            throw new ProjectFileError(
                409,
                "conflict",
                "The file already exists.",
                sha256(current),
            );
        }
        if (input.expectedHash !== null) {
            const currentHash = current === undefined ? null : sha256(current);
            if (currentHash !== input.expectedHash) {
                throw new ProjectFileError(
                    409,
                    "conflict",
                    "The file changed before it was written.",
                    currentHash,
                );
            }
        }
        await machine.fs.mkdir(PRODUCT, dirname(target), { recursive: true });
        // A replaced file keeps its permissions; the temporary name is unguessable, so writing it
        // cannot land on someone else's file.
        const mode =
            current === undefined ? undefined : (await machine.fs.stat(PRODUCT, target)).mode;
        const temporary = `${target}.${randomUUID()}.tmp`;
        try {
            await machine.fs.writeFile(PRODUCT, temporary, bytes);
            if (mode !== undefined) await machine.fs.chmod(PRODUCT, temporary, mode & 0o7777);
            await machine.fs.move(PRODUCT, temporary, target);
        } finally {
            await machine.fs.rm(PRODUCT, temporary, { force: true }).catch(() => undefined);
        }
        return { created: current === undefined, hash: sha256(bytes) };
    }

    /**
     * Serializes in-process compare-and-swap writes to one canonical path.
     *
     * A lock disappears as soon as its owner releases it, so idle paths retain no state and a
     * burst cannot leave an unbounded chain behind.
     */
    async #withWriteLock<Result>(path: string, work: () => Promise<Result>): Promise<Result> {
        const previous = this.#writeLocks.get(path);
        let release: (() => void) | undefined;
        const current = new Promise<void>((resolve) => {
            release = resolve;
        });
        this.#writeLocks.set(path, current);
        await previous;
        try {
            return await work();
        } finally {
            release?.();
            if (this.#writeLocks.get(path) === current) {
                this.#writeLocks.delete(path);
            }
        }
    }

    /**
     * Proves the recorded folder is still the folder, then hands back its canonical form.
     *
     * A recorded path that now resolves somewhere else is a replaced folder, not a moved one: if
     * a project root or a workspace checkout were swapped for a link, following it would serve
     * one tree's files under another tree's name. Refusing is the only answer that cannot be
     * wrong; the record is corrected by re-probing the project, not by reading through the link.
     */
    async #canonicalRoot(
        runnerId: string | undefined,
        path: string,
    ): Promise<{ readonly root: string; readonly runnerId?: string }> {
        const machine = await this.#runners.machine(runnerId);
        let canonical: string;
        try {
            canonical = await machine.fs.realpath(PRODUCT, path);
            const information = await machine.fs.stat(PRODUCT, canonical);
            if (!information.isDirectory) {
                throw new ProjectFileError(
                    403,
                    "forbidden",
                    "The selected root is not a directory.",
                );
            }
        } catch (error) {
            if (error instanceof ProjectFileError || isMachineRefusal(error)) throw error;
            throw new ProjectFileError(404, "missing", "The selected root does not exist.");
        }
        if (canonical !== resolve(path)) {
            throw new ProjectFileError(
                403,
                "forbidden",
                "The recorded folder now points somewhere else.",
            );
        }
        return runnerId === undefined ? { root: canonical } : { root: canonical, runnerId };
    }

    async #machine(root: ProjectFileRoot): Promise<Compute> {
        return await this.#runners.machine(root.runnerId);
    }

    /** Keeps what a client just looked at current, in the way the folder's machine allows. */
    #watch(root: ProjectFileRoot, machine: Compute, relativeDirectory: string, directory: string) {
        if (root.runnerId === undefined) {
            this.#watcherInstance().watchDirectory(root, relativeDirectory, directory);
        } else {
            this.#watcherInstance().watchTree({ ...root, runnerId: root.runnerId }, machine);
        }
    }

    async #resolveExisting(
        machine: Compute,
        root: string,
        path: string,
        directory: boolean,
    ): Promise<string> {
        this.#assertRelativePath(path);
        const candidate = resolve(root, path);
        if (!isWithin(root, candidate)) {
            throw new ProjectFileError(403, "forbidden", "The path is outside the selected root.");
        }
        let canonical: string;
        try {
            canonical = await machine.fs.realpath(PRODUCT, candidate);
        } catch (error) {
            if (isMachineRefusal(error)) throw error;
            throw new ProjectFileError(404, "missing", "The requested path was not found.");
        }
        this.#assertWithinRoot(canonical, root);
        const information = await machine.fs.lstat(PRODUCT, canonical);
        if (directory && !information.isDirectory) {
            throw new ProjectFileError(400, "invalid", "The requested path is not a directory.");
        }
        return canonical;
    }

    async #resolveWritePath(machine: Compute, root: string, path: string): Promise<string> {
        const candidate = resolve(root, path);
        if (!isWithin(root, candidate)) {
            throw new ProjectFileError(403, "forbidden", "The path is outside the selected root.");
        }
        try {
            return await machine.fs.realpath(PRODUCT, candidate);
        } catch (error) {
            if (isMachineRefusal(error)) throw error;
            const suffix = [basename(candidate)];
            let ancestor = dirname(candidate);
            for (;;) {
                const parent = await machine.fs.realpath(PRODUCT, ancestor).catch(() => undefined);
                if (parent !== undefined) return join(parent, ...suffix);
                const next = dirname(ancestor);
                if (next === ancestor) {
                    throw new ProjectFileError(
                        404,
                        "missing",
                        "The parent directory was not found.",
                    );
                }
                suffix.unshift(basename(ancestor));
                ancestor = next;
            }
        }
    }

    #assertWithinRoot(path: string, root: string): void {
        if (!isWithin(root, path)) {
            throw new ProjectFileError(403, "forbidden", "The path is outside the selected root.");
        }
    }

    #assertRelativePath(path: string): void {
        if (
            !Value.Check(relativeFilePathSchema, path) ||
            path.split("/").some((part) => part === ".." || part === ".")
        ) {
            throw new ProjectFileError(400, "invalid", "The path must be a relative POSIX path.");
        }
    }

    #assertSize(bytes: number, maximumBytes = MAX_FILE_BYTES): void {
        if (bytes > maximumBytes) {
            throw new ProjectFileError(
                413,
                "too_large",
                "The project file exceeds the size limit.",
            );
        }
    }

    #watcherInstance(): ProjectFileWatcher {
        this.#watcher ??= new ProjectFileWatcher(
            this.#root().named("project-file-watcher"),
            async (ctx, root, paths, structural) => {
                if (structural) {
                    if (root.runnerId === undefined) this.#index.refresh(root.root);
                    else this.#machineIndex.refresh(root.runnerId, root.root);
                }
                await this.#publish(ctx, root.workspaceId ?? root.projectId, paths);
            },
        );
        return this.#watcher;
    }

    #root(): RootContext {
        this.#lifetime ??= createRootContext();
        return this.#lifetime;
    }

    async #publish(
        ctx: Context,
        workspaceId: string,
        paths: readonly string[] | null,
    ): Promise<void> {
        const event = {
            at: Date.now(),
            eventId: randomUUID(),
            paths: paths === null ? null : [...paths],
            type: "files_changed" as const,
            workspaceId,
        };
        if (!Value.Check(projectFilesEventSchema, event)) {
            throw new Error("The project files module created an invalid event.");
        }
        if (event.paths !== null) Object.freeze(event.paths);
        Object.freeze(event);
        for (const listener of [...this.#listeners]) {
            try {
                await listener(ctx, event);
            } catch (error: unknown) {
                ctx.log.warn(
                    "A project files subscriber failed after the filesystem changed.",
                    { eventId: event.eventId, workspaceId: event.workspaceId },
                    error,
                );
            }
        }
    }
}

function assertSchema<T extends import("@sinclair/typebox").TSchema>(
    schema: T,
    value: unknown,
    name: string,
): asserts value is Static<T> {
    if (!Value.Check(schema, value))
        throw new ProjectFileError(400, "invalid", `The ${name} is invalid.`);
}

function parseCursor(value: string | undefined): number {
    if (value === undefined) return 0;
    if (!/^(0|[1-9][0-9]*)$/.test(value)) {
        throw new ProjectFileError(400, "invalid", "The file-tree cursor is invalid.");
    }
    const cursor = Number(value);
    if (!Number.isSafeInteger(cursor)) {
        throw new ProjectFileError(400, "invalid", "The file-tree cursor is invalid.");
    }
    return cursor;
}

function decodeBase64(value: string): Buffer {
    if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
        throw new ProjectFileError(400, "invalid", "File content must be base64.");
    }
    return Buffer.from(value, "base64");
}

function isWithin(root: string, candidate: string): boolean {
    const rootPath = resolve(root);
    const candidatePath = resolve(candidate);
    return candidatePath === rootPath || candidatePath.startsWith(`${rootPath}${sep}`);
}

/** A refusal from the folder's machine itself, which the caller reports as it stands. */
function isMachineRefusal(error: unknown): boolean {
    return error instanceof RunnerUnavailableError || error instanceof LocalExecutionDisabledError;
}

function errorCode(error: unknown): unknown {
    return typeof error === "object" && error !== null
        ? (error as { code?: unknown }).code
        : undefined;
}

function locationChanged(): ProjectFileError {
    return new ProjectFileError(
        403,
        "forbidden",
        "The file location changed while it was being opened.",
    );
}

function sha256(bytes: Buffer): string {
    return createHash("sha256").update(bytes).digest("hex");
}
