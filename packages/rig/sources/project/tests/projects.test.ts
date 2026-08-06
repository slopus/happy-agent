import { execFile as execFileCallback } from "node:child_process";
import { renameSync, rmSync } from "node:fs";
import {
    access,
    mkdir,
    mkdtemp,
    readFile,
    realpath,
    rename,
    rm,
    symlink,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";

import { createId } from "@paralleldrive/cuid2";
import {
    defineProvider,
    modelOpenaiGpt56Sol,
    type AssistantMessage,
    type InferenceStream,
} from "@slopus/rig-execution";
import Database from "better-sqlite3";
import sharp from "sharp";
import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { migrateSessionDatabase } from "../../persistence/database/migrateSessionDatabase.js";
import { openSessionDatabase } from "../../persistence/database/openSessionDatabase.js";
import { projects, projectWorkspaces } from "../../persistence/database/schema.js";
import { PersistentGlobalEventQueue } from "../../global-event/PersistentGlobalEventQueue.js";
import { Agent, createNodeAgentContext } from "../../agent/index.js";
import type { CodingAssistantRuntime } from "../../runtime/CodingAssistantRuntime.js";
import type { CreateCodingAssistantAgentOptions } from "../../runtime/createCodingAssistantAgent.js";
import type { InMemorySession, InMemorySessionOptions } from "../../session/InMemorySession.js";
import { PersistentSessionStore } from "../../session/PersistentSessionStore.js";
import { NativeProcessManager } from "../../processes/index.js";
import type { GitCommandRunner } from "../../git/types.js";
import { ProjectRegistrationError, ProjectRepository } from "../ProjectRepository.js";

const execFile = promisify(execFileCallback);
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
    await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("projects", () => {
    it("validates every project registration path failure before importing it", async () => {
        const fixture = await createFixture({
            projectGit: async (cwd, args) => {
                if (args[0] !== "rev-parse" || args[1] !== "--show-toplevel") {
                    throw new Error("Unexpected Git command.");
                }
                if (cwd.endsWith("inaccessible")) {
                    const error = new Error("fatal: Permission denied") as NodeJS.ErrnoException;
                    error.code = "EACCES";
                    throw error;
                }
                if (cwd.endsWith("not-git")) throw new Error("fatal: not a git repository");
                if (cwd.endsWith("nested")) return join(cwd, "..");
                return cwd;
            },
        });
        const file = join(fixture.root, "file");
        const inaccessible = join(fixture.root, "inaccessible");
        const notGit = join(fixture.root, "not-git");
        const nested = join(fixture.root, "repository", "nested");
        await Promise.all([
            writeFile(file, "not a directory"),
            mkdir(inaccessible),
            mkdir(notGit),
            mkdir(nested, { recursive: true }),
        ]);

        const expected = [
            [join(fixture.root, "missing"), "path_missing"],
            [file, "not_directory"],
            [inaccessible, "path_inaccessible"],
            [notGit, "not_git_repository"],
            [nested, "not_git_top_level"],
        ] as const;
        for (const [path, code] of expected) {
            await expect(fixture.store.registerProject({ path })).rejects.toMatchObject({
                code,
                name: "ProjectRegistrationError",
            } satisfies Partial<ProjectRegistrationError>);
        }
        expect(fixture.store.listProjects()).toEqual([]);
    });

    it("registers Git roots and linked worktree roots without creating chats or workspaces", async () => {
        const fixture = await createFixture({ durableGlobalEventQueue: true });
        const repository = await createRepository(fixture.root, "registered-project");
        const linkedWorktree = join(fixture.root, "linked-worktree");
        await git(repository, ["worktree", "add", "-q", "-b", "linked-worktree", linkedWorktree]);
        const projectId = createId();

        const [first, repeated] = await Promise.all([
            fixture.store.registerProject({ path: repository, projectId }),
            fixture.store.registerProject({ path: repository, projectId }),
        ]);
        const worktree = await fixture.store.registerProject({ path: linkedWorktree });

        expect(first).toEqual(repeated);
        expect(first).toMatchObject({ id: projectId });
        expect(first.path).toBe(await realpath(repository));
        expect(worktree.path).toBe(await realpath(linkedWorktree));
        expect(worktree.id).not.toBe(first.id);
        expect(fixture.store.listProjects()).toHaveLength(2);
        expect(fixture.store.listWorkspaces()).toEqual([]);
        expect(fixture.store.list()).toEqual([]);
        expect(
            fixture.store.globalEventQueue
                .list()
                ?.filter((entry) => entry.event.type === "project_created"),
        ).toHaveLength(2);
    });

    it("answers an ambiguous registration retry with the existing project and restores it once", async () => {
        const fixture = await createFixture({ durableGlobalEventQueue: true });
        const repository = await createRepository(fixture.root, "registered-retry");
        const projectId = createId();
        const created = await fixture.store.registerProject({ path: repository, projectId });
        const archived = await fixture.store.archiveProject(created.id, created.version);
        if (archived === undefined) throw new Error("Expected the project to be archived.");

        const restored = await fixture.store.registerProject({ path: repository, projectId });
        const repeated = await fixture.store.registerProject({
            path: repository,
            projectId: createId(),
        });

        expect(restored.archivedAt).toBeUndefined();
        expect(repeated.id).toBe(restored.id);
        expect(repeated.path).toBe(restored.path);
        expect(fixture.store.listProjects()).toHaveLength(1);
        const events = fixture.store.globalEventQueue.list()?.map((entry) => entry.event) ?? [];
        expect(events.filter((event) => event.type === "project_created")).toHaveLength(1);
        expect(events).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    data: { project: expect.objectContaining({ archivedAt: expect.any(Number) }) },
                    type: "project_updated",
                }),
                expect.objectContaining({
                    data: {
                        project: expect.not.objectContaining({ archivedAt: expect.anything() }),
                    },
                    type: "project_updated",
                }),
            ]),
        );
    });

    it("returns typed conflicts and resolves only ready managed workspace paths", async () => {
        const fixture = await createFixture();
        const repository = await createRepository(fixture.root, "managed-registration");
        const owner = await fixture.store.registerProject({ path: repository });
        const workspace = await fixture.store.createWorkspace(owner.id, {
            baseRef: "HEAD",
            name: "Managed Registration",
        });
        if (workspace === undefined) throw new Error("Expected a managed workspace.");
        const ready = await waitForWorkspace(
            fixture.store,
            owner.id,
            workspace.id,
            (value) => value.status === "ready",
        );

        await expect(fixture.store.registerProject({ path: ready.path })).resolves.toMatchObject({
            id: owner.id,
        });

        const database = new Database(fixture.databasePath);
        try {
            database
                .prepare("UPDATE project_workspaces SET status = 'failed' WHERE id = ?")
                .run(ready.id);
        } finally {
            database.close();
        }
        await expect(fixture.store.registerProject({ path: ready.path })).rejects.toMatchObject({
            code: "managed_workspace_unavailable",
            name: "ProjectRegistrationError",
        } satisfies Partial<ProjectRegistrationError>);

        const otherRepository = await createRepository(fixture.root, "conflicting-registration");
        await expect(
            fixture.store.registerProject({ path: otherRepository, projectId: owner.id }),
        ).rejects.toMatchObject({
            code: "project_id_conflict",
            name: "ProjectRegistrationError",
        } satisfies Partial<ProjectRegistrationError>);
        expect(fixture.store.listProjects()).toHaveLength(1);
    });

    it("rolls back a project mutation when its durable event cannot be stored", () => {
        const opened = openSessionDatabase(":memory:");
        migrateSessionDatabase(opened.database);
        const queue = new PersistentGlobalEventQueue(opened.database);
        opened.database.run(
            sql.raw(`
            CREATE TRIGGER reject_project_event
            BEFORE INSERT ON durable_global_events
            BEGIN
                SELECT RAISE(ABORT, 'event insert failed');
            END
        `),
        );
        const repository = new ProjectRepository({
            database: opened.database,
            homeDirectory: "/home",
            onEvent: (event) => {
                queue.append(event);
            },
            stateDirectory: "/state",
        });

        try {
            expect(() => repository.resolve("/workspace")).toThrow("event insert failed");
            expect(opened.database.select().from(projects).all()).toEqual([]);
        } finally {
            repository.close();
            queue.deactivate();
            opened.client.close();
        }
    });

    it("assigns canonical directories immediately and distinguishes nested projects", async () => {
        const fixture = await createFixture({ durableGlobalEventQueue: true });
        const projectDirectory = join(fixture.root, "project");
        const nestedDirectory = join(projectDirectory, "nested");
        const alias = join(fixture.root, "alias");
        await mkdir(nestedDirectory, { recursive: true });
        await symlink(projectDirectory, alias);

        const first = fixture.store.create({ cwd: projectDirectory });
        const second = fixture.store.create({ cwd: alias });
        const nested = fixture.store.create({ cwd: nestedDirectory });

        expect(first.snapshot().projectId).toBe(second.snapshot().projectId);
        expect(nested.snapshot().projectId).not.toBe(first.snapshot().projectId);
        expect(fixture.store.listProjects().map((project) => project.id)).toEqual([
            nested.snapshot().projectId,
            first.snapshot().projectId,
        ]);
        expect(
            fixture.store
                .list()
                .filter((session) => session.projectId === first.snapshot().projectId)
                .map((session) => session.id),
        ).toEqual([first.id, second.id]);

        const movedProject = fixture.store.reorderProject(
            nested.snapshot().projectId,
            { afterId: first.snapshot().projectId },
            fixture.store.getProject(nested.snapshot().projectId)!.version,
        );
        expect(movedProject).toBeDefined();
        expect(fixture.store.listProjects().map((project) => project.id)).toEqual([
            first.snapshot().projectId,
            nested.snapshot().projectId,
        ]);

        fixture.store.reorderSession(second.id, { afterId: null });
        expect(
            fixture.store
                .list()
                .filter((session) => session.projectId === first.snapshot().projectId)
                .map((session) => session.id),
        ).toEqual([second.id, first.id]);
        expect(fixture.store.globalEventQueue.list()?.map((entry) => entry.event.type)).toEqual([
            "project_created",
            "session_created",
            "session_created",
            "project_created",
            "session_created",
            "project_updated",
            "session_updated",
        ]);
    });

    it("creates a ready Home project with its built-in visual", async () => {
        const fixture = await createFixture();
        const session = fixture.store.create({ cwd: fixture.home });
        expect(fixture.store.getProject(session.snapshot().projectId)).toMatchObject({
            avatarBuiltin: "home",
            initializationStatus: "ready",
            kind: "home",
            name: "Home",
        });
    });

    it("keeps stale settings saves as conflicts after user project mutations", async () => {
        const fixture = await createFixture();
        const session = fixture.store.create({ cwd: fixture.home });
        const project = fixture.store.getProject(session.snapshot().projectId)!;
        const renamed = fixture.store.renameProject(
            project.id,
            "Renamed project",
            project.version,
        )!;

        expect(() =>
            fixture.store.setProjectSettings(
                project.id,
                { defaultWorkspaceCompute: { type: "local" } },
                project.version,
            ),
        ).toThrow("changed before its settings could be saved");

        const configured = fixture.store.setProjectSettings(
            project.id,
            { defaultWorkspaceCompute: { type: "local" } },
            renamed.version,
        )!;
        expect(() =>
            fixture.store.setProjectSettings(
                project.id,
                {
                    defaultWorkspaceCompute: {
                        image: "workspace-dev:latest",
                        type: "docker",
                    },
                },
                renamed.version,
            ),
        ).toThrow("changed before its settings could be saved");
        expect(fixture.store.getProject(project.id)).toMatchObject({
            settings: { defaultWorkspaceCompute: { generation: 1, type: "local" } },
            version: configured.version,
        });
    });

    it("rejects impossible future versions for settings and archive", async () => {
        const fixture = await createFixture();
        const directory = join(fixture.root, "future-version");
        await mkdir(directory);
        const projectId = fixture.store.create({ cwd: directory }).snapshot().projectId;
        const project = fixture.store.getProject(projectId)!;
        const futureVersion = project.version + 1_000_000;

        expect(() =>
            fixture.store.setProjectSettings(
                projectId,
                { defaultWorkspaceCompute: { type: "local" } },
                futureVersion,
            ),
        ).toThrow("The project changed before its settings could be saved.");
        await expect(fixture.store.archiveProject(projectId, futureVersion)).rejects.toThrow(
            "The project changed before it could be archived.",
        );
    });

    it("renames after enrichment but rejects a concurrent user mutation", async () => {
        const fixture = await createFixture();
        const session = fixture.store.create({ cwd: fixture.home });
        const project = fixture.store.getProject(session.snapshot().projectId)!;

        fixture.store.applyGitFacts(
            { projectId: project.id },
            {
                ahead: 0,
                behind: 0,
                branch: "main",
                detached: false,
                head: "a".repeat(40),
            },
        );
        expect(fixture.store.getProject(project.id)?.version).toBe(project.version + 1);

        const renamed = fixture.store.renameProject(
            project.id,
            "Renamed after enrichment",
            project.version,
        )!;
        expect(renamed.name).toBe("Renamed after enrichment");

        fixture.store.setProjectSettings(
            project.id,
            { defaultWorkspaceCompute: { type: "local" } },
            renamed.version,
        );
        expect(() =>
            fixture.store.renameProject(project.id, "Overlapping rename", renamed.version),
        ).toThrow("The project changed before it could be renamed.");
    });

    it("enriches a Git top-level project from its upstream and repository logo", async () => {
        const fixture = await createFixture();
        const repository = join(fixture.root, "local-folder");
        await mkdir(repository);
        await git(repository, ["init"]);
        await git(repository, ["config", "user.email", "rig@example.test"]);
        await git(repository, ["config", "user.name", "Rig Test"]);
        await writeFile(join(repository, "README.md"), "fixture\n");
        await git(repository, ["add", "README.md"]);
        await git(repository, ["commit", "-m", "Initial"]);
        await git(repository, [
            "remote",
            "add",
            "origin",
            "git@github.com:slopus/upstream-name.git",
        ]);
        await sharp({
            create: {
                background: { alpha: 1, b: 90, g: 40, r: 200 },
                channels: 4,
                height: 512,
                width: 512,
            },
        })
            .png()
            .toFile(join(repository, "logo.png"));

        const session = fixture.store.create({ cwd: repository });
        const project = await waitForProject(
            fixture.store,
            session.snapshot().projectId,
            (value) => value.initializationStatus === "ready",
        );
        expect(project).toMatchObject({
            initializationStatus: "ready",
            name: "upstream-name",
            nameSource: "git_remote",
        });
        expect(project.avatar).toMatchObject({
            height: 256,
            mediaType: "image/webp",
            source: "repository",
            width: 256,
        });
        await expect(fixture.store.getProjectAvatar(project.avatar!.hash)).resolves.toMatchObject({
            hash: project.avatar!.hash,
            mediaType: "image/webp",
        });
    });

    it("creates a managed Git worktree and archives its attached sessions", async () => {
        const fixture = await createFixture();
        const repository = join(fixture.root, "source");
        await mkdir(repository);
        await git(repository, ["init"]);
        await git(repository, ["config", "user.email", "rig@example.test"]);
        await git(repository, ["config", "user.name", "Rig Test"]);
        await writeFile(join(repository, "README.md"), "fixture\n");
        await git(repository, ["add", "README.md"]);
        await git(repository, ["commit", "-m", "Initial"]);

        const sourceSession = fixture.store.create({ cwd: repository });
        const workspace = await fixture.store.createWorkspace(sourceSession.snapshot().projectId, {
            baseRef: "HEAD",
            name: "Feature Work",
        });
        if (workspace === undefined) throw new Error("Expected a workspace.");
        const ready = await waitForWorkspace(
            fixture.store,
            workspace.projectId,
            workspace.id,
            (value) => value.status === "ready" || value.status === "failed",
        );
        expect(ready.status).toBe("ready");
        expect(await git(ready.path, ["branch", "--show-current"])).toBe("worktree/feature-work");
        expect(await git(repository, ["rev-parse", "worktree/feature-work"])).toBe(
            ready.baseCommit,
        );

        const workspaceSession = fixture.store.create({
            cwd: ready.path,
            workspaceId: ready.id,
        });
        const workspaceFork = fixture.store.fork(workspaceSession.id);
        if (workspaceFork === undefined) throw new Error("Expected a workspace session fork.");
        expect(workspaceSession.snapshot()).toMatchObject({
            projectId: sourceSession.snapshot().projectId,
            workspaceId: ready.id,
        });

        const archived = await fixture.store.archiveWorkspace(
            ready.projectId,
            ready.id,
            ready.version,
        );
        expect(archived?.status).toBe("archiving");
        expect(workspaceSession.snapshot()).toMatchObject({
            archived: true,
            status: "archived",
        });
        expect(workspaceFork.snapshot()).toMatchObject({
            archived: true,
            status: "archived",
        });
        expect(() => workspaceSession.submit({ text: "Do not run." })).toThrow("archived");
        expect(() => fixture.store.fork(workspaceSession.id)).toThrow("archived");
        await waitForWorkspace(
            fixture.store,
            ready.projectId,
            ready.id,
            (value) => value.status === "archived",
        );
        await expect(access(ready.path)).rejects.toThrow();
        await mkdir(ready.path, { recursive: true });
        expect(() => fixture.store.create({ cwd: ready.path })).toThrow("archived");
    });

    it("transfers the commit, working files, ignored files, and .context with .happyignore", async () => {
        const transfer = await createTransferFixture();
        await writeFile(join(transfer.source.path, "committed.txt"), "committed\n");
        await writeFile(join(transfer.source.path, "tracked-excluded.txt"), "committed overlay\n");
        await git(transfer.source.path, ["add", "committed.txt", "tracked-excluded.txt"]);
        await git(transfer.source.path, ["commit", "-m", "Source commit"]);
        const commit = await git(transfer.source.path, ["rev-parse", "HEAD"]);
        await writeFile(join(transfer.source.path, "dirty.txt"), "dirty\n");
        await writeFile(join(transfer.source.path, "ignored.txt"), "ignored\n");
        await writeFile(join(transfer.source.path, "excluded.txt"), "excluded\n");
        await writeFile(
            join(transfer.source.path, ".happyignore"),
            "excluded.txt\ntracked-excluded.txt\n",
        );
        await rm(join(transfer.source.path, "tracked-excluded.txt"));
        await execFile("mkfifo", [join(transfer.source.path, "runtime.fifo")]);
        await mkdir(join(transfer.source.path, ".context"));
        await writeFile(join(transfer.source.path, ".context", "handoff.md"), "context\n");

        const result = await transfer.fixture.store.transferSession(transfer.session.id, {
            targetWorkspaceId: transfer.target.id,
        });

        expect(result).toMatchObject({
            commit,
            session: {
                id: transfer.session.id,
                workspaceId: transfer.target.id,
                cwd: transfer.target.path,
            },
            state: "succeeded",
        });
        await expect(readFile(join(transfer.target.path, "committed.txt"), "utf8")).resolves.toBe(
            "committed\n",
        );
        await expect(readFile(join(transfer.target.path, "dirty.txt"), "utf8")).resolves.toBe(
            "dirty\n",
        );
        await expect(readFile(join(transfer.target.path, "ignored.txt"), "utf8")).resolves.toBe(
            "ignored\n",
        );
        await expect(
            readFile(join(transfer.target.path, ".context", "handoff.md"), "utf8"),
        ).resolves.toBe("context\n");
        await expect(access(join(transfer.target.path, "excluded.txt"))).rejects.toThrow();
        await expect(access(join(transfer.target.path, "tracked-excluded.txt"))).rejects.toThrow();
        await expect(access(join(transfer.target.path, "runtime.fifo"))).rejects.toThrow();
        expect(await git(transfer.target.path, ["rev-parse", "HEAD"])).toBe(commit);
    });

    it("rejects a transfer while the session has an active turn", async () => {
        const transfer = await createTransferFixture();
        transfer.session.submit({ text: "Keep this turn busy." });

        await expect(
            transfer.fixture.store.transferSession(transfer.session.id, {
                targetWorkspaceId: transfer.target.id,
            }),
        ).rejects.toThrow("active response");
    });

    it("executes a requested mid-turn transfer after the turn and shows the notice next turn", async () => {
        const firstStarted = deferred<void>();
        const finishFirst = deferred<void>();
        let response = 0;
        const runtimeOptions: CreateCodingAssistantAgentOptions[] = [];
        const provider = defineProvider({
            id: "codex",
            models: [modelOpenaiGpt56Sol],
            stream(_model, _context, options) {
                if (options?.sessionId?.endsWith(":title")) {
                    return transferResponseStream(
                        JSON.stringify({ recap: "Transfer test.", title: "Transfer test" }),
                    );
                }
                response += 1;
                if (response === 1) {
                    firstStarted.resolve();
                    return transferResponseStream("First turn complete.", finishFirst.promise);
                }
                return transferResponseStream("Second turn complete.");
            },
        });
        const transfer = await createTransferFixture({
            createRuntime: (options) => {
                runtimeOptions.push(options);
                return createTransferTestRuntime(options, provider);
            },
        });
        const run = transfer.session.submit({ text: "Move this session." });
        await firstStarted.promise;
        const workspaceContext = runtimeOptions[0]?.workspaces;
        if (workspaceContext === undefined) throw new Error("Expected workspace tools.");

        await expect(workspaceContext.transfer(transfer.target.id)).resolves.toEqual({
            state: "scheduled",
            targetWorkspaceId: transfer.target.id,
        });
        await expect(workspaceContext.transfer(transfer.target.id)).rejects.toThrow(
            "already has a workspace transfer in progress",
        );
        expect(() =>
            transfer.fixture.store.create({
                cwd: transfer.target.path,
                workspaceId: transfer.target.id,
            }),
        ).toThrow("receiving a session transfer");
        expect(transfer.session.workspaceTransferState()).toEqual({
            status: "scheduled",
            targetWorkspaceId: transfer.target.id,
        });
        expect(transfer.session.snapshot()).toMatchObject({
            cwd: transfer.source.path,
            workspaceId: transfer.source.id,
        });
        await writeFile(join(transfer.source.path, "after-request.txt"), "included later\n");
        await expect(access(join(transfer.target.path, "after-request.txt"))).rejects.toThrow();

        finishFirst.resolve();
        await transfer.session.waitForRun(run.runId);
        await waitFor(
            () => transfer.session.snapshot(),
            (snapshot) => snapshot.workspaceId === transfer.target.id,
        );
        await expect(
            readFile(join(transfer.target.path, "after-request.txt"), "utf8"),
        ).resolves.toBe("included later\n");

        const next = transfer.session.submit({ text: "Where am I now?" });
        await transfer.session.waitForRun(next.runId);
        const nextOptions = runtimeOptions[1];
        expect(nextOptions?.cwd).toBe(transfer.target.path);
        const noticeText = nextOptions?.contextMessages
            ?.flatMap((message) =>
                message.role === "system"
                    ? message.blocks.flatMap((block) => (block.type === "text" ? [block.text] : []))
                    : [],
            )
            .find((text) => text.includes("<session-transfer-notice>"));
        expect(noticeText).toContain(transfer.target.path);
        expect(noticeText).toContain("working-tree overlay");
        expect(noticeText).toContain("Subagents spawned earlier");
    });

    it("records a durable failure notice when a turn-end transfer fails", async () => {
        const started = deferred<void>();
        const finish = deferred<void>();
        const runtimeOptions: CreateCodingAssistantAgentOptions[] = [];
        let failSourceLsTree = true;
        const provider = defineProvider({
            id: "codex",
            models: [modelOpenaiGpt56Sol],
            stream(_model, _context, options) {
                if (options?.sessionId?.endsWith(":title")) {
                    return transferResponseStream(
                        JSON.stringify({ recap: "Transfer test.", title: "Transfer test" }),
                    );
                }
                started.resolve();
                return transferResponseStream("Turn complete.", finish.promise);
            },
        });
        const transfer = await createTransferFixture({
            createRuntime: (options) => {
                runtimeOptions.push(options);
                return createTransferTestRuntime(options, provider);
            },
            projectGit: async (cwd, args) => {
                if (failSourceLsTree && cwd.includes("source") && args[0] === "ls-tree") {
                    failSourceLsTree = false;
                    throw new Error("Injected turn-end transfer failure.");
                }
                return git(cwd, args);
            },
        });
        const run = transfer.session.submit({ text: "Move after this turn." });
        await started.promise;
        const workspaceContext = runtimeOptions[0]?.workspaces;
        if (workspaceContext === undefined) throw new Error("Expected workspace tools.");
        await workspaceContext.transfer(transfer.target.id);

        finish.resolve();
        await transfer.session.waitForRun(run.runId);
        await waitFor(
            () => transfer.session.workspaceTransferState(),
            (state) => state.status === "failed",
        );
        expect(transfer.session.workspaceTransferState()).toMatchObject({
            errorMessage: "Injected turn-end transfer failure.",
            status: "failed",
        });
        expect(
            transfer.session.events
                .all()
                .some(
                    (event) =>
                        event.type === "run_error" &&
                        event.data.errorMessage.includes("Session transfer failed"),
                ),
        ).toBe(true);

        const next = transfer.session.submit({ text: "Did the move work?" });
        await transfer.session.waitForRun(next.runId);
        const failureNotice = transfer.session
            .state()
            .contextMessages?.flatMap((message) =>
                message.role === "system"
                    ? message.blocks.flatMap((block) => (block.type === "text" ? [block.text] : []))
                    : [],
            )
            .find((text) => text.includes("<session-transfer-failure-notice>"));
        expect(failureNotice).toContain("FAILED");
        expect(failureNotice).toContain(transfer.source.path);
        expect(failureNotice).toContain("Injected turn-end transfer failure.");
    });

    it("restores the target commit clean and keeps the source untouched when applying fails", async () => {
        let failSourceLsTree = false;
        const transfer = await createTransferFixture({
            projectGit: async (cwd, args) => {
                if (failSourceLsTree && cwd.includes("source") && args[0] === "ls-tree") {
                    failSourceLsTree = false;
                    throw new Error("Injected transfer failure.");
                }
                return git(cwd, args);
            },
        });
        const targetCommit = await git(transfer.target.path, ["rev-parse", "HEAD"]);
        await writeFile(join(transfer.target.path, "target-only.txt"), "preserve me\n");
        await writeFile(join(transfer.source.path, "dirty.txt"), "source change\n");
        failSourceLsTree = true;

        await expect(
            transfer.fixture.store.transferSession(transfer.session.id, {
                targetWorkspaceId: transfer.target.id,
            }),
        ).rejects.toThrow("Injected transfer failure");

        expect(transfer.session.snapshot()).toMatchObject({
            cwd: transfer.source.path,
            workspaceId: transfer.source.id,
        });
        expect(transfer.session.workspaceTransferState()).toMatchObject({
            status: "failed",
            targetWorkspaceId: transfer.target.id,
        });
        expect(await git(transfer.target.path, ["rev-parse", "HEAD"])).toBe(targetCommit);
        await expect(access(join(transfer.target.path, "target-only.txt"))).rejects.toThrow();
        await expect(access(join(transfer.target.path, "dirty.txt"))).rejects.toThrow();
        await expect(readFile(join(transfer.source.path, "dirty.txt"), "utf8")).resolves.toBe(
            "source change\n",
        );
    });

    it("quarantines and names a target workspace when restoring it fails", async () => {
        let applyingFailed = false;
        const transfer = await createTransferFixture({
            projectGit: async (cwd, args) => {
                if (cwd.includes("source") && args[0] === "ls-tree") {
                    applyingFailed = true;
                    throw new Error("Original apply failure.");
                }
                if (applyingFailed && cwd.includes("target") && args[0] === "reset") {
                    throw new Error("Target restore failure.");
                }
                return git(cwd, args);
            },
        });

        await expect(
            transfer.fixture.store.transferSession(transfer.session.id, {
                targetWorkspaceId: transfer.target.id,
            }),
        ).rejects.toThrow(
            "workspace 'Transfer Target': Original apply failure. The workspace could not be restored: Target restore failure.",
        );
        expect(transfer.session.workspaceTransferState()).toMatchObject({
            errorMessage: expect.stringContaining("Original apply failure."),
            status: "failed",
            target: "restore_failed",
        });
        expect(
            transfer.fixture.store.getWorkspace(transfer.target.projectId, transfer.target.id),
        ).toMatchObject({
            error: expect.stringContaining("Target restore failure."),
            status: "failed",
        });
        expect(() =>
            transfer.fixture.store.create({
                cwd: transfer.target.path,
                workspaceId: transfer.target.id,
            }),
        ).toThrow("is failed");
    });

    it("rejects a target workspace that already has an attached session", async () => {
        const transfer = await createTransferFixture();
        transfer.fixture.store.create({
            cwd: transfer.target.path,
            workspaceId: transfer.target.id,
        });

        await expect(
            transfer.fixture.store.transferSession(transfer.session.id, {
                targetWorkspaceId: transfer.target.id,
            }),
        ).rejects.toThrow("no attached sessions");
        expect(transfer.session.snapshot()).toMatchObject({
            cwd: transfer.source.path,
            workspaceId: transfer.source.id,
        });
    });

    it("accepts a target workspace whose only attached sessions are archived", async () => {
        const transfer = await createTransferFixture();
        const archived = transfer.fixture.store.create({
            cwd: transfer.target.path,
            workspaceId: transfer.target.id,
        });
        archived.setArchived(true);

        await expect(
            transfer.fixture.store.transferSession(transfer.session.id, {
                targetWorkspaceId: transfer.target.id,
            }),
        ).resolves.toMatchObject({ state: "succeeded" });
    });

    it("abandons a persisted pending transfer on restart with a failure notice", async () => {
        const started = deferred<void>();
        const neverFinish = deferred<void>();
        const runtimeOptions: CreateCodingAssistantAgentOptions[] = [];
        const provider = defineProvider({
            id: "codex",
            models: [modelOpenaiGpt56Sol],
            stream(_model, _context, options) {
                if (options?.sessionId?.endsWith(":title")) {
                    return transferResponseStream(
                        JSON.stringify({ recap: "Transfer test.", title: "Transfer test" }),
                    );
                }
                started.resolve();
                return transferResponseStream("Still running.", neverFinish.promise);
            },
        });
        const transfer = await createTransferFixture({
            createRuntime: (options) => {
                runtimeOptions.push(options);
                return createTransferTestRuntime(options, provider);
            },
        });
        transfer.session.submit({ text: "Schedule and crash." });
        await started.promise;
        const workspaceContext = runtimeOptions[0]?.workspaces;
        if (workspaceContext === undefined) throw new Error("Expected workspace tools.");
        await workspaceContext.transfer(transfer.target.id);
        transfer.fixture.store.close();

        const restarted = await transfer.fixture.restart();
        const restored = restarted.get(transfer.session.id);
        if (restored === undefined) throw new Error("Expected restored session.");
        expect(restored.workspaceTransferState()).toMatchObject({
            errorMessage: expect.stringContaining("local server stopped"),
            status: "failed",
            target: "not_touched",
            targetWorkspaceId: transfer.target.id,
        });
        const failureNotice = restored
            .state()
            .contextMessages?.flatMap((message) =>
                message.role === "system"
                    ? message.blocks.flatMap((block) => (block.type === "text" ? [block.text] : []))
                    : [],
            )
            .find((text) => text.includes("<session-transfer-failure-notice>"));
        expect(failureNotice).toContain("FAILED");
        expect(failureNotice).toContain(transfer.source.path);
        expect(failureNotice).toContain("local server stopped");
    });

    it("persists an internal move notice for the next turn", async () => {
        const transfer = await createTransferFixture();
        const commit = await git(transfer.source.path, ["rev-parse", "HEAD"]);

        await transfer.fixture.store.transferSession(transfer.session.id, {
            targetWorkspaceId: transfer.target.id,
        });

        transfer.fixture.store.close();
        const restarted = await transfer.fixture.restart();
        const restored = restarted.get(transfer.session.id);
        if (restored === undefined) throw new Error("Expected the transferred session.");
        const notice = restored
            .state()
            .contextMessages?.findLast(
                (message) =>
                    message.role === "system" &&
                    message.blocks.some(
                        (block) =>
                            block.type === "text" &&
                            block.text.includes("<session-transfer-notice>"),
                    ),
            );
        const noticeText = notice?.blocks
            .flatMap((block) => (block.type === "text" ? [block.text] : []))
            .join("\n");
        expect(notice).toMatchObject({ internal: true, role: "system" });
        expect(noticeText).toContain(transfer.target.path);
        expect(noticeText).toContain(commit);
    });

    it("archives a workspace while an observer writes on its own connection", async () => {
        // Happy sync attaches to a session the moment the store hands it out, and writes through a
        // second connection to the same file. A workspace archival that holds the write lock while
        // it looks up its sessions can never let that write through, and SQLite is synchronous, so
        // the daemon deadlocks against itself until the busy timeout reports "database is locked".
        let observe = false;
        const observed: string[] = [];
        const fixture = await createFixture({
            onSessionAccess: (session) => {
                if (!observe) return;
                observed.push(session.id);
                writeOnSeparateConnection(fixture.databasePath);
            },
        });
        const repository = await createRepository(fixture.root, "observed-source");
        const source = fixture.store.create({ cwd: repository });
        const workspace = await fixture.store.createWorkspace(source.snapshot().projectId, {
            baseRef: "HEAD",
            name: "Observed Work",
        });
        if (workspace === undefined) throw new Error("Expected a workspace.");
        const ready = await waitForWorkspace(
            fixture.store,
            workspace.projectId,
            workspace.id,
            (value) => value.status === "ready" || value.status === "failed",
        );
        expect(ready.status).toBe("ready");
        const workspaceSession = fixture.store.create({ cwd: ready.path, workspaceId: ready.id });

        observe = true;
        const archived = await fixture.store.archiveWorkspace(ready.projectId, ready.id);

        expect(archived?.status).toBe("archiving");
        expect(observed).toContain(workspaceSession.id);
        expect(workspaceSession.snapshot()).toMatchObject({ archived: true, status: "archived" });
        await waitForWorkspace(
            fixture.store,
            ready.projectId,
            ready.id,
            (value) => value.status === "archived",
        );
    });

    it("runs configured workspace setup commands in order before becoming ready", async () => {
        const fixture = await createFixture();
        const repository = await createRepository(fixture.root, "setup-source");
        await writeFile(
            join(repository, "rig.toml"),
            [
                "[workspace]",
                "setup_commands = [",
                '    "printf first > workspace-setup-order.txt",',
                '    "test \\"$(cat workspace-setup-order.txt)\\" = first && printf -- \\"\\\\nsecond\\\\n\\" >> workspace-setup-order.txt",',
                "]",
                "",
            ].join("\n"),
        );
        await git(repository, ["add", "rig.toml"]);
        await git(repository, ["commit", "-m", "Configure workspace setup"]);
        const source = fixture.store.create({ cwd: repository });

        const created = await fixture.store.createWorkspace(source.snapshot().projectId, {
            baseRef: "HEAD",
            name: "Configured Setup",
        });
        if (created === undefined) throw new Error("Expected a workspace.");
        const initialized = await waitForWorkspace(
            fixture.store,
            created.projectId,
            created.id,
            (workspace) => workspace.status === "ready" || workspace.status === "failed",
        );

        expect(initialized.status).toBe("ready");
        await expect(
            readFile(join(initialized.path, "workspace-setup-order.txt"), "utf8"),
        ).resolves.toBe("first\nsecond\n");
        expect(
            fixture.store
                .create({
                    cwd: initialized.path,
                    workspaceId: initialized.id,
                })
                .snapshot(),
        ).toMatchObject({
            workspaceId: initialized.id,
        });
    });

    it("fails workspace initialization on the first failed setup command", async () => {
        const fixture = await createFixture();
        const repository = await createRepository(fixture.root, "failed-setup-source");
        await writeFile(
            join(repository, "rig.toml"),
            [
                "[workspace]",
                "setup_commands = [",
                '    "printf before > setup-before.txt",',
                '    "printf setup-failed >&2; exit 7",',
                '    "printf after > setup-after.txt",',
                "]",
                "",
            ].join("\n"),
        );
        await git(repository, ["add", "rig.toml"]);
        await git(repository, ["commit", "-m", "Configure failing workspace setup"]);
        const source = fixture.store.create({ cwd: repository });

        const created = await fixture.store.createWorkspace(source.snapshot().projectId, {
            baseRef: "HEAD",
            name: "Failed Setup",
        });
        if (created === undefined) throw new Error("Expected a workspace.");
        const initialized = await waitForWorkspace(
            fixture.store,
            created.projectId,
            created.id,
            (workspace) => workspace.status === "ready" || workspace.status === "failed",
        );

        expect(initialized).toMatchObject({
            error: expect.stringContaining("setup-failed"),
            status: "failed",
        });
        await expect(readFile(join(initialized.path, "setup-before.txt"), "utf8")).resolves.toBe(
            "before",
        );
        await expect(readFile(join(initialized.path, "setup-after.txt"), "utf8")).rejects.toThrow();
        expect(() =>
            fixture.store.create({
                cwd: initialized.path,
                workspaceId: initialized.id,
            }),
        ).toThrow("failed");
    });

    it("serializes same-project Git work without serializing workspace setup", async () => {
        const fixture = await createFixture();
        const repository = await createRepository(fixture.root, "parallel-setup-source");
        const releasePath = join(repository, "release-workspace-setup");
        const setupCommand = [
            "printf started > setup-started.txt",
            `while [ ! -f ${JSON.stringify(releasePath)} ]; do sleep 0.02; done`,
        ].join("; ");
        await writeFile(
            join(repository, "rig.toml"),
            ["[workspace]", `setup_commands = [${JSON.stringify(setupCommand)}]`, ""].join("\n"),
        );
        await git(repository, ["add", "rig.toml"]);
        await git(repository, ["commit", "-m", "Configure parallel workspace setup"]);
        const source = fixture.store.create({ cwd: repository });

        const first = await fixture.store.createWorkspace(source.snapshot().projectId, {
            baseRef: "HEAD",
            name: "First Setup",
        });
        if (first === undefined) throw new Error("Expected the first workspace.");
        await waitForPath(join(first.path, "setup-started.txt"));
        const second = await fixture.store.createWorkspace(source.snapshot().projectId, {
            baseRef: "HEAD",
            name: "Second Setup",
        });
        if (second === undefined) throw new Error("Expected the second workspace.");
        try {
            await waitForPath(join(second.path, "setup-started.txt"), 1_000);
        } finally {
            await writeFile(releasePath, "release\n");
        }

        await Promise.all([
            waitForWorkspace(
                fixture.store,
                first.projectId,
                first.id,
                (workspace) => workspace.status === "ready",
            ),
            waitForWorkspace(
                fixture.store,
                second.projectId,
                second.id,
                (workspace) => workspace.status === "ready",
            ),
        ]);
    });

    it("bounds recovery setup work while retaining per-project Git serialization", async () => {
        const fixture = await createFixture();
        const repository = await createRepository(fixture.root, "bounded-recovery-source");
        const source = fixture.store.create({ cwd: repository });
        const reserved = await Promise.all(
            Array.from({ length: 5 }, (_, index) =>
                fixture.store.createWorkspace(source.snapshot().projectId, {
                    baseRef: "HEAD",
                    name: `Recovery ${index + 1}`,
                }),
            ),
        );
        if (reserved.some((workspace) => workspace === undefined)) {
            throw new Error("Expected recovery workspaces.");
        }
        const workspaces = await Promise.all(
            reserved.map(async (workspace) => {
                const value = workspace;
                if (value === undefined) throw new Error("Expected a recovery workspace.");
                return await waitForWorkspace(
                    fixture.store,
                    value.projectId,
                    value.id,
                    (candidate) => candidate.status === "ready",
                );
            }),
        );
        const releasePath = join(fixture.root, "release-recovery-setup");
        const setupCommand = [
            "printf started > recovery-setup-started.txt",
            `while [ ! -f ${JSON.stringify(releasePath)} ]; do sleep 0.02; done`,
        ].join("; ");
        await Promise.all(
            workspaces.map((workspace) =>
                writeFile(
                    join(workspace.path, "rig.toml"),
                    ["[workspace]", `setup_commands = [${JSON.stringify(setupCommand)}]`, ""].join(
                        "\n",
                    ),
                ),
            ),
        );

        fixture.store.close();
        const opened = openSessionDatabase(fixture.databasePath);
        opened.database
            .update(projectWorkspaces)
            .set({ status: "initializing" })
            .where(eq(projectWorkspaces.projectId, source.snapshot().projectId))
            .run();
        opened.client.close();

        const recovered = await fixture.restart();
        try {
            const markerPaths = workspaces.map((workspace) =>
                join(workspace.path, "recovery-setup-started.txt"),
            );
            const deadline = Date.now() + 10_000;
            let started = 0;
            while (started < 4) {
                started = (
                    await Promise.all(
                        markerPaths.map(async (path) => {
                            try {
                                await access(path);
                                return true;
                            } catch {
                                return false;
                            }
                        }),
                    )
                ).filter(Boolean).length;
                if (Date.now() >= deadline) {
                    throw new Error("Timed out waiting for bounded recovery setup work.");
                }
                await new Promise<void>((resolve) => setTimeout(resolve, 20));
            }
            await new Promise<void>((resolve) => setTimeout(resolve, 100));
            const startedBeforeRelease = (
                await Promise.all(
                    markerPaths.map(async (path) => {
                        try {
                            await access(path);
                            return true;
                        } catch {
                            return false;
                        }
                    }),
                )
            ).filter(Boolean).length;
            expect(startedBeforeRelease).toBe(4);

            await writeFile(releasePath, "release\n");
            await Promise.all(
                workspaces.map((workspace) =>
                    waitForWorkspace(
                        recovered,
                        workspace.projectId,
                        workspace.id,
                        (candidate) => candidate.status === "ready",
                    ),
                ),
            );
        } finally {
            await writeFile(releasePath, "release\n");
            recovered.close();
        }
    });

    it("reserves an initializing workspace before base preparation finishes and retries it idempotently", async () => {
        const baseResolutionStarted = deferred<void>();
        const releaseBaseResolution = deferred<void>();
        let blockBaseResolution = false;
        const fixture = await createFixture({
            durableGlobalEventQueue: true,
            projectGit: async (cwd, args) => {
                if (
                    blockBaseResolution &&
                    args[0] === "rev-parse" &&
                    args[1] === "--verify" &&
                    args[2] === "--end-of-options" &&
                    args[3] === "HEAD^{commit}"
                ) {
                    baseResolutionStarted.resolve(undefined);
                    await releaseBaseResolution.promise;
                }
                return git(cwd, args);
            },
        });
        const repository = await createRepository(fixture.root, "reserved-before-base");
        const source = fixture.store.create({ cwd: repository });
        const projectId = source.snapshot().projectId;
        const workspaceId = createId();
        blockBaseResolution = true;

        const creating = fixture.store.createWorkspace(projectId, {
            baseRef: "HEAD",
            id: workspaceId,
            name: "Reserved Before Base",
        });
        await baseResolutionStarted.promise;

        try {
            expect(fixture.store.getWorkspace(projectId, workspaceId)).toMatchObject({
                id: workspaceId,
                status: "initializing",
            });
            expect(
                fixture.store.globalEventQueue
                    .list()
                    ?.filter((entry) => entry.event.type === "workspace_created"),
            ).toHaveLength(1);

            const created = await creating;
            expect(created).toMatchObject({ id: workspaceId, status: "initializing" });
            await expect(
                fixture.store.createWorkspace(projectId, {
                    baseRef: "HEAD",
                    id: workspaceId,
                    name: "Reserved Before Base",
                }),
            ).resolves.toMatchObject({ id: workspaceId, status: "initializing" });
            expect(fixture.store.listWorkspaces(projectId)).toHaveLength(1);
        } finally {
            releaseBaseResolution.resolve(undefined);
            await creating.catch(() => undefined);
        }

        await expect(
            waitForWorkspace(
                fixture.store,
                projectId,
                workspaceId,
                (workspace) => workspace.status === "ready",
            ),
        ).resolves.toMatchObject({ status: "ready" });
    });

    it("keeps a reservation and marks it failed when delayed base preparation fails", async () => {
        const baseResolutionStarted = deferred<void>();
        const failBaseResolution = deferred<void>();
        let blockBaseResolution = false;
        const fixture = await createFixture({
            projectGit: async (cwd, args) => {
                if (
                    blockBaseResolution &&
                    args[0] === "rev-parse" &&
                    args[1] === "--verify" &&
                    args[2] === "--end-of-options" &&
                    args[3] === "HEAD^{commit}"
                ) {
                    baseResolutionStarted.resolve(undefined);
                    await failBaseResolution.promise;
                    throw new Error("Injected base preparation failure.");
                }
                return git(cwd, args);
            },
        });
        const repository = await createRepository(fixture.root, "reserved-base-failure");
        const source = fixture.store.create({ cwd: repository });
        const projectId = source.snapshot().projectId;
        const workspaceId = createId();
        blockBaseResolution = true;

        const creating = fixture.store.createWorkspace(projectId, {
            baseRef: "HEAD",
            id: workspaceId,
            name: "Reserved Base Failure",
        });
        await baseResolutionStarted.promise;

        try {
            expect(fixture.store.getWorkspace(projectId, workspaceId)).toMatchObject({
                id: workspaceId,
                status: "initializing",
            });
            await expect(creating).resolves.toMatchObject({
                id: workspaceId,
                status: "initializing",
            });
        } finally {
            failBaseResolution.resolve(undefined);
            await creating.catch(() => undefined);
        }

        await expect(
            waitForWorkspace(
                fixture.store,
                projectId,
                workspaceId,
                (workspace) => workspace.status === "failed",
            ),
        ).resolves.toMatchObject({
            error: expect.stringContaining('The workspace base "HEAD" did not resolve'),
            status: "failed",
        });
    });

    it("versions and publishes resolved initialization facts before materialization", async () => {
        const worktreeAddStarted = deferred<void>();
        const releaseWorktreeAdd = deferred<void>();
        const fixture = await createFixture({
            durableGlobalEventQueue: true,
            projectGit: async (cwd, args) => {
                if (args[0] === "worktree" && args[1] === "add") {
                    worktreeAddStarted.resolve(undefined);
                    await releaseWorktreeAdd.promise;
                }
                return git(cwd, args);
            },
        });
        const repository = await createRepository(fixture.root, "versioned-initialization");
        const source = fixture.store.create({ cwd: repository });
        const workspace = await fixture.store.createWorkspace(source.snapshot().projectId, {
            baseRef: "HEAD",
            name: "Versioned Initialization",
        });
        if (workspace === undefined) throw new Error("Expected a workspace.");
        await worktreeAddStarted.promise;

        try {
            const recorded = fixture.store.getWorkspace(workspace.projectId, workspace.id);
            expect(recorded).toMatchObject({
                baseCommit: expect.any(String),
                baseRef: "HEAD",
                gitCommonDir: expect.any(String),
                id: workspace.id,
                status: "initializing",
                version: workspace.version + 1,
            });
            const initializationUpdates =
                fixture.store.globalEventQueue.list()?.flatMap((entry) => {
                    if (
                        entry.event.type !== "workspace_updated" ||
                        !("workspace" in entry.event.data)
                    ) {
                        return [];
                    }
                    const eventWorkspace = entry.event.data.workspace;
                    return eventWorkspace.id === workspace.id &&
                        eventWorkspace.status === "initializing"
                        ? [eventWorkspace]
                        : [];
                }) ?? [];
            expect(initializationUpdates.at(-1)?.version).toBe(workspace.version + 1);
        } finally {
            releaseWorktreeAdd.resolve(undefined);
        }

        await expect(
            waitForWorkspace(
                fixture.store,
                workspace.projectId,
                workspace.id,
                (value) => value.status === "ready",
            ),
        ).resolves.toMatchObject({ version: workspace.version + 2 });
    });

    it("serializes initialization Git work within one project while other projects continue", async () => {
        const firstBaseResolutionStarted = deferred<void>();
        const otherBaseResolutionStarted = deferred<void>();
        const releaseFirstBaseResolution = deferred<void>();
        let serializedRepositoryName: string | undefined;
        let baseResolutions = 0;
        let otherBaseResolutions = 0;
        const fixture = await createFixture({
            projectGit: async (cwd, args) => {
                if (
                    args[0] === "rev-parse" &&
                    args[1] === "--verify" &&
                    args[2] === "--end-of-options" &&
                    args[3] === "HEAD^{commit}"
                ) {
                    if (basename(cwd) === serializedRepositoryName) {
                        baseResolutions += 1;
                        if (baseResolutions === 1) {
                            firstBaseResolutionStarted.resolve(undefined);
                            await releaseFirstBaseResolution.promise;
                        }
                    } else {
                        otherBaseResolutions += 1;
                        otherBaseResolutionStarted.resolve(undefined);
                    }
                }
                return git(cwd, args);
            },
        });
        const repository = await createRepository(fixture.root, "serialized-initialization");
        serializedRepositoryName = basename(repository);
        const source = fixture.store.create({ cwd: repository });
        const first = await fixture.store.createWorkspace(source.snapshot().projectId, {
            baseRef: "HEAD",
            name: "First",
        });
        if (first === undefined) throw new Error("Expected the first workspace.");
        await firstBaseResolutionStarted.promise;
        const second = await fixture.store.createWorkspace(source.snapshot().projectId, {
            baseRef: "HEAD",
            name: "Second",
        });
        if (second === undefined) throw new Error("Expected the second workspace.");
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(baseResolutions).toBe(1);

        const otherRepository = await createRepository(fixture.root, "parallel-initialization");
        const otherSource = fixture.store.create({ cwd: otherRepository });
        const other = await fixture.store.createWorkspace(otherSource.snapshot().projectId, {
            baseRef: "HEAD",
            name: "Other Project",
        });
        if (other === undefined) throw new Error("Expected the other workspace.");
        const startedInParallel = await Promise.race([
            otherBaseResolutionStarted.promise.then(() => true),
            new Promise<false>((resolve) => setTimeout(() => resolve(false), 500)),
        ]);
        releaseFirstBaseResolution.resolve(undefined);
        expect(startedInParallel).toBe(true);
        expect(otherBaseResolutions).toBe(1);
        const initialized = await Promise.all([
            waitForWorkspace(
                fixture.store,
                first.projectId,
                first.id,
                (value) => value.status === "ready" || value.status === "failed",
            ),
            waitForWorkspace(
                fixture.store,
                second.projectId,
                second.id,
                (value) => value.status === "ready" || value.status === "failed",
            ),
            waitForWorkspace(
                fixture.store,
                other.projectId,
                other.id,
                (value) => value.status === "ready" || value.status === "failed",
            ),
        ]);
        expect(initialized.map((workspace) => workspace.status)).toEqual([
            "ready",
            "ready",
            "ready",
        ]);
        expect(baseResolutions).toBe(2);
    });

    it("starts every waiting session automatically and preserves each session's submission order", async () => {
        const worktreeAddStarted = deferred<void>();
        const releaseWorktreeAdd = deferred<void>();
        const runtimeOptions: CreateCodingAssistantAgentOptions[] = [];
        const submissionOrder: string[] = [];
        const provider = defineProvider({
            id: "codex",
            models: [modelOpenaiGpt56Sol],
            stream(_model, context, options) {
                if (!options?.sessionId?.endsWith(":title")) {
                    const message = context.messages.findLast(
                        (candidate) => candidate.role === "user",
                    );
                    const text =
                        message?.role === "user" && Array.isArray(message.content)
                            ? message.content
                                  .flatMap((block) => (block.type === "text" ? [block.text] : []))
                                  .join("\n")
                            : "";
                    submissionOrder.push(text);
                }
                return transferResponseStream("Completed.");
            },
        });
        const fixture = await createFixture({
            createRuntime: (options) => {
                runtimeOptions.push(options);
                return createTransferTestRuntime(options, provider);
            },
            projectGit: async (cwd, args) => {
                if (args[0] === "worktree" && args[1] === "add") {
                    worktreeAddStarted.resolve();
                    await releaseWorktreeAdd.promise;
                }
                return git(cwd, args);
            },
        });
        const repository = await createRepository(fixture.root, "waiting-sessions");
        const projectId = fixture.store.create({ cwd: repository }).snapshot().projectId;
        const workspace = await fixture.store.createWorkspace(projectId, {
            baseRef: "HEAD",
            name: "Waiting Sessions",
        });
        if (workspace === undefined) throw new Error("Expected a workspace.");
        await worktreeAddStarted.promise;

        const first = fixture.store.create({ cwd: workspace.path, workspaceId: workspace.id });
        const second = fixture.store.create({ cwd: workspace.path, workspaceId: workspace.id });
        const equivalentPath = fixture.store.create({
            cwd: `${workspace.path}/.`,
            workspaceId: workspace.id,
        });
        const firstRun = first.submit({ text: "First submission." });
        const secondRun = first.submit({ text: "Second submission." });
        const otherRun = second.submit({ text: "Other session." });
        const equivalentPathRun = equivalentPath.submit({ text: "Equivalent path." });
        await new Promise((resolve) => setImmediate(resolve));

        expect(runtimeOptions).toEqual([]);
        expect(first.state().queuedRuns).toHaveLength(2);
        expect(second.state().queuedRuns).toHaveLength(1);

        releaseWorktreeAdd.resolve();
        await Promise.all([
            first.waitForRun(firstRun.runId),
            first.waitForRun(secondRun.runId),
            second.waitForRun(otherRun.runId),
            equivalentPath.waitForRun(equivalentPathRun.runId),
        ]);

        expect(submissionOrder).toEqual(
            expect.arrayContaining([
                "First submission.",
                "Second submission.",
                "Other session.",
                "Equivalent path.",
            ]),
        );
        expect(submissionOrder.indexOf("First submission.")).toBeLessThan(
            submissionOrder.indexOf("Second submission."),
        );
        expect(runtimeOptions).toHaveLength(3);
    });

    it("fails a waiting run durably without removing its session or user message", async () => {
        const baseResolutionStarted = deferred<void>();
        const failBaseResolution = deferred<void>();
        let runtimes = 0;
        const fixture = await createFixture({
            createRuntime: () => {
                runtimes += 1;
                throw new Error("A failed workspace must not create a runtime.");
            },
            projectGit: async (cwd, args) => {
                if (
                    args[0] === "rev-parse" &&
                    args[1] === "--verify" &&
                    args[2] === "--end-of-options" &&
                    args[3] === "HEAD^{commit}"
                ) {
                    baseResolutionStarted.resolve();
                    await failBaseResolution.promise;
                    throw new Error("Injected unavailable base.");
                }
                return git(cwd, args);
            },
        });
        const repository = await createRepository(fixture.root, "waiting-failure");
        const projectId = fixture.store.create({ cwd: repository }).snapshot().projectId;
        const workspace = await fixture.store.createWorkspace(projectId, {
            baseRef: "HEAD",
            name: "Waiting Failure",
        });
        if (workspace === undefined) throw new Error("Expected a workspace.");
        await baseResolutionStarted.promise;
        const session = fixture.store.create({ cwd: workspace.path, workspaceId: workspace.id });
        const submitted = session.submit({
            clientSubmissionId: "waiting-failure-message",
            debug: true,
            text: "Keep this message.",
        });

        failBaseResolution.resolve();
        await session.waitForRun(submitted.runId);

        expect(fixture.store.get(session.id)).toBe(session);
        expect(session.state().queuedRuns).toEqual([]);
        expect(session.state().messages).toMatchObject([
            { message: { id: "waiting-failure-message", role: "user" } },
        ]);
        expect(
            session.events
                .since(undefined)
                ?.find(
                    (event) => event.type === "run_error" && event.data.runId === submitted.runId,
                ),
        ).toMatchObject({
            data: { errorMessage: expect.stringContaining("workspace initialization failed") },
            type: "run_error",
        });
        await expect(access(workspace.path)).rejects.toMatchObject({ code: "ENOENT" });
        expect(runtimes).toBe(0);
    });

    it("resumes a waiting workspace run after daemon restart", async () => {
        const worktreeAddStarted = deferred<void>();
        const releaseWorktreeAdd = deferred<void>();
        const worktreeAddFinished = deferred<void>();
        const providerRuns: string[] = [];
        const provider = defineProvider({
            id: "codex",
            models: [modelOpenaiGpt56Sol],
            stream(_model, context, options) {
                if (!options?.sessionId?.endsWith(":title")) {
                    const message = context.messages.findLast(
                        (candidate) => candidate.role === "user",
                    );
                    if (message?.role === "user" && Array.isArray(message.content)) {
                        providerRuns.push(
                            message.content
                                .flatMap((block) => (block.type === "text" ? [block.text] : []))
                                .join("\n"),
                        );
                    }
                }
                return transferResponseStream("Recovered.");
            },
        });
        let blockFirstAdd = true;
        const fixture = await createFixture({
            createRuntime: (options) => createTransferTestRuntime(options, provider),
            projectGit: async (cwd, args) => {
                if (blockFirstAdd && args[0] === "worktree" && args[1] === "add") {
                    worktreeAddStarted.resolve();
                    await releaseWorktreeAdd.promise;
                    try {
                        return await git(cwd, args);
                    } finally {
                        blockFirstAdd = false;
                        worktreeAddFinished.resolve();
                    }
                }
                return git(cwd, args);
            },
        });
        const repository = await createRepository(fixture.root, "waiting-restart");
        const projectId = fixture.store.create({ cwd: repository }).snapshot().projectId;
        const workspace = await fixture.store.createWorkspace(projectId, {
            baseRef: "HEAD",
            name: "Waiting Restart",
        });
        if (workspace === undefined) throw new Error("Expected a workspace.");
        await worktreeAddStarted.promise;
        const session = fixture.store.create({ cwd: workspace.path, workspaceId: workspace.id });
        const submitted = session.submit({
            clientSubmissionId: "waiting-restart-message",
            text: "Resume after restart.",
        });
        fixture.store.close();
        releaseWorktreeAdd.resolve();
        await worktreeAddFinished.promise;

        const restarted = await fixture.restart();
        const restored = restarted.get(session.id);
        if (restored === undefined) throw new Error("Expected the waiting session.");
        await restored.waitForRun(submitted.runId);

        expect(providerRuns).toEqual(["Resume after restart."]);
        expect(restored.state().messages).toMatchObject([
            { message: { id: "waiting-restart-message", role: "user" } },
            { message: { role: "agent" } },
        ]);
        expect(restored.state().interruption).toBeUndefined();
    });

    it("skips workspace storage keys already occupied on disk or in packed Git refs", async () => {
        const fixture = await createFixture();
        const repository = await createRepository(fixture.root, "collision-source");
        const source = fixture.store.create({ cwd: repository });
        const project = fixture.store.getProject(source.snapshot().projectId);
        if (project === undefined) throw new Error("Expected a project.");
        await mkdir(join(fixture.state, "workspaces", project.storageKey, "workspace"), {
            recursive: true,
        });
        await git(repository, ["branch", "worktree/workspace-2"]);
        await git(repository, ["pack-refs", "--all", "--prune"]);

        const created = await fixture.store.createWorkspace(project.id, {
            baseRef: "HEAD",
            name: "Workspace",
        });
        if (created === undefined) throw new Error("Expected a workspace.");
        const ready = await waitForWorkspace(
            fixture.store,
            project.id,
            created.id,
            (value) => value.status === "ready" || value.status === "failed",
        );

        expect(ready).toMatchObject({
            status: "ready",
            storageKey: "workspace-3",
        });
        expect(await git(ready.path, ["branch", "--show-current"])).toBe("worktree/workspace-3");
        expect(fixture.store.create({ cwd: ready.path }).snapshot()).toMatchObject({
            projectId: project.id,
            workspaceId: ready.id,
        });
    });

    it("finds packed workspace branches through a linked worktree gitdir", async () => {
        const fixture = await createFixture();
        const repository = await createRepository(fixture.root, "linked-collision-source");
        const linkedWorktree = join(fixture.root, "linked-collision-worktree");
        await git(repository, [
            "worktree",
            "add",
            "-q",
            "-b",
            "linked-collision-worktree",
            linkedWorktree,
        ]);
        await git(repository, ["branch", "worktree/workspace"]);
        await git(repository, ["pack-refs", "--all", "--prune"]);

        const source = fixture.store.create({ cwd: linkedWorktree });
        const project = fixture.store.getProject(source.snapshot().projectId);
        if (project === undefined) throw new Error("Expected a project.");
        const created = await fixture.store.createWorkspace(project.id, {
            baseRef: "HEAD",
            name: "Workspace",
        });
        if (created === undefined) throw new Error("Expected a workspace.");
        const ready = await waitForWorkspace(
            fixture.store,
            project.id,
            created.id,
            (value) => value.status === "ready" || value.status === "failed",
        );

        expect(ready).toMatchObject({
            status: "ready",
            storageKey: "workspace-2",
        });
        expect(await git(ready.path, ["branch", "--show-current"])).toBe("worktree/workspace-2");
    });

    it("keeps human-readable workspace keys when packed refs exceed 256 KiB", async () => {
        const fixture = await createFixture();
        const repository = await createRepository(fixture.root, "large-packed-refs-source");
        const source = fixture.store.create({ cwd: repository });
        const project = fixture.store.getProject(source.snapshot().projectId);
        if (project === undefined) throw new Error("Expected a project.");
        const commit = await git(repository, ["rev-parse", "HEAD"]);
        const packedRefs = [
            `${commit} refs/heads/worktree/workspace`,
            ...Array.from(
                { length: 5_000 },
                (_value, index) =>
                    `${commit} refs/heads/generated/ref-${String(index).padStart(5, "0")}`,
            ),
        ].join("\n");
        await writeFile(join(repository, ".git", "packed-refs"), `${packedRefs}\n`);
        const id = createId();

        const created = await fixture.store.createWorkspace(project.id, {
            baseRef: "HEAD",
            id,
            name: "Workspace",
        });
        if (created === undefined) throw new Error("Expected a workspace.");
        expect(created).toMatchObject({
            id,
            status: "initializing",
            storageKey: "workspace-2",
        });

        const ready = await waitForWorkspace(
            fixture.store,
            project.id,
            created.id,
            (value) => value.status === "ready" || value.status === "failed",
        );
        expect(ready.status).toBe("ready");
    });

    it("uses a collision-safe identity when Git metadata cannot be inspected", async () => {
        const fixture = await createFixture();
        const repository = await createRepository(fixture.root, "unreadable-git-metadata");
        const source = fixture.store.create({ cwd: repository });
        const projectId = source.snapshot().projectId;
        const realGitDirectory = join(repository, ".git-real");
        await rename(join(repository, ".git"), realGitDirectory);
        await writeFile(join(repository, ".git"), "not-a-gitdir\n");
        const id = createId();

        const created = await fixture.store.createWorkspace(projectId, {
            baseRef: "HEAD",
            id,
            name: "Workspace",
        });
        if (created === undefined) throw new Error("Expected a workspace.");
        expect(created.storageKey).toBe(`workspace-${id}`);

        // Restore the repository without yielding to the setImmediate initialization callback.
        // An asynchronous rm followed by rename lets Linux begin initialization between them.
        rmSync(join(repository, ".git"), { force: true });
        renameSync(realGitDirectory, join(repository, ".git"));
        await expect(
            waitForWorkspace(
                fixture.store,
                projectId,
                id,
                (workspace) => workspace.status === "ready" || workspace.status === "failed",
            ),
        ).resolves.toMatchObject({ status: "ready" });
    });

    it("keeps archival committed when physical workspace cleanup fails", async () => {
        let failRemoval = false;
        const cleanupErrors: unknown[] = [];
        const fixture = await createFixture({
            onWorkspaceCleanupError: (error) => cleanupErrors.push(error),
            projectGit: async (cwd, args) => {
                if (failRemoval && args[0] === "worktree" && args[1] === "remove") {
                    throw new Error("Injected worktree cleanup failure.");
                }
                return git(cwd, args);
            },
        });
        const repository = await createRepository(fixture.root, "cleanup-source");
        const source = fixture.store.create({ cwd: repository });
        const created = await fixture.store.createWorkspace(source.snapshot().projectId, {
            baseRef: "HEAD",
            name: "Cleanup Failure",
        });
        if (created === undefined) throw new Error("Expected a workspace.");
        const ready = await waitForWorkspace(
            fixture.store,
            created.projectId,
            created.id,
            (value) => value.status === "ready",
        );

        failRemoval = true;
        const response = await fixture.store.archiveWorkspace(
            ready.projectId,
            ready.id,
            ready.version,
        );
        expect(response?.status).toBe("archiving");
        const archived = await waitForWorkspace(
            fixture.store,
            ready.projectId,
            ready.id,
            (value) => value.status === "archived",
        );

        expect(archived).not.toHaveProperty("error");
        expect(cleanupErrors).toHaveLength(1);
        await expect(access(ready.path)).resolves.toBeUndefined();
    });

    it("refuses cleanup after a managed workspace ancestor is replaced by a symlink", async () => {
        const cleanupErrors: unknown[] = [];
        const workspacesDirectory = await mkdtemp(join(tmpdir(), "rig-managed-workspaces-test-"));
        cleanups.push(() => rm(workspacesDirectory, { force: true, recursive: true }));
        const fixture = await createFixture({
            onWorkspaceCleanupError: (error) => cleanupErrors.push(error),
            workspacesDirectory,
        });
        const repository = await createRepository(fixture.root, "symlink-cleanup-source");
        const source = fixture.store.create({ cwd: repository });
        const created = await fixture.store.createWorkspace(source.snapshot().projectId, {
            baseRef: "HEAD",
            name: "Protected Cleanup",
        });
        if (created === undefined) throw new Error("Expected a workspace.");
        const workspace = await waitForWorkspace(
            fixture.store,
            created.projectId,
            created.id,
            (value) => value.status === "ready",
        );
        const project = fixture.store.getProject(created.projectId);
        if (project === undefined) throw new Error("Expected a project.");

        await Promise.all([
            rm(repository, { force: true, recursive: true }),
            rm(workspacesDirectory, { force: true, recursive: true }),
        ]);
        const substitutedRoot = join(fixture.root, "substituted-workspaces");
        const substitutedWorkspace = join(
            substitutedRoot,
            project.storageKey,
            workspace.storageKey,
        );
        const protectedFile = join(substitutedWorkspace, "must-survive.txt");
        await mkdir(substitutedWorkspace, { recursive: true });
        await writeFile(protectedFile, "not managed by Rig\n");
        await symlink(substitutedRoot, workspacesDirectory);

        await fixture.store.archiveWorkspace(workspace.projectId, workspace.id, workspace.version);
        await waitForWorkspace(
            fixture.store,
            workspace.projectId,
            workspace.id,
            (value) => value.status === "archived",
        );

        await expect(readFile(protectedFile, "utf8")).resolves.toBe("not managed by Rig\n");
        expect(cleanupErrors.map(String)).toContain(
            "Error: The workspace path does not match its managed storage identity.",
        );
    });

    it("stops instead of reporting cleanup when workspace archival hits the database", async () => {
        const databaseError = captureDriverError();
        let failRemoval = false;
        const cleanupErrors: unknown[] = [];
        const fixture = await createFixture({
            onWorkspaceCleanupError: (error) => cleanupErrors.push(error),
            projectGit: async (cwd, args) => {
                if (failRemoval && args[0] === "worktree" && args[1] === "remove") {
                    throw databaseError;
                }
                return git(cwd, args);
            },
        });
        const repository = await createRepository(fixture.root, "database-failure-source");
        const source = fixture.store.create({ cwd: repository });
        const created = await fixture.store.createWorkspace(source.snapshot().projectId, {
            baseRef: "HEAD",
            name: "Database Failure",
        });
        if (created === undefined) throw new Error("Expected a workspace.");
        const ready = await waitForWorkspace(
            fixture.store,
            created.projectId,
            created.id,
            (value) => value.status === "ready",
        );

        failRemoval = true;
        const escaped = await captureUnhandledRejection(async () => {
            await fixture.store.archiveWorkspace(ready.projectId, ready.id, ready.version);
        });

        // Residue left on disk is worth a warning because the next attempt can still remove it.
        // A database that cannot answer is neither reportable nor retryable.
        expect(escaped).toBe(databaseError);
        expect(cleanupErrors).toEqual([]);
    });

    it("reconciles interrupted workspace creation and archival after restart", async () => {
        const fixture = await createFixture();
        const repository = join(fixture.root, "source");
        await mkdir(repository);
        await git(repository, ["init"]);
        await git(repository, ["config", "user.email", "rig@example.test"]);
        await git(repository, ["config", "user.name", "Rig Test"]);
        await writeFile(join(repository, "README.md"), "fixture\n");
        await writeFile(
            join(repository, "rig.toml"),
            '[workspace]\nsetup_commands = ["printf recovered > workspace-setup-recovered.txt"]\n',
        );
        await git(repository, ["add", "README.md", "rig.toml"]);
        await git(repository, ["commit", "-m", "Initial"]);

        const source = fixture.store.create({ cwd: repository });
        const first = await fixture.store.createWorkspace(source.snapshot().projectId, {
            baseRef: "HEAD",
            name: "Recovered Create",
        });
        const second = await fixture.store.createWorkspace(source.snapshot().projectId, {
            baseRef: "HEAD",
            name: "Recovered Archive",
        });
        if (first === undefined || second === undefined) {
            throw new Error("Expected recovery workspaces.");
        }
        const [readyFirst, readySecond] = await Promise.all([
            waitForWorkspace(
                fixture.store,
                first.projectId,
                first.id,
                (value) => value.status === "ready",
            ),
            waitForWorkspace(
                fixture.store,
                second.projectId,
                second.id,
                (value) => value.status === "ready",
            ),
        ]);
        expect(
            fixture.store
                .listWorkspaces(source.snapshot().projectId)
                .map((workspace) => workspace.id),
        ).toEqual([readySecond.id, readyFirst.id]);
        fixture.store.reorderWorkspace(
            source.snapshot().projectId,
            readyFirst.id,
            { afterId: null },
            readyFirst.version,
        );
        expect(
            fixture.store
                .listWorkspaces(source.snapshot().projectId)
                .map((workspace) => workspace.id),
        ).toEqual([readyFirst.id, readySecond.id]);
        const attached = fixture.store.create({
            cwd: readySecond.path,
            workspaceId: readySecond.id,
        });
        fixture.store.close();
        await rm(join(readyFirst.path, "workspace-setup-recovered.txt"));

        const opened = openSessionDatabase(fixture.databasePath);
        opened.database
            .update(projectWorkspaces)
            .set({ status: "initializing" })
            .where(eq(projectWorkspaces.id, readyFirst.id))
            .run();
        opened.database
            .update(projectWorkspaces)
            .set({ status: "archiving" })
            .where(eq(projectWorkspaces.id, readySecond.id))
            .run();
        opened.client.close();

        const recovered = new PersistentSessionStore({
            databasePath: fixture.databasePath,
            homeDirectory: fixture.home,
            stateDirectory: fixture.state,
        });
        try {
            expect(
                (
                    await waitForWorkspace(
                        recovered,
                        first.projectId,
                        first.id,
                        (value) => value.status === "ready" || value.status === "failed",
                    )
                ).status,
            ).toBe("ready");
            await expect(
                readFile(join(readyFirst.path, "workspace-setup-recovered.txt"), "utf8"),
            ).resolves.toBe("recovered");
            expect(
                (
                    await waitForWorkspace(
                        recovered,
                        second.projectId,
                        second.id,
                        (value) => value.status === "archived",
                    )
                ).status,
            ).toBe("archived");
            expect(recovered.get(attached.id)?.snapshot().status).toBe("archived");
            await expect(access(readySecond.path)).rejects.toThrow();
        } finally {
            recovered.close();
        }
    });

    it("cannot become ready after archival starts during worktree creation", async () => {
        const addStarted = deferred<void>();
        const releaseAdd = deferred<void>();
        const fixture = await createFixture({
            projectGit: async (cwd, args) => {
                if (args[0] === "worktree" && args[1] === "add") {
                    addStarted.resolve(undefined);
                    await releaseAdd.promise;
                }
                return git(cwd, args);
            },
        });
        const repository = join(fixture.root, "source");
        await mkdir(repository);
        await git(repository, ["init"]);
        await git(repository, ["config", "user.email", "rig@example.test"]);
        await git(repository, ["config", "user.name", "Rig Test"]);
        await writeFile(join(repository, "README.md"), "fixture\n");
        await git(repository, ["add", "README.md"]);
        await git(repository, ["commit", "-m", "Initial"]);

        const source = fixture.store.create({ cwd: repository });
        const workspace = await fixture.store.createWorkspace(source.snapshot().projectId, {
            baseRef: "HEAD",
            name: "Archive During Create",
        });
        if (workspace === undefined) throw new Error("Expected a workspace.");
        await addStarted.promise;
        const current = fixture.store.getWorkspace(workspace.projectId, workspace.id);
        if (current === undefined) throw new Error("Expected recorded initialization facts.");

        const archive = fixture.store.archiveWorkspace(
            workspace.projectId,
            workspace.id,
            current.version,
        );
        await waitForWorkspace(
            fixture.store,
            workspace.projectId,
            workspace.id,
            (value) => value.status === "archiving",
        );
        releaseAdd.resolve(undefined);

        const archiving = await archive;
        expect(archiving?.status).toBe("archiving");
        const archived = await waitForWorkspace(
            fixture.store,
            workspace.projectId,
            workspace.id,
            (value) => value.status === "archived",
        );
        expect(archived.status).toBe("archived");
        await expect(access(workspace.path)).rejects.toThrow();
        const observedStates =
            fixture.store.globalEventQueue
                .list()
                ?.flatMap((entry) =>
                    entry.event.type === "workspace_created" ||
                    entry.event.type === "workspace_updated"
                        ? [entry.event.data.workspace.status]
                        : [],
                ) ?? [];
        expect(observedStates).toContain("archiving");
        expect(observedStates).toContain("archived");
        expect(observedStates).not.toContain("ready");
    });

    it("stops a running setup command when the workspace is archived", async () => {
        const fixture = await createFixture();
        const repository = await createRepository(fixture.root, "archive-during-setup");
        await writeFile(
            join(repository, "rig.toml"),
            [
                "[workspace]",
                'setup_commands = ["printf started > setup-started.txt; sleep 30; printf finished > setup-finished.txt"]',
                "",
            ].join("\n"),
        );
        await git(repository, ["add", "rig.toml"]);
        await git(repository, ["commit", "-m", "Configure long workspace setup"]);
        const source = fixture.store.create({ cwd: repository });
        const workspace = await fixture.store.createWorkspace(source.snapshot().projectId, {
            baseRef: "HEAD",
            name: "Archive During Setup",
        });
        if (workspace === undefined) throw new Error("Expected a workspace.");
        await waitForPath(join(workspace.path, "setup-started.txt"));
        const current = fixture.store.getWorkspace(workspace.projectId, workspace.id);
        if (current === undefined) throw new Error("Expected recorded initialization facts.");

        const archiving = await fixture.store.archiveWorkspace(
            workspace.projectId,
            workspace.id,
            current.version,
        );
        expect(archiving?.status).toBe("archiving");
        await waitForWorkspace(
            fixture.store,
            workspace.projectId,
            workspace.id,
            (value) => value.status === "archived",
        );

        await expect(access(workspace.path)).rejects.toThrow();
        expect(
            fixture.store.globalEventQueue
                .list()
                ?.some(
                    (entry) =>
                        (entry.event.type === "workspace_created" ||
                            entry.event.type === "workspace_updated") &&
                        entry.event.data.workspace.status === "ready" &&
                        entry.event.data.workspace.id === workspace.id,
                ),
        ).toBe(false);
    });

    it("archives its chats and workspaces, and returns when the folder is used again", async () => {
        const fixture = await createFixture();
        const repository = join(fixture.root, "source");
        await mkdir(repository);
        await git(repository, ["init"]);
        await git(repository, ["config", "user.email", "rig@example.test"]);
        await git(repository, ["config", "user.name", "Rig Test"]);
        await writeFile(join(repository, "README.md"), "fixture\n");
        await git(repository, ["add", "README.md"]);
        await git(repository, ["commit", "-m", "Initial"]);

        const root = fixture.store.create({ cwd: repository });
        const projectId = root.snapshot().projectId;
        const created = await fixture.store.createWorkspace(projectId, {
            baseRef: "HEAD",
            name: "Feature",
        });
        if (created === undefined) throw new Error("Expected a workspace.");
        const workspace = await waitForWorkspace(
            fixture.store,
            projectId,
            created.id,
            (value) => value.status === "ready",
        );
        const attached = fixture.store.create({ cwd: workspace.path, workspaceId: workspace.id });

        const archived = await fixture.store.archiveProject(
            projectId,
            fixture.store.getProject(projectId)!.version,
        );

        expect(archived?.archivedAt).toBeGreaterThan(0);
        expect(fixture.store.get(root.id)?.snapshot().archived).toBe(true);
        expect(fixture.store.get(attached.id)?.snapshot().status).toBe("archived");
        expect(fixture.store.getWorkspace(projectId, workspace.id)?.status).toBe("archived");
        await expect(access(workspace.path)).rejects.toThrow();

        const resumed = fixture.store.create({ cwd: repository });
        expect(resumed.snapshot().projectId).toBe(projectId);
        expect(fixture.store.getProject(projectId)?.archivedAt).toBeUndefined();
    });

    it("does not let delayed archive cleanup overtake a later unarchive", async () => {
        const fixture = await createFixture();
        const directory = join(fixture.root, "archive-race");
        await mkdir(directory);
        const session = fixture.store.create({ cwd: directory });
        const projectId = session.snapshot().projectId;
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        fixture.store.remoteTerminals.closeProject = () => held;

        const archiving = fixture.store.archiveProject(
            projectId,
            fixture.store.getProject(projectId)!.version,
        );
        expect(session.snapshot().archived).toBe(true);
        session.setArchived(false);
        fixture.store.unarchiveProject(projectId);
        release();
        await archiving;

        expect(fixture.store.getProject(projectId)?.archivedAt).toBeUndefined();
        expect(session.snapshot().archived).toBe(false);
    });

    it("refuses to archive against a stale version and repeats without effect", async () => {
        const fixture = await createFixture();
        const directory = join(fixture.root, "folder");
        await mkdir(directory);
        const session = fixture.store.create({ cwd: directory });
        const projectId = session.snapshot().projectId;
        const staleVersion = fixture.store.getProject(projectId)!.version;
        fixture.store.renameProject(projectId, "Renamed folder", staleVersion);

        await expect(fixture.store.archiveProject(projectId, staleVersion)).rejects.toThrow(
            /changed before it could be archived/,
        );

        const archived = await fixture.store.archiveProject(
            projectId,
            fixture.store.getProject(projectId)!.version,
        );
        const repeated = await fixture.store.archiveProject(projectId, 999);
        expect(repeated?.archivedAt).toBe(archived?.archivedAt);
        expect(repeated?.version).toBe(archived?.version);
    });
    it("records presence and worktree capability for every project at startup", async () => {
        const fixture = await createFixture();
        const repository = await createRepository(fixture.root, "tracked");
        const plain = join(fixture.root, "plain");
        await mkdir(plain);

        const repositoryProject = fixture.store.create({ cwd: repository }).snapshot().projectId;
        const plainProject = fixture.store.create({ cwd: plain }).snapshot().projectId;

        const tracked = await waitForProject(
            fixture.store,
            repositoryProject,
            (project) => project.worktreeSupport !== "unknown",
        );
        expect(tracked).toMatchObject({ presence: "present", worktreeSupport: "supported" });
        expect(tracked.git?.branch).toBe("main");

        const unsupported = await waitForProject(
            fixture.store,
            plainProject,
            (project) => project.worktreeSupport !== "unknown",
        );
        expect(unsupported).toMatchObject({
            presence: "present",
            worktreeSupport: "unsupported",
            worktreeSupportReason: "This folder is not a Git repository.",
        });
    });

    it("reports a project whose directory disappeared as missing after a restart", async () => {
        const fixture = await createFixture();
        const directory = join(fixture.root, "vanishing");
        await mkdir(directory);
        const projectId = fixture.store.create({ cwd: directory }).snapshot().projectId;
        await waitForProject(fixture.store, projectId, (p) => p.worktreeSupport !== "unknown");
        fixture.store.close();
        await rm(directory, { force: true, recursive: true });

        const restarted = await fixture.restart();

        const project = await waitForProject(
            restarted,
            projectId,
            (value) => value.presence === "missing",
        );
        expect(project.worktreeSupportReason).toBe("This folder no longer exists.");
    });

    it("refuses immediate checkout operations when a ready workspace directory is missing", async () => {
        const fixture = await createFixture();
        const repository = await createRepository(fixture.root, "missing-workspace-source");
        const projectId = fixture.store.create({ cwd: repository }).snapshot().projectId;
        const sourceReservation = await fixture.store.createWorkspace(projectId, {
            baseRef: "HEAD",
            name: "Missing Source",
        });
        const targetReservation = await fixture.store.createWorkspace(projectId, {
            baseRef: "HEAD",
            name: "Available Target",
        });
        if (sourceReservation === undefined || targetReservation === undefined) {
            throw new Error("Expected workspace reservations.");
        }
        const [source, target] = await Promise.all([
            waitForWorkspace(
                fixture.store,
                projectId,
                sourceReservation.id,
                (workspace) => workspace.status === "ready",
            ),
            waitForWorkspace(
                fixture.store,
                projectId,
                targetReservation.id,
                (workspace) => workspace.status === "ready",
            ),
        ]);
        const session = fixture.store.create({ cwd: source.path, workspaceId: source.id });
        fixture.store.close();
        await rm(source.path, { force: true, recursive: true });

        const restarted = await fixture.restart();
        await waitForWorkspace(
            restarted,
            projectId,
            source.id,
            (workspace) => workspace.presence === "missing",
        );

        expect(() => restarted.fork(session.id)).toThrow("unavailable workspace");
        await expect(
            restarted.remoteTerminals.create(
                { projectId, workspaceId: source.id },
                { command: "pwd" },
            ),
        ).rejects.toThrow("ready, available");
        await expect(
            restarted.transferSession(session.id, { targetWorkspaceId: target.id }),
        ).rejects.toThrow("not ready and available");
    });

    it("persists the resolved base commit so a moving base ref cannot rewrite history", async () => {
        const fixture = await createFixture();
        const repository = await createRepository(fixture.root, "based");
        const projectId = fixture.store.create({ cwd: repository }).snapshot().projectId;
        const expected = await git(repository, ["rev-parse", "HEAD"]);

        const created = await fixture.store.createWorkspace(projectId, {
            baseRef: "main",
            name: "Based",
        });
        if (created === undefined) throw new Error("Expected a workspace.");
        const workspace = await waitForWorkspace(
            fixture.store,
            projectId,
            created.id,
            (value) => value.baseCommit !== undefined,
        );

        expect(workspace.baseRef).toBe("main");
        expect(workspace.baseCommit).toBe(expected.toLowerCase());
    });

    it("forks the remote trunk instead of the project's local branch", async () => {
        const gitCalls: { args: readonly string[]; cwd: string }[] = [];
        const fixture = await createFixture({
            projectGit: async (cwd, args) => {
                gitCalls.push({ args, cwd });
                return git(cwd, args);
            },
        });
        const remote = join(fixture.root, "remote.git");
        const upstream = await createRepository(fixture.root, "upstream");
        await mkdir(remote);
        await git(remote, ["init", "--bare"]);
        await git(remote, ["symbolic-ref", "HEAD", "refs/heads/main"]);
        await git(upstream, ["remote", "add", "origin", remote]);
        await git(upstream, ["push", "-u", "origin", "main"]);
        const repository = join(fixture.root, "clone");
        await git(fixture.root, ["clone", remote, repository]);
        await git(repository, ["config", "user.email", "rig@example.test"]);
        await git(repository, ["config", "user.name", "Rig Test"]);

        await writeFile(join(upstream, "REMOTE.md"), "new upstream commit\n");
        await git(upstream, ["add", "REMOTE.md"]);
        await git(upstream, ["commit", "-m", "Advance origin"]);
        await git(upstream, ["push", "origin", "main"]);
        const expected = (await git(upstream, ["rev-parse", "HEAD"])).toLowerCase();

        // The project folder is left on a commit that exists nowhere but here.
        await writeFile(join(repository, "LOCAL.md"), "local only\n");
        await git(repository, ["add", "LOCAL.md"]);
        await git(repository, ["commit", "-m", "Local only"]);
        const projectId = fixture.store.create({ cwd: repository }).snapshot().projectId;

        const workspace = await fixture.store.createWorkspace(projectId, { name: "Fresh Origin" });
        if (workspace === undefined) throw new Error("Expected a workspace.");
        const ready = await waitForWorkspace(
            fixture.store,
            projectId,
            workspace.id,
            (value) => value.status === "ready" || value.status === "failed",
        );

        expect(ready.status).toBe("ready");
        expect(ready.baseRef).toBe("origin/main");
        expect(ready.baseCommit).toBe(expected);
        expect(await git(ready.path, ["rev-parse", "HEAD"])).toBe(expected);
        await expect(access(join(ready.path, "REMOTE.md"))).resolves.toBeUndefined();
        await expect(access(join(ready.path, "LOCAL.md"))).rejects.toThrow();
        const fetches = gitCalls.filter(
            (call) => call.args[0] === "fetch" && call.args[1] === "origin",
        );
        expect(fetches).not.toHaveLength(0);
        // Fetching happens in the project, before the worktree exists, and never inside it.
        expect(fetches.every((call) => call.cwd !== ready.path)).toBe(true);
    });

    it("records the trunk a project was added on and reuses it for every workspace", async () => {
        const fixture = await createFixture();
        const repository = await createRepository(fixture.root, "trunk-named");
        await git(repository, ["branch", "-m", "main", "release"]);
        await git(repository, ["update-ref", "refs/remotes/origin/release", "HEAD"]);
        await git(repository, [
            "symbolic-ref",
            "refs/remotes/origin/HEAD",
            "refs/remotes/origin/release",
        ]);
        const projectId = fixture.store.create({ cwd: repository }).snapshot().projectId;
        await waitForProject(fixture.store, projectId, (p) => p.defaultBranch !== undefined);
        expect(fixture.store.getProject(projectId)?.defaultBranch).toBe("release");

        // A project folder that later moves to another branch keeps forking its trunk.
        await git(repository, ["checkout", "-q", "-b", "sidetrack"]);
        await writeFile(join(repository, "SIDE.md"), "side\n");
        await git(repository, ["add", "SIDE.md"]);
        await git(repository, ["commit", "-m", "Side"]);

        const created = await fixture.store.createWorkspace(projectId, { name: "From Trunk" });
        if (created === undefined) throw new Error("Expected a workspace.");
        const workspace = await waitForWorkspace(
            fixture.store,
            projectId,
            created.id,
            (value) => value.status === "ready" || value.status === "failed",
        );
        expect(workspace.status).toBe("ready");
        expect(workspace.baseRef).toBe("origin/release");
    });

    it("keeps a client-chosen workspace identity honest about the base it was built on", async () => {
        const fixture = await createFixture();
        const repository = await createRepository(fixture.root, "retry-base");
        const projectId = fixture.store.create({ cwd: repository }).snapshot().projectId;
        const id = createId();

        const first = await fixture.store.createWorkspace(projectId, { id, name: "Retried" });
        if (first === undefined) throw new Error("Expected a workspace.");
        // The same request, repeated because the caller never learned it landed.
        const repeated = await fixture.store.createWorkspace(projectId, { id, name: "Retried" });
        expect(repeated?.id).toBe(first.id);
        expect(fixture.store.listWorkspaces(projectId)).toHaveLength(1);

        await expect(
            fixture.store.createWorkspace(projectId, { baseRef: "HEAD~0", id, name: "Retried" }),
        ).rejects.toThrow(/different base/);
    });

    it("inherits a workspace title once and publishes the updated workspace", async () => {
        const fixture = await createFixture();
        const repository = await createRepository(fixture.root, "workspace-title");
        const projectId = fixture.store.create({ cwd: repository }).snapshot().projectId;
        const created = await fixture.store.createWorkspace(projectId, {
            baseRef: "main",
            name: "Workspace Branch",
        });
        if (created === undefined) throw new Error("Expected a workspace.");
        const ready = await waitForWorkspace(
            fixture.store,
            projectId,
            created.id,
            (workspace) => workspace.status === "ready",
        );

        const opened = openSessionDatabase(fixture.databasePath);
        const events: string[] = [];
        const projects = new ProjectRepository({
            database: opened.database,
            homeDirectory: fixture.home,
            onEvent: (event) => events.push(event.type),
            stateDirectory: fixture.state,
        });
        try {
            expect(
                projects.inheritWorkspaceTitle(projectId, ready.id, "First Chat Workspace Title"),
            ).toMatchObject({ title: "First Chat Workspace Title" });
            expect(
                projects.inheritWorkspaceTitle(projectId, ready.id, "Later Chat Title"),
            ).toMatchObject({ title: "First Chat Workspace Title" });
            expect(events).toEqual(["workspace_updated"]);
        } finally {
            projects.close();
            opened.client.close();
        }
    });

    it("lets a client name what it creates, and refuses a name that means something else", async () => {
        const fixture = await createFixture();
        const repository = await createRepository(fixture.root, "client-named");
        const other = await createRepository(fixture.root, "client-named-other");
        const projectId = createId();
        const workspaceId = createId();

        const session = fixture.store.createWithId(createId(), { cwd: repository, projectId });
        expect(session.snapshot().projectId).toBe(projectId);

        const created = await fixture.store.createWorkspace(projectId, {
            baseRef: "HEAD",
            id: workspaceId,
            name: "Client Named",
        });
        expect(created?.id).toBe(workspaceId);

        // The request is answered again rather than creating a second workspace,
        // which is what makes a retry safe.
        const repeated = await fixture.store.createWorkspace(projectId, {
            baseRef: "HEAD",
            id: workspaceId,
            name: "Client Named",
        });
        expect(repeated?.id).toBe(workspaceId);
        expect(fixture.store.listWorkspaces(projectId)).toHaveLength(1);

        const otherProjectId = fixture.store.create({ cwd: other }).snapshot().projectId;
        await expect(
            fixture.store.createWorkspace(otherProjectId, {
                baseRef: "HEAD",
                id: workspaceId,
                name: "Elsewhere",
            }),
        ).rejects.toThrow("another project");
        await expect(
            fixture.store.createWorkspace(projectId, {
                baseRef: "HEAD~0",
                id: workspaceId,
                name: "Rebased",
            }),
        ).rejects.toThrow("different base");
        await expect(
            fixture.store.createWorkspace(projectId, {
                baseRef: "HEAD",
                id: "Not A Cuid2",
                name: "Invalid",
            }),
        ).rejects.toThrow("cuid2");

        // A directory Rig already knows keeps the identity it has, so importing
        // it again is answered rather than renamed, and reusing that identity
        // for a different folder is refused.
        const reimported = fixture.store.createWithId(createId(), {
            cwd: repository,
            projectId: createId(),
        });
        expect(reimported.snapshot().projectId).toBe(projectId);
        expect(() => fixture.store.createWithId(createId(), { cwd: other, projectId })).toThrow(
            "another folder",
        );
    });

    it("answers a repeated session create instead of creating a second session", async () => {
        const fixture = await createFixture();
        const directory = join(fixture.root, "retried-session");
        await mkdir(directory, { recursive: true });
        const sessionId = createId();

        const created = fixture.store.createWithId(sessionId, { cwd: directory });
        const repeated = fixture.store.createWithId(sessionId, { cwd: directory });

        expect(repeated.id).toBe(created.id);
        expect(fixture.store.list().filter((session) => session.cwd === directory)).toHaveLength(1);
        expect(() => fixture.store.createWithId(sessionId, { cwd: fixture.root })).toThrow(
            "another directory",
        );
    });
});

