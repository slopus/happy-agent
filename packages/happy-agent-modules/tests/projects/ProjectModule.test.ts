import { rm } from "node:fs/promises";

import { sql } from "drizzle-orm";
import { Value } from "@sinclair/typebox/value";
import { agentDatabaseRows, agentDatabaseRun } from "@slopus/happy-agent-base";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { GitModule } from "../../sources/git/index.js";
import { durableFunctionsMigrations } from "../../sources/durableFunctions/index.js";
import {
    MAX_PROJECT_ERROR_LENGTH,
    projectCreateInputSchema,
    projectEnsureInputSchema,
    projectMigrations,
    projectSetAvatarInputSchema,
    projectRemoteSourceSchema,
    projectRenameInputSchema,
    projectSchema,
    projectSettingsSchema,
    projectSettingsUpdateInputSchema,
    ProjectsModule,
} from "../../sources/projects/index.js";
import { writeGuardedProject } from "../../sources/projects/store/projectRecords.js";
import { temporaryTestConfig } from "../support/configModule.js";
import { moduleDatabase } from "../support/moduleDatabase.js";
import { projectsModuleFor } from "../support/projectsModule.js";

/** Cross-workspace work is a feature a person turns on, so a test turns it on the same way. */
const CROSS_WORKSPACE_TOML = "[features]\ncross_workspace = true\n";

