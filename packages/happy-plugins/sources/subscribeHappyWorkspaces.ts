import { openHappyPluginEventStream } from "./openHappyPluginEventStream.js";
import type { HappyMcpTransport } from "./startHappyMcpServer.js";
import {
    happyWorkspaceEventSchema,
    type HappyWorkspaceEvent,
    type HappyWorkspaceSubscription,
} from "./types.js";

export async function subscribeHappyWorkspaces(
    handler: (event: HappyWorkspaceEvent) => void | Promise<void>,
    transport: HappyMcpTransport,
): Promise<HappyWorkspaceSubscription> {
    let closing = false;
    let failure: string | undefined;
    let status: HappyWorkspaceSubscription["status"] = "connected";
    const stream = await openHappyPluginEventStream({
        eventSchema: happyWorkspaceEventSchema,
        label: "workspace",
        onEvent: (event) =>
            Promise.resolve()
                .then(() => handler(event))
                .catch((error: unknown) => {
                    warn(`The Happy workspace subscriber failed. ${errorToMessage(error)}`);
                }),
        path: "/workspaces/events",
        socketPath: transport.socketPath,
        token: transport.token,
    });
    void stream.closed.then((error) => {
        status = "closed";
        if (closing) return;
        failure = error.message;
        warn(`The Happy workspace stream closed. ${error.message}`);
    });
    return {
        get failure() {
            return failure;
        },
        get status() {
            return status;
        },
        async close() {
            if (closing) return;
            closing = true;
            status = "closed";
            stream.close();
            await stream.closed;
        },
    };
}

function errorToMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function warn(message: string): void {
    try {
        console.warn(message);
    } catch {
        // Plugin logging is diagnostic and cannot fail workspace event delivery.
    }
}
