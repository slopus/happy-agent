import type { Server } from "node:http";
import type { Duplex } from "node:stream";

import { WebSocketServer } from "ws";

import { WebSocketDuplex } from "../terminal/WebSocketDuplex.js";
import { createNodeBinaryWebSocket } from "../terminal/createNodeBinaryWebSocket.js";
import { isAuthorizedProtocolRequest } from "./isAuthorizedProtocolRequest.js";
import { matchP2pPeerRoute } from "./matchP2pPeerRoute.js";
import type { SessionStore } from "../session/SessionStore.js";

const MAX_WIRE_MESSAGE_BYTES = 4 * 1024 * 1024 + 20;

export function attachRemoteTerminalWebSocketServer(options: {
    server: Server;
    store: SessionStore;
    token: string;
}): void {
    const webSocketServer = new WebSocketServer({
        maxPayload: MAX_WIRE_MESSAGE_BYTES,
        noServer: true,
        perMessageDeflate: false,
    });
    options.server.on("upgrade", (request, socket, head) => {
        if (matchP2pPeerRoute(request.url) !== undefined) return;
        const route = matchRemoteTerminalAttachRoute(request.url);
        if (route === undefined) {
            rejectUpgrade(socket, 404, "Not Found");
            return;
        }
        if (!isAuthorizedProtocolRequest(request, options.token)) {
            rejectUpgrade(socket, 401, "Unauthorized");
            return;
        }
        const terminal = options.store.remoteTerminals.get(route.scope, route.terminalId);
        if (terminal === undefined) {
            rejectUpgrade(socket, 404, "Not Found");
            return;
        }
        webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
            const stream = new WebSocketDuplex(createNodeBinaryWebSocket(webSocket));
            const detach = terminal.attach(stream);
            stream.once("close", detach);
        });
    });

    const closeAllConnections = options.server.closeAllConnections.bind(options.server);
    options.server.closeAllConnections = () => {
        for (const client of webSocketServer.clients) client.terminate();
        closeAllConnections();
    };
}

export function matchRemoteTerminalAttachRoute(requestUrl: string | undefined):
    | {
          scope: { projectId: string; workspaceId?: string };
          terminalId: string;
      }
    | undefined {
    try {
        const pathname = new URL(requestUrl ?? "/", "http://unix").pathname;
        const parts = pathname.split("/").filter(Boolean);
        if (
            parts.length === 5 &&
            parts[0] === "projects" &&
            parts[2] === "terminals" &&
            parts[4] === "attach"
        ) {
            return {
                scope: { projectId: decodeURIComponent(parts[1]!) },
                terminalId: decodeURIComponent(parts[3]!),
            };
        }
        if (
            parts.length === 7 &&
            parts[0] === "projects" &&
            parts[2] === "workspaces" &&
            parts[4] === "terminals" &&
            parts[6] === "attach"
        ) {
            return {
                scope: {
                    projectId: decodeURIComponent(parts[1]!),
                    workspaceId: decodeURIComponent(parts[3]!),
                },
                terminalId: decodeURIComponent(parts[5]!),
            };
        }
        return undefined;
    } catch {
        return undefined;
    }
}

function rejectUpgrade(socket: Duplex, statusCode: number, statusText: string): void {
    socket.end(
        `HTTP/1.1 ${statusCode} ${statusText}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
        () => socket.destroy(),
    );
}
