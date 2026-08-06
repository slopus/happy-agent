import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { migrateSessionDatabase } from "../../database/migrateSessionDatabase.js";
import { openSessionDatabase } from "../../database/openSessionDatabase.js";
import { projectAvatarAssets, projects, projectWorkspaces } from "../../database/schema.js";
import { inTx } from "../../inTx.js";
import { projectRefresh } from "../projectRefresh.js";
import { projectSetAvatar } from "../projectSetAvatar.js";
import { projectSetSettings } from "../projectSetSettings.js";
import { queryProject } from "../queryProject.js";
import { workspaceReserve } from "../workspaceReserve.js";
import { workspaceApplyProbe } from "../workspaceApplyProbe.js";

describe("project persistence", () => {
    it("rolls back the avatar asset and project reference together", () => {
        const opened = databaseWithProject();

        expect(() =>
            inTx(opened.database, (tx) => {
                projectSetAvatar(tx, {
                    asset: { byteLength: 3, hash: "a".repeat(64), height: 1, width: 1 },
                    now: 2,
                    projectId: "project-1",
                    source: "user",
                });
                throw new Error("fail after avatar");
            }),
        ).toThrow("fail after avatar");

        expect(opened.database.select().from(projectAvatarAssets).all()).toEqual([]);
        expect(
            opened.database
                .select({ avatarHash: projects.avatarHash })
                .from(projects)
                .where(eq(projects.id, "project-1"))
                .get(),
        ).toEqual({ avatarHash: null });
        opened.client.close();
    });

    it("rolls back a complete workspace reservation with its outer action", () => {
        const opened = databaseWithProject();

        expect(() =>
            inTx(opened.database, (tx) => {
                workspaceReserve(tx, {
                    baseCommit: "a".repeat(40),
                    baseRef: "main",
                    gitCommonDir: "/workspace/.git",
                    id: "workspace-1",
                    name: "Feature",
                    now: 2,
                    pathForStorageKey: (key) => `/state/workspaces/project/${key}`,
                    projectId: "project-1",
                });
                throw new Error("fail after workspace");
            }),
        ).toThrow("fail after workspace");

        expect(opened.database.select().from(projectWorkspaces).all()).toEqual([]);
        opened.client.close();
    });

    it("does not let an initialization-era probe overwrite workspace presence", () => {
        const opened = databaseWithProject();
        workspaceReserve(opened.database, {
            id: "workspace-1",
            name: "Feature",
            now: 2,
            pathForStorageKey: (key) => `/state/workspaces/project/${key}`,
            projectId: "project-1",
        });

        expect(
            workspaceApplyProbe(
                opened.database,
                "project-1",
                "workspace-1",
                {
                    gitAhead: 0,
                    gitBehind: 0,
                    gitBranch: null,
                    gitDetached: false,
                    gitHead: null,
                    gitUpstream: null,
                    presence: "missing",
                },
                3,
            ),
        ).toBe(0);
        expect(
            opened.database
                .select({
                    presence: projectWorkspaces.presence,
                    status: projectWorkspaces.status,
                })
                .from(projectWorkspaces)
                .where(eq(projectWorkspaces.id, "workspace-1"))
                .get(),
        ).toEqual({ presence: "present", status: "initializing" });
        opened.client.close();
    });

    it("stores and clears the default workspace compute atomically", () => {
        const opened = databaseWithProject();

        expect(
            projectSetSettings(
                opened.database,
                "project-1",
                { defaultWorkspaceCompute: { image: "rig-dev:latest", type: "docker" } },
                2,
                1,
            ),
        ).toBe(1);
        expect(queryProject(opened.database, "project-1")).toMatchObject({
            settings: {
                defaultWorkspaceCompute: {
                    generation: 1,
                    image: "rig-dev:latest",
                    type: "docker",
                },
            },
            version: 2,
        });

        expect(
            projectSetSettings(
                opened.database,
                "project-1",
                { defaultWorkspaceCompute: { image: "rig-dev:latest", type: "docker" } },
                3,
                2,
            ),
        ).toBe(1);
        expect(queryProject(opened.database, "project-1")).toMatchObject({
            settings: {
                defaultWorkspaceCompute: {
                    generation: 1,
                    image: "rig-dev:latest",
                    type: "docker",
                },
            },
            version: 3,
        });
        expect(
            projectSetSettings(
                opened.database,
                "project-1",
                { defaultWorkspaceCompute: { type: "local" } },
                4,
                3,
            ),
        ).toBe(1);
        expect(queryProject(opened.database, "project-1")).toMatchObject({
            settings: {
                defaultWorkspaceCompute: {
                    generation: 2,
                    type: "local",
                },
            },
            version: 4,
        });
        expect(() =>
            projectSetSettings(
                opened.database,
                "project-1",
                { defaultWorkspaceCompute: { image: "invalid image", type: "docker" } },
                5,
                4,
            ),
        ).toThrow("must not contain whitespace");
        opened.client.close();
    });

    it("guards settings with the last user mutation rather than enrichment", () => {
        const opened = databaseWithProject();
        opened.database
            .update(projects)
            .set({ version: sql`${projects.version} + 1` })
            .where(eq(projects.id, "project-1"))
            .run();

        expect(
            projectSetSettings(
                opened.database,
                "project-1",
                { defaultWorkspaceCompute: { type: "local" } },
                2,
                1,
            ),
        ).toBe(1);
        expect(
            projectSetSettings(
                opened.database,
                "project-1",
                { defaultWorkspaceCompute: { type: "docker", image: "rig-dev:latest" } },
                3,
                2,
            ),
        ).toBe(0);
        opened.client.close();
    });

    it("keeps refresh out of the user mutation watermark", () => {
        const opened = databaseWithProject();

        expect(projectRefresh(opened.database, "project-1", 2)).toBe(1);
        expect(
            opened.database
                .select({
                    userMutationVersion: projects.userMutationVersion,
                    version: projects.version,
                })
                .from(projects)
                .where(eq(projects.id, "project-1"))
                .get(),
        ).toEqual({ userMutationVersion: 1, version: 2 });
        opened.client.close();
    });
});

function databaseWithProject(): ReturnType<typeof openSessionDatabase> {
    const opened = openSessionDatabase(":memory:");
    migrateSessionDatabase(opened.database);
    opened.database
        .insert(projects)
        .values({
            createdAtMs: 1,
            gitAhead: 0,
            gitBehind: 0,
            gitDetached: false,
            id: "project-1",
            initializationAttempt: 0,
            initializationStatus: "ready",
            kind: "regular",
            name: "Project",
            nameKey: "project",
            nameSource: "folder",
            orderKey: "a0",
            path: "/workspace",
            presence: "present",
            storageKey: "project",
            updatedAtMs: 1,
            version: 1,
            worktreeSupport: "supported",
        })
        .run();
    return opened;
}
