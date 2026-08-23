import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
    HappyAgentClient,
    HAPPY_AGENT_PROTOCOL_VERSION,
    type HealthResponse,
} from "@slopus/happy-agent-client";

import { HappyTerminalUserError } from "../HappyTerminalUserError.js";
import { createUnixSocketFetch } from "./createUnixSocketFetch.js";
import { ensureHappyAgentBinary, type HappyAgentBinary } from "./ensureHappyAgentBinary.js";
import { selectedHappyAgentBinary } from "./happyAgentBinaryConfig.js";
import { getHappyDaemonPaths, type HappyDaemonPaths } from "./getHappyDaemonPaths.js";

const DAEMON_COMMAND_TIMEOUT_MS = 75_000;
const READY_TIMEOUT_MS = 60_000;
const commandSchema = Type.Array(Type.String({ minLength: 1, maxLength: 4_096 }), {
    maxItems: 32,
    minItems: 1,
});
type DaemonCommand = Static<typeof commandSchema>;

export interface LocalProtocolServerConnection {
    readonly client: HappyAgentClient;
    readonly health: HealthResponse;
    readonly paths: HappyDaemonPaths;
    readonly token: string;
}

export type ObservedLocalProtocolServer = LocalProtocolServerConnection;

export interface EnsureLocalProtocolServerOptions {
    onStatus?: (message: string) => void;
}

let inProcessDaemon: Promise<void> | undefined;
interface LocalHappyAgentSources {
    cliPath: string;
    runModuleUrl: string;
}

/** Connects to the running daemon, or starts the selected or downloaded Agent when no socket responds. */
export async function ensureLocalProtocolServer(
    options: EnsureLocalProtocolServerOptions = {},
): Promise<LocalProtocolServerConnection> {
    const paths = getHappyDaemonPaths();
    await mkdir(paths.agentDirectory, { mode: 0o700, recursive: true });
    const selectedRelease = await selectedHappyAgentBinary(paths);

    const observed = await observeLocalProtocolServer(paths);
    if (observed !== undefined) return await connectWhenReady(observed);

    try {
        if (runDaemonInProcess()) {
            options.onStatus?.("Starting local Happy Agent sources.");
            await startLocalDaemonInProcess(paths);
        } else {
            const command = await resolveHappyAgentCommand(
                paths,
                options.onStatus,
                selectedRelease,
            );
            options.onStatus?.(
                command.source === "release"
                    ? `Starting Happy Agent ${command.version}.`
                    : "Starting local Happy Agent sources.",
            );
            await runHappyAgent(command.arguments, "start");
        }
    } catch (error) {
        const raced = await observeLocalProtocolServer(paths);
        if (raced !== undefined) return await connectWhenReady(raced);
        throw new HappyTerminalUserError("The local Happy Agent daemon could not be started.", {
            cause: error,
            hint: error instanceof Error ? error.message : String(error),
        });
    }

    const started = await waitForDaemon(paths);
    return await connectWhenReady(started);
}

export async function observeLocalProtocolServer(
    paths: HappyDaemonPaths = getHappyDaemonPaths(),
): Promise<ObservedLocalProtocolServer | undefined> {
    const token = await readTokenIfPresent(paths.tokenPath);
    if (token === undefined || token.length === 0) return undefined;
    const client = new HappyAgentClient({
        endpoint: "http://happy",
        fetch: createUnixSocketFetch(paths.socketPath),
        token,
    });
    try {
        const health = await client.getHealth();
        assertCompatibleProtocol(health);
        return { client, health, paths, token };
    } catch (error) {
        if (error instanceof HappyTerminalUserError) throw error;
        return undefined;
    }
}

export async function readTokenIfPresent(tokenPath: string): Promise<string | undefined> {
    try {
        return (await readFile(tokenPath, "utf8")).trim();
    } catch {
        return undefined;
    }
}

/** The local Gym keeps the daemon in the TUI process to make full-system scenarios inexpensive. */
export function runDaemonInProcess(environment: NodeJS.ProcessEnv = process.env): boolean {
    return environment.HAPPY_TERMINAL_GYM_IN_PROCESS_DAEMON === "1";
}

/** Gym in-process daemon only. Production launch always uses the selected managed binary. */
export function resolveLocalHappyAgentSources(
    moduleUrl: string = import.meta.url,
    exists: (path: URL) => boolean = existsSync,
): LocalHappyAgentSources | undefined {
    for (const prefix of ["../../happy-agent/sources/", "../../../happy-agent/sources/"]) {
        const cli = new URL(`${prefix}cli.ts`, moduleUrl);
        const run = new URL(`${prefix}lifecycle/runAgentDaemon.ts`, moduleUrl);
        if (cli.protocol === "file:" && run.protocol === "file:" && exists(cli) && exists(run)) {
            return { cliPath: fileURLToPath(cli), runModuleUrl: run.href };
        }
    }
    return undefined;
}

