import { ensurePrivateDirectory } from "@slopus/happy-agent-compute";
import { spawn } from "node:child_process";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { AgentDaemonError } from "./AgentDaemonError.js";
import { waitForDaemonProcessExit } from "./daemonPid.js";
import { getHappyDaemonPaths } from "./getHappyDaemonPaths.js";
import { resolveAgentDaemonProcessCommand } from "./resolveAgentDaemonProcessCommand.js";
import { rotateDaemonLog } from "./rotateDaemonLog.js";
import { runAgentDaemonCommand } from "./runAgentDaemonCommand.js";

/** Marks the detached worker and names the process it must outlive. Not shown in usage. */
const WORKER_ARGUMENT = "--detached-after=";
const CALLER_EXIT_TIMEOUT_MS = 60_000;

/**
 * Schedules `reload` in a detached worker and returns at once, with the worker's log path.
 *
 * An agent's shell belongs to the daemon being replaced, so a foreground reload dies during
 * shutdown. The worker runs in its own session and waits for this process to exit; it is then
 * no longer the daemon's descendant, and reload's ancestry check accepts it.
 */
export async function detachAgentDaemonReload(): Promise<string> {
    if (process.platform === "win32") {
        // Windows does not reparent an orphan, so its ancestry cannot be proven independent.
        throw new AgentDaemonError("Detached reload is not available on Windows.", {
            hint: "Run happy-agent reload from an independent terminal.",
        });
    }
    const command = resolveAgentDaemonProcessCommand(undefined, undefined, [
        "reload",
        `${WORKER_ARGUMENT}${String(process.pid)}`,
    ]);
    if (command === undefined) {
        throw new AgentDaemonError("Cannot locate the Happy agent entrypoint.");
    }
    const paths = getHappyDaemonPaths();
    const logPath = join(paths.directory, "reload.log");
    await ensurePrivateDirectory(paths.directory);
    await rotateDaemonLog(logPath).catch(() => undefined);
    const log = await open(logPath, "a", 0o600);
    try {
        await log.chmod(0o600);
        const child = spawn(command.executable, command.arguments, {
            cwd: homedir(),
            detached: true,
            windowsHide: true,
            env: process.env,
            stdio: ["ignore", log.fd, log.fd],
        });
        await new Promise<void>((resolve, reject) => {
            child.once("spawn", resolve);
            child.once("error", reject);
        });
        child.unref();
    } finally {
        await log.close();
    }
    return logPath;
}

/** The caller PID when `argument` marks a detached reload worker. */
export function readDetachedReloadCaller(argument: string | undefined): number | undefined {
    if (argument === undefined || !argument.startsWith(WORKER_ARGUMENT)) return undefined;
    const pid = Number(argument.slice(WORKER_ARGUMENT.length));
    return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

/** The worker side: wait for the caller to exit, then run the ordinary graceful reload. */
export async function runDetachedAgentDaemonReload(callerPid: number): Promise<void> {
    const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);
    log(`Reloading Happy Agent once process ${String(callerPid)} exits.`);
    if (!(await waitForDaemonProcessExit(callerPid, CALLER_EXIT_TIMEOUT_MS))) {
        throw new AgentDaemonError(
            `Process ${String(callerPid)} did not exit; the daemon was left running.`,
        );
    }
    await runAgentDaemonCommand("reload", { log });
}
