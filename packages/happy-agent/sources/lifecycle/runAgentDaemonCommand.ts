import { HappyAgentClient, type HealthResponse } from "@slopus/happy-agent-client";

import { createUnixSocketFetch } from "./createUnixSocketFetch.js";
import { readDaemonTokenIfPresent } from "./daemonToken.js";
import { ensureAgentDaemon } from "./ensureAgentDaemon.js";
import { getHappyDaemonPaths } from "./getHappyDaemonPaths.js";
import { stopLocalProtocolServer } from "./stopLocalProtocolServer.js";

export type AgentDaemonCommand = "reload" | "start" | "stop" | "status";

export function isAgentDaemonCommand(value: string | undefined): value is AgentDaemonCommand {
    return value === "start" || value === "stop" || value === "status" || value === "reload";
}

export interface RunAgentDaemonCommandOptions {
    /** The daemon entrypoint handed to {@link ensureAgentDaemon} when a daemon must be spawned. */
    entrypoint?: string;
    log?: (line: string) => void;
}

/** Runs one daemon lifecycle command and reports the outcome in human-readable lines. */
export async function runAgentDaemonCommand(
    command: AgentDaemonCommand,
    options: RunAgentDaemonCommandOptions = {},
): Promise<void> {
    const log = options.log ?? ((line: string) => console.log(line));
    const entrypoint = options.entrypoint === undefined ? {} : { entrypoint: options.entrypoint };

    if (command === "start") {
        const connection = await ensureAgentDaemon({
            confirmRestart: async () => true,
            ...entrypoint,
        });
        log(`Daemon is running at ${connection.paths.socketPath}`);
        log(`Daemon log: ${connection.paths.logPath}`);
        return;
    }

    const connection = await connectToExistingDaemon();
    if (command === "reload") {
        if (connection !== undefined) {
            await stopLocalProtocolServer(connection.client, getHappyDaemonPaths().socketPath);
        }
        const reloaded = await ensureAgentDaemon({
            confirmRestart: async () => true,
            ...entrypoint,
        });
        log(`Daemon is running at ${reloaded.paths.socketPath}`);
        log(`Daemon log: ${reloaded.paths.logPath}`);
        return;
    }

    if (command === "status") {
        const paths = getHappyDaemonPaths();
        if (connection === undefined) {
            log("Daemon is not running.");
            log(`Daemon log: ${paths.logPath}`);
            return;
        }
        if (!connection.health.ready) {
            log(`Daemon is starting at ${paths.socketPath}`);
            log(`Daemon log: ${paths.logPath}`);
            return;
        }
        log(`Daemon is running at ${paths.socketPath}`);
        log(`Daemon log: ${paths.logPath}`);
        return;
    }

    if (connection === undefined) {
        log("Daemon is not running.");
        return;
    }
    await connection.client.shutdown();
    log("Daemon is stopping.");
}

async function connectToExistingDaemon(): Promise<
    | {
          client: HappyAgentClient;
          health: HealthResponse;
      }
    | undefined
> {
    const paths = getHappyDaemonPaths();
    const token = await readDaemonTokenIfPresent(paths.tokenPath);
    if (token === undefined) {
        return undefined;
    }

    const client = new HappyAgentClient({
        endpoint: "http://happy",
        fetch: createUnixSocketFetch(paths.socketPath),
        token,
    });
    try {
        const health = await client.getHealth();
        return { client, health };
    } catch {
        return undefined;
    }
}
