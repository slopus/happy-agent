import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    AgentKV,
    ensureAgentDatabaseConnection,
    withAgentConfig,
    type AgentModuleScope,
} from "@slopus/happy-agent-base";
import { expect, it } from "vitest";
import { ComputeModule } from "../../sources/compute/index.js";
import { SecretsModule } from "../../sources/secrets/index.js";
import { SkillsModule } from "../../sources/skills/index.js";
import { scanGlobalSkills } from "../../sources/skills/impl/scanGlobalSkills.js";
import { collectMirroredSkills } from "../../sources/skills/impl/collectMirroredSkills.js";
import { testConfig } from "../support/computeModule.js";
import { resolveModuleHooks } from "../support/moduleHooks.js";
import { moduleDatabase } from "../support/moduleDatabase.js";
import { InMemoryPersistence } from "../support/InMemoryPersistence.js";

it("discovers, searches and reads all 10,000 flat installations with bounded prompts and repeatable scans", async () => {
    const directory = await mkdtemp(join(tmpdir(), "skill-scale-"));
    const compute = new ComputeModule(testConfig, new SecretsModule());
    const root = join(directory, ".agents", "skills");
    const db = moduleDatabase([], "skill-scale");
    ensureAgentDatabaseConnection(db.database);
    await db.ready;
    const ctx = withAgentConfig(db.context, { modules: { compute: { cwd: directory } } });
    try {
        await mkdir(join(directory, ".git"));
        for (let start = 0; start < 10_000; start += 64) {
            await Promise.all(
                Array.from({ length: Math.min(64, 10_000 - start) }, async (_, offset) => {
                    const index = start + offset;
                    const name = `skill-${String(index).padStart(5, "0")}`;
                    const path = join(root, name);
                    await mkdir(path, { recursive: true });
                    await writeFile(
                        join(path, "SKILL.md"),
                        `---\nname: ${name}\ndescription: Indexed workflow ${index}.\n---\nComplete instructions ${index}.`,
                    );
                }),
            );
        }
        const machine = await compute.resolve(ctx, "scale");
        if (machine === undefined) throw new Error("Expected a native compute.");
        machine.fs.home = join(directory, "empty-home");
        const directoryPage = machine.fs.readdirPage.bind(machine.fs);
        let pages = 0;
        machine.fs.readdirPage = async (...args) => {
            const page = await directoryPage(...args);
            pages++;
            return page;
        };
        const skills = new SkillsModule(compute);
        const start = performance.now();
        expect(await skills.slashCommands(ctx, "scale")).toHaveLength(10_000);
        const discoveryMs = performance.now() - start;
        const searchStart = performance.now();
        const matches = await skills.list(ctx, "scale", { query: "skill-09999", limit: 1 });
        const searchMs = performance.now() - searchStart;
        expect(matches.skills[0]?.name).toBe("skill-09999");
        const readStart = performance.now();
        expect((await skills.read(ctx, "scale", { name: "skill-09999" })).content).toContain(
            "Complete instructions 9999.",
        );
        const readMs = performance.now() - readStart;
        const hooks = await resolveModuleHooks(ctx, skills);
        const store = new InMemoryPersistence();
        const scope: AgentModuleScope = {
            agent: { id: "scale" } as never,
            kv: new AgentKV(store, "agent."),
            runKV: new AgentKV(store, "run."),
            sharedKV: new AgentKV(store, "shared."),
            historyKV: new AgentKV(store, "history."),
        };
        await hooks.messageAcceptedTransact!(ctx, scope, {
            id: "message",
            kind: "send",
            profile: null,
            metadata: { messageOrigin: "user" },
            message: { role: "user", content: [{ type: "text", text: "Start." }] },
        });
        const instructionMs: number[] = [];
        let previous: string | undefined;
        for (let index = 0; index < 3; index++) {
            const before = performance.now();
            const pagesBefore = pages;
            const prompt = await hooks.instructions!(ctx, scope);
            instructionMs.push(performance.now() - before);
            expect(prompt.length).toBeLessThanOrEqual(12_000);
            if (previous !== undefined) {
                expect(prompt).toBe(previous);
                expect(pages).toBe(pagesBefore);
            }
            previous = prompt;
        }
        await hooks.beforeTurn!(ctx, scope, {} as never);
        const turnStart = performance.now();
        await skills.slashCommands(ctx, "scale");
        const turnRefreshMs = performance.now() - turnStart;
        const refreshedPages = pages;
        expect(await hooks.instructions!(ctx, scope)).toBe(previous);
        expect(pages).toBe(refreshedPages);
        const globalStart = performance.now();
        const global = await scanGlobalSkills(root);
        expect(global.skills).toHaveLength(10_000);
        expect(global.skills.at(-1)).toMatchObject({
            name: "skill-09999",
            status: "ready",
            files: [{ path: "SKILL.md" }],
        });
        console.info("10,000-skill scan timings (ms)", {
            discoveryMs,
            searchMs,
            readMs,
            instructionMs,
            turnRefreshMs,
            managementMs: performance.now() - globalStart,
        });
        const mirrored = await collectMirroredSkills([root], new Set(), new Map());
        expect(mirrored.skills).toHaveLength(10_000);
        expect(mirrored.skipped).toEqual([]);
    } finally {
        await compute.dispose(ctx);
        db.close();
        await rm(directory, { recursive: true, force: true });
    }
    // Several complete permission-aware scans plus management and mirror collection are intentional.
}, 300_000);