async function resolveHappyAgentCommand(
    paths: HappyDaemonPaths,
    onStatus: ((message: string) => void) | undefined,
    selectedRelease: HappyAgentBinary | undefined,
): Promise<
    | { arguments: DaemonCommand; source: "development" }
    | { arguments: DaemonCommand; source: "release"; version: string }
> {
    const override = process.env.HAPPY_TERMINAL_GYM_HAPPY_AGENT_COMMAND?.trim();
    if (override !== undefined && override.length > 0) {
        let parsed: unknown;
        try {
            parsed = JSON.parse(override);
        } catch (error) {
            throw new Error("HAPPY_TERMINAL_GYM_HAPPY_AGENT_COMMAND is not valid JSON.", {
                cause: error,
            });
        }
        if (!Value.Check(commandSchema, parsed)) {
            throw new Error(
                "HAPPY_TERMINAL_GYM_HAPPY_AGENT_COMMAND must be a non-empty command array.",
            );
        }
        return { arguments: parsed, source: "development" };
    }

    if (selectedRelease !== undefined) {
        return {
            arguments: [selectedRelease.path],
            source: "release",
            version: selectedRelease.version,
        };
    }

    const release = await ensureHappyAgentBinary({
        ...(onStatus === undefined ? {} : { onStatus }),
        paths,
    });
    return { arguments: [release.path], source: "release", version: release.version };
}

async function startLocalDaemonInProcess(paths: HappyDaemonPaths): Promise<void> {
    const localSources = resolveLocalHappyAgentSources();
    if (localSources === undefined) {
        throw new Error("The in-process Gym daemon requires a Happy Agent source checkout.");
    }
    inProcessDaemon ??= import(localSources.runModuleUrl).then(async (module: unknown) => {
        if (
            typeof module !== "object" ||
            module === null ||
            !("runAgentDaemon" in module) ||
            typeof module.runAgentDaemon !== "function"
        ) {
            throw new Error("The local Happy Agent source entrypoint is invalid.");
        }
        await module.runAgentDaemon({ persistPid: false });
    });
    await inProcessDaemon;
    const observed = await waitForDaemon(paths);
    await connectWhenReady(observed);
}

function runHappyAgent(command: DaemonCommand, action: "start"): Promise<void> {
    const [executable, ...arguments_] = command;
    if (executable === undefined) throw new Error("The Happy Agent command is empty.");
    return new Promise((resolve, reject) => {
        execFile(
            executable,
            [...arguments_, action],
            {
                env: process.env,
                maxBuffer: 1024 * 1024,
                timeout: DAEMON_COMMAND_TIMEOUT_MS,
            },
            (error, _stdout, stderr) => {
                if (error === null) {
                    resolve();
                    return;
                }
                const detail = stderr.trim();
                reject(detail.length === 0 ? error : new Error(detail, { cause: error }));
            },
        );
    });
}

async function waitForDaemon(paths: HappyDaemonPaths): Promise<ObservedLocalProtocolServer> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
        const observed = await observeLocalProtocolServer(paths);
        if (observed !== undefined) return observed;
        await delay(50);
    }
    throw new Error("Timed out while waiting for the local Happy Agent daemon.");
}

async function connectWhenReady(
    observed: ObservedLocalProtocolServer,
): Promise<LocalProtocolServerConnection> {
    let health = observed.health;
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (!health.ready && Date.now() < deadline) {
        await delay(50);
        health = await observed.client.getHealth();
        assertCompatibleProtocol(health);
    }
    if (!health.ready) throw new Error("The local Happy Agent daemon did not finish starting.");
    return { client: observed.client, health, paths: observed.paths, token: observed.token };
}

function assertCompatibleProtocol(health: HealthResponse): void {
    if (health.version.protocol === HAPPY_AGENT_PROTOCOL_VERSION) return;
    throw new HappyTerminalUserError(
        `The running Happy Agent uses protocol ${String(health.version.protocol)}, but this Happy Terminal expects protocol ${String(HAPPY_AGENT_PROTOCOL_VERSION)}.`,
        { hint: "Stop the daemon and upgrade Happy Terminal before trying again." },
    );
}

function delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
