import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ensureAgentDatabaseConnection } from "@slopus/happy-agent-base";
import {
    createHostCompute,
    createRunnerChannelPair,
    RunnerHost,
    type ComputeProcessStartOptions,
} from "@slopus/happy-agent-compute";
import { createRootContext } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it } from "vitest";

import { ComputeModule } from "../../sources/compute/index.js";
import { ConfigModule } from "../../sources/config/index.js";
import { McpModule } from "../../sources/mcp/index.js";
import { PresenceModule } from "../../sources/presence/index.js";
import { RunnersModule } from "../../sources/runners/index.js";
import { SecretsModule } from "../../sources/secrets/index.js";
import { UserInputModule } from "../../sources/userInput/index.js";
import { moduleDatabase } from "../support/moduleDatabase.js";
import { resolveModuleHooks } from "../support/moduleHooks.js";

const fixture = fileURLToPath(new URL("./fixtures/stdioServer.mjs", import.meta.url));
const ctx = createRootContext();
const TOKEN = "a".repeat(43);

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/**
 * An MCP module beside connected runners whose product programs are recorded. The first runner,
 * `build-box`, is the default unless `defaultId` says otherwise; `undefined` keeps this machine
 * the default, as `[runners] default = "local"` does.
 */
async function runnerWorld(
    options: {
        readonly runnerIds?: readonly string[];
        readonly defaultId?: string | undefined;
    } = {},
) {
    const runnerIds = options.runnerIds ?? ["build-box"];
    const root = await realpath(await mkdtemp(join(tmpdir(), "happy-mcp-runner-")));
    cleanups.push(async () => await rm(root, { force: true, recursive: true }));
    const home = join(root, "runner-home");
    await mkdir(home);

    const runners = new RunnersModule({
        get runners() {
            return {
                defaultId: "defaultId" in options ? options.defaultId : runnerIds[0],
                entries: Object.fromEntries(runnerIds.map((id) => [id, { token: TOKEN }])),
            };
        },
    } as unknown as ConfigModule);
    const database = moduleDatabase(runners.migrations, "mcp-runner-test");
    ensureAgentDatabaseConnection(database.database);
    await database.ready;
    runners.beforeStart(database.context);
    cleanups.push(() => database.close());
    cleanups.push(async () => await runners.close());

    const started: ComputeProcessStartOptions[] = [];
    const startedOn = new Map<string, ComputeProcessStartOptions[]>();
    /** Start a runner process and connect it; it holds nothing from an earlier one. */
    const startRunner = async (runnerId = "build-box") => {
        const host = new RunnerHost({
            ctx: database.rootContext.named("test-runner"),
            identity: { version: "9.9.9", platform: "linux", arch: "x64", hostname: "box", home },
            createCompute: async (computeCtx, request) => {
                const compute = createHostCompute({ ctx: computeCtx, cwd: request.cwd });
                const processes = compute.processes;
                if (processes === undefined) return compute;
                return Object.assign(compute, {
                    processes: {
                        start: async (startCtx: never, options: ComputeProcessStartOptions) => {
                            started.push(options);
                            startedOn.set(runnerId, [...(startedOn.get(runnerId) ?? []), options]);
                            return await processes.start(startCtx, options);
                        },
                    },
                });
            },
        });
        cleanups.push(async () => await host.dispose(database.rootContext.named("test-dispose")));
        const connected = new Promise<void>((resolve) => {
            const stop = runners.onUpdated((_ctx, snapshot) => {
                const status = snapshot.runners.find((entry) => entry.id === runnerId)?.status;
                if (status !== "connected") return;
                stop();
                resolve();
            });
        });
        const [daemonSide, runnerSide] = createRunnerChannelPair();
        void runners.accept(runnerId, daemonSide);
        void host.serve(runnerSide);
        await connected;
        return {
            /** The runner process stops without a goodbye, taking its programs with it. */
            stop: async () => {
                const disconnected = new Promise<void>((resolve) => {
                    const stop = runners.onUpdated((_ctx, snapshot) => {
                        const status = snapshot.runners.find(
                            (entry) => entry.id === runnerId,
                        )?.status;
                        if (status === "connected") return;
                        stop();
                        resolve();
                    });
                });
                runnerSide.close("The runner stopped.");
                await host.dispose(database.rootContext.named("test-runner-stop"));
                await disconnected;
            },
        };
    };
    const runner = await startRunner();
    for (const runnerId of runnerIds.slice(1)) await startRunner(runnerId);

    const config = await ConfigModule.load(join(root, ".happy"));
    const module = new McpModule(
        config,
        new UserInputModule(new PresenceModule(config)),
        { onEvent: () => () => undefined } as never,
        runners,
        new ComputeModule(config, new SecretsModule(), runners),
    );
    cleanups.push(async () => await module.close());
    return { config, home, module, root, runner, runners, startRunner, started, startedOn };
}

