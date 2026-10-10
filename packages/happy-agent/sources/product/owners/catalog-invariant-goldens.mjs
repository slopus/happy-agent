import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "@sinclair/typebox/value";
import { testConfigRootedAt } from "../../../../happy-agent-modules/tests/support/configModule.ts";
import { workspacesCatalogFrom } from "../../../../happy-agent-modules/tests/support/workspacesModule.ts";
import { moduleDatabase } from "../../../../happy-agent-modules/tests/support/moduleDatabase.ts";
import { projectMigrations } from "../../../../happy-agent-modules/sources/projects/ProjectMigrations.ts";
import { workspaceMigrations } from "../../../../happy-agent-modules/sources/workspaces/WorkspaceMigrations.ts";
import { projectSchema } from "../../../../happy-agent-modules/sources/projects/Project.ts";
import { workspaceSchema } from "../../../../happy-agent-modules/sources/workspaces/Workspace.ts";
import { insertProjectRow } from "../../../../happy-agent-modules/sources/projects/store/projectRecords.ts";
import { insertWorkspace } from "../../../../happy-agent-modules/sources/workspaces/store/workspaceRecords.ts";
import { writeNativeCapture } from "../../../scripts/write-native-capture.mjs";

const root = await mkdtemp(join(tmpdir(), "native-source-catalog-invariants-"));
const catalog = workspacesCatalogFrom(await testConfigRootedAt(root));
const database = moduleDatabase(
    [...projectMigrations, ...workspaceMigrations],
    "native-source-catalog-invariants",
);
await database.ready;
const projectBase = {
    id: "invariant-project",
    repositoryRef: "/tmp/native-invariant/project",
    kind: "regular",
    storageKey: "invariant-project",
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
    orderKey: "500",
    version: 2,
    createdAt: 100,
    updatedAt: 200,
};
const projectChanges = [
    {},
    { updatedAt: 99 },
    { status: "archived" },
    { status: "archived", archivedAt: 99 },
    { status: "archived", archivedAt: 201 },
    { archivedAt: 100 },
    { kind: "home", initializationStatus: "initializing" },
    { initializationError: "Setup failed." },
    { worktreeUnsupportedReason: "No worktrees." },
    { status: "archived", archivedAt: 200 },
    { initializationStatus: "failed", initializationError: "Setup failed." },
    { worktreeSupport: "unsupported", worktreeUnsupportedReason: "No worktrees." },
];
const workspaceBase = {
    id: "invariant-workspace",
    projectRef: projectBase.id,
    parentId: projectBase.id,
    name: "Workspace",
    nameConfigured: true,
    branch: "worktree/invariant",
    storageKey: "invariant-workspace",
    kind: "directory",
    path: "/tmp/native-invariant/workspace",
    presence: "present",
    status: "ready",
    orderKey: "500",
    version: 2,
    gitAhead: 0,
    gitBehind: 0,
    gitDetached: false,
    initializationAttempt: 1,
    createdAt: 100,
    updatedAt: 200,
};
const workspaceChanges = [
    {},
    { updatedAt: 99 },
    { status: "archived" },
    { status: "archived", archivedAt: 99 },
    { status: "archived", archivedAt: 201 },
    { archivedAt: 100 },
    { version: 1 },
    { version: 1, status: "initializing" },
    { version: 1, status: "initializing", presence: "missing" },
    { status: "archiving" },
    { status: "archived", archivedAt: 200 },
];
try {
    const projects = [];
    const workspaces = [];
    for (const [index, changes] of projectChanges.entries()) {
        const record = {
            ...projectBase,
            ...changes,
            id: `invariant-project-${index}`,
            repositoryRef: `/tmp/native-invariant/project-${index}`,
            storageKey: `project-${index}`,
        };
        assert(Value.Check(projectSchema, record));
        await insertProjectRow(database.database, record);
        let accepted = true;
        try {
            await catalog.projects.get(database.context, record.id);
        } catch {
            accepted = false;
        }
        projects.push({ changes, record, accepted });
    }
    for (const [index, changes] of workspaceChanges.entries()) {
        const record = {
            ...workspaceBase,
            ...changes,
            id: `invariant-workspace-${index}`,
            path: `/tmp/native-invariant/workspace-${index}`,
            name: `Workspace ${index}`,
            storageKey: `workspace-${index}`,
            branch: `worktree/invariant-${index}`,
        };
        assert(Value.Check(workspaceSchema, record));
        await insertWorkspace(database.database, record);
        let accepted = true;
        try {
            await catalog.workspaces.get(database.context, record.id);
        } catch {
            accepted = false;
        }
        workspaces.push({ changes, record, accepted });
    }
    const clockProject = {
        ...projectBase,
        id: "clock-project",
        repositoryRef: "/tmp/native-invariant/clock-project",
        storageKey: "clock-project",
        updatedAt: 4_000_000_000_000,
    };
    await insertProjectRow(database.database, clockProject);
    let projectMutationRejected = false;
    try {
        await catalog.projects.rename(database.context, {
            projectId: clockProject.id,
            name: "Future project name",
            expectedVersion: 2,
        });
    } catch {
        projectMutationRejected = true;
    }
    assert(projectMutationRejected);
    const projectAfter = await catalog.projects.get(database.context, clockProject.id);
    assert.deepEqual(projectAfter, clockProject);
    const clockWorkspace = {
        ...workspaceBase,
        id: "clock-workspace",
        path: "/tmp/native-invariant/clock-workspace",
        branch: "worktree/clock-workspace",
        name: "Clock workspace",
        storageKey: "clock-workspace",
        updatedAt: 4_000_000_000_000,
    };
    await insertWorkspace(database.database, clockWorkspace);
    const workspaceAfter = await catalog.workspaces.rename(database.context, {
        workspaceId: clockWorkspace.id,
        name: "Future workspace name",
        expectedVersion: 2,
    });
    assert.equal(workspaceAfter.updatedAt, clockWorkspace.updatedAt + 1);
    writeNativeCapture(
        new URL("catalog_invariant_goldens.json", import.meta.url),
        JSON.stringify(
            {
                projectBase,
                workspaceBase,
                projects,
                workspaces,
                clock: {
                    projectBefore: clockProject,
                    projectAfter,
                    projectMutationRejected,
                    workspaceBefore: clockWorkspace,
                    workspaceAfter,
                },
            },
            null,
            2,
        ) + "\n",
    );
} finally {
    await catalog.workspaces.close(database.context);
    await catalog.runners.close();
    database.close();
    await rm(root, { recursive: true, force: true });
}
