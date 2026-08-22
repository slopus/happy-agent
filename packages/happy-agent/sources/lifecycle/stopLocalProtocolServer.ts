import {
    HappyAgentApiError,
    type DrainWaitingAgent,
    type DrainWaitingFor,
    type HappyAgentClient,
} from "@slopus/happy-agent-client";

import { readDaemonPid, waitForDaemonProcessExit } from "./daemonPid.js";
import type { HappyDaemonPaths } from "./getHappyDaemonPaths.js";
import { waitForSocketRemoval } from "./waitForSocketRemoval.js";

const DAEMON_SHUTDOWN_TIMEOUT_MS = 30_000;
const DRAIN_POLL_INTERVAL_MS = 100;

export interface StopLocalProtocolServerOptions {
    readonly onDrainProgress?: (message: string) => void;
}

export async function stopLocalProtocolServer(
    client: HappyAgentClient,
    paths: Pick<HappyDaemonPaths, "pidPath" | "socketPath"> | string,
    options: StopLocalProtocolServerOptions = {},
): Promise<void> {
    const socketPath = typeof paths === "string" ? paths : paths.socketPath;
    let pid = typeof paths === "string" ? undefined : await readDaemonPid(paths.pidPath);
    await drainLocalProtocolServer(client, options.onDrainProgress);
    try {
        pid = (await client.shutdown()).pid;
    } catch (error) {
        const stopped = await waitForDaemonShutdown(socketPath, pid);
        if (stopped.socketRemoved && stopped.processExited) {
            return;
        }
        throw new Error(`Could not stop the existing local daemon: ${errorToMessage(error)}`);
    }
    const stopped = await waitForDaemonShutdown(socketPath, pid);
    if (!stopped.socketRemoved) {
        throw new Error(
            "Timed out while waiting for the existing local daemon to release its socket. A replacement was not started.",
        );
    }
    if (!stopped.processExited) {
        throw new Error(
            `Daemon process ${String(pid)} did not exit after releasing its socket. Run 'happy-agent kill' to force it to stop.`,
        );
    }
}

async function drainLocalProtocolServer(
    client: HappyAgentClient,
    report: ((message: string) => void) | undefined,
): Promise<void> {
    try {
        await client.drain();
    } catch (error: unknown) {
        if (error instanceof HappyAgentApiError && (error.status === 403 || error.status === 404)) {
            report?.("This daemon does not support draining; stopping it directly.");
            return;
        }
        throw error;
    }
    let previous: string | undefined;
    for (;;) {
        const health = await client.getHealth();
        const waiting = health.drainWaitingFor ?? [];
        const current = JSON.stringify(waiting);
        if (current !== previous) {
            report?.(formatDrainProgress(waiting));
            previous = current;
        }
        if (waiting.length === 0) return;
        await delay(DRAIN_POLL_INTERVAL_MS);
    }
}

export function formatDrainProgress(waiting: readonly DrainWaitingFor[]): string {
    if (waiting.length === 0) return "Daemon drain is complete.";
    return `Draining: ${waiting.map(formatDrainWait).join("; ")}.`;
}

function formatDrainWait(wait: DrainWaitingFor): string {
    const noun =
        wait.name === "api-mutations"
            ? plural(wait.count, "API mutation")
            : wait.name === "agent-system"
              ? plural(wait.count, "agent")
              : wait.name === "auto-agent-system"
                ? plural(wait.count, "permission reviewer")
                : `${String(wait.count)} ${wait.name.replaceAll("-", " ")}`;
    if (wait.agents === undefined || wait.agents.length === 0) return noun;
    const agents = wait.agents.map((agent) => `${agent.id}: ${stageLabel(agent.stage)}`).join(", ");
    return `${noun} (${agents}${wait.truncated === true ? ", …" : ""})`;
}

function stageLabel(stage: DrainWaitingAgent["stage"]): string {
    return stage === "tools" ? "tool calls" : stage;
}

function plural(count: number, noun: string): string {
    return `${String(count)} ${noun}${count === 1 ? "" : "s"}`;
}

function delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForDaemonShutdown(
    socketPath: string,
    pid: number | undefined,
): Promise<{ readonly processExited: boolean; readonly socketRemoved: boolean }> {
    const [socketRemoved, processExited] = await Promise.all([
        waitForSocketRemoval(socketPath, DAEMON_SHUTDOWN_TIMEOUT_MS),
        pid === undefined
            ? Promise.resolve(true)
            : waitForDaemonProcessExit(pid, DAEMON_SHUTDOWN_TIMEOUT_MS),
    ]);
    return { processExited, socketRemoved };
}

function errorToMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
