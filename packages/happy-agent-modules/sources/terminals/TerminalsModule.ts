import type { Duplex } from "node:stream";

import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { detach, mapAsyncLock, type Context, type MapAsyncLock } from "@steve.kite/stdlib";

import { createUuidV7Factory } from "../events/index.js";
import { BotsModule } from "../bots/index.js";
import { ProjectsModule } from "../projects/index.js";
import { WorkspacesModule } from "../workspaces/index.js";

import {
    createTerminalInputSchema,
    resizeTerminalInputSchema,
    terminalEventListenerSchema,
    terminalEventSchema,
    terminalScopeSchema,
    TerminalError,
    type CreateTerminalInput,
    type ResizeTerminalInput,
    type Terminal,
    type TerminalChanges,
    type TerminalEvent,
    type TerminalEventListener,
    type TerminalScope,
    type TerminalUnsubscribe,
} from "./Terminal.js";
import type { TerminalProcessFactory } from "./TerminalProcess.js";
import { createHostTerminalProcessFactory } from "./impl/createHostTerminalProcessFactory.js";
import { TerminalCollection } from "./impl/TerminalCollection.js";
import type { TerminalSession } from "./impl/TerminalSession.js";

/**
 * Interactive terminals on a project or one of its workspaces.
 *
 * A terminal here is not an agent's shell command and not a chat: it is a real pseudo-terminal a
 * person types into, and everyone looking at the same folder sees the same collection of them. The
 * module owns the process, the one canonical Ghostty emulator behind it, and the protocol that
 * keeps every attached replica in step; a caller supplies only the folder's identity and gets back
 * a record and a stream to attach.
 *
 * Nothing here is durable. A terminal is a running process and a live screen, and both end with the
 * daemon, so there is no record to restore and none is kept.
 */
export class TerminalsModule {
    readonly name = "terminals";

    readonly #locks: MapAsyncLock<string> = mapAsyncLock<string>();
    readonly #listeners = new Set<TerminalEventListener>();
    readonly #nextVersion = createUuidV7Factory();
    readonly #bots: BotsModule | undefined;
    readonly #projects: ProjectsModule;
    readonly #scopes = new Map<string, TerminalCollection>();
    readonly #workspaces: WorkspacesModule;
    /** Closures started by an archival, so shutdown and tests can wait for them. */
    readonly #closures = new Set<Promise<void>>();
    #closed = false;
    #processFactory: TerminalProcessFactory;

