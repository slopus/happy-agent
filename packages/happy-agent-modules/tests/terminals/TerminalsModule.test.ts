import { PassThrough } from "node:stream";

import type { Context } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it, vi } from "vitest";

import { durableFunctionsMigrations } from "../../sources/durableFunctions/index.js";
import { GitModule } from "../../sources/git/index.js";
import { projectMigrations, type ProjectsModule } from "../../sources/projects/index.js";
import {
    MAX_TERMINALS_PER_SCOPE,
    TerminalError,
    TerminalsModule,
    type TerminalEvent,
    type TerminalProcess,
    type TerminalProcessFactory,
    type TerminalProcessOptions,
} from "../../sources/terminals/index.js";
import { workspaceMigrations, type WorkspacesModule } from "../../sources/workspaces/index.js";
import { temporaryTestConfig } from "../support/configModule.js";
import { moduleDatabase } from "../support/moduleDatabase.js";
import { workspacesCatalogFrom } from "../support/workspacesModule.js";

const opened: World[] = [];

afterEach(async () => {
    for (const world of opened.splice(0)) {
        await world.module.close();
        await world.close();
    }
});

describe("TerminalsModule", () => {
    it("opens a terminal in the project's own folder and lists it back", async () => {
        const { ctx, factory, module, project } = await createWorld("terminals-project-folder");

        const terminal = await module.create(
            ctx,
            { projectId: project.id },
            { cols: 40, rows: 12 },
        );

        expect(terminal.status).toBe("running");
        expect(terminal.cols).toBe(40);
        expect(terminal.rows).toBe(12);
        expect(terminal.colorScheme).toBe("dark");
        expect(terminal.exitCode).toBeNull();
        expect(factory.started[0]?.cwd).toBe(project.repositoryRef);
        expect(await module.list(ctx, { projectId: project.id })).toEqual([terminal]);
    });

    it("publishes a full created resource with its root workspace and UUIDv7 version", async () => {
        const { ctx, module, project } = await createWorld("terminals-created-event");
        const events: TerminalEvent[] = [];
        module.onEvent((event) => {
            events.push(event);
        });

        const terminal = await module.create(ctx, { projectId: project.id }, {});

        expect(terminal.workspaceId).toBe(project.id);
        expect(terminal.version).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        );
        expect(events).toEqual([{ terminal, type: "terminal_created" }]);
    });

    it("starts a workspace terminal in the worktree rather than inside the project", async () => {
        const { ctx, factory, module, project, workspace, workspacesDirectory } = await createWorld(
            "terminals-workspace-folder",
        );
        const scope = { projectId: project.id, workspaceId: workspace.id };

        await module.create(ctx, scope, {});

        expect(factory.started[0]?.cwd).toBe(workspace.path);
        expect(workspace.path.startsWith(workspacesDirectory)).toBe(true);
        // The two folders are two collections: a project terminal is not a workspace terminal.
        expect(await module.list(ctx, { projectId: project.id })).toEqual([]);
        expect(await module.list(ctx, scope)).toHaveLength(1);
    });

    it("resolves a relative working directory against the folder, and keeps an absolute one", async () => {
        const { ctx, factory, module, project } = await createWorld("terminals-cwd");

        await module.create(ctx, { projectId: project.id }, { cwd: "packages/thing" });
        await module.create(ctx, { projectId: project.id }, { cwd: "/somewhere/else" });

        expect(factory.started.map((options) => options.cwd)).toEqual([
            `${project.repositoryRef}/packages/thing`,
            "/somewhere/else",
        ]);
    });

    it("refuses a project, a workspace, and a terminal nobody has", async () => {
        const { ctx, module, project } = await createWorld("terminals-unknown");

        await expect(module.list(ctx, { projectId: "missing" })).rejects.toMatchObject({
            code: "not_found",
        });
        await expect(
            module.create(ctx, { projectId: project.id, workspaceId: "missing" }, {}),
        ).rejects.toMatchObject({ code: "not_found" });
        await expect(module.get(ctx, { projectId: project.id }, "nope")).rejects.toMatchObject({
            code: "not_found",
        });
    });

    it("refuses a workspace that is not ready and an archived project", async () => {
        const { archivedProject, ctx, initializingWorkspace, module, project } =
            await createWorld("terminals-not-usable");

        await expect(
            module.create(
                ctx,
                { projectId: project.id, workspaceId: initializingWorkspace.id },
                {},
            ),
        ).rejects.toMatchObject({ code: "conflict" });
        await expect(
            module.create(ctx, { projectId: archivedProject.id }, {}),
        ).rejects.toMatchObject({ code: "conflict" });
    });

    it("refuses a workspace that belongs to another project", async () => {
        const { ctx, module, otherProject, workspace } = await createWorld(
            "terminals-foreign-workspace",
        );

        await expect(
            module.create(ctx, { projectId: otherProject.id, workspaceId: workspace.id }, {}),
        ).rejects.toMatchObject({ code: "not_found" });
    });

    it("resizes the process and the record together", async () => {
        const { ctx, factory, module, project } = await createWorld("terminals-resize");
        const scope = { projectId: project.id };
        const events: TerminalEvent[] = [];
        module.onEvent((event) => {
            events.push(event);
        });
        const created = await module.create(ctx, scope, {});

        const resized = await module.resize(ctx, scope, created.id, { cols: 100, rows: 30 });

        expect(resized).toMatchObject({ cols: 100, id: created.id, rows: 30 });
        expect(resized.version > created.version).toBe(true);
        expect(factory.processes[0]?.sizes.at(-1)).toEqual([100, 30]);
        expect(events).toContainEqual({
            changes: { cols: 100, rows: 30 },
            previousVersion: created.version,
            terminalId: created.id,
            type: "terminal_updated",
            version: resized.version,
        });
    });

    it("keeps a stopped terminal, holding what it exited with", async () => {
        const { ctx, factory, module, project } = await createWorld("terminals-exit-code");
        const scope = { projectId: project.id };
        const events: TerminalEvent[] = [];
        module.onEvent((event) => {
            events.push(event);
        });
        const created = await module.create(ctx, scope, {});
        factory.processes[0]?.exitWith(3);

        const stopped = await module.stop(ctx, scope, created.id);

        expect(stopped).toMatchObject({ exitCode: 3, id: created.id, status: "exited" });
        expect(stopped.version > created.version).toBe(true);
        expect(await module.list(ctx, scope)).toEqual([stopped]);
        expect(events).toContainEqual({
            changes: { exitCode: 3, status: "exited" },
            previousVersion: created.version,
            terminalId: created.id,
            type: "terminal_updated",
            version: stopped.version,
        });
    });

    it("does not mint a version or event for a resize that changes nothing", async () => {
        const { ctx, module, project } = await createWorld("terminals-noop-resize");
        const scope = { projectId: project.id };
        const events: TerminalEvent[] = [];
        module.onEvent((event) => {
            events.push(event);
        });
        const created = await module.create(ctx, scope, {});

        const unchanged = await module.resize(ctx, scope, created.id, {
            cols: created.cols,
            rows: created.rows,
        });

        expect(unchanged).toEqual(created);
        expect(events).toEqual([{ terminal: created, type: "terminal_created" }]);
    });

    it("refuses one terminal past the limit, then reuses the place a finished one gave up", async () => {
        const { ctx, factory, module, project } = await createWorld("terminals-limit");
        const scope = { projectId: project.id };
        const first = await module.create(ctx, scope, {});
        for (let opened = 1; opened < MAX_TERMINALS_PER_SCOPE; opened += 1) {
            await module.create(ctx, scope, {});
        }

        await expect(module.create(ctx, scope, {})).rejects.toMatchObject({
            code: "conflict",
        });

        factory.processes[0]?.exitWith(0);
        await module.stop(ctx, scope, first.id);
        const replacement = await module.create(ctx, scope, {});

        const listed = await module.list(ctx, scope);
        expect(listed).toHaveLength(MAX_TERMINALS_PER_SCOPE);
        expect(listed.map((terminal) => terminal.id)).toContain(replacement.id);
        expect(listed.map((terminal) => terminal.id)).not.toContain(first.id);
    });

    it("ends a folder's terminals when that folder goes away", async () => {
        const { ctx, factory, module, project, workspace } =
            await createWorld("terminals-close-folder");
        const workspaceScope = { projectId: project.id, workspaceId: workspace.id };
        await module.create(ctx, { projectId: project.id }, {});
        await module.create(ctx, workspaceScope, {});

        await module.closeScope(workspaceScope);

        expect(factory.processes[1]?.killed).toBe(true);
        expect(factory.processes[0]?.killed).toBe(false);
        expect(await module.list(ctx, workspaceScope)).toEqual([]);

        await module.closeProject(project.id);
        expect(factory.processes[0]?.killed).toBe(true);
    });

    it("ends a workspace's terminals when the workspace is archived", async () => {
        const { ctx, factory, module, project, workspace, workspaces } = await createWorld(
            "terminals-workspace-archived",
        );
        const workspaceScope = { projectId: project.id, workspaceId: workspace.id };
        await module.create(ctx, { projectId: project.id }, {});
        await module.create(ctx, workspaceScope, {});

        await workspaces.beginArchive(ctx, workspace.id);
        await module.whenClosuresSettle();

        // The workspace folder is going away, so its shells go with it; the project's own folder
        // is untouched and so is the terminal standing in it.
        expect(factory.processes[1]?.killed).toBe(true);
        expect(factory.processes[0]?.killed).toBe(false);
    });

    it("ends every terminal under a project when the project is archived", async () => {
        const { ctx, factory, module, project, projects, workspace } = await createWorld(
            "terminals-project-archived",
        );
        await module.create(ctx, { projectId: project.id }, {});
        await module.create(ctx, { projectId: project.id, workspaceId: workspace.id }, {});

        await projects.archive(ctx, project.id);
        await module.whenClosuresSettle();

        expect(factory.processes[0]?.killed).toBe(true);
        expect(factory.processes[1]?.killed).toBe(true);
    });

    it("answers an archival while its shells are still being ended", async () => {
        const { ctx, factory, module, project, workspace, workspaces } = await createWorld(
            "terminals-archive-does-not-wait",
        );
        await module.create(ctx, { projectId: project.id, workspaceId: workspace.id }, {});
        const process = factory.processes[0] as FakeProcess;
        // A shell nothing can end, so its closure cannot finish without the timeout being waited
        // out. Archiving must come back anyway.
        process.ignoresKill = true;

        vi.useFakeTimers();
        try {
            await workspaces.beginArchive(ctx, workspace.id);

            // The decision is durable and the caller has it back, with the shell still being waited
            // out: no timer had to fire for the archival to answer.
            expect((await workspaces.get(ctx, workspace.id))?.status).toBe("archiving");
            expect(process.killed).toBe(true);
            await vi.advanceTimersByTimeAsync(2_000);
        } finally {
            vi.useRealTimers();
        }
        await module.whenClosuresSettle();
    });

    it("refuses a terminal that finishes opening after its folder was closed", async () => {
        const { ctx, factory, module, project } = await createWorld("terminals-create-loses-race");
        const scope = { projectId: project.id };
        // The collection has to already exist, so that closing has something to take.
        await module.create(ctx, scope, {});

        const open = factory.hold();
        const creating = module.create(ctx, scope, {});
        while (factory.started.length < 2) await new Promise(setImmediate);
        await module.closeScope(scope, ctx);
        open();

        await expect(creating).rejects.toBeInstanceOf(TerminalError);
        // The shell that did start is not left standing in a folder nobody has any more.
        expect(factory.processes[1]?.killed).toBe(true);
        expect(await module.list(ctx, scope)).toEqual([]);
    });

    it("refuses the first terminal of a folder archived while it was resolving", async () => {
        const { ctx, factory, module, project, workspace, workspaces } = await createWorld(
            "terminals-first-create-loses-race",
        );
        const scope = { projectId: project.id, workspaceId: workspace.id };
        // Nothing is open on this folder yet, so the closure the archival starts has no collection
        // to find. This create must not be the thing that installs one behind it.
        const ready = await workspaces.get(ctx, workspace.id);
        const resolve = workspaces.get.bind(workspaces);

        let release!: () => void;
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        let first = true;
        vi.spyOn(workspaces, "get").mockImplementation(async (getCtx, workspaceId) => {
            if (!first || workspaceId !== workspace.id) return await resolve(getCtx, workspaceId);
            first = false;
            await held;
            // The answer this create started with: the workspace as it was before the archival.
            return ready;
        });

        const creating = module.create(ctx, scope, {});
        // Let the create reach its first resolution before the folder is taken away from it.
        while (first) await new Promise(setImmediate);
        await workspaces.beginArchive(ctx, workspace.id);
        await module.whenClosuresSettle();
        release();

        await expect(creating).rejects.toBeInstanceOf(TerminalError);
        // No shell was ever started in the folder that is about to be deleted.
        expect(factory.started).toEqual([]);
    });

    it("closes a terminal at once, without waiting on the process to agree", async () => {
        const { ctx, factory, module, project } = await createWorld("terminals-instant-stop");
        const scope = { projectId: project.id };
        const created = await module.create(ctx, scope, {});

        vi.useFakeTimers();
        try {
            await expect(module.stop(ctx, scope, created.id)).resolves.toMatchObject({
                status: "exited",
            });
            // Nothing was waited out: no timer ever had to fire for the terminal to be gone.
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            vi.useRealTimers();
        }
        expect(factory.processes[0]?.killed).toBe(true);
    });

    it("gives up out loud on a terminal process nothing can end", async () => {
        const { ctx, factory, module, project } = await createWorld("terminals-immortal-stop");
        const scope = { projectId: project.id };
        const created = await module.create(ctx, scope, {});
        const process = factory.processes[0] as FakeProcess;
        process.ignoresKill = true;

        vi.useFakeTimers();
        try {
            const stopping = expect(module.stop(ctx, scope, created.id)).rejects.toMatchObject({
                code: "unavailable",
            });
            await vi.advanceTimersByTimeAsync(2_000);

            await stopping;
        } finally {
            vi.useRealTimers();
        }
        // Let the folder close without sitting through the timeout a second time.
        process.exitWith(null);
    });

    it("attaches a stream and detaches it again", async () => {
        const { ctx, module, project } = await createWorld("terminals-attach");
        const scope = { projectId: project.id };
        const created = await module.create(ctx, scope, {});
        const stream = new PassThrough();

        const detach = await module.attach(ctx, scope, created.id, stream);
        detach();
        stream.destroy();

        expect(typeof detach).toBe("function");
    });

    it("refuses settings that are not terminal settings at all", async () => {
        const { ctx, module, project } = await createWorld("terminals-invalid-settings");
        const scope = { projectId: project.id };

        await expect(module.create(ctx, scope, { cols: 0 })).rejects.toBeInstanceOf(TerminalError);
        await expect(
            module.create(ctx, scope, {
                nonsense: true,
            } as unknown as Record<string, never>),
        ).rejects.toMatchObject({ code: "invalid" });
    });

    it("opens nothing once it has closed", async () => {
        const { ctx, module, project } = await createWorld("terminals-closed");
        await module.close();

        await expect(module.create(ctx, { projectId: project.id }, {})).rejects.toMatchObject({
            code: "unavailable",
        });
    });
});

