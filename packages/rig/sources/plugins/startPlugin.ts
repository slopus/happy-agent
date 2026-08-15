import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { Value } from "@sinclair/typebox/value";
import type Dockerode from "dockerode";
import type { HappyPluginStatus } from "happy-plugins";

import { createSandboxedCommand } from "../agent/context/createSandboxedCommand.js";
import { createToolEnvironment } from "../agent/context/createToolEnvironment.js";
import type { DockerExecutionConfig } from "../execution/index.js";
import type { RigAgentService } from "../agent/RigAgentService.js";
import type { GeneratedMediaStore } from "../generated-media/index.js";
import type { SessionStore } from "../session/SessionStore.js";
import { createPluginNodeRuntime } from "./createPluginNodeRuntime.js";
import {
    createPluginApiServer,
    type CreatePluginApiServerOptions,
} from "./createPluginApiServer.js";
import { getPluginDataDirectory } from "./getPluginDataDirectory.js";
import { PluginLog } from "./PluginLog.js";
import type { PluginComputeRegistry } from "./PluginComputeRegistry.js";
import type { PluginHookRegistry } from "./PluginHookRegistry.js";
import type { PluginMcpRegistrationRetirement, PluginMcpRegistry } from "./PluginMcpRegistry.js";
import type { PluginNetworkRegistry } from "./PluginNetworkRegistry.js";
import type { PluginAppRegistry } from "./PluginAppRegistry.js";
import { fileSystemErrorSchema, type RegisteredPlugin } from "./types.js";
import { snapshotPluginApps } from "./snapshotPluginApps.js";
import { startPluginDockerContainer } from "./startPluginDockerContainer.js";
import {
    startPluginDockerSocketBridge,
    type PluginDockerSocketBridge,
} from "./startPluginDockerSocketBridge.js";
import { PluginStartupState } from "./PluginStartupState.js";

const STOP_GRACE_MS = 2_000;

export interface RunningPlugin {
    readonly completion: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
    readonly dataDirectory: string;
    readonly logPath: string;
    readonly name: string;
    readonly pid: number | undefined;
    readonly retirement: Promise<PluginMcpRegistrationRetirement>;
    readonly startup: PluginStartupState;
    readonly statusMessage: string | undefined;
    close(options?: { force?: boolean }): Promise<void>;
}

export interface StartPluginOptions {
    agents?: RigAgentService;
    appRegistry?: PluginAppRegistry;
    dataDirectory?: string;
    defaultDocker?: DockerExecutionConfig;
    docker?: Dockerode;
    dockerCleanupTimeoutMs?: number;
    environment?: NodeJS.ProcessEnv;
    generatedMedia?: GeneratedMediaStore;
    hookRegistry?: PluginHookRegistry;
    listPlugins: CreatePluginApiServerOptions["listPlugins"];
    listProviderUsage?: CreatePluginApiServerOptions["listProviderUsage"];
    computeRegistry?: PluginComputeRegistry;
    mcpRegistry?: PluginMcpRegistry;
    networkRegistry?: PluginNetworkRegistry;
    onStatus?: (status: HappyPluginStatus) => void;
    preserveLog?: boolean;
    store: SessionStore;
}

interface PluginProcess {
    readonly completion: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
    readonly pid: number | undefined;
    readonly stderr: NodeJS.ReadableStream | undefined;
    readonly stdout: NodeJS.ReadableStream | undefined;
    close(options?: { force?: boolean }): Promise<void>;
}