describe("ProjectsModule", () => {
    it("owns its catalog migration and is built from the modules it depends on", async () => {
        const module = await projectsModule();

        expect(module.name).toBe("projects");
        expect(module.migrations).toEqual(projectMigrations);
    });

    it("serializes only remote project provisioning on the shared clone lock", async () => {
        const database = await migratedProjectDatabase("projects-clone-lock-test");
        const projects = await projectsModule();
        try {
            const local = await projects.create(database.context, {
                id: "local-project",
                name: "Local",
                repositoryRef: "/tmp/projects/local",
            });
            const remote = await projects.create(database.context, {
                id: "remote-project",
                name: "Remote",
                repositoryRef: "/tmp/projects/remote",
                remoteSource: { kind: "git", url: "https://example.com/remote.git" },
            });
            await projects.scheduleInitialization(database.context, local.id);
            await projects.scheduleInitialization(database.context, remote.id);

            const calls = await agentDatabaseRows<{
                readonly arguments_json: string;
                readonly lock_keys_json: string;
            }>(
                database.database,
                sql`SELECT arguments_json, lock_keys_json FROM durable_function_calls`,
            );
            const locks = new Map(
                calls.map((call) => [
                    (JSON.parse(call.arguments_json) as { id: string }).id,
                    JSON.parse(call.lock_keys_json) as string[],
                ]),
            );
            expect(locks.get(local.id)).toEqual([`project.${local.id}`]);
            expect(locks.get(remote.id)).toEqual([`project.${remote.id}`, "projects.clone"]);
        } finally {
            database.close();
        }
    });

    it("keeps project rows runtime-validated around the real folder record", () => {
        const record = {
            id: "project-1",
            repositoryRef: "/tmp/projects/one",
            kind: "regular",
            storageKey: "one",
            name: "Project",
            nameSource: "folder",
            status: "active",
            presence: "present",
            initializationStatus: "ready",
            initializationAttempt: 0,
            worktreeSupport: "unknown",
            gitAhead: 0,
            gitBehind: 0,
            gitDetached: false,
            orderKey: "00000000000000000001",
            version: 1,
            createdAt: 1,
            updatedAt: 1,
        };

        expect(Value.Check(projectSchema, record)).toBe(true);
        // A project is its folder, so an opaque reference is no longer a project.
        expect(Value.Check(projectSchema, { ...record, repositoryRef: "repo:1" })).toBe(false);
        expect(Value.Check(projectSchema, { ...record, storageKey: "Not A Key" })).toBe(false);
        expect(Value.Check(projectSchema, { ...record, kind: "worktree" })).toBe(false);
        expect(Value.Check(projectSchema, { ...record, initializationStatus: "pending" })).toBe(
            false,
        );
    });

    it("accepts only the bounded workspace compute settings", () => {
        expect(Value.Check(projectSettingsSchema, {})).toBe(true);
        expect(
            Value.Check(projectSettingsSchema, { defaultWorkspaceCompute: { type: "local" } }),
        ).toBe(true);
        expect(
            Value.Check(projectSettingsSchema, {
                defaultWorkspaceCompute: { image: "node:22", type: "docker" },
            }),
        ).toBe(true);
        expect(Value.Check(projectSettingsSchema, { theme: "dark" })).toBe(false);
        expect(
            Value.Check(projectSettingsSchema, { defaultWorkspaceCompute: { type: "docker" } }),
        ).toBe(false);
        expect(
            Value.Check(projectSettingsSchema, {
                defaultWorkspaceCompute: { image: "node:22", type: "local" },
            }),
        ).toBe(false);
        expect(
            Value.Check(projectSettingsSchema, { defaultWorkspaceCompute: { type: "remote" } }),
        ).toBe(false);
    });

    it("does not accept caller-owned operation identities", () => {
        expect(
            Value.Check(projectCreateInputSchema, {
                repositoryRef: "/tmp/projects/one",
                name: "Project",
                operationId: "legacy-operation",
            }),
        ).toBe(false);
        expect(
            Value.Check(projectEnsureInputSchema, {
                repositoryRef: "/tmp/projects/one",
                operationId: "legacy-operation",
            }),
        ).toBe(false);
        expect(
            Value.Check(projectRenameInputSchema, {
                projectId: "project-1",
                name: "Renamed",
                operationId: "legacy-operation",
            }),
        ).toBe(false);
        expect(
            Value.Check(projectSettingsUpdateInputSchema, {
                projectId: "project-1",
                settings: {},
                operationId: "legacy-operation",
            }),
        ).toBe(false);
    });

    it("offers the catalog only when the user asked for cross-workspace work", async () => {
        expect(await projectToolNames(await projectsModule(), "agent-a")).toEqual([]);
        expect(
            await projectToolNames(await projectsModule(CROSS_WORKSPACE_TOML), "agent-a"),
        ).toEqual(["list_projects"]);
    });

    it("keeps the catalog out of a subagent", async () => {
        expect(
            await projectToolNames(await projectsModule(CROSS_WORKSPACE_TOML), "subagent-a"),
        ).toEqual([]);
    });

    it("uses the context transaction for direct catalog mutations", async () => {
        const database = await migratedProjectDatabase("projects-tool-commit-test");
        const projects = await projectsModule();

        try {
            const created = await projects.create(database.context, {
                repositoryRef: "/tmp/projects/one",
                name: "Project",
            });
            await projects.ensure(database.context, {
                repositoryRef: "/tmp/projects/one",
            });
            while (Date.now() <= created.updatedAt) {
                // The store timestamps catalog updates with wall-clock milliseconds.
            }
            await projects.rename(database.context, {
                projectId: created.id,
                name: "Renamed",
            });
            await projects.updateSettings(database.context, {
                projectId: created.id,
                settings: { defaultWorkspaceCompute: { type: "local" } },
            });
            await projects.archive(database.context, created.id);

            expect(await projects.get(database.context, created.id)).toMatchObject({
                name: "Renamed",
                nameSource: "user",
                status: "archived",
            });
            expect(await projects.readSettings(database.context, created.id)).toEqual({
                defaultWorkspaceCompute: { type: "local" },
            });
        } finally {
            database.close();
        }
    });

    it("drops the obsolete project replay tables and rebuilds the catalog as folders", async () => {
        const database = await migratedProjectDatabase("projects-drop-idempotency-test");
        try {
            const tables = await agentDatabaseRows<{ readonly name: string }>(
                database.database,
                sql`SELECT name FROM sqlite_master
                    WHERE type = 'table'
                      AND name IN (
                          'happy_agent_module_project_operation_receipts',
                          'happy_agent_module_project_mutation_proofs'
                      )`,
            );
            expect(tables).toEqual([]);
            expect(projectMigrations.map(([key]) => key)).toEqual([
                "001-projects-catalog",
                "002-drop-project-idempotency-tables",
                "003-project-order-version-avatar",
                "004-project-folder-record",
                "005-project-without-owner",
                "006-project-root-agents",
                "007-project-root-agent-order-keys",
                "008-project-avatar-assets",
            ]);
        } finally {
            database.close();
        }
    });

    it("upgrades legacy root-agent positions into durable order keys", async () => {
        const database = moduleDatabase([], "projects-agent-order-key-upgrade-test");
        try {
            const legacyMigrations = projectMigrations.slice(0, 6);
            for (const [, migrate] of legacyMigrations) {
                await migrate(database.context, database.database);
            }
            await agentDatabaseRun(
                database.database,
                sql`INSERT INTO happy_agent_module_project_root_agents (project_id, agent_id)
                    VALUES ('project-1', 'agent-a'), ('project-1', 'agent-b')`,
            );

            const [, migrateOrderKeys] = projectMigrations[6]!;
            await migrateOrderKeys(database.context, database.database);

            expect(
                await agentDatabaseRows<{ readonly agent_id: string; readonly order_key: string }>(
                    database.database,
                    sql`SELECT agent_id, order_key
                        FROM happy_agent_module_project_root_agents
                        ORDER BY position`,
                ),
            ).toEqual([
                { agent_id: "agent-a", order_key: "00000000000000000001" },
                { agent_id: "agent-b", order_key: "00000000000000000002" },
            ]);
        } finally {
            database.close();
        }
    });

    it("keeps each top-level agent in its project's durable root order", async () => {
        const database = await migratedProjectDatabase("projects-root-agents-test");
        try {
            const projects = await projectsModule();
            projects.beforeStart(database.context, {
                parentOf: () => Promise.resolve(null),
            } as never);
            const first = await projects.create(database.context, {
                repositoryRef: "/tmp/projects/root-agents-first",
                name: "First",
            });
            const second = await projects.create(database.context, {
                repositoryRef: "/tmp/projects/root-agents-second",
                name: "Second",
            });

            await projects.attachAgent(database.context, first.id, "agent-b");
            await projects.attachAgent(database.context, first.id, "agent-a");
            await projects.attachAgent(database.context, first.id, "agent-b");

            const attached = await projects.listAgents(database.context, first.id);
            expect(attached).toEqual([
                {
                    agentId: "agent-b",
                    orderKey: expect.any(String),
                },
                {
                    agentId: "agent-a",
                    orderKey: expect.any(String),
                },
            ]);
            expect(new Set(attached.map((association) => association.orderKey)).size).toBe(2);
            expect(await projects.listAgentIds(database.context, first.id)).toEqual([
                "agent-b",
                "agent-a",
            ]);
            await projects.reorderAgent(database.context, first.id, "agent-a", null);
            const reordered = await projects.listAgents(database.context, first.id);
            expect(await projects.listAgentIds(database.context, first.id)).toEqual([
                "agent-a",
                "agent-b",
            ]);
            expect(reordered[0]?.orderKey).not.toBe(attached[1]?.orderKey);
            expect(reordered[1]?.orderKey).toBe(attached[0]?.orderKey);

            const restarted = projectsModuleFor(await temporaryTestConfig(), new GitModule());
            expect(await restarted.listAgents(database.context, first.id)).toEqual(reordered);
            expect(await projects.projectForAgent(database.context, "agent-a")).toMatchObject({
                id: first.id,
            });
            expect(
                await projects.projectForAgent(database.context, "agent-missing"),
            ).toBeUndefined();
            await expect(
                projects.attachAgent(database.context, second.id, "agent-a"),
            ).rejects.toThrow(`Agent "agent-a" already belongs to project "${first.id}".`);

            await projects.archive(database.context, first.id);
            expect(await projects.listAgentIds(database.context, first.id)).toEqual([
                "agent-a",
                "agent-b",
            ]);
        } finally {
            database.close();
        }
    });

    it("attaches a managed catalog root only through the explicit managed boundary", async () => {
        const database = await migratedProjectDatabase("projects-managed-root-agent-test");
        try {
            const projects = await projectsModule();
            projects.beforeStart(database.context, {
                parentOf: async (_ctx: unknown, agentId: string) =>
                    agentId === "managed-agent" ? "parent-agent" : null,
            } as never);
            const project = await projects.create(database.context, {
                repositoryRef: "/tmp/projects/managed-root-agent",
                name: "Managed root agent",
            });

            await expect(
                projects.attachAgent(database.context, project.id, "managed-agent"),
            ).rejects.toThrow("Only a root agent can be attached to a project.");
            await expect(
                projects.attachManagedRootAgent(database.context, project.id, "root-agent"),
            ).rejects.toThrow("Only an agent managed by another agent");

            await projects.attachManagedRootAgent(database.context, project.id, "managed-agent");
            expect(await projects.listAgentIds(database.context, project.id)).toEqual([
                "managed-agent",
            ]);
        } finally {
            database.close();
        }
    });

    it("finds a project by its folder and refuses anything that is not a path", async () => {
        const database = await migratedProjectDatabase("projects-by-path-test");
        try {
            const projects = await projectsModule();
            const created = await projects.create(database.context, {
                repositoryRef: "/tmp/projects/by-path",
                name: "By path",
            });

            expect(
                await projects.getByPath(database.context, "/tmp/projects/by-path"),
            ).toMatchObject({ id: created.id, repositoryRef: "/tmp/projects/by-path" });
            expect(
                await projects.getByPath(database.context, "/tmp/projects/elsewhere"),
            ).toBeUndefined();
            await expect(projects.getByPath(database.context, "repo:by-path")).rejects.toThrow(
                "absolute path",
            );
        } finally {
            database.close();
        }
    });

    it("registers the home directory as the never-initialized home project", async () => {
        const database = await migratedProjectDatabase("projects-home-test");
        try {
            const projects = await projectsModule();
            const home = await projects.ensure(database.context, {
                kind: "home",
                repositoryRef: "/Users/person",
            });

            expect(home.created).toBe(true);
            expect(home.project).toMatchObject({
                kind: "home",
                name: "Home",
                storageKey: "home",
                initializationStatus: "ready",
                presence: "present",
            });
            // Nothing sets the home directory up, so a refresh is a no-op.
            const refreshed = await projects.refresh(database.context, home.project.id);
            expect(refreshed).toEqual(home.project);
        } finally {
            database.close();
        }
    });

    it("converges on the folder through ensure and restores an archived project", async () => {
        const database = await migratedProjectDatabase("projects-restore-test");
        try {
            let nextId = 0;
            const projects = await projectsModule();
            const created = await projects.create(database.context, {
                repositoryRef: "/tmp/projects/restore",
                name: "Restore me",
            });

            const converged = await projects.ensure(database.context, {
                repositoryRef: "/tmp/projects/restore",
            });
            expect(converged.created).toBe(false);
            expect(converged.changed).toBe(false);
            expect(converged.project.version).toBe(created.version);

            const archived = await projects.archive(database.context, created.id);
            expect(archived.status).toBe("archived");
            expect(archived.version).toBe(created.version + 1);

            const ensured = await projects.ensure(database.context, {
                repositoryRef: "/tmp/projects/restore",
            });
            expect(ensured.created).toBe(false);
            expect(ensured.changed).toBe(true);
            expect(ensured.project.id).toBe(created.id);
            expect(ensured.project.status).toBe("active");
            expect(ensured.project.version).toBe(archived.version + 1);

            const archivedAgain = await projects.archive(database.context, created.id);
            const restored = await projects.restore(database.context, created.id);
            expect(restored.status).toBe("active");
            expect(restored.version).toBe(archivedAgain.version + 1);
            await expect(projects.restore(database.context, created.id)).resolves.toEqual(restored);
        } finally {
            database.close();
        }
    });

    it("lets a remote replace a folder-derived name but never a name a person chose", async () => {
        const database = await migratedProjectDatabase("projects-name-source-test");
        try {
            let nextId = 0;
            const projects = await projectsModule();
            const derived = await projects.ensure(database.context, {
                repositoryRef: "/tmp/projects/happy-agent",
            });
            expect(derived.project.name).toBe("happy-agent");
            expect(derived.project.nameSource).toBe("folder");

            const adopted = await projects.adoptRemoteName(database.context, {
                name: "Happy Agent",
                projectId: derived.project.id,
            });
            expect(adopted.name).toBe("Happy Agent");
            expect(adopted.nameSource).toBe("remote");

            // A remote name is not a folder name, so the next remote does not win.
            const ignored = await projects.adoptRemoteName(database.context, {
                name: "Something else",
                projectId: derived.project.id,
            });
            expect(ignored).toEqual(adopted);

            const chosen = await projects.rename(database.context, {
                name: "My project",
                projectId: derived.project.id,
            });
            expect(chosen.nameSource).toBe("user");
            const stillChosen = await projects.adoptRemoteName(database.context, {
                name: "Remote name",
                projectId: derived.project.id,
            });
            expect(stillChosen).toEqual(chosen);
        } finally {
            database.close();
        }
    });

    it("walks a project through every initialization transition", async () => {
        const database = await migratedProjectDatabase("projects-initialization-test");
        try {
            let nextId = 0;
            const projects = await projectsModule();
            const cloned = await projects.create(database.context, {
                name: "Cloned",
                remoteSource: { kind: "github", repository: "slopus/happy" },
                repositoryRef: "/tmp/projects/cloned",
                requiredSecretKind: "github",
            });
            expect(cloned).toMatchObject({
                presence: "missing",
                initializationStatus: "initializing",
                initializationAttempt: 0,
            });

            const landed = await projects.markCloneReady(database.context, cloned.id);
            expect(landed.presence).toBe("present");

            const failed = await projects.markInitializationFailed(database.context, {
                error: "The install script exited with status 1.",
                projectId: cloned.id,
            });
            expect(failed).toMatchObject({
                initializationStatus: "failed",
                initializationAttempt: 1,
                initializationError: "The install script exited with status 1.",
            });

            // A failure is only recorded while the project is still initializing.
            expect(
                await projects.markInitializationFailed(database.context, {
                    error: "A second failure.",
                    projectId: cloned.id,
                }),
            ).toEqual(failed);

            const retried = await projects.retryInitialization(database.context, cloned.id);
            expect(retried.initializationStatus).toBe("initializing");
            expect(retried.initializationError).toBeUndefined();

            const ready = await projects.markInitializationReady(database.context, cloned.id);
            expect(ready).toMatchObject({
                initializationStatus: "ready",
                initializationAttempt: 2,
            });
            expect(ready.initializationError).toBeUndefined();
            expect(await projects.markCloneReady(database.context, cloned.id)).toEqual(ready);

            const refreshed = await projects.refresh(database.context, cloned.id);
            expect(refreshed).toMatchObject({
                initializationStatus: "initializing",
                initializationAttempt: 3,
            });

            await expect(
                projects.markInitializationFailed(database.context, {
                    error: "e".repeat(MAX_PROJECT_ERROR_LENGTH + 1),
                    projectId: cloned.id,
                }),
            ).rejects.toThrow("initialization failure input is invalid");
        } finally {
            database.close();
        }
    });

    it("writes probes and Git facts only when the observation actually changed", async () => {
        const database = await migratedProjectDatabase("projects-probe-test");
        try {
            let nextId = 0;
            const projects = await projectsModule();
            const created = await projects.create(database.context, {
                name: "Probed",
                repositoryRef: "/tmp/projects/probed",
            });

            // The project already looks like this, so the probe writes nothing.
            const unchanged = await projects.applyProbe(database.context, {
                presence: "present",
                projectId: created.id,
                worktreeSupport: "unknown",
            });
            expect(unchanged).toEqual(created);

            const probed = await projects.applyProbe(database.context, {
                presence: "present",
                projectId: created.id,
                worktreeSupport: "unsupported",
                worktreeUnsupportedReason: "The folder is not a Git repository.",
            });
            expect(probed.version).toBe(created.version + 1);
            expect(probed.worktreeSupport).toBe("unsupported");
            expect(probed.worktreeUnsupportedReason).toBe("The folder is not a Git repository.");
            expect(
                await projects.applyProbe(database.context, {
                    presence: "present",
                    projectId: created.id,
                    worktreeSupport: "unsupported",
                    worktreeUnsupportedReason: "The folder is not a Git repository.",
                }),
            ).toEqual(probed);

            const facts = {
                ahead: 2,
                behind: 1,
                branch: "main",
                detached: false,
                head: "0123456789abcdef",
                upstream: "origin/main",
            } as const;
            const untouched = await projects.applyGitFacts(database.context, {
                git: { ahead: 0, behind: 0, detached: false },
                projectId: created.id,
            });
            expect(untouched).toEqual(probed);

            const withFacts = await projects.applyGitFacts(database.context, {
                git: facts,
                projectId: created.id,
            });
            expect(withFacts.version).toBe(probed.version + 1);
            expect(withFacts).toMatchObject({
                gitAhead: 2,
                gitBehind: 1,
                gitBranch: "main",
                gitDetached: false,
                gitHead: "0123456789abcdef",
                gitUpstream: "origin/main",
            });
            expect(
                await projects.applyGitFacts(database.context, {
                    git: facts,
                    projectId: created.id,
                }),
            ).toEqual(withFacts);

            // The trunk workspaces fork from is decided once.
            const branched = await projects.setDefaultBranch(database.context, {
                branch: "main",
                projectId: created.id,
            });
            expect(branched.defaultBranch).toBe("main");
            expect(
                await projects.setDefaultBranch(database.context, {
                    branch: "develop",
                    projectId: created.id,
                }),
            ).toEqual(branched);

            // An archived project no longer takes host observations.
            const archived = await projects.archive(database.context, created.id);
            expect(
                await projects.applyProbe(database.context, {
                    presence: "missing",
                    projectId: created.id,
                    worktreeSupport: "supported",
                }),
            ).toEqual(archived);
        } finally {
            database.close();
        }
    });

    it("keeps an independent project order and reorders the main catalog", async () => {
        const database = await migratedProjectDatabase("projects-order-test");
        try {
            let nextId = 0;
            const projects = await projectsModule();
            const first = await projects.ensure(database.context, {
                repositoryRef: "/tmp/projects/first",
                name: "First",
            });
            const second = await projects.ensure(database.context, {
                repositoryRef: "/tmp/projects/second",
                name: "Second",
            });
            const third = await projects.ensure(database.context, {
                repositoryRef: "/tmp/projects/third",
                name: "Third",
            });

            expect(await projectIds(projects, database.context)).toEqual([
                first.project.id,
                second.project.id,
                third.project.id,
            ]);
            await projects.reorder(database.context, {
                afterId: null,
                projectId: third.project.id,
            });
            expect(await projectIds(projects, database.context)).toEqual([
                third.project.id,
                first.project.id,
                second.project.id,
            ]);
            await projects.reorder(database.context, {
                afterId: second.project.id,
                expectedVersion: first.project.version,
                projectId: first.project.id,
            });
            expect(await projectIds(projects, database.context)).toEqual([
                third.project.id,
                second.project.id,
                first.project.id,
            ]);
        } finally {
            database.close();
        }
    });

    it("stores avatar metadata, reads the bytes it kept, and clears the avatar", async () => {
        const database = await migratedProjectDatabase("projects-avatar-test");
        const config = await temporaryTestConfig();
        try {
            const bytes = await projectAvatarPng(220, 80, 40);
            expect(
                Value.Check(projectSetAvatarInputSchema, {
                    bytes,
                    contentType: "image/png",
                    projectId: "project-avatar",
                    source: "user",
                }),
            ).toBe(true);
            const projects = projectsModuleFor(config, new GitModule());
            const created = await projects.create(database.context, {
                repositoryRef: "/tmp/projects/avatar",
                name: "Avatar",
            });
            const updated = await projects.setAvatar(database.context, {
                bytes,
                contentType: "image/png",
                expectedVersion: created.version,
                projectId: created.id,
                source: "user",
            });
            expect(updated.avatar).toMatchObject({
                kind: "image",
                source: "user",
                thumbhash: expect.any(String),
            });
            await expect(projects.avatarAsset(database.context, created.id)).resolves.toMatchObject(
                {
                    contentHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
                    contentType: "image/webp",
                    thumbhash: updated.avatar?.thumbhash,
                },
            );
            const asset = await projects.avatarAsset(database.context, created.id);
            await expect(sharp(asset?.bytes).metadata()).resolves.toMatchObject({
                format: "webp",
            });

            const cleared = await projects.clearAvatar(database.context, {
                expectedVersion: updated.version,
                projectId: created.id,
            });
            expect(cleared.avatar).toBeUndefined();
            await expect(
                projects.avatarAsset(database.context, created.id),
            ).resolves.toBeUndefined();
        } finally {
            database.close();
            await rm(config.configuration.paths.happyHome, { force: true, recursive: true });
        }
    });

    it("rejects stale rename and settings writes with expected versions", async () => {
        const database = await migratedProjectDatabase("projects-concurrency-test");
        try {
            const projects = await projectsModule();
            const created = await projects.create(database.context, {
                repositoryRef: "/tmp/projects/concurrency",
                name: "Original",
            });
            const renamed = await projects.rename(database.context, {
                expectedVersion: created.version,
                name: "Renamed",
                projectId: created.id,
            });
            await expect(
                projects.rename(database.context, {
                    expectedVersion: created.version,
                    name: "Stale rename",
                    projectId: created.id,
                }),
            ).rejects.toThrow("changed before it could be renamed");

            const configured = await projects.updateSettings(database.context, {
                expectedVersion: renamed.version,
                projectId: created.id,
                settings: { defaultWorkspaceCompute: { image: "node:22", type: "docker" } },
            });
            expect(configured.changed).toBe(true);
            await expect(
                projects.updateSettings(database.context, {
                    expectedVersion: renamed.version,
                    projectId: created.id,
                    settings: { defaultWorkspaceCompute: { type: "local" } },
                }),
            ).rejects.toThrow("changed before its settings could be saved");
        } finally {
            database.close();
        }
    });

    it("ignores every observation that arrives after a project was archived", async () => {
        const events: string[] = [];
        const projects = await projectsModule();
        projects.onEventTransactional((_ctx, event) => {
            events.push(event.type);
        });
        const database = await migratedProjectDatabase("projects-late-observation-test");

        try {
            const created = await projects.create(database.context, {
                repositoryRef: "/tmp/projects/late",
                name: "Late",
            });
            const archived = await projects.archive(database.context, created.id);
            const settledEvents = [...events];

            // Setup, probes and refreshes that were already running describe a project nobody has
            // any more. None of them may touch the row, its version, or the log.
            const late = [
                await projects.markCloneReady(database.context, created.id),
                await projects.markInitializationReady(database.context, created.id),
                await projects.markInitializationFailed(database.context, {
                    projectId: created.id,
                    error: "The clone gave up.",
                }),
                await projects.retryInitialization(database.context, created.id),
                await projects.refresh(database.context, created.id),
                await projects.applyProbe(database.context, {
                    projectId: created.id,
                    presence: "missing",
                    worktreeSupport: "unsupported",
                }),
                await projects.applyGitFacts(database.context, {
                    projectId: created.id,
                    git: { ahead: 4, behind: 2, detached: true },
                }),
                await projects.adoptRemoteName(database.context, {
                    projectId: created.id,
                    name: "Named too late",
                }),
            ];

            for (const observed of late) expect(observed).toEqual(archived);
            expect(events).toEqual(settledEvents);
        } finally {
            database.close();
        }
    });

    it("refuses a guarded write that would land on a row something else moved", async () => {
        const projects = await projectsModule();
        const database = await migratedProjectDatabase("projects-guarded-write-test");

        try {
            const created = await projects.create(database.context, {
                repositoryRef: "/tmp/projects/guarded",
                name: "Guarded",
            });

            const rename = async (expectedVersion: number) =>
                await writeGuardedProject(
                    database.database,
                    created.id,
                    expectedVersion,
                    sql`UPDATE happy_agent_module_projects
                        SET name = 'Renamed', updated_at = 2, version = version + 1
                        WHERE id = ${created.id} AND version = ${expectedVersion}
                        RETURNING id`,
                    "The project changed before it could be renamed.",
                );

            // A write decided against a version the row has already left touches nothing, and the
            // caller is told rather than handed a result it did not cause.
            await expect(rename(created.version + 5)).rejects.toThrow(
                "changed before it could be renamed",
            );
            await expect(projects.get(database.context, created.id)).resolves.toEqual(created);

            const stored = await rename(created.version);
            expect(stored).toMatchObject({ name: "Renamed", version: created.version + 1 });
        } finally {
            database.close();
        }
    });

    it("does not offer a cursor to a page that has already shown everything", async () => {
        const projects = await projectsModule();
        const database = await migratedProjectDatabase("projects-exact-page-test");

        try {
            for (const folder of ["/tmp/projects/one", "/tmp/projects/two"]) {
                await projects.create(database.context, {
                    repositoryRef: folder,
                    name: folder,
                });
            }

            const exact = await projects.list(database.context, { limit: 2 });
            expect(exact.projects).toHaveLength(2);
            expect(exact.nextCursor).toBeUndefined();
            expect(projects.formatPageForModel(exact)).not.toContain("More projects");

            const partial = await projects.list(database.context, { limit: 1 });
            expect(partial.nextCursor).toBe("1");
        } finally {
            database.close();
        }
    });

    it("keeps complete catalog pages separate from model-output fitting", async () => {
        const projects = await projectsModule();
        const database = await migratedProjectDatabase("projects-catalog-page-test");

        try {
            for (let index = 0; index < 50; index += 1) {
                await projects.create(database.context, {
                    name: `Project ${String(index)}`,
                    repositoryRef: `/tmp/projects/${String(index)}-${"x".repeat(300)}`,
                });
            }

            const catalog = await projects.listCatalogPage(database.context, { limit: 50 });
            const model = await projects.list(database.context, { limit: 50 });

            expect(catalog.projects).toHaveLength(50);
            expect(catalog.nextCursor).toBeUndefined();
            expect(model.projects.length).toBeLessThan(50);
            expect(model.nextCursor).toBe(String(model.projects.length));
        } finally {
            database.close();
        }
    });

    it("accepts only the remote URLs a clone would actually run", () => {
        const remote = (url: string) =>
            Value.Check(projectRemoteSourceSchema, { kind: "git", url });

        expect(remote("https://github.com/acme/retry-policy.git")).toBe(true);
        expect(remote("https://git.example.com:8443/acme/retry-policy.git")).toBe(true);

        // The clone boundary refuses each of these, so a project that recorded one could never
        // finish being set up.
        expect(remote("http://github.com/acme/retry-policy.git")).toBe(false);
        expect(remote("git@github.com:acme/retry-policy.git")).toBe(false);
        expect(remote("ssh://git@github.com/acme/retry-policy.git")).toBe(false);
        expect(remote("file:///tmp/acme/retry-policy")).toBe(false);
        expect(remote("https://token:x@github.com/acme/retry-policy.git")).toBe(false);
        expect(remote("https://")).toBe(false);
        expect(remote(" https://github.com/acme/retry-policy.git")).toBe(false);
    });

    it("refuses text a person could not have typed and folders a host did not normalize", () => {
        const record = {
            id: "project-1",
            repositoryRef: "/tmp/projects/one",
            kind: "regular",
            storageKey: "one",
            name: "Project",
            nameSource: "folder",
            status: "active",
            presence: "present",
            initializationStatus: "ready",
            initializationAttempt: 0,
            worktreeSupport: "unknown",
            gitAhead: 0,
            gitBehind: 0,
            gitDetached: false,
            orderKey: "00000000000000000001",
            version: 1,
            createdAt: 1,
            updatedAt: 1,
        };
        expect(Value.Check(projectSchema, record)).toBe(true);

        // Control characters reach a terminal as an escape sequence rather than as text.
        expect(Value.Check(projectSchema, { ...record, name: "Retry\u0007policy" })).toBe(false);
        expect(Value.Check(projectSchema, { ...record, name: "Retry\tpolicy" })).toBe(false);

        // A project is one canonical folder, already resolved by the host.
        for (const repositoryRef of [
            "projects/one",
            "/tmp/projects/../one",
            "/tmp/projects/./one",
            "/tmp/projects/one/",
        ]) {
            expect(Value.Check(projectSchema, { ...record, repositoryRef })).toBe(false);
        }
        expect(Value.Check(projectSchema, { ...record, repositoryRef: "C:\\projects\\one" })).toBe(
            true,
        );

        // Git refuses these itself, so a row that holds one describes a branch that cannot exist.
        for (const gitBranch of ["main..old", "main~1", "refs/heads/main.lock", "@{now}"]) {
            expect(Value.Check(projectSchema, { ...record, gitBranch })).toBe(false);
        }
        expect(Value.Check(projectSchema, { ...record, gitBranch: "refs/heads/main" })).toBe(true);
    });
});