interface World {
    /** A project whose folder no terminal may stand in any more. */
    readonly archivedProject: { readonly id: string };
    readonly close: () => Promise<void>;
    readonly ctx: Context;
    readonly factory: FakeProcessFactory;
    /** A workspace whose folder is not usable yet, because the catalog is still making it. */
    readonly initializingWorkspace: { readonly id: string };
    /** A second project, so a workspace of the first one is foreign to it. */
    readonly otherProject: { readonly id: string };
    readonly module: TerminalsModule;
    readonly project: { readonly id: string; readonly repositoryRef: string };
    /** The catalogs whose archival decisions this module follows. */
    readonly projects: ProjectsModule;
    readonly workspaces: WorkspacesModule;
    readonly workspace: { readonly id: string; readonly path: string };
    /**
     * Where this world's workspace folders live, as the catalog itself resolves it: configuration
     * says where the managed root is, and Git settles what that path really names.
     */
    readonly workspacesDirectory: string;
}

/**
 * The two catalogs a terminal asks, as themselves.
 *
 * A terminal's folder is whatever the projects and workspaces catalogs say it is, so this drives the
 * real ones over a real agent database rather than restating their answers in a stand-in that could
 * drift from them. Only the pseudo-terminal is replaced, because a shell is not what is under test.
 */
