import assert from "node:assert/strict";
import { Value } from "@sinclair/typebox/value";
import { sql } from "drizzle-orm";
import { agentDatabaseRun } from "@slopus/happy-agent-base";
import { writeNativeCapture } from "../../../scripts/write-native-capture.mjs";
import { moduleDatabase } from "../../../../happy-agent-modules/tests/support/moduleDatabase.ts";
import { projectMigrations } from "../../../../happy-agent-modules/sources/projects/ProjectMigrations.ts";
import { workspaceMigrations } from "../../../../happy-agent-modules/sources/workspaces/WorkspaceMigrations.ts";
import { createProjectQueries } from "../../../../happy-agent-modules/sources/projects/store/projectQueries.ts";
import { insertProjectRow } from "../../../../happy-agent-modules/sources/projects/store/projectRecords.ts";
import { listProjectRootAgents } from "../../../../happy-agent-modules/sources/projects/store/projectRootAgents.ts";
import { createWorkspaceStore } from "../../../../happy-agent-modules/sources/workspaces/WorkspaceStore.ts";
import { insertWorkspace } from "../../../../happy-agent-modules/sources/workspaces/store/workspaceRecords.ts";
import {
    insertWorkspaceAgent,
    readWorkspaceAgents,
} from "../../../../happy-agent-modules/sources/workspaces/store/workspaceAgents.ts";
import { parseCursor } from "../../../../happy-agent-modules/sources/projects/projectRuntime.ts";
import { ownerCatalogRowSchemas, ownerCatalogSchemas } from "./catalog-schema-export.mjs";

