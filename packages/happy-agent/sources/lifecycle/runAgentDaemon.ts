import { startHappyAgentDaemon, type HappyAgentDaemon } from "../main.js";
import { removeDaemonPidSync } from "./daemonPid.js";
import { createGymInferenceFromEnvironment } from "./gymInference.js";
import { getDaemonIdentity } from "./getDaemonIdentity.js";
import { getHappyDaemonPaths } from "./getHappyDaemonPaths.js";

export interface RunAgentDaemonOptions {
    /** False only when a test embeds the daemon inside a process it must not kill. */
    readonly persistPid?: boolean;
}

/**
 * Runs the daemon in the foreground of the current process: the complete Happy agent behind its
 * private Unix socket. The process stays alive while the socket serves and exits once the daemon
 * closes after a shutdown request or a termination signal.
 */
export async function runAgentDaemon(
    options: RunAgentDaemonOptions = {},
): Promise<HappyAgentDaemon> {
    const identity = getDaemonIdentity();
    const gymInference = createGymInferenceFromEnvironment();
    const paths = getHappyDaemonPaths();
    const persistPid = options.persistPid ?? true;
    if (persistPid) {
        process.once("exit", () => removeDaemonPidSync(paths.pidPath, process.pid));
    }
    const daemon = await startHappyAgentDaemon({
        happyHome: paths.happyHome,
        persistPid,
        version: identity.version,
        ...(gymInference === undefined ? {} : { inference: gymInference }),
    });
    const stop = (signal: "SIGINT" | "SIGTERM") => {
        const reason = signal === "SIGINT" ? "sigint" : "sigterm";
        void daemon.close(reason).catch((error: unknown) => {
            process.stderr.write(
                `Daemon shutdown failed after ${signal}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
            );
            process.exitCode = 1;
        });
    };
    process.once("SIGINT", () => stop("SIGINT"));
    process.once("SIGTERM", () => stop("SIGTERM"));
    return daemon;
}
