import { STATUS_CODES, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";

import type { P2pNetwork, P2pTunnelRequestHead } from "../p2p/index.js";
import { selectP2pTunnelRequestHeaders } from "../p2p/index.js";
import { isAuthorizedProtocolRequest } from "./isAuthorizedProtocolRequest.js";
import { matchHttpProxyRoute } from "./attachHttpConnectProxy.js";
import { matchP2pPeerRoute } from "./matchP2pPeerRoute.js";
import { matchRemoteTerminalAttachRoute } from "./attachRemoteTerminalWebSocketServer.js";

export function attachP2pPeerTunnels(options: {
    network?: P2pNetwork;
    server: Server;
    token: string;
}): void {
    const active = new Set<Duplex>();
    const handle = (
        request: IncomingMessage,
        socket: Duplex,
        head: Buffer,
        method: "CONNECT" | "GET",
    ): void => {
        const route = matchP2pPeerRoute(request.url);
        if (route === undefined) return;
        if (!isAuthorizedProtocolRequest(request, options.token)) {
            reject(socket, 401, "Unauthorized");
            return;
        }
        if (
            options.network === undefined ||
            (method === "GET"
                ? matchRemoteTerminalAttachRoute(route.path) === undefined
                : matchHttpProxyRoute(route.path) === undefined)
        ) {
            reject(socket, 404, "Not Found");
            return;
        }
        const controller = new AbortController();
        const close = () => controller.abort();
        socket.once("close", close);
        const requestHead: P2pTunnelRequestHead = {
            headers: method === "GET" ? selectP2pTunnelRequestHeaders(request.headers) : {},
            method,
            path: route.path,
        };
        void options.network
            .openTunnel(route.peerId, requestHead, controller.signal)
            .then(({ connection, transport }) => {
                if (controller.signal.aborted) {
                    connection.stream.destroy();
                    return;
                }
                const expected = method === "GET" ? 101 : 200;
                const headers = {
                    ...connection.response.headers,
                    "x-rig-p2p-peer": route.peerId,
                    "x-rig-p2p-transport": transport,
                };
                socket.write(serializeResponse(connection.response.status, headers));
                if (connection.response.status !== expected) {
                    socket.end();
                    connection.stream.destroy();
                    return;
                }
                active.add(socket);
                active.add(connection.stream);
                const cleanup = () => {
                    active.delete(socket);
                    active.delete(connection.stream);
                    socket.destroy();
                    connection.stream.destroy();
                };
                socket.once("error", cleanup);
                connection.stream.once("error", cleanup);
                socket.once("close", cleanup);
                connection.stream.once("close", cleanup);
                if (head.byteLength > 0) connection.stream.write(head);
                socket.pipe(connection.stream);
                connection.stream.pipe(socket);
            })
            .catch(() => {
                if (!socket.destroyed) reject(socket, 502, "Bad Gateway");
            });
    };
    options.server.on("upgrade", (request, socket, head) => handle(request, socket, head, "GET"));
    options.server.on("connect", (request, socket, head) =>
        handle(request, socket, head, "CONNECT"),
    );
    options.server.once("close", () => {
        for (const stream of active) stream.destroy();
        active.clear();
    });
}

function serializeResponse(status: number, headers: Readonly<Record<string, string>>): string {
    const lines = [
        `HTTP/1.1 ${String(status)} ${STATUS_CODES[status] ?? "Response"}`,
        ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
        "",
        "",
    ];
    return lines.join("\r\n");
}

function reject(socket: Duplex, status: number, text: string): void {
    socket.end(
        `HTTP/1.1 ${String(status)} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
        () => socket.destroy(),
    );
}
