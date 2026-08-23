import { sql } from "drizzle-orm";
import { Value } from "@sinclair/typebox/value";
import { agentDatabaseRun } from "@slopus/happy-agent-base";
import { withAfterCommit, type Context } from "@steve.kite/stdlib";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { GitModule } from "../../sources/git/index.js";
import {
    MAX_PROJECT_AVATAR_BYTES,
    MAX_PROJECT_REPOSITORY_REF_LENGTH,
    projectByIdInputSchema,
    projectCreateInputSchema,
    projectIdSchema,
    projectMigrations,
    projectRemoteSourceSchema,
    projectSchema,
    projectSettingsSchema,
    projectStateChangeReasonSchema,
    ProjectsModule,
} from "../../sources/projects/index.js";
import {
    PROJECTS_TABLE,
    PROJECT_SETTINGS_TABLE,
} from "../../sources/projects/ProjectMigrations.js";
import { temporaryTestConfig } from "../support/configModule.js";
import { moduleDatabase } from "../support/moduleDatabase.js";
import { projectsModuleFor } from "../support/projectsModule.js";

describe("ProjectsModule edge cases", () => {
    it("preserves the documented singleton home-project invariant", async () => {
        const database = await migratedProjectDatabase("projects-home-singleton-edge");
        try {
            const projects = await projectsModule();
            await projects.ensure(database.context, {
                kind: "home",
                repositoryRef: "/Users/person",
            });

            await expect(
                projects.ensure(database.context, {
                    kind: "home",
                    repositoryRef: "/Users/another-person",
                }),
            ).rejects.toThrow(/single home project|home project already exists/i);
        } finally {
            database.close();
        }
    });

    it("treats equivalent settings with different object key order as a no-op", async () => {
        const database = await migratedProjectDatabase("projects-settings-order-edge");
        try {
            const projects = await projectsModule();
            const created = await projects.create(database.context, {
                name: "Settings order",
                repositoryRef: "/tmp/projects/settings-order",
            });
            const first = await projects.updateSettings(database.context, {
                projectId: created.id,
                settings: {
                    defaultWorkspaceCompute: {
                        type: "docker",
                        image: "node:22",
                    },
                },
            });

            const equivalent = await projects.updateSettings(database.context, {
                projectId: created.id,
                settings: {
                    defaultWorkspaceCompute: {
                        image: "node:22",
                        type: "docker",
                    },
                },
            });

            expect(equivalent.changed).toBe(false);
            expect(equivalent.version).toBe(first.version);
            expect(await projects.get(database.context, created.id)).toMatchObject({
                version: first.version,
            });
        } finally {
            database.close();
        }
    });

    it("treats the same normalized avatar bytes as a no-op", async () => {
        const database = await migratedProjectDatabase("projects-avatar-order-edge");
        try {
            const projects = await projectsModule();
            const created = await projects.create(database.context, {
                name: "Avatar order",
                repositoryRef: "/tmp/projects/avatar-order",
            });
            const bytes = await projectAvatarPng(40, 80, 220);
            const first = await projects.setAvatar(database.context, {
                bytes,
                contentType: "image/png",
                projectId: created.id,
                source: "user",
            });

            const second = await projects.setAvatar(database.context, {
                bytes: new Uint8Array(bytes),
                contentType: "image/png",
                projectId: created.id,
                source: "user",
            });

            expect(second.version).toBe(first.version);
            expect(second).toEqual(first);
        } finally {
            database.close();
        }
    });

    it("rejects malformed persisted boolean values instead of coercing them", async () => {
        const database = await migratedProjectDatabase("projects-malformed-boolean-edge");
        try {
            const projects = await projectsModule();
            const created = await projects.create(database.context, {
                name: "Malformed boolean",
                repositoryRef: "/tmp/projects/malformed-boolean",
            });
            await agentDatabaseRun(
                database.database,
                sql`UPDATE ${sql.raw(PROJECTS_TABLE)}
                    SET git_detached = 2
                    WHERE id = ${created.id}`,
            );

            await expect(projects.get(database.context, created.id)).rejects.toThrow(
                /invalid project|storage/i,
            );
        } finally {
            database.close();
        }
    });

    it("keeps a legal maximum-length folder actionable at the minimum output budget", async () => {
        const database = await migratedProjectDatabase("projects-min-output-path-edge");
        try {
            const projects = await projectsModule();
            const repositoryRef = `/${"x".repeat(MAX_PROJECT_REPOSITORY_REF_LENGTH - 1)}`;
            await projects.create(database.context, {
                name: "Long folder",
                repositoryRef,
            });

            const page = await projects.list(database.context, { limit: 1 });
            expect(page.projects).toHaveLength(1);
            expect(projects.formatPageForModel(page)).toContain("Project ID:");
        } finally {
            database.close();
        }
    });

    it("accepts expected-version guards on archival and restoration inputs", () => {
        expect(Value.Check(projectByIdInputSchema, { projectId: "project-1" })).toBe(true);
        expect(
            Value.Check(projectByIdInputSchema, {
                expectedVersion: 1,
                projectId: "project-1",
            }),
        ).toBe(true);
    });

    it("does not require compute when a resolved remote name cannot apply", async () => {
        const database = await migratedProjectDatabase("projects-remote-name-no-compute-edge");
        try {
            const projects = await projectsModule();
            const created = await projects.create(database.context, {
                name: "Chosen name",
                repositoryRef: "/tmp/projects/user-name",
            });
            const renamed = await projects.rename(database.context, {
                name: "Person chosen",
                projectId: created.id,
            });

            await expect(projects.resolveRemoteName(database.context, created.id)).resolves.toEqual(
                renamed,
            );
        } finally {
            database.close();
        }
    });

    it("publishes one frozen event after the outer transaction commits", async () => {
        const transactional: object[] = [];
        const postCommit: object[] = [];
        const projects = await projectsModule();
        projects.onEventTransactional((_ctx, event) => {
            transactional.push(event);
            expect(Object.isFrozen(event)).toBe(true);
            if ("project" in event) expect(Object.isFrozen(event.project)).toBe(true);
        });
        projects.onEvent((_ctx, event) => {
            postCommit.push(event);
        });
        const database = await migratedProjectDatabase("projects-event-boundary-edge");
        try {
            const [outerContext, drain] = withAfterCommit(database.context);
            await projects.create(outerContext, {
                name: "Event boundary",
                repositoryRef: "/tmp/projects/event-boundary",
            });
            expect(transactional).toHaveLength(1);
            expect(postCommit).toHaveLength(0);

            await drain();
            expect(postCommit).toHaveLength(1);
            expect(postCommit[0]).toBe(transactional[0]);
        } finally {
            database.close();
        }
    });

    it("rolls back durable state when a transactional subscriber rejects", async () => {
        const projects = await projectsModule();
        projects.onEventTransactional(() => {
            throw new Error("reject project mutation");
        });
        const database = await migratedProjectDatabase("projects-listener-rollback-edge");
        try {
            await expect(
                projects.create(database.context, {
                    name: "Rolled back",
                    repositoryRef: "/tmp/projects/listener-rollback",
                }),
            ).rejects.toThrow("reject project mutation");
            await expect(
                projects.getByPath(database.context, "/tmp/projects/listener-rollback"),
            ).resolves.toBeUndefined();
        } finally {
            database.close();
        }
    });

    it("contains a hostile post-commit subscriber failure", async () => {
        const hostile = {
            [Symbol.toPrimitive](): never {
                throw new Error("cannot stringify observer failure");
            },
        };
        const projects = await projectsModule();
        projects.onEvent(() => {
            throw hostile;
        });
        const database = await migratedProjectDatabase("projects-post-commit-hostile-edge");
        try {
            // The change is already durable, so a subscriber that fails — even one whose failure
            // cannot be turned into text — reaches the log rather than the caller.
            await expect(
                projects.create(database.context, {
                    name: "Post commit",
                    repositoryRef: "/tmp/projects/post-commit-hostile",
                }),
            ).resolves.toMatchObject({ name: "Post commit" });
            await expect(
                projects.getByPath(database.context, "/tmp/projects/post-commit-hostile"),
            ).resolves.toMatchObject({ name: "Post commit" });
        } finally {
            database.close();
        }
    });

    it("keeps a subscriber taken from a class bound to the object that owns it", async () => {
        class Watcher {
            readonly #seen: string[] = [];

            observe = (_ctx: Context, event: { readonly type: string }): void => {
                this.#seen.push(event.type);
            };

            get seen(): readonly string[] {
                return this.#seen;
            }
        }
        const watcher = new Watcher();
        const projects = await projectsModule();
        projects.onEventTransactional(watcher.observe);
        const database = await migratedProjectDatabase("projects-class-listener-edge");
        try {
            await projects.create(database.context, {
                name: "Class listener",
                repositoryRef: "/tmp/projects/class-listener",
            });
            expect(watcher.seen).toEqual(["project_created"]);
        } finally {
            database.close();
        }
    });

    it("stops telling a subscriber that has unsubscribed", async () => {
        const seen: string[] = [];
        const projects = await projectsModule();
        const stop = projects.onEventTransactional((_ctx, event) => {
            seen.push(event.type);
        });
        const database = await migratedProjectDatabase("projects-unsubscribe-edge");
        try {
            const created = await projects.create(database.context, {
                name: "Watched",
                repositoryRef: "/tmp/projects/watched",
            });
            stop();
            await projects.rename(database.context, {
                name: "Renamed unwatched",
                projectId: created.id,
            });
            expect(seen).toEqual(["project_created"]);
        } finally {
            database.close();
        }
    });

    it("mints its own identities rather than taking them from a caller", async () => {
        const projects = await projectsModule();
        const database = await migratedProjectDatabase("projects-identity-edge");
        try {
            const first = await projects.create(database.context, {
                name: "First",
                repositoryRef: "/tmp/projects/identity-first",
            });
            const second = await projects.create(database.context, {
                name: "Second",
                repositoryRef: "/tmp/projects/identity-second",
            });

            expect(first.id).not.toBe(second.id);
            expect(Value.Check(projectIdSchema, first.id)).toBe(true);
            expect(Value.Check(projectIdSchema, second.id)).toBe(true);
        } finally {
            database.close();
        }
    });

    it("returns an empty settings object when its companion row is absent", async () => {
        const database = await migratedProjectDatabase("projects-missing-settings-edge");
        try {
            const projects = await projectsModule();
            const created = await projects.create(database.context, {
                name: "Missing settings",
                repositoryRef: "/tmp/projects/missing-settings",
            });
            await agentDatabaseRun(
                database.database,
                sql`DELETE FROM ${sql.raw(PROJECT_SETTINGS_TABLE)}
                    WHERE project_id = ${created.id}`,
            );

            await expect(projects.readSettings(database.context, created.id)).resolves.toEqual({});
        } finally {
            database.close();
        }
    });

    it("rejects malformed persisted settings JSON", async () => {
        const database = await migratedProjectDatabase("projects-malformed-settings-edge");
        try {
            const projects = await projectsModule();
            const created = await projects.create(database.context, {
                name: "Malformed settings",
                repositoryRef: "/tmp/projects/malformed-settings",
            });
            await agentDatabaseRun(
                database.database,
                sql`UPDATE ${sql.raw(PROJECT_SETTINGS_TABLE)}
                    SET settings_json = '{ "not_a_setting": true }'
                    WHERE project_id = ${created.id}`,
            );

            await expect(projects.readSettings(database.context, created.id)).rejects.toThrow(
                /settings/i,
            );
        } finally {
            database.close();
        }
    });

    it("keeps archived rows out of the default list and supports status pages", async () => {
        const database = await migratedProjectDatabase("projects-list-status-edge");
        try {
            let next = 0;
            const projects = await projectsModule();
            const active = await projects.create(database.context, {
                name: "Active",
                repositoryRef: "/tmp/projects/list-active",
            });
            const archived = await projects.create(database.context, {
                name: "Archived",
                repositoryRef: "/tmp/projects/list-archived",
            });
            await projects.archive(database.context, archived.id);

            await expect(projects.list(database.context)).resolves.toMatchObject({
                projects: [{ id: active.id }],
            });
            await expect(
                projects.list(database.context, { status: "archived" }),
            ).resolves.toMatchObject({
                projects: [{ id: archived.id, status: "archived" }],
            });
            await expect(
                projects.list(database.context, { includeArchived: true }),
            ).resolves.toMatchObject({
                projects: [{ id: active.id }, { id: archived.id }],
            });
        } finally {
            database.close();
        }
    });

    it("survives a fresh module instance over the same database", async () => {
        const database = await migratedProjectDatabase("projects-reload-edge");
        try {
            const first = await projectsModule();
            const created = await first.create(database.context, {
                name: "Reloaded",
                repositoryRef: "/tmp/projects/reloaded",
            });
            const second = await projectsModule();
            await expect(second.get(database.context, created.id)).resolves.toEqual(created);
            await expect(second.readSettings(database.context, created.id)).resolves.toEqual({});
        } finally {
            database.close();
        }
    });

    it("validates bounded public schemas at their dangerous edges", () => {
        expect(
            Value.Check(projectCreateInputSchema, {
                name: "Project",
                repositoryRef: "/tmp/project",
            }),
        ).toBe(true);
        expect(
            Value.Check(projectCreateInputSchema, {
                name: "Project",
                repositoryRef: `/tmp/${"x".repeat(MAX_PROJECT_REPOSITORY_REF_LENGTH)}`,
            }),
        ).toBe(false);
        expect(
            Value.Check(projectSchema, {
                id: "project",
                repositoryRef: "/tmp/project",
                kind: "regular",
                storageKey: "project",
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
                avatar: {
                    kind: "image",
                    source: "user",
                    thumbhash: "abcd",
                },
            }),
        ).toBe(true);
        expect(
            Value.Check(projectSettingsSchema, {
                defaultWorkspaceCompute: {
                    type: "docker",
                    image: `node:${"x".repeat(507)}`,
                },
            }),
        ).toBe(true);
        expect(
            Value.Check(projectSettingsSchema, {
                defaultWorkspaceCompute: {
                    type: "docker",
                    image: `node:${"x".repeat(508)}`,
                },
            }),
        ).toBe(false);
        expect(MAX_PROJECT_AVATAR_BYTES).toBe(8 * 1024 * 1024);
        expect(
            Value.Check(projectRemoteSourceSchema, {
                kind: "git",
                url: "https://github.com:bad/repo",
            }),
        ).toBe(false);
        expect(Value.Check(projectStateChangeReasonSchema, "probe")).toBe(true);
    });
});

/**
 * The catalog as the product builds it: configuration rooted in a folder this test owns, and Git
 * itself. Identities, event identities and timestamps are the module's own, so nothing here
 * asserts on them.
 */
async function projectsModule(toml?: string): Promise<ProjectsModule> {
    return projectsModuleFor(await temporaryTestConfig(toml), new GitModule());
}

async function migratedProjectDatabase(name: string) {
    const database = moduleDatabase([], name);
    for (const [, migrate] of projectMigrations) {
        await migrate(database.context, database.database);
    }
    return database;
}

async function projectAvatarPng(red: number, green: number, blue: number): Promise<Buffer> {
    return await sharp({
        create: {
            background: { alpha: 1, b: blue, g: green, r: red },
            channels: 4,
            height: 48,
            width: 64,
        },
    })
        .png()
        .toBuffer();
}
