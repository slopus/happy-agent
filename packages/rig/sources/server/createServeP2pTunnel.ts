import { request as sendHttpRequest, type IncomingMessage } from "node:http";
import { PassThrough, type Duplex } from "node:stream";

import {
    selectP2pTunnelResponseHeaders,
    selectP2pTunnelRequestHeaders,
    type P2pTunnelConnection,
    type P2pTunnelRequestHead,
    type ServeP2pTunnel,
} from "../p2p/index.js";
import { matchHttpProxyRoute } from "./attachHttpConnectProxy.js";
import { matchRemoteTerminalAttachRoute } from "./attachRemoteTerminalWebSocketServer.js";

export function createServeP2pTunnel(options: {
    socketPath: string;
    token: string;
}): ServeP2pTunnel {
    return async (peerId, request, signal) => {
        if (!isAllowedTunnelRequest(request)) {
            return closedTunnel(403);
        }
        return await openLocalTunnel(options, peerId, request, signal);
    };
}

function isAllowedTunnelRequest(request: P2pTunnelRequestHead): boolean {
    return request.method === "GET"
        ? matchRemoteTerminalAttachRoute(request.path) !== undefined
        : matchHttpProxyRoute(request.path) !== undefined;
}

function openLocalTunnel(
    options: { socketPath: string; token: string },
    peerId: string,
    tunnel: P2pTunnelRequestHead,
    signal: AbortSignal,
): Promise<P2pTunnelConnection> {
    return new Promise((resolve, reject) => {
        if (signal.aborted) return reject(new Error("The peer cancelled the tunnel."));
        let settled = false;
        const request = sendHttpRequest({
            headers: {
                ...selectP2pTunnelRequestHeaders(tunnel.headers),
                authorization: `Bearer ${options.token}`,
                "x-rig-p2p-peer": peerId,
            },
            method: tunnel.method,
            path: tunnel.path,
            socketPath: options.socketPath,
        });
        const abort = () => request.destroy(new Error("The peer cancelled the tunnel."));
        const finish = (response: IncomingMessage, socket: Duplex, head: Buffer): void => {
            if (settled) {
                socket.destroy();
                return;
            }
            settled = true;
            if (head.byteLength > 0) socket.unshift(head);
            const cleanup = () => signal.removeEventListener("abort", abort);
            socket.once("close", cleanup);
            resolve({
                response: {
                    headers: selectP2pTunnelResponseHeaders(response.headers),
                    status: response.statusCode ?? 502,
                },
                stream: socket,
            });
        };
        request.once("upgrade", finish);
        request.once("connect", finish);
        request.once("response", (response) => {
            response.resume();
            if (settled) return;
            settled = true;
            signal.removeEventListener("abort", abort);
            resolve(closedTunnel(response.statusCode ?? 502, response.headers));
        });
        request.once("error", (error) => {
            signal.removeEventListener("abort", abort);
            if (!settled) reject(error);
        });
        signal.addEventListener("abort", abort, { once: true });
        request.end();
    });
}

function closedTunnel(
    status: number,
    headers: IncomingMessage["headers"] = {},
): P2pTunnelConnection {
    const stream = new PassThrough();
    stream.end();
    return {
        response: { headers: selectP2pTunnelResponseHeaders(headers), status },
        stream,
    };
}