/**
 * Takes the write lock the way any observer with its own connection does. The short timeout keeps
 * a deadlock quick to report; a healthy archival never contends for the lock at all.
 */
function writeOnSeparateConnection(databasePath: string): void {
    const client = new Database(databasePath, { timeout: 250 });
    try {
        client.exec("BEGIN IMMEDIATE");
        client.exec("COMMIT");
    } finally {
        client.close();
    }
}

async function createFixture(
    options: {
        durableGlobalEventQueue?: boolean;
        onSessionAccess?: (session: InMemorySession) => void;
        onWorkspaceCleanupError?: (error: unknown, projectId: string, workspaceId: string) => void;
        projectGit?: GitCommandRunner;
        createRuntime?: InMemorySessionOptions["createRuntime"];
        workspacesDirectory?: string;
    } = {},
): Promise<{
    home: string;
    databasePath: string;
    restart: () => Promise<PersistentSessionStore>;
    root: string;
    state: string;
    store: PersistentSessionStore;
}> {
    const root = await mkdtemp(join(tmpdir(), "rig-projects-test-"));
    const home = join(root, "home");
    const state = join(root, "state");
    await Promise.all([mkdir(home), mkdir(state)]);
    const databasePath = join(state, "sessions.sqlite");
    const open = () =>
        new PersistentSessionStore({
            ...(options.createRuntime === undefined
                ? {}
                : { createRuntime: options.createRuntime }),
            databasePath,
            ...(options.durableGlobalEventQueue === undefined
                ? {}
                : { durableGlobalEventQueue: options.durableGlobalEventQueue }),
            homeDirectory: home,
            ...(options.onSessionAccess === undefined
                ? {}
                : { onSessionAccess: options.onSessionAccess }),
            ...(options.onWorkspaceCleanupError === undefined
                ? {}
                : { onWorkspaceCleanupError: options.onWorkspaceCleanupError }),
            ...(options.projectGit === undefined ? {} : { projectGit: options.projectGit }),
            stateDirectory: state,
            ...(options.workspacesDirectory === undefined
                ? {}
                : { workspacesDirectory: options.workspacesDirectory }),
        });
    const stores = [open()];
    cleanups.push(async () => {
        try {
            for (const store of stores) store.close();
        } finally {
            await rm(root, { force: true, recursive: true });
        }
    });
    const restart = async () => {
        const next = open();
        stores.push(next);
        return next;
    };
    return { databasePath, home, restart, root, state, store: stores[0]! };
}