async function createWorld(name: string): Promise<World> {
    const database = moduleDatabase([], name);
    for (const [, migrate] of durableFunctionsMigrations) {
        await migrate(database.context, database.database);
    }
    for (const [, migrate] of projectMigrations) {
        await migrate(database.context, database.database);
    }
    for (const [, migrate] of workspaceMigrations) {
        await migrate(database.context, database.database);
    }

    const ctx = database.context;
    const config = await temporaryTestConfig();
    const git = new GitModule();
    const { durableFunctions, projects, start, workspaces } = workspacesCatalogFrom(config, git);
    await start(ctx);

    const project = await projects.create(ctx, {
        name: "Main",
        repositoryRef: "/projects/main",
    });
    const otherProject = await projects.create(ctx, {
        name: "Other",
        repositoryRef: "/projects/other",
    });
    const gone = await projects.create(ctx, {
        name: "Gone",
        repositoryRef: "/projects/gone",
    });
    const archivedProject = await projects.archive(ctx, gone.id);

    const reserved = await workspaces.reserve(ctx, {
        name: "Ready",
        projectRef: project.id,
    });
    const workspace = await workspaces.markReady(ctx, {
        workspaceId: reserved.workspace.id,
    });
    const initializing = await workspaces.reserve(ctx, {
        name: "Starting",
        projectRef: project.id,
    });

    const factory = new FakeProcessFactory();
    const module = TerminalsModule.withProcessFactory(projects, workspaces, factory);

    const world: World = {
        archivedProject,
        close: async () => {
            durableFunctions.stop();
            await workspaces.close(ctx);
            database.close();
        },
        ctx,
        factory,
        initializingWorkspace: initializing.workspace,
        module,
        otherProject,
        project,
        projects,
        workspace,
        workspaces,
        workspacesDirectory: git.normalizeFuturePath(config.workspacesHome),
    };
    opened.push(world);
    return world;
}

