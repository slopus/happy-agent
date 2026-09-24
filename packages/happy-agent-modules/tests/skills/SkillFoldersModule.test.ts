import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentModuleScope, AnyAgentTool } from "@slopus/happy-agent-base";
import { Value } from "@sinclair/typebox/value";
import { createRootContext, type Context } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BotsModule } from "../../sources/bots/index.js";
import { ConfigModule, parseHappyAgentConfigToml } from "../../sources/config/index.js";
import { SkillFoldersModule, SkillsModule } from "../../sources/skills/index.js";
import { FakeCompute } from "../compute/support/FakeCompute.js";
import { scriptedComputeModule } from "../support/computeModule.js";
import { testConfigRootedAt } from "../support/configModule.js";

const ctx = createRootContext().named("skill-folders-test");
const roots: string[] = [];

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("SkillFoldersModule", () => {
    it("shows its tools only to active admin bots and rechecks authorization on execution", async () => {
        const fixture = await createFixture();
        await expect(fixture.toolNames("admin-agent")).resolves.toEqual([
            "list_skill_folders",
            "add_skill_folder",
            "remove_skill_folder",
        ]);
        await expect(fixture.toolNames("ordinary-agent")).resolves.toEqual([]);
        await expect(fixture.toolNames("archived-admin-agent")).resolves.toEqual([]);
        await expect(fixture.toolNames("human-agent")).resolves.toEqual([]);

        await expect(fixture.module.add(ctx, "ordinary-agent", fixture.folder)).rejects.toThrow(
            "Only an active admin bot can manage this installation's skill folders.",
        );
        await expect(fixture.module.list(ctx, "human-agent")).rejects.toThrow(
            "Only an active admin bot can manage this installation's skill folders.",
        );
    });

    it("declares reviewed installation-wide writes and a local read", async () => {
        const fixture = await createFixture();
        const list = await fixture.tool("list_skill_folders");
        const add = await fixture.tool("add_skill_folder");
        const remove = await fixture.tool("remove_skill_folder");
        expect(list.shouldReviewInAutoMode?.({} as never, {} as never)).toBe(false);
        expect(list.requiresAutoOrFullAccess).toBeFalsy();
        for (const tool of [add, remove]) {
            expect(tool.durable).toBe(true);
            expect(tool.requiresAutoOrFullAccess).toBe(true);
            expect(
                tool.shouldReviewInAutoMode?.({ path: fixture.folder } as never, {} as never),
            ).toBe(true);
            expect(tool.shouldRunInFullAccessInAutoMode).toBeUndefined();
            expect(
                tool.describeAutoPermissionAction?.({ path: fixture.folder } as never, {} as never),
            ).toContain("installation-wide configuration write");
        }
    });

    it("adds and removes folders in runtime.toml and discovery sees the change live", async () => {
        const fixture = await createFixture();
        const machine = new FakeCompute("/workspace");
        machine.directories.add("/workspace/.git");
        machine.write(
            join(fixture.folder, "lint", "SKILL.md"),
            "---\nname: lint\ndescription: Lint the code.\n---\n\nLint instructions.",
        );
        const compute = scriptedComputeModule(async () => machine);
        vi.spyOn(compute, "fileSystemIdentity").mockReturnValue("native-test");
        const skills = new SkillsModule(compute, undefined, fixture.config);
        await expect(skills.list(ctx, "admin-agent")).resolves.toEqual({ skills: [] });

        const add = await fixture.tool("add_skill_folder");
        await expect(add.execute(ctx, { path: fixture.folder }, toolCall("add"))).resolves.toEqual({
            path: fixture.folder,
            changed: true,
            folders: [{ path: fixture.folder, source: "runtime" }],
        });
        await expect(skills.list(ctx, "admin-agent")).resolves.toMatchObject({
            skills: [{ name: "lint", location: join(fixture.folder, "lint", "SKILL.md") }],
        });
        expect(await fixture.runtimeDirectories()).toEqual([fixture.folder]);

        // A replayed call after an interruption completes without duplicating the folder.
        await expect(
            add.execute(ctx, { path: fixture.folder }, toolCall("add-again")),
        ).resolves.toMatchObject({ changed: false });
        expect(await fixture.runtimeDirectories()).toEqual([fixture.folder]);

        // The saved folder survives a restart.
        const reloaded = await testConfigRootedAt(fixture.root);
        expect(reloaded.globalSkillDirectories).toEqual([fixture.folder]);

        const remove = await fixture.tool("remove_skill_folder");
        await expect(
            remove.execute(ctx, { path: fixture.folder }, toolCall("remove")),
        ).resolves.toEqual({ path: fixture.folder, changed: true, folders: [] });
        await expect(skills.list(ctx, "admin-agent")).resolves.toEqual({ skills: [] });
        expect(await fixture.runtimeDirectories()).toBeUndefined();
        await expect(
            remove.execute(ctx, { path: fixture.folder }, toolCall("remove-again")),
        ).resolves.toMatchObject({ changed: false });
    });

    it("keeps folders from the user happy.toml and refuses to remove them", async () => {
        const fixture = await createFixture({ userFolder: true });
        await expect(fixture.module.list(ctx, "admin-agent")).resolves.toEqual({
            folders: [{ path: fixture.folder, source: "user" }],
        });
        await expect(fixture.module.add(ctx, "admin-agent", fixture.folder)).resolves.toMatchObject(
            { changed: false },
        );
        await expect(fixture.module.remove(ctx, "admin-agent", fixture.folder)).rejects.toThrow(
            "Only the user can remove it by editing that file.",
        );
        expect(fixture.config.globalSkillDirectories).toEqual([fixture.folder]);
        expect(await fixture.runtimeDirectories()).toBeUndefined();
    });

    it("rejects relative, missing, and non-folder paths", async () => {
        const fixture = await createFixture();
        await expect(fixture.module.add(ctx, "admin-agent", "skills")).rejects.toThrow(
            "A skill folder must be an absolute path.",
        );
        await expect(
            fixture.module.add(ctx, "admin-agent", join(fixture.root, "missing")),
        ).rejects.toThrow("does not exist");
        const file = join(fixture.root, "file.txt");
        await writeFile(file, "not a folder");
        await expect(fixture.module.add(ctx, "admin-agent", file)).rejects.toThrow(
            "is not a folder",
        );
        expect(fixture.config.globalSkillDirectories).toEqual([]);
    });

    it("rejects ~/ paths instead of resolving them against a home", async () => {
        const fixture = await createFixture();
        for (const path of ["~/team-skills", "~", "./skills", "../skills"]) {
            await expect(fixture.module.add(ctx, "admin-agent", path)).rejects.toThrow(
                "A skill folder must be an absolute path.",
            );
            await expect(fixture.module.remove(ctx, "admin-agent", path)).rejects.toThrow(
                "A skill folder must be an absolute path.",
            );
        }
        const add = await fixture.tool("add_skill_folder");
        expect(Value.Check(add.parameters, { path: "~/team-skills" })).toBe(false);
        expect(Value.Check(add.parameters, { path: fixture.folder })).toBe(true);
        expect(fixture.config.globalSkillDirectories).toEqual([]);
    });
});

