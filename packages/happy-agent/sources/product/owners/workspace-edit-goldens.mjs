import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testConfigRootedAt } from "../../../../happy-agent-modules/tests/support/configModule.ts";
import { workspacesCatalogFrom } from "../../../../happy-agent-modules/tests/support/workspacesModule.ts";
import { moduleDatabase } from "../../../../happy-agent-modules/tests/support/moduleDatabase.ts";
import { projectMigrations } from "../../../../happy-agent-modules/sources/projects/ProjectMigrations.ts";
import { workspaceMigrations } from "../../../../happy-agent-modules/sources/workspaces/WorkspaceMigrations.ts";
import { durableFunctionsMigrations } from "../../../../happy-agent-modules/sources/durableFunctions/index.ts";
import { insertProjectRow } from "../../../../happy-agent-modules/sources/projects/store/projectRecords.ts";
import { insertWorkspace } from "../../../../happy-agent-modules/sources/workspaces/store/workspaceRecords.ts";
import { writeNativeCapture } from "../../../scripts/write-native-capture.mjs";

const root = await mkdtemp(join(tmpdir(), "native-source-workspace-edits-"));
const config = await testConfigRootedAt(root);
const catalog = workspacesCatalogFrom(config);
const database = moduleDatabase(
    [...projectMigrations, ...workspaceMigrations, ...durableFunctionsMigrations],
    "native-source-workspace-edits",
);
await database.ready;
catalog.workspaces.beforeStart(database.context, catalog.agents.asRef());
const project = {
    id: "workspaceprojectfixture",
    repositoryRef: "/tmp/native-workspace-edits/project",
    kind: "regular",
    storageKey: "workspace-project",
    name: "Project",
    nameSource: "folder",
    status: "active",
    presence: "present",
    initializationStatus: "ready",
    initializationAttempt: 0,
    worktreeSupport: "unsupported",
    gitAhead: 0,
    gitBehind: 0,
    gitDetached: false,
    orderKey: "500",
    version: 2,
    createdAt: 100,
    updatedAt: 200,
};
const initial = ["Placeholder", "Other", "Archived", "Same", "Nested"].map((name, index) => ({
    id: `workspacefixture${index + 1}`,
    projectRef: project.id,
    parentId: index === 4 ? "workspacefixture2" : project.id,
    name,
    nameConfigured: index !== 0 && index !== 3,
    branch: `worktree/${name.toLowerCase()}`,
    storageKey: `workspace-${index + 1}`,
    kind: "directory",
    path: `/tmp/native-workspace-edits/${index + 1}`,
    presence: "present",
    status: index === 2 ? "archived" : "ready",
    orderKey: String((index + 1) * 2),
    version: 2,
    gitAhead: 0,
    gitBehind: 0,
    gitDetached: false,
    initializationAttempt: 1,
    createdAt: 100,
    updatedAt: 200,
    ...(index === 2 ? { archivedAt: 200 } : {}),
}));
function comparable(value) {
    if (Array.isArray(value)) return value.map(comparable);
    if (value && typeof value === "object")
        return Object.fromEntries(
            Object.entries(value)
                .filter(([key]) => !["eventId", "at", "updatedAt", "archivedAt"].includes(key))
                .map(([key, value]) => [key, comparable(value)]),
        );
    return value;
}
const events = [];
catalog.workspaces.onEventTransactional((_ctx, event) => events.push(comparable(event)));
const cases = [];
try {
    await insertProjectRow(database.database, project);
    for (const row of initial) await insertWorkspace(database.database, row);
    async function run(kind, input, operation) {
        const count = events.length;
        const result = await operation();
        cases.push({ kind, input, result: comparable(result), events: events.slice(count) });
        return result;
    }
    let current = await run(
        "rename",
        { workspaceId: "workspacefixture1", name: "Other", expectedVersion: 2 },
        () =>
            catalog.workspaces.rename(database.context, {
                workspaceId: "workspacefixture1",
                name: "Other",
                expectedVersion: 2,
            }),
    );
    current = await run(
        "rename",
        { workspaceId: current.id, name: current.name, expectedVersion: current.version },
        () =>
            catalog.workspaces.rename(database.context, {
                workspaceId: current.id,
                name: current.name,
                expectedVersion: current.version,
            }),
    );
    await run(
        "rename",
        { workspaceId: "workspacefixture4", name: "Same", expectedVersion: 2 },
        () =>
            catalog.workspaces.rename(database.context, {
                workspaceId: "workspacefixture4",
                name: "Same",
                expectedVersion: 2,
            }),
    );
    current = await run(
        "reorder",
        { workspaceId: current.id, afterId: "workspacefixture3", expectedVersion: current.version },
        () =>
            catalog.workspaces.reorder(database.context, {
                workspaceId: current.id,
                afterId: "workspacefixture3",
                expectedVersion: current.version,
            }),
    );
    current = await run(
        "reorder",
        { workspaceId: current.id, afterId: "workspacefixture3", expectedVersion: current.version },
        () =>
            catalog.workspaces.reorder(database.context, {
                workspaceId: current.id,
                afterId: "workspacefixture3",
                expectedVersion: current.version,
            }),
    );
    await run("attach", { workspaceId: current.id, agentId: "workspaceagentfixtureone" }, () =>
        catalog.workspaces.attachAgent(database.context, current.id, "workspaceagentfixtureone"),
    );
    await run("attach", { workspaceId: current.id, agentId: "workspaceagentfixtureone" }, () =>
        catalog.workspaces.attachAgent(database.context, current.id, "workspaceagentfixtureone"),
    );
    current = await catalog.workspaces.get(database.context, current.id);
    await run("archive", { workspaceId: current.id, expectedVersion: current.version }, () =>
        catalog.workspaces.beginArchive(database.context, current.id, {
            expectedVersion: current.version,
        }),
    );
    let rejected = false;
    try {
        await catalog.workspaces.reorder(database.context, {
            workspaceId: "workspacefixture2",
            afterId: "workspacefixture5",
            expectedVersion: 2,
        });
    } catch {
        rejected = true;
    }
    assert(rejected);
    writeNativeCapture(
        new URL("workspace_edit_goldens.json", import.meta.url),
        JSON.stringify({ project, initial, cases, crossParentRejected: true }, null, 2) + "\n",
    );
} finally {
    await catalog.workspaces.close(database.context);
    await catalog.runners.close();
    database.close();
    await rm(root, { recursive: true, force: true });
}
