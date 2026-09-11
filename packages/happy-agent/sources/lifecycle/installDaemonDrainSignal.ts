import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { HappyAgentDaemon } from "../main.js";
import { daemonProcessIdentity } from "./daemonProcessIdentity.js";
import {
    daemonDrainStatePath,
    removeDaemonDrainState,
    writeDaemonDrainState,
    type DaemonDrainState,
} from "./daemonDrainState.js";

/** OS-authorized control, separate from (and never weakening) HTTP authentication. */
export async function installDaemonDrainSignal(
    daemon: HappyAgentDaemon,
    directory: string,
): Promise<() => Promise<void>> {
    // Windows uses the authenticated daemon API for graceful draining.
    if (process.platform === "win32") return async () => {};
    const path = daemonDrainStatePath(directory);
    const initial: DaemonDrainState = {
        version: 1,
        pid: process.pid,
        instance: randomUUID(),
        processIdentity: await daemonProcessIdentity(process.pid),
        phase: "ready",
        waitingFor: [],
    };
    let stopped = false;
    let published = false;
    let pendingSignal = false;
    let work: Promise<void> | undefined;
    const abort = new AbortController();
    const onSignal = () => {
        if (stopped || work !== undefined) return;
        if (!published) {
            pendingSignal = true;
            return;
        }
        work = (async () => {
            daemon.drain();
            let previous = "";
            while (!stopped) {
                const waitingFor = [...daemon.drainProgress()];
                const phase = waitingFor.length === 0 ? "drained" : "draining";
                const snapshot = { ...initial, phase, waitingFor } satisfies DaemonDrainState;
                const encoded = JSON.stringify(snapshot);
                if (encoded !== previous) {
                    await writeDaemonDrainState(path, snapshot);
                    previous = encoded;
                }
                if (phase === "drained") return;
                await delay(250, undefined, { signal: abort.signal });
            }
        })().catch(async () => {
            if (stopped) return;
            process.stderr.write("Local daemon draining failed; inspect the daemon log.\n");
            await writeDaemonDrainState(path, { ...initial, phase: "failed" }).catch(
                () => undefined,
            );
        });
    };
    process.on("SIGUSR2", onSignal);
    try {
        // Publish signal support only after the handler is installed.
        await writeDaemonDrainState(path, initial);
        published = true;
        if (pendingSignal) onSignal();
    } catch (error) {
        process.removeListener("SIGUSR2", onSignal);
        throw error;
    }
    return async () => {
        stopped = true;
        abort.abort();
        await work;
        await removeDaemonDrainState(path, initial.instance);
        process.removeListener("SIGUSR2", onSignal);
    };
}
