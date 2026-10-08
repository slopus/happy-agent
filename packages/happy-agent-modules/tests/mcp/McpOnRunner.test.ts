import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
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

/** An MCP module beside a connected runner whose product programs are recorded. */
async function runnerWorld() {
    const root = await realpath(await mkdtemp(join(tmpdir(), "happy-mcp-runner-")));
    cleanups.push(async () => await rm(root, { force: true, recursive: true }));
    const home = join(root, "runner-home");
    await mkdir(home);

    const runners = new RunnersModule({
        get runners() {
            return { defaultId: "build-box", entries: { "build-box": { token: TOKEN } } };
        },
    } as unknown as ConfigModule);
    const database = moduleDatabase(runners.migrations, "mcp-runner-test");
    ensureAgentDatabaseConnection(database.database);
    await database.ready;
    runners.beforeStart(database.context);
    cleanups.push(() => database.close());
    cleanups.push(async () => await runners.close());

    const started: ComputeProcessStartOptions[] = [];
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
                        return await processes.start(startCtx, options);
                    },
                },
            });
        },
    });
    cleanups.push(async () => await host.dispose(database.rootContext.named("test-dispose")));
    const connected = new Promise<void>((resolve) => {
        const stop = runners.onUpdated((_ctx, snapshot) => {
            if (snapshot.runners[0]?.status !== "connected") return;
            stop();
            resolve();
        });
    });
    const [daemonSide, runnerSide] = createRunnerChannelPair();
    void runners.accept("build-box", daemonSide);
    void host.serve(runnerSide);
    await connected;

    const config = await ConfigModule.load(join(root, ".happy"));
    const module = new McpModule(
        config,
        new UserInputModule(new PresenceModule(config)),
        { onEvent: () => () => undefined } as never,
        runners,
        new ComputeModule(config, new SecretsModule(), runners),
    );
    cleanups.push(async () => await module.close());
    return { home, module, root, started };
}

/** An agent whose folder is on the runner, as the compute configuration records it. */
function agentOnRunner(workingDirectory: string) {
    return {
        config: async () => ({
            environment: { osVersion: "test", platform: "linux", shell: "", workingDirectory },
            modules: { compute: { cwd: workingDirectory, runnerId: "build-box" } },
        }),
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

        await expect(echo(module, "hello")).resolves.toBe("on-runner:hello");
        expect(started).toEqual([
            expect.objectContaining({ command: process.execPath, args: [fixture, "on-runner"] }),
        ]);
    });

    it("starts the user's own stdio servers on the default runner", async () => {
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

        await expect(echo(module, "hi")).resolves.toBe("global:hi");
        expect(started.map((options) => options.args?.at(-1))).toEqual(["global"]);
    });
});

async function echo(module: McpModule, text: string): Promise<string> {
    const result = await module.callTool(ctx, "agent", {
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
