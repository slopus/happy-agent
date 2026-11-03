import {
    chmod,
    lstat,
    mkdir,
    mkdtemp,
    readdir,
    readFile,
    rm,
    stat,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureAgentDatabaseConnection } from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConfigModule } from "../../sources/config/index.js";
import type { DurableFunctionsModule } from "../../sources/durableFunctions/index.js";
import { GlobalSkillsModule } from "../../sources/skills/GlobalSkillsModule.js";
import { SkillMirrorModule } from "../../sources/skills/SkillMirrorModule.js";
import { connectedRunner } from "../support/connectedRunner.js";
import { moduleDatabase } from "../support/moduleDatabase.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const document = (name: string) =>
    `---\nname: ${name}\ndescription: The ${name} skill.\n---\nFollow the steps.\n`;

describe("skills copied to a runner", { timeout: 30_000 }, () => {
    it("copies enabled installed and configured skills with their files and executable bits", async () => {
        const world = await mirrorWorld();
        await world.install(world.root, "review", {
            "scripts/run.sh": { content: "#!/bin/sh\necho reviewed\n", executable: true },
            "references/guide.md": { content: "Read the guide.\n" },
        });
        await world.install(world.configured, "deploy");
        world.start();

        const folders = await world.waitForFolders(["deploy", "review"]);
        const review = join(world.synced, folders.review!);
        await expect(readFile(join(review, "SKILL.md"), "utf8")).resolves.toBe(document("review"));
        await expect(readFile(join(review, "references", "guide.md"), "utf8")).resolves.toBe(
            "Read the guide.\n",
        );
        expect((await stat(join(review, "scripts", "run.sh"))).mode & 0o777).toBe(0o555);
        expect((await stat(join(review, "SKILL.md"))).mode & 0o777).toBe(0o444);
    });

    it("sends only changed skills, and removes deleted and disabled ones", async () => {
        const world = await mirrorWorld();
        await world.install(world.root, "review");
        await world.install(world.root, "lint");
        await world.install(world.configured, "deploy");
        world.start();
        const before = await world.waitForFolders(["deploy", "lint", "review"]);
        const untouched = (await lstat(join(world.synced, before.deploy!))).ino;

        // An edit gives the skill a new folder; the others stay exactly where they were.
        await writeFile(join(world.root, "review", "SKILL.md"), `${document("review")}More.\n`);
        await world.globalSkills.list(world.ctx);
        const after = await world.waitForFolders(["deploy", "lint", "review"], (folders) =>
            folders.review !== before.review ? folders : undefined,
        );
        expect(after.deploy).toBe(before.deploy);
        expect((await lstat(join(world.synced, before.deploy!))).ino).toBe(untouched);

        // A disabled installed skill and a deleted configured one leave the runner.
        await rm(join(world.configured, "deploy"), { recursive: true });
        const lint = (await world.globalSkills.list(world.ctx)).skills.find(
            (skill) => skill.name === "lint",
        )!;
        await world.globalSkills.setEnabled(world.ctx, lint.id, false, lint.version);
        await world.waitForFolders(["review"]);
    });

    it("leaves out a skill past the bounds and copies the rest", async () => {
        const world = await mirrorWorld();
        await world.install(world.root, "huge", {
            "data.bin": { content: "x".repeat(8 * 1024 * 1024 + 1) },
        });
        await world.install(world.root, "small");
        world.start();

        await world.waitForFolders(["small"]);
    });

    it("cleans up what an interrupted sync left, and restores a copy the runner lost", async () => {
        const world = await mirrorWorld();
        await world.install(world.root, "review");
        await mkdir(join(world.synced, ".partial-review-0123456789abcdef"), { recursive: true });
        await mkdir(join(world.synced, "stale-folder"), { recursive: true });
        world.start();
        const first = await world.waitForFolders(["review"]);
        expect(await readdir(world.synced)).toEqual([first.review]);

        // The runner comes back without its copy, as after a reinstall.
        world.runner.disconnect();
        await rm(world.synced, { recursive: true, force: true });
        await world.runner.connect();
        await world.waitForFolders(["review"]);
    });

    it("copies the documentation and native skills, rewriting them only when they change", async () => {
        const world = await mirrorWorld();
        const { docsHome, skillsHome } = world.product;
        await mkdir(join(docsHome, "recipe"), { recursive: true });
        await writeFile(join(docsHome, "README.md"), "Read me.\n");
        await writeFile(join(docsHome, "recipe", "add-runner.md"), "Add a runner.\n");
        await world.install(skillsHome, "guided-review");
        world.optOut();
        world.start();

        const docs = join(world.runner.home, ".happy-agent", "docs");
        const skills = join(world.runner.home, ".happy-agent", "skills");
        await vi.waitFor(
            async () => {
                await expect(readFile(join(docs, "recipe", "add-runner.md"), "utf8")).resolves.toBe(
                    "Add a runner.\n",
                );
                await expect(
                    readFile(join(skills, "guided-review", "SKILL.md"), "utf8"),
                ).resolves.toBe(document("guided-review"));
            },
            { timeout: 10_000, interval: 50 },
        );
        const before = (await lstat(join(docs, "README.md"))).ino;

        // A recheck with nothing changed leaves the copy alone; a change replaces it.
        await world.globalSkills.list(world.ctx);
        world.runner.disconnect();
        await world.runner.connect();
        await new Promise((resolve) => setTimeout(resolve, 600));
        expect((await lstat(join(docs, "README.md"))).ino).toBe(before);
        await writeFile(join(docsHome, "README.md"), "Read me again.\n");
        world.runner.disconnect();
        await world.runner.connect();
        await vi.waitFor(
            async () =>
                await expect(readFile(join(docs, "README.md"), "utf8")).resolves.toBe(
                    "Read me again.\n",
                ),
            { timeout: 10_000, interval: 50 },
        );
    });

    it("gives a runner that opted out none of the installation's skills, and removes its copy", async () => {
        const world = await mirrorWorld();
        await world.install(world.root, "review");
        world.start();
        await world.waitForFolders(["review"]);

        world.optOut();
        world.runner.disconnect();
        await world.runner.connect();
        await world.waitForFolders([]);
    });
});

