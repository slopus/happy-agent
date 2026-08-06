import { createServer, type IncomingMessage, type Server } from "node:http";
import { connect } from "node:net";
import type { Duplex } from "node:stream";

import { isAuthorizedProtocolRequest } from "./isAuthorizedProtocolRequest.js";
import { matchP2pPeerRoute } from "./matchP2pPeerRoute.js";
import { proxyHttpRequest } from "./proxyHttpRequest.js";
import { resolveHttpProxyProjectScope } from "./resolveHttpProxyProjectScope.js";
import type { ProjectScope } from "../protocol/index.js";
import type { SessionStore } from "../session/SessionStore.js";

export function attachHttpConnectProxy(server: Server, token: string, store: SessionStore): void {
    const tunnels = new Set<Duplex>();
    const proxyServer = createServer(proxyHttpRequest);
    proxyServer.on("connect", (request, client, head) => {
        connectProxyTarget(request, client, head, tunnels);
    });
    proxyServer.on("clientError", (_error, socket) => socket.destroy());
    const closeTunnels = () => {
        for (const socket of tunnels) socket.destroy();
        tunnels.clear();
    };
    const closeServer = server.close.bind(server);
    server.close = ((callback?: (error?: Error) => void) => {
        closeTunnels();
        return closeServer(callback);
    }) as Server["close"];
    server.on("connect", (request, client, head) => {
        if (request.url === "/p2p/transports/ssh") return;
        if (matchP2pPeerRoute(request.url) !== undefined) return;
        const scope = matchHttpProxyRoute(request.url);
        if (scope === undefined) {
            client.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
            return;
        }
        if (!isAuthorizedProtocolRequest(request, token)) {
            client.end(
                'HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Bearer realm="Rig"\r\nConnection: close\r\n\r\n',
            );
            return;
        }

        const resolution = resolveHttpProxyProjectScope(scope, store);
        if (!resolution.allowed) {
            endWithStatus(client, resolution);
            return;
        }

        tunnels.add(client);
        client.once("close", () => tunnels.delete(client));
        client.once("error", () => client.destroy());
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        proxyServer.emit("connection", client);
        if (head.length > 0) client.unshift(head);
        client.resume();
    });
}

function connectProxyTarget(
    request: IncomingMessage,
    client: Duplex,
    head: Buffer,
    tunnels: Set<Duplex>,
): void {
    const target = parseAuthority(request.url);
    if (target === undefined) {
        client.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
        return;
    }

    const upstream = connect(target);
    tunnels.add(upstream);
    let connected = false;
    client.once("close", () => upstream.destroy());
    client.once("error", () => upstream.destroy());
    upstream.once("close", () => {
        tunnels.delete(upstream);
        client.destroy();
    });
    upstream.once("error", () => {
        if (!connected && !client.destroyed) {
            client.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
        } else {
            client.destroy();
        }
        upstream.destroy();
    });
    upstream.once("connect", () => {
        connected = true;
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length > 0) upstream.write(head);
        client.pipe(upstream);
        upstream.pipe(client);
    });
}

export function matchHttpProxyRoute(value: string | undefined): ProjectScope | undefined {
    if (value === undefined) return undefined;
    const match = /^\/projects\/([^/]+)(?:\/workspaces\/([^/]+))?\/proxy$/u.exec(value);
    if (match?.[1] === undefined) return undefined;
    try {
        const projectId = decodeURIComponent(match[1]);
        const workspaceId = match[2] === undefined ? undefined : decodeURIComponent(match[2]);
        if (projectId.length === 0 || workspaceId?.length === 0) return undefined;
        return {
            projectId,
            ...(workspaceId === undefined ? {} : { workspaceId }),
        };
    } catch {
        return undefined;
    }
}

function endWithStatus(
    client: Duplex,
    failure: { message: string; statusCode: number; statusText: string },
): void {
    client.end(
        `HTTP/1.1 ${String(failure.statusCode)} ${failure.statusText}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${String(Buffer.byteLength(failure.message))}\r\n\r\n${failure.message}`,
    );
}

function parseAuthority(value: string | undefined): { host: string; port: number } | undefined {
    if (value === undefined) return undefined;
    try {
        const target = new URL(`http://${value}`);
        const port = target.port.length === 0 ? 443 : Number(target.port);
        if (
            target.username.length > 0 ||
            target.password.length > 0 ||
            target.pathname !== "/" ||
            !Number.isSafeInteger(port) ||
            port < 1 ||
            port > 65_535
        ) {
            return undefined;
        }
        return { host: target.hostname, port };
    } catch {
        return undefined;
    }
}
