import { setTimeout as delay } from "node:timers/promises";
import { AgentDaemonError } from "./AgentDaemonError.js";
import { daemonProcessIdentity } from "./daemonProcessIdentity.js";
import { daemonDrainStatePath, readDaemonDrainState } from "./daemonDrainState.js";
import { isDaemonProcessRunning, readDaemonPid } from "./daemonPid.js";
import type { HappyDaemonPaths } from "./getHappyDaemonPaths.js";
import { formatDrainProgress } from "./stopLocalProtocolServer.js";

/** Request and await draining without reading an API token or connecting to an API. */
export async function drainDaemonFromSignal(
    paths: Pick<HappyDaemonPaths, "directory" | "pidPath">,
    log: (message: string) => void,
): Promise<void> {
    const pid = await readDaemonPid(paths.pidPath);
    if (pid === undefined || !(await isDaemonProcessRunning(pid))) {
        throw new AgentDaemonError("The daemon is not running; no drain was performed.");
    }
    if (pid === process.pid) throw new AgentDaemonError("Run drain from a separate local process.");
    const path = daemonDrainStatePath(paths.directory);
    const initial = await readInitialState(path).catch(() => {
        throw new AgentDaemonError("This daemon has no usable local signal-drain status.", {
            hint: "It may still be starting or may predate signal support. No signal was sent. Use its supported maintenance flow.",
        });
    });
    if (initial.pid !== pid || initial.processIdentity !== (await daemonProcessIdentity(pid))) {
        throw new AgentDaemonError(
            "The daemon's local drain status belongs to another process. No signal was sent.",
        );
    }
    if (initial.phase === "failed")
        throw new AgentDaemonError("Daemon draining previously failed; inspect its log.");
    if (initial.phase === "ready") {
        try {
            process.kill(pid, "SIGUSR2");
        } catch {
            throw new AgentDaemonError("Could not signal the daemon; draining was not confirmed.", {
                hint: "Run the command as the daemon's service user or an authorized administrator, and check that the same process is still running.",
            });
        }
    }
    log(
        "Waiting for the daemon to drain. No new work will be admitted; the daemon will stay running.",
    );
    const acknowledgementDeadline = Date.now() + 10_000;
    let previous = "";
    for (;;) {
        const state = await readDaemonDrainState(path).catch(() => {
            throw new AgentDaemonError(
                "Local drain status became unavailable; completion was not confirmed.",
            );
        });
        if (
            state.instance !== initial.instance ||
            (await readDaemonPid(paths.pidPath)) !== pid ||
            !(await isDaemonProcessRunning(pid))
        ) {
            throw new AgentDaemonError(
                "The daemon exited or was replaced before draining was confirmed.",
            );
        }
        if (state.phase === "failed")
            throw new AgentDaemonError("Daemon draining failed; inspect its log.");
        if (state.phase === "ready") {
            if (Date.now() >= acknowledgementDeadline) {
                throw new AgentDaemonError(
                    "The daemon did not acknowledge the drain signal. It was not stopped.",
                );
            }
        } else {
            const message = formatDrainProgress(state.waitingFor);
            if (message !== previous) log(message);
            previous = message;
            if (state.phase === "drained") {
                log(
                    "The daemon is drained and still running. Stop its service before backing up or replacing it.",
                );
                return;
            }
        }
        await delay(250);
    }
}

async function readInitialState(path: string) {
    // HTTP readiness can become visible just before the foreground runner installs OS control.
    const deadline = Date.now() + 5_000;
    for (;;) {
        try {
            return await readDaemonDrainState(path);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT" || Date.now() >= deadline)
                throw error;
            await delay(100);
        }
    }
}
