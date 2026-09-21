import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { durableFunctionsMigrations } from "../../sources/durableFunctions/index.js";
import { GitModule } from "../../sources/git/index.js";
import { projectMigrations } from "../../sources/projects/index.js";
import { cloneProjectTool } from "../../sources/projects/tools/clone_project.js";
import { testConfigRootedAt } from "../support/configModule.js";
import { moduleDatabase } from "../support/moduleDatabase.js";
import { projectsCatalogFor } from "../support/projectsModule.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    vi.restoreAllMocks();
});
const request = {
    name: "private-project",
    source: { kind: "github" as const, repository: "fixture/private" },
    secret: { kind: "github" as const },
};

describe.skipIf(process.platform === "win32")(
    "GitHub CLI import credentials (POSIX executable fixtures)",
    () => {
        it("registers the standalone owner's CLI login through clone_project without exposing it", async () => {
            const { projects, ctx } = await fixture();
            const tool = cloneProjectTool(projects);
            const call = {
                kv: {
                    getOrCreate: async (_ctx: unknown, _key: string, create: () => string) =>
                        create(),
                },
            } as unknown as Parameters<typeof tool.execute>[2];
            const project = await tool.execute(ctx, request, call);
            const owner = projects.gitCredential(project.id)!.creator;
            expect(projects.gitAuthentication(project.id, owner)).toBeDefined();
            expect(JSON.stringify([project, tool.toLLM!(project)])).not.toContain(
                "fixture-cli-token",
            );
        });

        it.each([
            { instanceId: "local-installation", profileId: "another-profile" },
            { instanceId: "remote-installation", profileId: "local" },
        ])("does not discover a CLI credential for a different creator: %j", async (createdBy) => {
            const { projects, ctx, root } = await fixture();
            const project = await projects.createRemote(ctx, request, { createdBy });
            expect(projects.gitAuthentication(project.id, createdBy)).toBeUndefined();
            await expect(access(join(root, "invoked"))).rejects.toMatchObject({ code: "ENOENT" });
        });

        it("keeps the credentials-unavailable error when the CLI has no login", async () => {
            const { projects, ctx, start } = await fixture("exit 1");
            const project = await projects.createRemote(ctx, request);
            await start();
            await vi.waitFor(async () => {
                expect(await projects.get(ctx, project.id)).toMatchObject({
                    initializationStatus: "failed",
                    initializationError: expect.stringContaining(
                        "GitHub credentials are unavailable",
                    ),
                });
            });
        });

        it("uses a pinned host, home cwd and restricted environment", async () => {
            const { config } = await fixture(
                `
test "$*" = 'auth token --hostname github.com' || exit 1
test "$PWD" -ef "$HOME" || exit 1
test "$PATH" = "$HOME/.local/bin" || exit 1
test "$GH_PROMPT_DISABLED" = 1 || exit 1
test -z "$GH_DEBUG$GIT_CONFIG_COUNT$NODE_OPTIONS" || exit 1
printf 'fixture-cli-token\\n'`,
                { GH_DEBUG: "api", GIT_CONFIG_COUNT: "99", NODE_OPTIONS: "--invalid" },
            );
            await expect(config.resolveGithubTokenForImport()).resolves.toBe("fixture-cli-token");
        });

        it.each([
            ["primary", { GITHUB_TOKEN: "primary", GH_TOKEN: "secondary" }, "primary"],
            ["secondary", { GH_TOKEN: "secondary" }, "secondary"],
            ["blank primary", { GITHUB_TOKEN: " ", GH_TOKEN: "secondary" }, undefined],
            ["blank secondary", { GH_TOKEN: "" }, undefined],
            [
                "invalid primary",
                { GITHUB_TOKEN: "bad\u0000token", GH_TOKEN: "secondary" },
                undefined,
            ],
            ["oversized secondary", { GH_TOKEN: "x".repeat(16_385) }, undefined],
        ] as const)(
            "honors an explicit %s token without CLI fallback",
            async (_label, environment, expected) => {
                const { config, root } = await fixture(undefined, environment);
                await expect(config.resolveGithubTokenForImport()).resolves.toBe(expected);
                await expect(access(join(root, "invoked"))).rejects.toMatchObject({
                    code: "ENOENT",
                });
            },
        );

        it.each([
            [
                "command failure",
                "printf fixture-private-token; printf fixture-private-token >&2; exit 1",
            ],
            ["empty output", "exit 0"],
            ["control characters", "printf 'fixture\\001token\\n'"],
            ["extra newline", "printf 'fixture-token\\n\\n'"],
            ["oversized output", 'i=0; while [ "$i" -lt 20000 ]; do printf x; i=$((i+1)); done'],
            ["timeout", "exec /bin/sleep 20"],
        ])("silently fails closed on %s", async (_label, script) => {
            const { config } = await fixture(script);
            await expect(config.resolveGithubTokenForImport()).resolves.toBeUndefined();
        });

        it("does not select a missing CLI or repository-local executable", async () => {
            const { config, root, bin } = await fixture();
            await rm(join(bin, "gh"));
            await expect(config.resolveGithubTokenForImport()).resolves.toBeUndefined();
            const repositoryBin = join(root, "bin");
            await mkdir(repositoryBin);
            await writeFile(
                join(repositoryBin, "gh"),
                '#!/bin/sh\nprintf unsafe > "$HOME/invoked"\n',
                { mode: 0o755 },
            );
            const untrusted = await testConfigRootedAt(root, undefined, {
                environment: {
                    HOME: root,
                    PATH: `bin:${repositoryBin}`,
                    GITHUB_TOKEN: undefined,
                    GH_TOKEN: undefined,
                },
            });
            await expect(untrusted.resolveGithubTokenForImport()).resolves.toBeUndefined();
            await expect(access(join(root, "invoked"))).rejects.toMatchObject({ code: "ENOENT" });
        });

        it("does not discover the host login in team mode", async () => {
            const { projects, ctx, root } = await fixture(
                undefined,
                {},
                '[feature.team]\nenabled = true\nworkos_organization_id = "org_test"\nowner_workos_user_id = "user_test"\n',
            );
            const project = await projects.createRemote(ctx, request);
            expect(
                projects.gitAuthentication(project.id, projects.gitCredential(project.id)!.creator),
            ).toBeUndefined();
            await expect(access(join(root, "invoked"))).rejects.toMatchObject({ code: "ENOENT" });
        });

        it("does not rediscover a CLI credential during background recovery after restart", async () => {
            const { projects, ctx, config, root } = await fixture();
            const project = await projects.createRemote(ctx, request);
            const git = new GitModule();
            cleanups.push(() => git.dispose());
            const reopened = projectsCatalogFor(config, git).projects;
            reopened.open("local-installation");
            const owner = reopened.gitCredential(project.id)!.creator;
            await expect(
                reopened.ensureGitAuthentication(ctx, project.id, owner),
            ).resolves.toBeUndefined();
            await reopened.retryRemoteProjects(ctx, "github");
            expect(reopened.gitAuthentication(project.id, owner)).toBeUndefined();
            expect(await readFile(join(root, "invoked"), "utf8")).toBe("called");
        });
    },
);

