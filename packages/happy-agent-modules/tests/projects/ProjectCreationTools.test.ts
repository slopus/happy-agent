import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Value } from "@sinclair/typebox/value";
import { afterEach, describe, expect, it } from "vitest";

import { durableFunctionsMigrations } from "../../sources/durableFunctions/index.js";
import { projectMigrations } from "../../sources/projects/index.js";
import { cloneProjectTool, createProjectTool } from "../../sources/projects/tools/index.js";
import { testConfigRootedAt } from "../support/configModule.js";
import { moduleDatabase } from "../support/moduleDatabase.js";
import { projectsModuleFor } from "../support/projectsModule.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "project-creation-tools-"));
    cleanups.push(() => rm(root, { force: true, recursive: true }));
    const config = await testConfigRootedAt(root);
    const projects = projectsModuleFor(config);
    projects.open("test-installation");
    const database = moduleDatabase(
        [...projectMigrations, ...durableFunctionsMigrations],
        "project-creation-tools",
    );
    cleanups.push(async () => database.close());
    await database.ready;
    return { root, projects, ctx: database.context, config };
}

/** The invocation's identity store survives tool reconstruction, as on replay. */
function invocation() {
    const values = new Map<string, string>();
    return {
        id: "project-creation-call",
        kv: {
            getOrCreate: async (_ctx: unknown, key: string, create: () => string) => {
                if (!values.has(key)) values.set(key, create());
                return values.get(key)!;
            },
        },
    } as unknown as Parameters<ReturnType<typeof createProjectTool>["execute"]>[2];
}

describe("project creation tools", () => {
    it("registers a plain folder once across replay and canonical aliases", async () => {
        const { ctx, root, projects } = await fixture();
        const path = join(root, "local-project");
        const alias = join(root, "alias");
        await mkdir(path);
        await symlink(path, alias);
        const call = invocation();
        const first = await createProjectTool(projects).execute(ctx, { path }, call);
        const replay = await createProjectTool(projects).execute(ctx, { path }, call);
        const existing = await createProjectTool(projects).execute(
            ctx,
            { path: alias },
            invocation(),
        );
        expect(replay).toEqual(first);
        expect(existing.id).toBe(first.id);
        expect(first).toMatchObject({
            name: "local-project",
            initializationStatus: "initializing",
        });
        expect((await projects.list(ctx)).projects).toHaveLength(1);
        expect(createProjectTool(projects).toLLM!(first)).toEqual([
            expect.objectContaining({ text: expect.stringContaining(first.id) }),
        ]);
    });

    it("rejects missing local folders without creating catalog entries", async () => {
        const { ctx, root, projects } = await fixture();
        await expect(
            createProjectTool(projects).execute(ctx, { path: join(root, "missing") }, invocation()),
        ).rejects.toThrow();
        expect((await projects.list(ctx)).projects).toEqual([]);
    });

    it.each([
        { kind: "github" as const, repository: "slopus/happy-agent" },
        { kind: "git" as const, url: "https://gitlab.com/example/project.git" },
    ])("reserves one durable clone for $kind across module restart", async (source) => {
        const { ctx, config, projects } = await fixture();
        const input = { name: "imported-project", source };
        const call = invocation();
        const first = await cloneProjectTool(projects).execute(ctx, input, call);
        expect(first).toMatchObject({
            remoteSource: source,
            presence: "missing",
            initializationStatus: "initializing",
        });
        const reopened = projectsModuleFor(config);
        reopened.open("test-installation");
        const replay = await cloneProjectTool(reopened).execute(ctx, input, call);
        expect(replay.id).toBe(first.id);
        expect((await reopened.list(ctx)).projects).toHaveLength(1);
        await expect(cloneProjectTool(reopened).execute(ctx, input, invocation())).rejects.toThrow(
            "already belongs to another project",
        );
        expect(cloneProjectTool(projects).toLLM!(first)).toEqual([
            expect.objectContaining({ text: expect.stringContaining("Still being set up") }),
        ]);
    });

    it("selects stored GitHub credentials without accepting secret material", async () => {
        const { ctx, projects } = await fixture();
        const tool = cloneProjectTool(projects);
        const input = {
            name: "private-project",
            source: { kind: "github" as const, repository: "example/private" },
            secret: { kind: "github" as const },
        };
        expect(Value.Check(tool.parameters!, input)).toBe(true);
        const project = await tool.execute(ctx, input, invocation());
        expect(project.requiredSecretKind).toBe("github");
        expect(
            Value.Check(tool.parameters!, { ...input, secret: { kind: "github", token: "no" } }),
        ).toBe(false);
        await expect(
            tool.execute(
                ctx,
                { ...input, source: { kind: "git", url: "https://example.com/repo" } },
                invocation(),
            ),
        ).rejects.toThrow("GitHub credentials can only be used with a GitHub repository");
    });

    it("rejects unsupported remotes, embedded credentials, and caller-owned IDs", async () => {
        const { projects } = await fixture();
        const tool = cloneProjectTool(projects);
        for (const url of [
            "git@github.com:owner/repo.git",
            "file:///tmp/repo",
            "http://example.com/repo",
            "https://user:token@example.com/repo",
        ]) {
            expect(
                Value.Check(tool.parameters!, { name: "repo", source: { kind: "git", url } }),
            ).toBe(false);
        }
        expect(
            Value.Check(tool.parameters!, {
                name: "repo",
                source: { kind: "github", repository: "owner/repo" },
                projectId: "chosen",
            }),
        ).toBe(false);
        expect(
            Value.Check(createProjectTool(projects).parameters!, { path: "relative/folder" }),
        ).toBe(false);
    });

    it("owns review, elevation, and external-boundary disclosure on the real tools", async () => {
        const { projects } = await fixture();
        const local = createProjectTool(projects);
        const remote = cloneProjectTool(projects);
        for (const tool of [local, remote]) {
            expect(tool.durable).toBe(true);
            expect(tool.requiresAutoOrFullAccess).toBe(true);
            expect(tool.shouldReviewInAutoMode!({} as never, {} as never)).toBe(true);
            expect(tool.shouldRunInFullAccessInAutoMode!({} as never, {} as never)).toBe(true);
        }
        expect(
            local.describeAutoPermissionAction!({ path: "/outside/project" }, {} as never),
        ).toContain("/outside/project");
        const description = remote.describeAutoPermissionAction!(
            {
                name: "private-project",
                source: { kind: "github", repository: "owner/private" },
                secret: { kind: "github" },
            },
            {} as never,
        );
        expect(description).toContain("https://github.com/owner/private");
        expect(description).toContain("configured GitHub credential");
        expect(description).toContain("outside the current workspace");
    });
});
