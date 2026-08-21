import { readPackageVersion } from "../readPackageVersion.js";

/** How the daemon identifies itself, so a launcher can tell whether a running daemon matches. */
export interface AgentDaemonIdentity {
    version: string;
}

export function getDaemonIdentity(version: string = readPackageVersion()): AgentDaemonIdentity {
    return { version };
}
