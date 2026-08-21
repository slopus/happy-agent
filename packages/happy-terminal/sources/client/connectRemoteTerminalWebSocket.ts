import type { Duplex } from "node:stream";

import WebSocket from "ws";

import { WebSocketDuplex } from "./WebSocketDuplex.js";

const MAX_WIRE_MESSAGE_BYTES = 4 * 1024 * 1024 + 20;

export function connectRemoteTerminalWebSocket(options: {
    path: string;
    socketPath: string;
    token: string;
}): Promise<Duplex> {
    return new Promise((resolve, reject) => {
        const webSocket = new WebSocket(`ws+unix://${options.socketPath}:${options.path}`, {
            handshakeTimeout: 10_000,
            headers: { authorization: `Bearer ${options.token}` },
            maxPayload: MAX_WIRE_MESSAGE_BYTES,
            perMessageDeflate: false,
        });
        let settled = false;
        const fail = (error: Error) => {
            if (settled) return;
            settled = true;
            webSocket.terminate();
            reject(error);
        };
        webSocket.once("error", fail);
        webSocket.once("unexpected-response", (_request, response) => {
            response.resume();
            fail(
                new Error(
                    `Remote terminal WebSocket failed with HTTP ${response.statusCode ?? 500}.`,
                ),
            );
        });
        webSocket.once("open", () => {
            if (settled) return;
            settled = true;
            webSocket.off("error", fail);
            resolve(new WebSocketDuplex(webSocket));
        });
    });
}