/** An agent whose folder is on the runner, as the compute configuration records it. */
function agentOnRunner(workingDirectory: string, runnerId = "build-box") {
    return agentsIn({ agent: { workingDirectory, runnerId } });
}

/** Agents by ID, each in a folder on a runner or, with no runner, on this machine. */
function agentsIn(
    placements: Record<string, { readonly workingDirectory: string; readonly runnerId?: string }>,
) {
    return {
        config: async (_ctx: unknown, agentId: string) => {
            const placement = placements[agentId];
            if (placement === undefined) return undefined;
            const { workingDirectory, runnerId } = placement;
            return {
                environment: { osVersion: "test", platform: "linux", shell: "", workingDirectory },
                modules: {
                    compute: {
                        cwd: workingDirectory,
                        ...(runnerId === undefined ? {} : { runnerId }),
                    },
                },
            };
        },
    } as never;
}

describe("MCP servers on a runner", () => {
    it("starts a runner workspace's own stdio servers on that runner", async () => {
        const { home, module, started } = await runnerWorld();
        const workspace = join(home, "workspace");
        await write(join(workspace, "mcp.toml"), serverToml("tools", "on-runner"));
        const agents = agentOnRunner(workspace);

        const hooks = await resolveModuleHooks(ctx, module, agents);
        await hooks.agentCreated?.(
            ctx,
            { agents, sharedKV: {} } as never,
            {
                id: "agent",
                metadata: undefined,
            } as never,
        );

        await connected(module);
        await expect(echo(module, "hello")).resolves.toBe("on-runner:hello");
        expect(started).toEqual([
            expect.objectContaining({ command: process.execPath, args: [fixture, "on-runner"] }),
        ]);
    });

    it("writes a runner folder's own catalog through that runner and starts its server there", async () => {
        const { home, module, started } = await runnerWorld();
        const workspace = join(home, "workspace");
        await mkdir(workspace, { recursive: true });
        const agents = agentOnRunner(workspace);
        const hooks = await resolveModuleHooks(ctx, module, agents);
        await hooks.agentCreated?.(
            ctx,
            { agents, sharedKV: {} } as never,
            { id: "agent", metadata: undefined } as never,
        );
        await expect
            .poll(() => module.workspaceMcpConfigLocation("agent"))
            .toBe(`${join(workspace, "mcp.toml")} on the runner build-box`);

        await module.configureWorkspaceServer(ctx, "agent", "tools", {
            transport: "stdio",
            command: process.execPath,
            args: [fixture, "configured"],
        });

        await expect(readFile(join(workspace, "mcp.toml"), "utf8")).resolves.toContain(
            "[mcp_servers.tools]",
        );
        await expect(echo(module, "hello")).resolves.toBe("configured:hello");
        expect(started).toEqual([
            expect.objectContaining({ command: process.execPath, args: [fixture, "configured"] }),
        ]);
    });

    it("fails a server at once while its runner is away and restarts it when it returns", async () => {
        const { home, module, runner, startRunner, started } = await runnerWorld();
        const workspace = join(home, "workspace");
        await write(join(workspace, "mcp.toml"), serverToml("tools", "on-runner"));
        const agents = agentOnRunner(workspace);
        const hooks = await resolveModuleHooks(ctx, module, agents);
        await hooks.agentCreated?.(
            ctx,
            { agents, sharedKV: {} } as never,
            {
                id: "agent",
                metadata: undefined,
            } as never,
        );
        await connected(module);
        await expect(echo(module, "before")).resolves.toBe("on-runner:before");

        await runner.stop();
        const startedAt = Date.now();
        await expect(echo(module, "away")).rejects.toThrow(
            "The runner build-box is not connected.",
        );
        expect(Date.now() - startedAt).toBeLessThan(2_000);

        await startRunner();
        await expect
            .poll(async () => await echo(module, "back").catch(() => ""))
            .toBe("on-runner:back");
        expect(started).toHaveLength(2);
    });

    it("starts the user's own stdio servers on the runner of an agent's folder", async () => {
        const { home, module, root, started } = await runnerWorld();
        await write(
            join(root, process.platform === "darwin" ? "Happy/Config" : "happy/config", "mcp.toml"),
            serverToml("tools", "global"),
        );
        const workspace = join(home, "empty-workspace");
        await mkdir(workspace);
        const agents = agentOnRunner(workspace);

        const hooks = await resolveModuleHooks(ctx, module, agents);
        await module.reload(ctx);
        await hooks.agentCreated?.(
            ctx,
            { agents, sharedKV: {} } as never,
            {
                id: "agent",
                metadata: undefined,
            } as never,
        );

        await connected(module);
        await expect(echo(module, "hi")).resolves.toBe("global:hi");
        expect(started.map((options) => options.args?.at(-1))).toEqual(["global"]);
    });

    it("starts the user's own stdio servers on each agent's runner, once per runner", async () => {
        const { home, module, root, startedOn } = await runnerWorld({
            runnerIds: ["build-box", "gpu-box"],
        });
        await write(userMcpToml(root), serverToml("tools", "global"));
        const left = join(home, "left");
        const right = join(home, "right");
        await mkdir(left);
        await mkdir(right);
        const agents = agentsIn({
            onDefault: { workingDirectory: left, runnerId: "build-box" },
            onOther: { workingDirectory: right, runnerId: "gpu-box" },
            alsoOnOther: { workingDirectory: left, runnerId: "gpu-box" },
        });
        const hooks = await resolveModuleHooks(ctx, module, agents);
        await module.reload(ctx);

        // An agent on the runner that is not the default gets the server on its own runner.
        await created(hooks, agents, "onOther");
        await connected(module, "onOther");
        await expect(echo(module, "hi", "onOther")).resolves.toBe("global:hi");
        expect(startedOn.get("gpu-box")).toHaveLength(1);
        expect(startedOn.get("build-box")).toBeUndefined();

        // A second agent on that runner shares the process; the default runner starts its own.
        await created(hooks, agents, "alsoOnOther");
        await created(hooks, agents, "onDefault");
        await connected(module, "alsoOnOther");
        await connected(module, "onDefault");
        await expect(echo(module, "again", "alsoOnOther")).resolves.toBe("global:again");
        await expect(echo(module, "there", "onDefault")).resolves.toBe("global:there");
        expect(startedOn.get("gpu-box")).toHaveLength(1);
        expect(startedOn.get("build-box")).toHaveLength(1);
    });

    it("keeps this machine's servers for its own agents when it stays the default", async () => {
        const { home, module, root, startedOn } = await runnerWorld({ defaultId: undefined });
        await write(userMcpToml(root), serverToml("tools", "global"));
        const local = await realpath(await mkdtemp(join(tmpdir(), "happy-mcp-local-")));
        cleanups.push(async () => await rm(local, { force: true, recursive: true }));
        const remote = join(home, "remote");
        await mkdir(remote);
        const agents = agentsIn({
            here: { workingDirectory: local },
            there: { workingDirectory: remote, runnerId: "build-box" },
        });
        const hooks = await resolveModuleHooks(ctx, module, agents);
        await module.reload(ctx);
        await created(hooks, agents, "here");
        await connected(module, "here");
        await expect(echo(module, "local", "here")).resolves.toBe("global:local");
        expect(startedOn.get("build-box")).toBeUndefined();

        await created(hooks, agents, "there");
        await connected(module, "there");
        await expect(echo(module, "remote", "there")).resolves.toBe("global:remote");
        expect(startedOn.get("build-box")).toHaveLength(1);
    });
});

