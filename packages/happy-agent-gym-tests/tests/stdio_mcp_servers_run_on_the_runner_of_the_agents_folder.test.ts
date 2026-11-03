import { execFile as execFileCallback } from "node:child_process";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
    createAgentGym,
    type AgentGym,
    type GymInferenceRequest,
    type GymTurn,
} from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const execFile = promisify(execFileCallback);
const BOX_TOKEN = "m".repeat(43);
const OTHER_TOKEN = "n".repeat(43);
const server = fileURLToPath(new URL("./fixtures/whereMcpServer.mjs", import.meta.url));
const ASK = "where-are-you:";
const running = new Set<AgentGym>();

afterEach(async () => {
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
}, 30_000);

/**
 * A stdio MCP server is a process on one machine, and it has to be the machine the agent's folder
 * is on: a filesystem or build server elsewhere would act on the wrong files. A folder's own
 * `mcp.toml` servers start on its runner, and the user's own servers start on each agent's runner,
 * whichever machine is the default. The fixture answers with the HOME it was started with, which
 * the gym gives each runner separately.
 */
describe("stdio MCP servers for a folder on a runner", { timeout: 120_000 }, () => {
    it("start a folder's own servers on its runner and reach them from its agent", async () => {
        const { gym, homes, agentIn, where } = await runners();
        const repository = await runnerRepository(homes.box, "with-own-server");
        await writeFile(join(repository, "mcp.toml"), serverToml("folder"), "utf8");
        const agentId = await agentIn(repository, "box");

        expect(await where(agentId, "folder", "own")).toEqual({
            home: homes.box,
            cwd: homes.box,
        });
        expect(gym.inference.unscripted).toEqual([]);
    });

    it("start the user's own servers on each agent's runner, not on the default machine", async () => {
        const { gym, homes, agentIn, where } = await runners({ userWide: true });
        const onBox = await agentIn(await runnerRepository(homes.box, "on-box"), "box");
        const onOther = await agentIn(await runnerRepository(homes.other, "on-other"), "other");

        expect((await where(onOther, "user", "other")).home).toBe(homes.other);
        expect((await where(onBox, "user", "box")).home).toBe(homes.box);
        expect(gym.inference.unscripted).toEqual([]);
    });
});

/**
 * A gym that keeps this machine the default beside two runners, `box` and `other`, each with a home
 * of its own. Any agent told `where-are-you:<server>:<tag>` calls that server's `where` tool once.
 */
async function runners(options: { readonly userWide?: boolean } = {}) {
    const gym = await createAgentGym({
        config: [
            "[runners]",
            'default = "local"',
            "",
            "[runners.box]",
            'name = "Box"',
            `token = "${BOX_TOKEN}"`,
            "",
            "[runners.other]",
            'name = "Other"',
            `token = "${OTHER_TOKEN}"`,
            "",
        ].join("\n"),
        timeoutMs: 30_000,
        inference: (request: GymInferenceRequest): GymTurn => {
            if (request.sessionId.startsWith("naming:")) {
                return { content: [{ type: "text", text: "Where" }] };
            }
            if (request.messages.at(-1)?.role === "tool") {
                return { content: [{ type: "text", text: "Answered." }] };
            }
            const asked = new RegExp(`${ASK}([a-z]+):([a-z]+)`).exec(lastUserText(request));
            if (asked === null) return { content: [{ type: "text", text: "Settled." }] };
            return {
                content: [
                    {
                        type: "tool_call",
                        name: `mcp__${asked[1]}__where`,
                        arguments: {},
                        callId: `where_${asked[2]}`,
                    },
                ],
            };
        },
    });
    running.add(gym);
    if (options.userWide === true) {
        await writeFile(
            join(
                gym.publicHomePath,
                process.platform === "darwin" ? "Config" : "config",
                "mcp.toml",
            ),
            serverToml("user"),
            "utf8",
        );
        await gym.restart();
    }
    const base = join(dirname(gym.workspacePath), "runner-homes");
    const homes = { box: join(base, "box"), other: join(base, "other") };
    for (const [id, token] of [
        ["box", BOX_TOKEN],
        ["other", OTHER_TOKEN],
    ] as const) {
        await mkdir(homes[id], { recursive: true });
        homes[id] = await realpath(homes[id]);
        await gym.startRunner({ home: homes[id], token });
    }
    await gym.waitUntil(async () => {
        const listed = (await gym.client.listRunners()).runners;
        return ["box", "other"].every((id) =>
            listed.some((runner) => runner.id === id && runner.status === "connected"),
        )
            ? true
            : undefined;
    }, "both runners to connect");

    /** A new agent in a project registered at `path` on the runner. */
    async function agentIn(path: string, runnerId: string): Promise<string> {
        const project = (await gym.client.registerProject({ path, runnerId })).project;
        await gym.waitUntil(async () => {
            const current = (await gym.client.getProject(project.id)).project;
            if (current.initialization.status === "failed")
                throw new Error(current.initialization.error ?? "The project could not be set up.");
            return current.initialization.status === "ready" ? true : undefined;
        }, "the runner project to become ready");
        return (await gym.client.createAgent({ workspaceId: project.id })).agent.id;
    }

    /** Where the `serverName` server that `agentId` reaches says it runs. */
    async function where(
        agentId: string,
        serverName: string,
        tag: string,
    ): Promise<{ home: string | null; cwd: string }> {
        await gym.send(`${ASK}${serverName}:${tag}`, {
            sessionId: agentId,
            permissionMode: "full_access",
        });
        const result = await gym.waitUntil(
            () => gym.inference.toolResults().find((item) => item.callId === `where_${tag}`),
            `the ${tag} agent's answer`,
        );
        const match = /\{.*\}/su.exec(result.text);
        if (match === null) throw new Error(`The server did not answer: ${result.text}`);
        return JSON.parse(match[0]) as { home: string | null; cwd: string };
    }

    return { gym, homes, agentIn, where };
}

async function runnerRepository(home: string, name: string): Promise<string> {
    const repository = join(home, name);
    await mkdir(repository, { recursive: true });
    await writeFile(join(repository, "readme.txt"), "hello\n", "utf8");
    await git(repository, ["init", "--quiet", "--initial-branch=main"]);
    await git(repository, ["add", "."]);
    await git(repository, ["commit", "--quiet", "-m", "initial"]);
    return repository;
}

function serverToml(name: string): string {
    return `[mcp_servers.${name}]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify([server])}\n`;
}

function lastUserText(request: GymInferenceRequest): string {
    return (request.messages.findLast((message) => message.role === "user")?.content ?? [])
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("\n");
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
    await execFile(
        "git",
        ["-c", "user.email=gym@example.invalid", "-c", "user.name=Runner Gym", ...args],
        { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
    );
}