/**
 * The catalog as the product builds it: configuration rooted in a folder this test owns, and Git
 * itself. Identities, event identities and timestamps are the module's own, so nothing here asserts
 * on them.
 */
async function projectsModule(toml?: string): Promise<ProjectsModule> {
    return projectsModuleFor(await temporaryTestConfig(toml), new GitModule());
}

async function migratedProjectDatabase(name: string) {
    const database = moduleDatabase([], name);
    for (const [, migrate] of durableFunctionsMigrations) {
        await migrate(database.context, database.database);
    }
    for (const [, migrate] of projectMigrations) {
        await migrate(database.context, database.database);
    }
    return database;
}

async function projectAvatarPng(red: number, green: number, blue: number): Promise<Buffer> {
    return await sharp({
        create: {
            background: { alpha: 0.75, b: blue, g: green, r: red },
            channels: 4,
            height: 80,
            width: 120,
        },
    })
        .png()
        .toBuffer();
}

/** The tools this module hands one agent. `subagent-a` is the only agent here with a parent. */
async function projectToolNames(
    projects: ProjectsModule,
    agentId: string,
): Promise<readonly string[]> {
    const agents = {
        parentOf: (_ctx: unknown, id: string) =>
            Promise.resolve(id === "subagent-a" ? "agent-a" : null),
    } as never;
    const hooks = projects.beforeStart(undefined as never, agents);
    const tools = await hooks.tools!(undefined as never, { agent: { id: agentId } } as never);
    return tools.map((tool) => tool.name);
}

async function projectIds(
    projects: ProjectsModule,
    context: Parameters<ProjectsModule["list"]>[0],
): Promise<readonly string[]> {
    const page = await projects.list(context);
    return page.projects.map((project) => project.id);
}