function userMcpToml(root: string): string {
    return join(root, process.platform === "darwin" ? "Happy/Config" : "happy/config", "mcp.toml");
}

async function created(
    hooks: Awaited<ReturnType<typeof resolveModuleHooks>>,
    agents: never,
    agentId: string,
): Promise<void> {
    await hooks.agentCreated?.(
        ctx,
        { agents, sharedKV: {} } as never,
        { id: agentId, metadata: undefined } as never,
    );
}

/** Creation only starts attaching an agent's folder; wait until its server is connected. */
async function connected(module: McpModule, agentId = "agent"): Promise<void> {
    await expect
        .poll(async () => (await module.listServerPage(ctx, agentId)).servers, { timeout: 10_000 })
        .toMatchObject([{ name: "tools", status: "connected" }]);
}

async function echo(module: McpModule, text: string, agentId = "agent"): Promise<string> {
    const result = await module.callTool(ctx, agentId, {
        server: "tools",
        name: "echo",
        arguments: { text },
    });
    const first = result.content?.[0];
    if (first?.type !== "text") throw new Error("The MCP fixture did not answer.");
    return first.text;
}

function serverToml(name: string, label: string): string {
    return [
        `[mcp_servers.${JSON.stringify(name)}]`,
        `command = ${JSON.stringify(process.execPath)}`,
        `args = ${JSON.stringify([fixture, label])}`,
        "startup_timeout_sec = 10",
        "tool_timeout_sec = 10",
        "",
    ].join("\n");
}

async function write(path: string, contents: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents, "utf8");
}