/** A process that never exists: the module's own behavior, with no shell in the way. */
class FakeProcess implements TerminalProcess {
    killed = false;
    /** A process nothing on this machine can end, which stop must give up on rather than hang. */
    ignoresKill = false;
    readonly sizes: [number, number][] = [];
    readonly written: string[] = [];
    #listener: ((data: Uint8Array) => void) | undefined;
    #resolve: ((value: { exitCode: number | null }) => void) | undefined;
    readonly #exit = new Promise<{ exitCode: number | null }>((resolve) => {
        this.#resolve = resolve;
    });

    exitWith(exitCode: number | null): void {
        this.#resolve?.({ exitCode });
    }

    kill(): void {
        this.killed = true;
        if (this.ignoresKill) return;
        this.exitWith(null);
    }

    onData(listener: (data: Uint8Array) => void): () => void {
        this.#listener = listener;
        return () => {
            if (this.#listener === listener) this.#listener = undefined;
        };
    }

    pause(): void {}

    resize(cols: number, rows: number): void {
        this.sizes.push([cols, rows]);
    }

    resume(): void {}

    wait(): Promise<{ exitCode: number | null }> {
        return this.#exit;
    }

    write(data: string | Uint8Array): boolean {
        this.written.push(typeof data === "string" ? data : Buffer.from(data).toString("utf8"));
        return true;
    }
}

class FakeProcessFactory implements TerminalProcessFactory {
    readonly processes: FakeProcess[] = [];
    readonly started: TerminalProcessOptions[] = [];
    #gate: Promise<void> | undefined;
    #open: (() => void) | undefined;

    /** Leave every start from here on in flight, returning the call that lets them through. */
    hold(): () => void {
        this.#gate = new Promise<void>((resolve) => {
            this.#open = resolve;
        });
        return () => {
            this.#gate = undefined;
            this.#open?.();
        };
    }

    async start(options: TerminalProcessOptions): Promise<TerminalProcess> {
        this.started.push(options);
        await this.#gate;
        const process = new FakeProcess();
        this.processes.push(process);
        return process;
    }
}
