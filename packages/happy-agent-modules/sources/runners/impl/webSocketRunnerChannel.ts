import type { RunnerChannel } from "@slopus/happy-agent-compute";

import type { BinaryWebSocket } from "../../transport/BinaryWebSocket.js";

/** A runner channel that can say when its WebSocket has really closed. */
export interface WebSocketRunnerChannel extends RunnerChannel {
    /**
     * Resolves once the WebSocket itself has closed, which is after every frame sent before
     * {@link RunnerChannel.close} has been handed to the transport. Shutdown waits on it, so a
     * goodbye is not cut off by whatever tears the transport down next.
     */
    readonly ended: Promise<void>;
}

/** A runner connection over an authenticated WebSocket: one binary message is one frame. */
export function webSocketRunnerChannel(webSocket: BinaryWebSocket): WebSocketRunnerChannel {
    let closed = false;
    let receiver: Parameters<RunnerChannel["receive"]>[0] | undefined;
    let closeReason: string | undefined;
    // Frames that arrive before the protocol installs its receiver, which it does at once.
    const early: Uint8Array[] = [];
    let resolveEnded!: () => void;
    const ended = new Promise<void>((resolve) => {
        resolveEnded = resolve;
    });
    const finish = (reason: string) => {
        if (closed) return;
        closed = true;
        if (receiver === undefined) closeReason = reason;
        else receiver.close(reason);
    };
    // Subscribed for the channel's whole life, not only while a receiver listens: the close that
    // follows our own close is what `ended` waits for.
    webSocket.subscribe({
        message: (data) => {
            if (closed) return;
            if (receiver === undefined) early.push(data);
            else receiver.frame(data);
        },
        error: () => {
            webSocket.close();
            finish("The runner connection failed.");
            resolveEnded();
        },
        close: () => {
            finish("The runner closed its connection.");
            resolveEnded();
        },
    });
    return {
        ended,
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
            for (const frame of early.splice(0)) next.frame(frame);
            if (closeReason !== undefined) next.close(closeReason);
        },
    };
}