async function createFixture(options: { userFolder?: boolean } = {}) {
    const root = await mkdtemp(join(tmpdir(), "happy-skill-folders-"));
    roots.push(root);
    const home = join(root, "home");
    const folder = join(home, "team-skills");
    await mkdir(folder, { recursive: true });
    const config: ConfigModule = await testConfigRootedAt(
        root,
        options.userFolder === true ? `[skills]\ndirectories = ["${folder}"]\n` : undefined,
        { environment: { HOME: home } },
    );
    const bots = {
        forAgent: vi.fn(async (_ctx: Context, agentId: string) => {
            if (agentId === "admin-agent") return { isAdmin: true, status: "active" };
            if (agentId === "ordinary-agent") return { isAdmin: false, status: "active" };
            if (agentId === "archived-admin-agent") return { isAdmin: true, status: "archived" };
            return undefined;
        }),
    } as unknown as BotsModule;
    const module = new SkillFoldersModule(config, bots);
    const hooks = module.beforeStart();
    const toolsFor = async (agentId: string): Promise<readonly AnyAgentTool[]> =>
        (await hooks.tools?.(ctx, { agent: { id: agentId } } as unknown as AgentModuleScope)) ?? [];
    return {
        config,
        folder,
        module,
        root,
        runtimeDirectories: async () =>
            parseHappyAgentConfigToml(
                await readFile(config.configuration.paths.runtimeConfigPath, "utf8").catch(
                    () => "",
                ),
            ).values.skills?.directories,
        tool: async (name: string): Promise<AnyAgentTool> => {
            const tool = (await toolsFor("admin-agent")).find((item) => item.name === name);
            if (tool === undefined) throw new Error(`The ${name} tool is missing.`);
            return tool;
        },
        toolNames: async (agentId: string) => (await toolsFor(agentId)).map((tool) => tool.name),
    };
}

function toolCall(id: string): never {
    return {
        id,
        kv: {
            getOrCreate: async (_ctx: Context, _key: string, create: () => unknown) =>
                await create(),
        },
        commit: async (_ctx: Context, result: unknown) => result,
    } as never;
}
