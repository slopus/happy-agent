import { afterEach, describe, expect, it } from "vitest";

import { durableFunctionsMigrations } from "../../sources/durableFunctions/index.js";
import { projectMigrations } from "../../sources/projects/index.js";
import { workspaceMigrations } from "../../sources/workspaces/index.js";
import { cleanupRoots, commitFile, createRepository, createRoot } from "../git/helpers.js";
import { testConfigRootedAt } from "../support/configModule.js";
import { moduleDatabase } from "../support/moduleDatabase.js";
import { workspacesCatalogFrom } from "../support/workspacesModule.js";

afterEach(cleanupRoots);

describe("workspace Git credential ownership", () => {
    it("uses the recorded project owner when the caller omits a creator", async () => {
        const fixture = await createFixture();
        try {
            const owner = { instanceId: "remote-instance", profileId: "remote-profile" };
            await fixture.projects.registerGitCredential(
                fixture.ctx,
                fixture.project.id,
                owner,
                "fixture-token",
            );
            await expect(
                fixture.workspaces.createWorkspace(fixture.ctx, fixture.project.id, {
                    name: "child",
                }),
            ).resolves.toMatchObject({ projectRef: fixture.project.id, status: "initializing" });
        } finally {
            await fixture.close();
        }
    });

    it("does not substitute the project owner for an explicitly different creator", async () => {
        const fixture = await createFixture();
        try {
            const owner = { instanceId: "owner-instance", profileId: "owner-profile" };
            await fixture.projects.registerGitCredential(
                fixture.ctx,
                fixture.project.id,
                owner,
                "fixture-token",
            );
            await expect(
                fixture.workspaces.createWorkspace(
                    fixture.ctx,
                    fixture.project.id,
                    {
                        name: "child",
                    },
                    undefined,
                    {
                        createdBy: { instanceId: "other-instance", profileId: "other-profile" },
                    },
                ),
            ).rejects.toThrow("GitHub credentials are unavailable for this workspace.");
            expect(await fixture.workspaces.list(fixture.ctx)).toEqual([]);
        } finally {
            await fixture.close();
        }
    });

    it("still rejects a project with no registered credential", async () => {
        const fixture = await createFixture();
        try {
            await expect(
                fixture.workspaces.createWorkspace(fixture.ctx, fixture.project.id, {
                    name: "child",
                }),
            ).rejects.toThrow("GitHub credentials are unavailable for this workspace.");
            expect(await fixture.workspaces.list(fixture.ctx)).toEqual([]);
        } finally {
            await fixture.close();
        }
    });

    it("restores the local owner's missing registration from configuration", async () => {
        const fixture = await createFixture("configured-fixture-token");
        try {
            const credential = fixture.projects.gitCredential(fixture.project.id)!;
            expect(
                fixture.projects.gitAuthentication(fixture.project.id, credential.creator),
            ).toBeUndefined();
            await expect(
                fixture.workspaces.createWorkspace(fixture.ctx, fixture.project.id, {
                    name: "child",
                }),
            ).resolves.toMatchObject({ status: "initializing" });
            expect(
                fixture.projects.gitAuthentication(fixture.project.id, credential.creator),
            ).toBeDefined();
        } finally {
            await fixture.close();
        }
    });

    it("does not replace a recorded remote owner with the local configured credential", async () => {
        const fixture = await createFixture("configured-fixture-token");
        try {
            const local = fixture.projects.gitCredential(fixture.project.id)!.creator;
            const remote = { instanceId: "remote-instance", profileId: "remote-profile" };
            await fixture.projects.registerGitCredential(
                fixture.ctx,
                fixture.project.id,
                remote,
                "remote-fixture-token",
            );
            await expect(
                fixture.workspaces.createWorkspace(
                    fixture.ctx,
                    fixture.project.id,
                    {
                        name: "child",
                    },
                    undefined,
                    { createdBy: local },
                ),
            ).rejects.toThrow("GitHub credentials are unavailable for this workspace.");
            expect(fixture.projects.gitCredential(fixture.project.id)?.creator).toEqual(remote);
            expect(fixture.projects.gitAuthentication(fixture.project.id, local)).toBeUndefined();
            expect(await fixture.workspaces.list(fixture.ctx)).toEqual([]);
        } finally {
            await fixture.close();
        }
    });

    it.each(["instanceId", "profileId"] as const)(
        "does not lend the configured token to a different %s",
        async (field) => {
            const fixture = await createFixture("configured-fixture-token");
            try {
                const credential = fixture.projects.gitCredential(fixture.project.id)!;
                const createdBy = { ...credential.creator, [field]: "another-owner" };
                await expect(
                    fixture.workspaces.createWorkspace(
                        fixture.ctx,
                        fixture.project.id,
                        {
                            name: "child",
                        },
                        undefined,
                        { createdBy },
                    ),
                ).rejects.toThrow("GitHub credentials are unavailable for this workspace.");
                expect(
                    fixture.projects.gitAuthentication(fixture.project.id, createdBy),
                ).toBeUndefined();
                expect(fixture.projects.gitCredential(fixture.project.id)).toEqual(credential);
                expect(await fixture.workspaces.list(fixture.ctx)).toEqual([]);
            } finally {
                await fixture.close();
            }
        },
    );
});

async function createFixture(githubToken?: string) {
    const repository = await createRepository();
    await commitFile(repository, "fixture.txt", "workspace fixture\n");
    const config = await testConfigRootedAt(await createRoot("workspace-credentials-"), undefined, {
        environment: { GITHUB_TOKEN: githubToken, GH_TOKEN: undefined },
    });
    const catalog = workspacesCatalogFrom(config);
    const database = moduleDatabase(
        [...durableFunctionsMigrations, ...projectMigrations, ...workspaceMigrations],
        "workspace-credentials",
    );
    await database.ready;
    const ctx = database.context;
    // Register durable work, but leave execution stopped: these cases prove the reservation
    // boundary. The API gym separately proves that the real checkout finishes.
    catalog.durableFunctions.beforeStart(ctx);
    catalog.projects.beforeStart(ctx, catalog.agents.asRef());
    catalog.workspaces.beforeStart(ctx, catalog.agents.asRef());
    catalog.projects.open("test-instance");
    const project = await catalog.projects.create(ctx, {
        name: "GitHub project",
        repositoryRef: repository,
        remoteSource: { kind: "github", repository: "workspace-gym/fixture" },
        requiredSecretKind: "github",
    });
    await catalog.projects.markCloneReady(ctx, project.id);
    await catalog.projects.probe(ctx, project.id);
    await catalog.projects.markInitializationReady(ctx, project.id);
    return {
        ...catalog,
        ctx,
        project,
        close: async () => {
            catalog.durableFunctions.stop();
            await catalog.workspaces.close(ctx);
            catalog.git.dispose();
            database.close();
        },
    };
}