async function createTransferFixture(
    options: {
        createRuntime?: InMemorySessionOptions["createRuntime"];
        projectGit?: GitCommandRunner;
    } = {},
): Promise<{
    fixture: Awaited<ReturnType<typeof createFixture>>;
    session: InMemorySession;
    source: NonNullable<Awaited<ReturnType<PersistentSessionStore["createWorkspace"]>>>;
    target: NonNullable<Awaited<ReturnType<PersistentSessionStore["createWorkspace"]>>>;
}> {
    const fixture = await createFixture(options);
    const repository = await createRepository(fixture.root, "transfer-source");
    await writeFile(join(repository, ".gitignore"), "ignored.txt\n");
    await git(repository, ["add", ".gitignore"]);
    await git(repository, ["commit", "-m", "Ignore fixture"]);
    const rootSession = fixture.store.create({ cwd: repository });
    const projectId = rootSession.snapshot().projectId;
    await waitForProject(
        fixture.store,
        projectId,
        (project) => project.initializationStatus === "ready",
    );
    const sourceReserved = await fixture.store.createWorkspace(projectId, {
        baseRef: "HEAD",
        name: "Transfer Source",
    });
    const targetReserved = await fixture.store.createWorkspace(projectId, {
        baseRef: "HEAD",
        name: "Transfer Target",
    });
    if (sourceReserved === undefined || targetReserved === undefined) {
        throw new Error("Expected transfer workspaces.");
    }
    const source = await waitForWorkspace(
        fixture.store,
        projectId,
        sourceReserved.id,
        (workspace) => workspace.status === "ready",
    );
    const target = await waitForWorkspace(
        fixture.store,
        projectId,
        targetReserved.id,
        (workspace) => workspace.status === "ready",
    );
    const session = fixture.store.create({ cwd: source.path, workspaceId: source.id });
    return { fixture, session, source, target };
}

