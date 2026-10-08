import { MAX_RUNNER_FRAME_BYTES, type RunnerChannel } from "@slopus/happy-agent-compute";
import type { createConnection } from "node:net";
import type { Duplex } from "node:stream";
import WebSocket, { type RawData } from "ws";

/** Why a connection attempt did not produce a channel. */
export class RunnerConnectError extends Error {
    override readonly name = "RunnerConnectError";

    /** The daemon refused the token, which retrying with the same token will not fix soon. */
    readonly refused: boolean;

    constructor(message: string, refused = false) {
        super(message);
        this.refused = refused;
    }
}

const CONNECT_TIMEOUT_MS = 20_000;

/**
 * Open the runner's connection to its daemon and hand it back as a runner channel.
 *
 * One binary WebSocket message is one frame. Anything else from the daemon — a text message, an
 * oversized message, a socket error — closes the channel with a reason the runner logs.
 */
export async function connectRunnerWebSocket(
    url: string,
    token: string,
    /** Opens the connection the WebSocket runs over, when the address alone cannot. */
    dial?: () => Promise<Duplex>,
): Promise<RunnerChannel> {
    let socket: Duplex | undefined;
    if (dial !== undefined) {
        try {
            socket = await dial();
        } catch (error) {
            throw new RunnerConnectError(
                `The daemon could not be reached: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }
    const opened = socket;
    const webSocket = new WebSocket(url, {
        headers: { authorization: `Bearer ${token}` },
        handshakeTimeout: CONNECT_TIMEOUT_MS,
        maxPayload: MAX_RUNNER_FRAME_BYTES,
        perMessageDeflate: false,
        ...(opened === undefined
            ? {}
            : { createConnection: (() => opened) as unknown as typeof createConnection }),
    });
    await new Promise<void>((resolve, reject) => {
        const fail = (error: RunnerConnectError) => {
            webSocket.removeAllListeners();
            webSocket.on("error", () => undefined);
            webSocket.terminate();
            reject(error);
        };
        webSocket.once("open", () => {
            webSocket.removeAllListeners();
            resolve();
        });
        webSocket.once("unexpected-response", (_request, response) => {
            const status = response.statusCode ?? 0;
            fail(
                status === 401
                    ? new RunnerConnectError("The daemon refused this runner's token.", true)
                    : status === 404
                      ? new RunnerConnectError(
                            "The daemon does not accept runners. It may be older than this runner, or have no runners configured.",
                            true,
                        )
                      : new RunnerConnectError(`The daemon answered with HTTP ${String(status)}.`),
            );
        });
        webSocket.once("error", (error) => {
            fail(new RunnerConnectError(`The daemon could not be reached: ${error.message}`));
        });
    });
    return clientRunnerChannel(webSocket);
}

function clientRunnerChannel(webSocket: WebSocket): RunnerChannel {
    let closed = false;
    let receiver: Parameters<RunnerChannel["receive"]>[0] | undefined;
    let pendingReason: string | undefined;
    const finish = (reason: string) => {
        if (closed) return;
        closed = true;
        if (receiver === undefined) pendingReason = reason;
        else receiver.close(reason);
    };
    const end = (reason: string) => {
        if (webSocket.readyState === WebSocket.OPEN) webSocket.close(1000);
        else webSocket.terminate();
        finish(reason);
    };
    webSocket.on("message", (data: RawData, isBinary: boolean) => {
        if (closed) return;
        if (!isBinary) {
            end("The daemon sent a text message, which the runner protocol does not use.");
            return;
        }
        receiver?.frame(rawDataBytes(data));
    });
    webSocket.on("close", (code, reason) => {
        const text = reason.toString("utf8");
        finish(
            text.length > 0
                ? `The daemon closed the connection: ${text}`
                : `The daemon's connection closed (${String(code)}).`,
        );
    });
    webSocket.on("error", (error) => end(`The connection to the daemon failed: ${error.message}`));
    webSocket.pause();
    return {
        send(frame) {
            if (closed) return;
            webSocket.send(frame, { binary: true, compress: false }, (error) => {
                if (error !== undefined && error !== null)
                    end(`The runner could not write to the daemon: ${error.message}`);
            });
        },
        close(reason) {
            end(reason);
        },
        receive(next) {
            if (receiver !== undefined) throw new Error("A runner channel has one receiver.");
            receiver = next;
            if (pendingReason !== undefined) {
                next.close(pendingReason);
                return;
            }
            webSocket.resume();
        },
    };
}

function rawDataBytes(data: RawData): Uint8Array {
    if (Array.isArray(data)) return Buffer.concat(data);
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    return data;
}