export async function startPlugin(
    plugin: RegisteredPlugin,
    options: StartPluginOptions,
): Promise<RunningPlugin> {
    if (plugin.entryPath === undefined) {
        throw new Error("A plugin without a main entry point has no process to start.");
    }
    const runtime = {
        ...plugin,
        apps: await snapshotPluginApps(plugin),
    };
    const environment = options.environment ?? process.env;
    // The plugin's code lives in Rig's managed folder, so everything it writes at runtime — its own
    // state and the socket it connects back through — belongs in the folder a person can open.
    const dataDirectory =
        options.dataDirectory ?? getPluginDataDirectory(plugin.folderName, environment);
    const runtimeSocketDirectory = join(dataDirectory, ".runtime");
    const socketPath = join(runtimeSocketDirectory, "plugin.sock");
    const logPath = join(plugin.directory, "plugin.log");
    await mkdir(dataDirectory, { mode: 0o755, recursive: true });
    await mkdir(runtimeSocketDirectory, { mode: 0o700, recursive: true });
    await chmod(runtimeSocketDirectory, 0o700);
    const preserveDockerBuildLog = options.preserveLog === true && plugin.docker !== undefined;
    const preservedLog = preserveDockerBuildLog
        ? await readFile(logPath).catch(() => undefined)
        : undefined;
    const initialLog =
        preservedLog === undefined
            ? undefined
            : Buffer.concat([preservedLog, Buffer.from("\n[rig] Plugin process started.\n")]);
    await Promise.all([
        ...(preserveDockerBuildLog ? [] : [rm(logPath, { force: true })]),
        rm(`${logPath}.next`, { force: true }),
        rm(socketPath, { force: true }),
    ]);

    const token = randomBytes(32).toString("base64url");
    const startup = new PluginStartupState();
    let processState: "starting" | "running" | "closing" | "exited" = "starting";
    let reportRetirement = (_retirement: PluginMcpRegistrationRetirement) => {};
    const retirement = new Promise<PluginMcpRegistrationRetirement>((resolve) => {
        reportRetirement = resolve;
    });
    const handleRequiredRegistrationRetirement = (event: PluginMcpRegistrationRetirement): void => {
        if (startup.fail(event.reason)) return;
        if (processState === "closing" || processState === "exited") return;
        reportRetirement(event);
    };
    let statusMessage: string | undefined;
    const compute = options.computeRegistry?.createConnection(
        {
            ...(plugin.manifest.compute === undefined ? {} : { compute: plugin.manifest.compute }),
            folder: plugin.folderName,
            name: plugin.manifest.name,
        },
        {
            onRequiredRegistrationRetired: handleRequiredRegistrationRetirement,
        },
    );
    const mcp = options.mcpRegistry?.createConnection(
        {
            folder: plugin.folderName,
            name: plugin.manifest.name,
        },
        {
            onActiveRegistrationRetired: handleRequiredRegistrationRetirement,
        },
    );
    const network = options.networkRegistry?.createConnection({
        folder: plugin.folderName,
        interceptDomains: plugin.manifest.interceptDomains ?? [],
        name: plugin.manifest.name,
    });
    const hooks = options.hookRegistry?.createConnection(
        {
            folder: plugin.folderName,
            name: plugin.manifest.name,
        },
        {
            onRequiredRegistrationRetired: handleRequiredRegistrationRetirement,
        },
    );
    let unregisterApps: (() => void) | undefined;
    try {
        unregisterApps =
            mcp === undefined
                ? undefined
                : options.appRegistry?.register(runtime, mcp.generation, dataDirectory);
    } catch (error) {
        compute?.close();
        hooks?.close();
        mcp?.close();
        network?.close();
        throw error;
    }
    const server = createPluginApiServer({
        ...(options.agents === undefined ? {} : { agents: options.agents }),
        ...(compute === undefined ? {} : { compute }),
        ...(options.computeRegistry === undefined
            ? {}
            : { computeRegistry: options.computeRegistry }),
        ...(options.defaultDocker === undefined ? {} : { defaultDocker: options.defaultDocker }),
        ...(options.listProviderUsage === undefined
            ? {}
            : { listProviderUsage: options.listProviderUsage }),
        listPlugins: options.listPlugins,
        ...(options.generatedMedia === undefined ? {} : { generatedMedia: options.generatedMedia }),
        ...(hooks === undefined ? {} : { hooks }),
        ...(mcp === undefined ? {} : { mcp }),
        ...(network === undefined ? {} : { network }),
        pluginFolder: plugin.folderName,
        pluginDataDirectory: dataDirectory,
        pluginName: plugin.manifest.name,
        onStatus: (status) => {
            statusMessage = status;
            options.onStatus?.(status);
        },
        startup,
        store: options.store,
        token,
    });
    let dockerSocketBridge: PluginDockerSocketBridge | undefined;
    try {
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(socketPath, () => {
                server.off("error", reject);
                resolve();
            });
        });
        await restrictSocketAccess(socketPath);
        if (plugin.docker !== undefined && process.platform === "darwin") {
            dockerSocketBridge = await startPluginDockerSocketBridge(socketPath, token);
        }
    } catch (error) {
        unregisterApps?.();
        compute?.close();
        hooks?.close();
        mcp?.close();
        network?.close();
        await dockerSocketBridge?.close();
        await closeServer(server);
        await rm(socketPath, { force: true });
        throw error;
    }

    let pluginProcess: PluginProcess;
    const log = new PluginLog({
        ...(initialLog === undefined ? {} : { initialContent: initialLog }),
        path: logPath,
    });
    try {
        pluginProcess =
            plugin.docker === undefined
                ? await startNativePluginProcess(plugin.entryPath, dataDirectory, environment, {
                      socketPath,
                      token,
                  })
                : await startPluginDockerContainer({
                      ...(options.dockerCleanupTimeoutMs === undefined
                          ? {}
                          : { cleanupTimeoutMs: options.dockerCleanupTimeoutMs }),
                      dataDirectory,
                      ...(options.docker === undefined ? {} : { docker: options.docker }),
                      environment,
                      plugin,
                      ...(dockerSocketBridge === undefined
                          ? {}
                          : { socketBridgePort: dockerSocketBridge.port }),
                      token,
                  });
        processState = "running";
    } catch (error) {
        unregisterApps?.();
        compute?.close();
        hooks?.close();
        mcp?.close();
        network?.close();
        await Promise.allSettled([dockerSocketBridge?.close(), closeServer(server), log.close()]);
        await rm(socketPath, { force: true });
        throw error;
    }

    pluginProcess.stdout?.on("data", (chunk: Buffer) => log.append("stdout", chunk));
    pluginProcess.stderr?.on("data", (chunk: Buffer) => log.append("stderr", chunk));
    let finalized: Promise<void> | undefined;
    const finalize = () =>
        (finalized ??= Promise.allSettled([
            pluginProcess.close({ force: true }),
            dockerSocketBridge?.close(),
            closeServer(server),
            log.close(),
            rm(socketPath, { force: true }),
        ]).then(() => {
            unregisterApps?.();
            compute?.close();
            hooks?.close();
            mcp?.close();
            network?.close();
        }));
    const completion = pluginProcess.completion.then(
        (result) => {
            processState = "exited";
            void finalize();
            return result;
        },
        (error: unknown) => {
            processState = "exited";
            void finalize();
            throw error;
        },
    );

    return {
        completion,
        dataDirectory,
        logPath,
        name: plugin.manifest.name,
        pid: pluginProcess.pid,
        retirement,
        startup,
        get statusMessage() {
            return statusMessage;
        },
        async close(options = {}) {
            if (processState !== "exited") processState = "closing";
            try {
                await pluginProcess.close(options);
            } finally {
                await finalize();
            }
        },
    };
}