const projects = Array.from({ length: 58 }, (_, index) => {
    const suffix = String(index).padStart(2, "0");
    return {
        id: `project-${suffix}`,
        repositoryRef: `/tmp/native-catalog/project-${suffix}`,
        ...(index === 7 ? { runnerId: "fixture" } : {}),
        kind: "regular",
        storageKey: `project-${suffix}`,
        name: index === 9 ? "p".repeat(500) : `Project ${suffix}`,
        nameSource: "user",
        status: index % 13 === 0 ? "archived" : "active",
        presence: "present",
        initializationStatus: "ready",
        initializationAttempt: 0,
        worktreeSupport: "unsupported",
        gitAhead: 0,
        gitBehind: 0,
        gitDetached: false,
        orderKey: String(100 - Math.floor(index / 2)),
        version: 2,
        createdAt: 100,
        updatedAt: 200,
        ...(index % 13 === 0 ? { archivedAt: 200 } : {}),
    };
});
const workspaces = Array.from({ length: 54 }, (_, index) => {
    const suffix = String(index).padStart(2, "0");
    const projectRef = index % 5 === 0 ? "project-01" : "project-02";
    const status = index % 11 === 0 ? "archived" : index % 7 === 0 ? "archiving" : "ready";
    return {
        id: `workspace-${suffix}`,
        projectRef,
        parentId: index === 8 ? "workspace-03" : projectRef,
        name: `Workspace ${suffix}`,
        nameConfigured: true,
        branch: `workspace-${suffix}`,
        storageKey: `workspace-${suffix}`,
        kind: "directory",
        path: `/tmp/native-catalog/workspace-${suffix}`,
        presence: "present",
        status,
        orderKey: String(100 - Math.floor(index / 2)),
        version: 2,
        gitAhead: 0,
        gitBehind: 0,
        gitDetached: false,
        initializationAttempt: 0,
        createdAt: 100,
        updatedAt: 200,
        ...(status === "archived" || status === "archiving" ? { archivedAt: 200 } : {}),
    };
});
const database = moduleDatabase(
    [...projectMigrations, ...workspaceMigrations],
    "native-catalog-capture",
);
await database.ready;
try {
    for (const project of projects) {
        assert(Value.Check(ownerCatalogRowSchemas.project, project));
        await insertProjectRow(database.database, project);
    }
    for (const workspace of workspaces) {
        assert(Value.Check(ownerCatalogRowSchemas.workspace, workspace));
        await insertWorkspace(database.database, workspace);
    }
    const projectAgents = [
        { agentId: "agent-z", orderKey: "400" },
        { agentId: "agent-b", orderKey: "200" },
        { agentId: "agent-a", orderKey: "200" },
    ];
    const workspaceAgents = [
        { agentId: "workspace-agent-z", orderKey: "300" },
        { agentId: "workspace-agent-b", orderKey: "100" },
        { agentId: "workspace-agent-a", orderKey: "100" },
    ];
    for (const association of projectAgents) {
        await agentDatabaseRun(
            database.database,
            sql`INSERT INTO happy_agent_module_project_root_agents(project_id,agent_id,order_key) VALUES(${"project-02"},${association.agentId},${association.orderKey})`,
        );
    }
    for (const association of workspaceAgents) {
        await insertWorkspaceAgent(database.database, {
            workspaceId: "workspace-03",
            ...association,
        });
    }
    const projectQueries = [
        {},
        { includeArchived: true },
        { includeArchived: true, cursor: "50" },
        { includeArchived: true, cursor: "58" },
        { status: "archived", includeArchived: false, limit: 2 },
        { status: "active", limit: 1, cursor: "1" },
        { cursor: "9007199254740991" },
    ];
    const workspaceQueries = [
        {},
        { includeArchived: true },
        { includeArchived: true, cursor: 50 },
        { includeArchived: true, cursor: 54 },
        { projectRef: "project-01", limit: 2 },
        { projectRef: "project-01", includeArchived: true, cursor: 2, limit: 3 },
        { cursor: 9007199254740991 },
    ];
    const projectStore = createProjectQueries();
    // Listing never calls the catalog argument; the original store owns the complete query.
    const workspaceStore = createWorkspaceStore(undefined);
    const projectPages = await Promise.all(
        projectQueries.map(async (query) => ({
            query,
            result: await projectStore.list(database.context, query),
        })),
    );
    const workspacePages = await Promise.all(
        workspaceQueries.map(async (query) => ({
            query,
            result: await workspaceStore.list(database.context, query),
        })),
    );
    const invalidProjectQueries = [
        { cursor: "01" },
        { cursor: "-1" },
        { cursor: "9007199254740992" },
        { cursor: 0 },
        { limit: 0 },
        { limit: 51 },
        { unknown: true },
    ].map((query) => {
        let accepted = Value.Check(ownerCatalogSchemas.ownerProjectPageQuery, query);
        if (accepted && query.cursor !== undefined) {
            try {
                parseCursor(query.cursor);
            } catch {
                accepted = false;
            }
        }
        assert.equal(accepted, false);
        return query;
    });
    const invalidWorkspaceQueries = [
        { cursor: "0" },
        { cursor: -1 },
        { cursor: 1.5 },
        { cursor: 9007199254740992 },
        { limit: 0 },
        { limit: 51 },
        { projectId: "project-02" },
        { status: "ready" },
    ];
    for (const query of invalidWorkspaceQueries)
        assert.equal(Value.Check(ownerCatalogSchemas.ownerWorkspacePageQuery, query), false);
    const sourceProjectAgents = (await listProjectRootAgents(database.context, "project-02")).map(
        ({ agentId, orderKey }) => ({ agentId, orderKey }),
    );
    const sourceWorkspaceAgents = (
        await readWorkspaceAgents(database.database, "workspace-03")
    ).map(({ agentId, orderKey }) => ({ agentId, orderKey }));
    writeNativeCapture(
        new URL("catalog_goldens.json", import.meta.url),
        JSON.stringify(
            {
                projects,
                workspaces,
                projectPages,
                workspacePages,
                invalidProjectQueries,
                invalidWorkspaceQueries,
                projectAgents,
                workspaceAgents,
                sourceProjectAgents,
                sourceWorkspaceAgents,
            },
            null,
            2,
        ) + "\n",
    );
} finally {
    database.close();
}
