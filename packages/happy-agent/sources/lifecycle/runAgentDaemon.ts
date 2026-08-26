import { startHappyAgentDaemon, type HappyAgentDaemon } from "../main.js";
import { syncHappyAgentDocs } from "../documentation/syncHappyAgentDocs.js";
import { removeDaemonPidSync } from "./daemonPid.js";
import { createGymInferenceFromEnvironment } from "./gymInference.js";
import { getDaemonIdentity } from "./getDaemonIdentity.js";
import { getHappyDaemonPaths } from "./getHappyDaemonPaths.js";

export interface RunAgentDaemonOptions {
    /** False only when a test embeds the daemon inside a process it must not kill. */
    readonly persistPid?: boolean;
    /** Hard-exit after graceful shutdown so unrelated dangling work cannot retain the process. */
    readonly hardExit?: boolean;
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
    await syncHappyAgentDocs(paths.happyHome);
    const persistPid = options.persistPid ?? true;
    const hardExit = options.hardExit ?? persistPid;
    if (persistPid) {
        process.once("exit", () => removeDaemonPidSync(paths.pidPath, process.pid));
    }
    const daemon = await startHappyAgentDaemon({
        happyHome: paths.happyHome,
        persistPid,
        version: identity.version,
        ...(gymInference === undefined ? {} : { inference: gymInference }),
    });
    if (hardExit) {
        void daemon.closed.then(
            () => process.exit(0),
            (error: unknown) => {
                process.stderr.write(
                    `Daemon shutdown failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
                );
                process.exit(1);
            },
        );
    }
    const stop = (signal: "SIGINT" | "SIGTERM") => {
        const reason = signal === "SIGINT" ? "sigint" : "sigterm";
        void daemon.close(reason).catch((error: unknown) => {
            if (hardExit) return;
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
