import type { DaemonRestartRequest } from "../client/index.js";

export function formatDaemonRestartMessage(request: DaemonRestartRequest): string {
    return `The running daemon uses Happy Terminal ${request.runningIdentity.version}, but this CLI is Happy Terminal ${request.currentIdentity.version}. Restart the daemon to use this CLI.`;
}
