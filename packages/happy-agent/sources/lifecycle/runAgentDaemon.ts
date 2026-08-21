import { startHappyAgentDaemon, type HappyAgentDaemon } from "../main.js";
import { createGymInferenceFromEnvironment } from "./gymInference.js";
import { getDaemonIdentity } from "./getDaemonIdentity.js";
import { getHappyDaemonPaths } from "./getHappyDaemonPaths.js";

/**
 * Runs the daemon in the foreground of the current process: the complete Happy agent behind its
 * private Unix socket. The process stays alive while the socket serves and exits once the daemon
 * closes after a shutdown request or a termination signal.
 */
export async function runAgentDaemon(): Promise<HappyAgentDaemon> {
    const identity = getDaemonIdentity();
    const gymInference = createGymInferenceFromEnvironment();
    const daemon = await startHappyAgentDaemon({
        happyHome: getHappyDaemonPaths().happyHome,
        version: identity.version,
        ...(gymInference === undefined ? {} : { inference: gymInference }),
    });
    const stop = () => {
        void daemon.close().catch(() => undefined);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    return daemon;
}