function createTransferTestRuntime(
    options: CreateCodingAssistantAgentOptions,
    provider: ReturnType<typeof defineProvider>,
): CodingAssistantRuntime {
    const processManager = new NativeProcessManager();
    const context = createNodeAgentContext({ cwd: options.cwd, processManager });
    if (options.workspaces !== undefined) context.workspaces = options.workspaces;
    return {
        agent: new Agent({
            context,
            modelId: options.modelId ?? modelOpenaiGpt56Sol.id,
            printToConsole: false,
            provider,
            tools: [],
        }),
        context,
        cwd: options.cwd,
        processManager,
        executor: provider,
    };
}

function transferResponseStream(text: string, release = Promise.resolve()): InferenceStream {
    const message: AssistantMessage = {
        api: "test",
        content: [{ text, type: "text" }],
        model: modelOpenaiGpt56Sol.id,
        provider: "codex",
        role: "assistant",
        stopReason: "stop",
        timestamp: 1,
        usage: {
            cacheRead: 0,
            cacheWrite: 0,
            cost: {
                cacheRead: 0,
                cacheWrite: 0,
                input: 0,
                output: 0,
                total: 0,
            },
            input: 0,
            output: 0,
            totalTokens: 0,
        },
    };
    return {
        async *[Symbol.asyncIterator]() {
            await release;
            yield { partial: message, type: "start" as const };
            yield { message, reason: "stop" as const, type: "done" as const };
        },
        async result() {
            await release;
            return message;
        },
    };
}