async function mirrorWorld() {
    const home = await mkdtemp(join(tmpdir(), "skill-mirror-"));
    cleanups.push(() => rm(home, { recursive: true, force: true }));
    const root = join(home, ".agents", "skills");
    const configured = join(home, "configured-skills");
    await mkdir(root, { recursive: true });
    await mkdir(configured, { recursive: true });
    const loaded = await ConfigModule.load(join(home, ".happy"), {
        environment: { ...process.env, HOME: home },
    });
    let syncSkills: boolean | undefined;
    const config = new Proxy(loaded, {
        get(target, property) {
            if (property === "globalSkillDirectories") return [configured];
            if (property === "runners") {
                return {
                    entries: {
                        "build-box": {
                            name: "Build box",
                            token: "a".repeat(43),
                            ...(syncSkills === undefined ? {} : { syncSkills }),
                        },
                    },
                };
            }
            // Getters read private fields, so they run against the real module.
            const value = Reflect.get(target, property, target) as unknown;
            return typeof value === "function" ? value.bind(target) : value;
        },
    });

    const runner = await connectedRunner(cleanups);
    const globalDurable = { register: vi.fn(), invoke: vi.fn(async () => ({ status: "created" })) };
    const globalSkills = new GlobalSkillsModule(
        config,
        globalDurable as unknown as DurableFunctionsModule,
    );
    const database = moduleDatabase(globalSkills.migrations, "skill-mirror-test");
    ensureAgentDatabaseConnection(database.database);
    await database.ready;
    cleanups.push(() => database.close());
    cleanups.push(() => globalSkills.close());
    await globalSkills.beforeStart(database.context);

    let executor: ((ctx: Context) => Promise<unknown>) | undefined;
    const mirrorDurable = {
        register: (definition: { executor: (ctx: Context) => Promise<unknown> }) => {
            executor = definition.executor;
        },
        invoke: vi.fn(async () => ({ status: "created" })),
    };
    const mirror = new SkillMirrorModule(
        config,
        runner.runners,
        globalSkills,
        mirrorDurable as unknown as DurableFunctionsModule,
    );
    mirror.beforeStart(database.context);
    cleanups.push(() => mirror.close());
    const synced = join(runner.home, ".happy-agent", "synced-skills");

    return {
        ctx: database.context,
        root,
        configured,
        synced,
        runner,
        globalSkills,
        product: loaded.configuration.paths,
        /** Starts the loop the durable dispatcher would start after daemon startup. */
        start: () => void executor?.(database.context),
        optOut: () => {
            syncSkills = false;
        },
        install: async (
            under: string,
            name: string,
            files: Record<string, { content: string; executable?: boolean }> = {},
        ) => {
            await mkdir(join(under, name), { recursive: true });
            await writeFile(join(under, name, "SKILL.md"), document(name));
            for (const [path, file] of Object.entries(files)) {
                const target = join(under, name, path);
                await mkdir(join(target, ".."), { recursive: true });
                await writeFile(target, file.content);
                if (file.executable === true) await chmod(target, 0o755);
            }
        },
        /** The runner's copy once it holds exactly these skills, as folder names by skill. */
        waitForFolders: async (
            names: readonly string[],
            accept: (folders: Record<string, string>) => Record<string, string> | undefined = (
                folders,
            ) => folders,
        ): Promise<Record<string, string>> =>
            await vi.waitFor(
                async () => {
                    const entries = await readdir(synced).catch(() => [] as string[]);
                    const folders: Record<string, string> = {};
                    for (const entry of entries) {
                        const skill = /^(.+)-[0-9a-f]{16}$/u.exec(entry)?.[1];
                        if (skill === undefined) throw new Error(`Unexpected ${entry}.`);
                        folders[skill] = entry;
                    }
                    expect(Object.keys(folders).sort()).toEqual([...names].sort());
                    const accepted = accept(folders);
                    if (accepted === undefined) throw new Error("Not changed yet.");
                    return accepted;
                },
                { timeout: 10_000, interval: 50 },
            ),
    };
}
