import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentProviders, withAgentConfig, withAgentDatabase } from "@slopus/happy-agent-base";
import { HappyAgentClient } from "@slopus/happy-agent-client";
import { expect, it, vi } from "vitest";
import {
    startHappyAgentRuntime,
    type HappyAgentRuntime,
} from "../../sources/runtime/startHappyAgentRuntime.js";
import { ScriptedProvider } from "../support/ScriptedProvider.js";

it("serves parsed skills, streams native file changes, enforces disablement, and survives restart", async () => {
    const home = await mkdtemp(join(tmpdir(), "runtime-global-skills-"));
    vi.stubEnv("HOME", home);
    const directory = join(home, ".agents", "skills", "review");
    await mkdir(directory, { recursive: true });
    const content = "---\nname: review\ndescription: Review changes.\n---\nInstructions.\n";
    await writeFile(join(directory, "SKILL.md"), content);
    let runtime: HappyAgentRuntime | undefined;
    let server: Server | undefined;
    const stop = async () => {
        server?.closeAllConnections();
        if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
        server = undefined;
        await runtime?.close();
        runtime = undefined;
    };
    const start = async () => {
        const providers = new AgentProviders();
        providers.add("gym", new ScriptedProvider([]), "codex");
        let endpoint = "";
        runtime = await startHappyAgentRuntime({
            happyHome: join(home, ".happy"),
            environment: { ...process.env, HOME: home },
            inference: {
                providers,
                models: [
                    {
                        id: "gym/model",
                        providerId: "gym",
                        name: "Gym",
                        defaultEffort: "medium",
                        effortLevels: ["medium"],
                    },
                ],
            },
            onPrepared: async (prepared) => {
                server = createServer((request, response) => {
                    void prepared.api.handleRequest(
                        prepared.context("skills-test.http"),
                        request,
                        response,
                    );
                });
                await new Promise<void>((resolve, reject) => {
                    server!.once("error", reject);
                    server!.listen(0, "127.0.0.1", resolve);
                });
                const address = server.address();
                if (!address || typeof address === "string")
                    throw new Error("Missing server address.");
                endpoint = `http://127.0.0.1:${address.port}`;
            },
        });
        return new HappyAgentClient({ endpoint, token: runtime.api.token()! });
    };
    try {
        let client = await start();
        const list = await client.listGlobalSkills();
        expect(list.skills).toHaveLength(1);
        const skill = list.skills[0]!;
        expect(await client.getGlobalSkill(skill.id)).toMatchObject({
            content,
            instructions: "Instructions.\n",
        });
        const disabled = await client.updateGlobalSkill(
            skill.id,
            { enabled: false, mutationId: "disable-skill" },
            { ifMatch: skill.version },
        );
        await expect(
            client.updateGlobalSkill(skill.id, { enabled: true }, { ifMatch: skill.version }),
        ).rejects.toMatchObject({ status: 409, body: { currentVersion: disabled.skill.version } });
        expect(await readFile(join(directory, "SKILL.md"), "utf8")).toBe(content);
        const workspace = join(home, "workspace");
        await mkdir(workspace);
        const { project } = await client.registerProject({ path: workspace });
        const { agent } = await client.createAgent({
            workspaceId: project.id,
            title: "Skill availability",
        });
        const agentCtx = withAgentConfig(withAgentDatabase(runtime!.ctx, runtime!.database), {
            modules: { compute: { cwd: workspace } },
        });
        const native = await runtime!.modules.compute.resolve(agentCtx, agent.id);
        expect(native?.fs.home).toBe(home);
        expect(typeof runtime!.modules.compute.fileSystemIdentity(native!)).toBe("string");
        expect(await runtime!.modules.skills.list(agentCtx, agent.id)).toEqual({ skills: [] });
        expect(
            (await client.getAgent(agent.id)).slashCommands?.some(
                (command) => command.name === "review",
            ),
        ).toBe(false);
        await expect(
            runtime!.modules.skills.read(agentCtx, agent.id, { name: "review" }),
        ).rejects.toThrow("Unknown skill");

        const abort = new AbortController();
        const frames = client.streamEvents({
            after: list.cursor,
            signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]),
        });
        const nextSkillEvent = async () => {
            for (let count = 0; count < 200; count++) {
                const frame = await frames.next();
                if (frame.done) throw new Error("The skills stream ended.");
                if (frame.value.kind === "event" && frame.value.event.type === "skills.updated")
                    return frame.value.event.payload;
            }
            throw new Error("No skills update arrived.");
        };
        try {
            const toggleEvent = await nextSkillEvent();
            expect(toggleEvent).toMatchObject({
                skillIds: [skill.id],
                paths: [],
                mutationId: "disable-skill",
            });
            await writeFile(join(directory, "guide.txt"), "supporting content");
            // Only the watcher may publish this event: no skill endpoint is polled here.
            expect(await nextSkillEvent()).toMatchObject({
                skillIds: [skill.id],
                paths: expect.arrayContaining(["review/guide.txt"]),
            });
            const skillsRoot = join(home, ".agents", "skills");
            await rename(skillsRoot, `${skillsRoot}-saved`);
            expect(await nextSkillEvent()).toMatchObject({ skillIds: [skill.id] });
            await mkdir(directory, { recursive: true });
            await writeFile(join(directory, "SKILL.md"), content);
            await writeFile(join(directory, "guide.txt"), "supporting content");
            expect(await nextSkillEvent()).toMatchObject({ skillIds: [skill.id] });
        } finally {
            abort.abort();
            await frames.return(undefined);
        }
        const changed = await client.getGlobalSkill(skill.id);
        expect(changed.skill.version).not.toBe(disabled.skill.version);
        expect(changed.skill.enabled).toBe(false);
        expect(
            (await client.listGlobalSkillFiles(skill.id)).files.map((file) => file.path),
        ).toEqual(["SKILL.md", "guide.txt"]);
        await expect(client.readGlobalSkillFile(skill.id, "../private")).rejects.toMatchObject({
            status: 400,
        });
        const binary = await client.readGlobalSkillFile(skill.id, "guide.txt");
        expect(binary.contentType).toBe("application/octet-stream");
        expect(new TextDecoder().decode(binary.data)).toBe("supporting content");
        await stop();
        await writeFile(join(directory, "SKILL.md.tmp"), content + "Offline edit.\n");
        await rename(join(directory, "SKILL.md.tmp"), join(directory, "SKILL.md"));
        client = await start();
        expect(await client.getGlobalSkill(skill.id)).toMatchObject({
            skill: { id: skill.id, enabled: false },
            instructions: "Instructions.\nOffline edit.\n",
        });
        expect(await readFile(runtime!.configuration.paths.runtimeConfigPath, "utf8")).toContain(
            "review = false",
        );
    } finally {
        await stop();
        vi.unstubAllEnvs();
        await rm(home, { recursive: true, force: true });
    }
}, 60000);