/** Uses a real driver fault so the test cannot drift from what SQLite actually throws. */
function captureDriverError(): unknown {
    const opened = openSessionDatabase(":memory:");
    try {
        opened.database.run(sql.raw("select * from missing_table"));
        throw new Error("Expected the driver to fail.");
    } catch (error) {
        return error;
    } finally {
        opened.client.close();
    }
}

/**
 * Observes the process-level hard failure a database fault is supposed to become, and answers
 * `undefined` when nothing escaped. Rig's own listeners are lifted for the duration so the
 * deliberate rejection is not also reported as a failure of the surrounding suite.
 */
async function captureUnhandledRejection(run: () => Promise<void>): Promise<unknown> {
    const installed = process.listeners("unhandledRejection");
    for (const listener of installed) process.off("unhandledRejection", listener);
    let captured: unknown;
    const observe = (reason: unknown): void => {
        captured ??= reason;
    };
    process.on("unhandledRejection", observe);
    try {
        await run();
        for (let attempt = 0; attempt < 200 && captured === undefined; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        return captured;
    } finally {
        process.off("unhandledRejection", observe);
        for (const listener of installed) process.on("unhandledRejection", listener);
    }
}

async function createRepository(root: string, name: string): Promise<string> {
    const repository = join(root, name);
    await mkdir(repository, { recursive: true });
    await git(repository, ["init", "--initial-branch=main"]);
    await git(repository, ["config", "user.email", "rig@example.test"]);
    await git(repository, ["config", "user.name", "Rig Test"]);
    await writeFile(join(repository, "README.md"), "fixture\n");
    await git(repository, ["add", "README.md"]);
    await git(repository, ["commit", "-m", "Initial"]);
    return repository;
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
    const result = await execFile("git", ["-C", cwd, ...args], {
        encoding: "utf8",
        timeout: 5_000,
    });
    return result.stdout.trim();
}

async function waitForProject(
    store: PersistentSessionStore,
    projectId: string,
    predicate: (project: NonNullable<ReturnType<PersistentSessionStore["getProject"]>>) => boolean,
) {
    return await waitFor(() => store.getProject(projectId), predicate);
}

async function waitForWorkspace(
    store: PersistentSessionStore,
    projectId: string,
    workspaceId: string,
    predicate: (
        workspace: NonNullable<ReturnType<PersistentSessionStore["getWorkspace"]>>,
    ) => boolean,
) {
    return await waitFor(() => store.getWorkspace(projectId, workspaceId), predicate);
}

function deferred<T>(): {
    promise: Promise<T>;
    reject: (reason?: unknown) => void;
    resolve: (value: T | PromiseLike<T>) => void;
} {
    let reject!: (reason?: unknown) => void;
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, reject, resolve };
}

async function waitFor<T>(read: () => T | undefined, predicate: (value: T) => boolean): Promise<T> {
    const deadline = Date.now() + 10_000;
    for (;;) {
        const value = read();
        if (value !== undefined && predicate(value)) return value;
        if (Date.now() >= deadline) throw new Error("Timed out waiting for project state.");
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
}

async function waitForPath(path: string, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        try {
            await access(path);
            return;
        } catch {
            if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}.`);
            await new Promise<void>((resolve) => setTimeout(resolve, 20));
        }
    }
}
