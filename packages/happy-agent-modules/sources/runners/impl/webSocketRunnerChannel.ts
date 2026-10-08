import type { RunnerChannel } from "@slopus/happy-agent-compute";

import type { BinaryWebSocket } from "../../transport/BinaryWebSocket.js";

/** A runner connection over an authenticated WebSocket: one binary message is one frame. */
export function webSocketRunnerChannel(webSocket: BinaryWebSocket): RunnerChannel {
    let closed = false;
    let unsubscribe: (() => void) | undefined;
    let receiver: Parameters<RunnerChannel["receive"]>[0] | undefined;
    let closeReason: string | undefined;
    const finish = (reason: string) => {
        if (closed) return;
        closed = true;
        unsubscribe?.();
        if (receiver === undefined) closeReason = reason;
        else receiver.close(reason);
    };
    return {
        send(frame) {
            if (closed) return;
            webSocket.send(frame, (error) => {
                if (error !== undefined) {
                    webSocket.close();
                    finish("The runner connection could not be written to.");
                }
            });
        },
        close(reason) {
            if (closed) return;
            webSocket.close();
            finish(reason);
        },
        receive(next) {
            if (receiver !== undefined) throw new Error("A runner channel has one receiver.");
            receiver = next;
            if (closeReason !== undefined) {
                next.close(closeReason);
                return;
            }
            unsubscribe = webSocket.subscribe({
                message: (data) => {
                    if (!closed) next.frame(data);
                },
                error: () => {
                    webSocket.close();
                    finish("The runner connection failed.");
                },
                close: () => finish("The runner closed its connection."),
            });
        },
    };
}