    /**
     * @param projects The catalog that owns where a project's checkout is. A terminal stands in a
     * folder someone else decided on, so it asks the catalog that decided rather than deriving a
     * path of its own.
     * @param workspaces The catalog that owns where a managed worktree is and whether it is usable.
     * A workspace folder is not inside its project's, and it only exists once the catalog says the
     * workspace is ready, so both answers have to come from here.
     */
    constructor(projects: ProjectsModule, workspaces: WorkspacesModule, bots?: BotsModule) {
        this.#bots = bots;
        this.#projects = projects;
        this.#workspaces = workspaces;
        this.#processFactory = createHostTerminalProcessFactory();

        // A terminal is a shell standing in a folder. Archiving is the decision that the folder is
        // nobody's any more and is about to be deleted, so these collections end with it. Both
        // catalogs own their own decision, so this module listens for it rather than asking them
        // to know that terminals exist.
        //
        // Ending a shell means killing a process and waiting for it to be reaped, which the
        // archival must not be held up by: archiving answers as soon as the decision is durable,
        // and closing terminals is background work. So each closure is started here and tracked,
        // never awaited by the catalog's post-commit publisher.
        workspaces.onEvent((ctx, event) => {
            if (event.type !== "workspace_updated" || event.change !== "begin_archive") return;
            const closeCtx = detach(ctx).named("terminal-archive-closure");
            this.#closeInBackground(
                closeCtx,
                this.closeScope(
                    {
                        projectId: event.workspace.projectRef,
                        workspaceId: event.workspace.id,
                    },
                    closeCtx,
                ),
            );
        });
        projects.onEvent((ctx, event) => {
            if (event.type !== "project_archived") return;
            const closeCtx = detach(ctx).named("terminal-archive-closure");
            this.#closeInBackground(closeCtx, this.closeProject(event.project.id, closeCtx));
        });
        bots?.onEvent((ctx, event) => {
            if (
                event.type !== "bot_updated" ||
                event.bot.status !== "archived" ||
                event.previousBot.status === "archived"
            )
                return;
            const closeCtx = detach(ctx).named("terminal-archive-closure");
            this.#closeInBackground(
                closeCtx,
                this.closeScope(
                    { projectId: event.bot.id, workspaceId: event.bot.workspaceId },
                    closeCtx,
                ),
            );
        });
    }

    /**
     * Follows one archival's closure without letting it fail the archival or delay it.
     *
     * The decision is already durable by the time this runs, so a shell that will not die is
     * something to report rather than a reason to keep the folder in the catalog.
     */
    #closeInBackground(ctx: Context, closing: Promise<void>): void {
        const tracked = closing
            .catch((error: unknown) => {
                ctx.log.error("Terminals could not be closed after an archival.", error);
            })
            .finally(() => {
                this.#closures.delete(tracked);
            });
        this.#closures.add(tracked);
    }

    /** Waits for closures an archival started, for shutdown and for tests. */
    async whenClosuresSettle(): Promise<void> {
        while (this.#closures.size > 0) {
            await Promise.allSettled(this.#closures);
        }
    }

    /**
     * Test-only construction over one supplied pseudo-terminal boundary.
     *
     * Production always spawns a real pseudo-terminal. A test that needs to drive the lifecycle
     * without a shell replaces the boundary here instead of reaching into the module.
     */
    static withProcessFactory(
        projects: ProjectsModule,
        workspaces: WorkspacesModule,
        processFactory: TerminalProcessFactory,
    ): TerminalsModule {
        const module = new TerminalsModule(projects, workspaces);
        module.#processFactory = processFactory;
        return module;
    }

    /**
     * Takes a listener for this daemon lifetime's non-durable terminal state.
     *
     * Register during startup, before this module can create a terminal, to observe all lifecycle
     * events. Unlike durable catalog modules terminals have no transactional subscription: their
     * process and screen disappear with the daemon.
     */
    onEvent(listener: TerminalEventListener): TerminalUnsubscribe {
        if (!Value.Check(terminalEventListenerSchema, listener)) {
            throw new Error("A terminal subscriber must be a function.");
        }
        this.#listeners.add(listener);
        return () => {
            this.#listeners.delete(listener);
        };
    }

    /** Open one terminal in a project or workspace folder. */
    async create(
        ctx: Context,
        scope: TerminalScope,
        input: CreateTerminalInput,
    ): Promise<Terminal> {
        assertScope(scope);
        if (!Value.Check(createTerminalInputSchema, input)) {
            throw new TerminalError("invalid", "The terminal settings are invalid.");
        }
        const collection = await this.#collection(ctx, scope);
        const session = await collection.create(input);
        return session.terminal();
    }

    /** Every terminal open on this folder right now. */
    async list(ctx: Context, scope: TerminalScope): Promise<readonly Terminal[]> {
        assertScope(scope);
        // Resolving first is what makes an unknown project or workspace a refusal rather than an
        // empty list that looks like a folder with nothing open in it.
        await this.#root(ctx, scope);
        return this.#scopes.get(scopeKey(scope))?.list() ?? [];
    }

    /** One terminal's current record. */
    async get(ctx: Context, scope: TerminalScope, terminalId: string): Promise<Terminal> {
        return (await this.session(ctx, scope, terminalId)).terminal();
    }

    /**
     * The live terminal, for a caller that is about to attach a stream to it.
     *
     * Attaching needs the session itself rather than its record, because the protocol — not this
     * module — owns what a new viewer is sent and in what order.
     */
    async session(
        ctx: Context,
        scope: TerminalScope,
        terminalId: string,
    ): Promise<TerminalSession> {
        assertScope(scope);
        await this.#root(ctx, scope);
        const session = this.#scopes.get(scopeKey(scope))?.get(terminalId);
        if (session === undefined) {
            throw new TerminalError("not_found", "The terminal was not found.");
        }
        return session;
    }

    /** Attach one stream, returning the call that detaches it again. */
    async attach(
        ctx: Context,
        scope: TerminalScope,
        terminalId: string,
        stream: Duplex,
    ): Promise<() => void> {
        const session = await this.session(ctx, scope, terminalId);
        return session.attach(stream);
    }

    async resize(
        ctx: Context,
        scope: TerminalScope,
        terminalId: string,
        input: ResizeTerminalInput,
    ): Promise<Terminal> {
        if (!Value.Check(resizeTerminalInputSchema, input)) {
            throw new TerminalError("invalid", "The terminal size is invalid.");
        }
        const session = await this.session(ctx, scope, terminalId);
        return await session.resize(input.cols, input.rows);
    }

    /** Stop the process. The record stays, holding the exit code, until the terminal is evicted. */
    async stop(ctx: Context, scope: TerminalScope, terminalId: string): Promise<Terminal> {
        const session = await this.session(ctx, scope, terminalId);
        return await session.stop();
    }

    /**
     * End every terminal on one folder.
     *
     * Archiving a workspace removes the folder its terminals are standing in, so this module runs
     * it from that decision rather than leaving shells in a directory that is gone.
     */
    async closeScope(scope: TerminalScope, ctx?: Context): Promise<void> {
        assertScope(scope);
        await this.#closeKey(scopeKey(scope), ctx);
    }

    /** End every terminal of a project, including those of its workspaces. */
    async closeProject(projectId: string, ctx?: Context): Promise<void> {
        // Read the keys first, then take each scope's own lock. A collection installed by a create
        // that is still holding its lock is caught by the archived-folder check that create makes
        // once it has it, so nothing this scan misses can survive.
        const keys = [...this.#scopes.entries()]
            .filter(([, collection]) => collection.projectId === projectId)
            .map(([key]) => key);
        await Promise.all(keys.map(async (key) => await this.#closeKey(key, ctx)));
    }

    /**
     * Ends one folder's collection under the lock that also guards creating it.
     *
     * Creation resolves its folder, then installs the collection under this lock. Closing takes
     * the same lock, so a create that has begun either finishes before the close removes its
     * collection — and its session is disposed with the rest — or installs into a collection this
     * close has already marked disposed, which refuses it. Neither order leaves a live shell in an
     * archived folder.
     */
    async #closeKey(key: string, ctx: Context | undefined): Promise<void> {
        const close = async (): Promise<void> => {
            const collection = this.#scopes.get(key);
            if (collection === undefined) return;
            this.#scopes.delete(key);
            await collection.dispose();
        };
        if (ctx === undefined) {
            await close();
            return;
        }
        await this.#locks.runInLock(ctx, key, close);
    }

    /** Stop everything. Nothing opens after this. */
    async close(): Promise<void> {
        this.#closed = true;
        const collections = [...this.#scopes.values()];
        this.#scopes.clear();
        await Promise.all(collections.map(async (collection) => await collection.dispose()));
        // A closure an archival started owns collections this one already took, so shutdown ends
        // only once those have finished too.
        await this.whenClosuresSettle();
    }

    /**
     * The collection for one folder, created on first use.
     *
     * Two people opening the first terminal of the same project at the same moment must end up in
     * one collection, or the limit and the listing would each describe half of the truth.
     */
    async #collection(ctx: Context, scope: TerminalScope): Promise<TerminalCollection> {
        const key = scopeKey(scope);
        await this.#root(ctx, scope);
        return await this.#locks.runInLock(ctx, key, async () => {
            if (this.#closed) {
                throw new TerminalError("unavailable", "The Happy agent is shutting down.");
            }
            const existing = this.#scopes.get(key);
            if (existing !== undefined) return existing;
            // Ask the catalog again, under the lock, before installing the first collection for
            // this folder. A closure scans for the collections to end and closes only what it
            // finds, so a folder archived while the resolution above was in flight would be
            // scanned before this collection existed and closed by nothing afterwards. Resolving
            // once more here is what makes such a create lose that race rather than win it.
            const root = await this.#root(ctx, scope);
            const created = new TerminalCollection({
                nextVersion: this.#nextVersion,
                onCreated: (terminal) => this.#emit({ terminal, type: "terminal_created" }),
                onUpdated: (before, after) => this.#emitUpdated(before, after),
                projectId: scope.projectId,
                processFactory: this.#processFactory,
                root,
                workspaceId: scope.workspaceId ?? scope.projectId,
            });
            this.#scopes.set(key, created);
            return created;
        });
    }

    #emitUpdated(before: Terminal, after: Terminal): void {
        const changes = terminalChanges(before, after);
        if (Object.keys(changes).length === 0) return;
        this.#emit({
            changes,
            previousVersion: before.version,
            terminalId: after.id,
            type: "terminal_updated",
            version: after.version,
        });
    }

    #emit(event: TerminalEvent): void {
        if (!Value.Check(terminalEventSchema, event)) {
            throw new Error("The terminal module created an invalid event.");
        }
        for (const listener of [...this.#listeners]) {
            try {
                void Promise.resolve(listener(structuredClone(event))).catch(() => undefined);
            } catch {
                // Terminal state has already changed. An observer must not make opening, resizing,
                // or stopping a person's shell look like it failed.
            }
        }
    }

    /** Where this folder actually is, according to the catalog that owns it. */
    async #root(ctx: Context, scope: TerminalScope): Promise<string> {
        if (scope.workspaceId !== undefined) {
            const bot = await this.#bots?.forWorkspace(ctx, scope.workspaceId);
            if (bot !== undefined && bot.id === scope.projectId) {
                if (bot.status !== "active") {
                    throw new TerminalError("conflict", "An archived bot cannot open a terminal.");
                }
                return bot.path;
            }
        }
        const project = await this.#projects.get(ctx, scope.projectId);
        if (project === undefined) {
            throw new TerminalError("not_found", "The project was not found.");
        }
        if (scope.workspaceId === undefined) {
            if (project.status === "archived") {
                throw new TerminalError("conflict", "An archived project cannot open a terminal.");
            }
            return project.repositoryRef;
        }
        const workspace = await this.#workspaces.get(ctx, scope.workspaceId);
        if (workspace === undefined || workspace.projectRef !== scope.projectId) {
            throw new TerminalError("not_found", "The workspace was not found.");
        }
        if (workspace.status !== "ready") {
            throw new TerminalError("conflict", "Only a ready workspace can open a terminal.");
        }
        return workspace.path;
    }
}

function assertScope(scope: TerminalScope): void {
    if (!Value.Check(terminalScopeSchema, scope)) {
        throw new TerminalError("invalid", "The terminal project or workspace is invalid.");
    }
}

/** One key per folder. A project and its workspaces are separate collections, as their folders are. */
function scopeKey(scope: TerminalScope): string {
    return JSON.stringify([scope.projectId, scope.workspaceId ?? null]);
}

function terminalChanges(before: Terminal, after: Terminal): TerminalChanges {
    return {
        ...(before.cols === after.cols ? {} : { cols: after.cols }),
        ...(before.colorScheme === after.colorScheme ? {} : { colorScheme: after.colorScheme }),
        ...(before.epoch === after.epoch ? {} : { epoch: after.epoch }),
        ...(before.exitCode === after.exitCode ? {} : { exitCode: after.exitCode }),
        ...(before.rows === after.rows ? {} : { rows: after.rows }),
        ...(before.status === after.status ? {} : { status: after.status }),
        ...(before.workspaceId === after.workspaceId ? {} : { workspaceId: after.workspaceId }),
    };
}