async function fixture(
    script = "printf 'fixture-cli-token\\n'",
    environment: NodeJS.ProcessEnv = {},
    toml?: string,
) {
    const root = await mkdtemp(join(tmpdir(), "github-cli-credential-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const bin = join(root, ".local", "bin");
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, "gh"), `#!/bin/sh\nprintf called >> "$HOME/invoked"\n${script}\n`, {
        mode: 0o755,
    });
    const config = await testConfigRootedAt(root, toml, {
        environment: {
            HOME: root,
            PATH: bin,
            GITHUB_TOKEN: undefined,
            GH_TOKEN: undefined,
            ...environment,
        },
    });
    const git = new GitModule();
    cleanups.push(() => git.dispose());
    vi.spyOn(git, "localIdentity").mockResolvedValue(undefined);
    const database = moduleDatabase(
        [...projectMigrations, ...durableFunctionsMigrations],
        "github-cli-credential",
    );
    cleanups.push(database.close);
    await database.ready;
    const ctx = database.context;
    const { projects, durableFunctions, agents } = projectsCatalogFor(config, git);
    const hooks = durableFunctions.beforeStart(ctx);
    projects.beforeStart(ctx, agents.asRef());
    projects.open("local-installation");
    cleanups.push(() => durableFunctions.stop());
    return {
        projects,
        ctx,
        root,
        bin,
        config,
        start: async () => hooks.afterStart?.(ctx, agents.asRef()),
    };
}