async function startNativePluginProcess(
    entryPath: string,
    dataDirectory: string,
    environment: NodeJS.ProcessEnv,
    connection: { socketPath: string; token: string },
): Promise<PluginProcess> {
    const node = await createPluginNodeRuntime({ entryPath });
    const command = await createSandboxedCommand({
        argv: [...node.argv],
        command: node.executable,
        commandCwd: dataDirectory,
        cwd: dataDirectory,
        mode: "workspace_write",
        protectProjectMetadata: false,
        shell: environment.SHELL?.trim() || "/bin/sh",
    });
    const child = spawn(command.command, command.args ?? [], {
        cwd: dataDirectory,
        env: {
            ...(await createToolEnvironment("workspace_write", environment, {
                cwd: dataDirectory,
            })),
            HAPPY_PLUGIN_DIRECTORY: dataDirectory,
            HAPPY_PLUGIN_SOCKET_PATH: connection.socketPath,
            HAPPY_PLUGIN_TOKEN: connection.token,
        },
        stdio: ["ignore", "pipe", "pipe"],
    });
    const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve, reject) => {
            child.once("error", reject);
            child.once("exit", (code, signal) => resolve({ code, signal }));
        },
    );
    let gracefulClose: Promise<void> | undefined;
    let forcedClose: Promise<void> | undefined;
    return {
        completion,
        pid: child.pid,
        stderr: child.stderr,
        stdout: child.stdout,
        close(options = {}) {
            if (options.force === true) {
                return (forcedClose ??= closeNativeProcess(child, completion, true));
            }
            return (gracefulClose ??= closeNativeProcess(child, completion, false));
        },
    };
}

async function closeNativeProcess(
    child: ReturnType<typeof spawn>,
    completion: Promise<unknown>,
    force: boolean,
): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill(force ? "SIGKILL" : "SIGTERM");
    if (force) {
        await completion.catch(() => undefined);
        return;
    }
    const stopped = await Promise.race([
        completion.then(
            () => true,
            () => true,
        ),
        new Promise<false>((resolve) => {
            const timer = setTimeout(() => resolve(false), STOP_GRACE_MS);
            timer.unref();
        }),
    ]);
    if (stopped) return;
    child.kill("SIGKILL");
    await completion.catch(() => undefined);
}

async function restrictSocketAccess(socketPath: string): Promise<void> {
    try {
        await chmod(socketPath, 0o600);
    } catch (error) {
        // Docker Desktop bind mounts reject chmod on Unix sockets even though the
        // containing runtime directory is private and every request requires a token.
        if (!Value.Check(fileSystemErrorSchema, error) || error.code !== "EINVAL") throw error;
    }
}

function closeServer(server: ReturnType<typeof createPluginApiServer>): Promise<void> {
    if (!server.listening) return Promise.resolve();
    return new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
    });
}
