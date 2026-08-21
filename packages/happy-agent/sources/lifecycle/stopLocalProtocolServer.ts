import type { HappyAgentClient } from "@slopus/happy-agent-client";

import { waitForSocketRemoval } from "./waitForSocketRemoval.js";

const DAEMON_SHUTDOWN_TIMEOUT_MS = 30_000;

export async function stopLocalProtocolServer(
    client: HappyAgentClient,
    socketPath: string,
): Promise<void> {
    try {
        await client.shutdown();
    } catch (error) {
        if (await waitForSocketRemoval(socketPath, DAEMON_SHUTDOWN_TIMEOUT_MS)) {
            return;
        }
        throw new Error(`Could not stop the existing local daemon: ${errorToMessage(error)}`);
    }
    if (!(await waitForSocketRemoval(socketPath, DAEMON_SHUTDOWN_TIMEOUT_MS))) {
        throw new Error(
            "Timed out while waiting for the existing local daemon to release its socket. A replacement was not started.",
        );
    }
}

function errorToMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
