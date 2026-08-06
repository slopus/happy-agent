import type { Server } from "node:http";
import type { Duplex } from "node:stream";

import { isAuthorizedProtocolRequest } from "./isAuthorizedProtocolRequest.js";

const SSH_BRIDGE_PATH = "/p2p/transports/ssh";

export function attachP2pSshBridge(
    server: Server,
    token: string,
    accept: ((stream: Duplex) => Promise<void>) | undefined,
): void {
    const bridges = new Set<Duplex>();
    server.on("connect", (request, client, head) => {
        if (request.url !== SSH_BRIDGE_PATH) return;
        if (!isAuthorizedProtocolRequest(request, token)) {
            client.end(
                'HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Bearer realm="Rig"\r\nConnection: close\r\n\r\n',
            );
            return;
        }
        if (accept === undefined) {
            client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
            return;
        }
        bridges.add(client);
        client.once("close", () => bridges.delete(client));
        client.once("error", () => client.destroy());
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.byteLength > 0) client.unshift(head);
        client.resume();
        void accept(client).catch(() => client.destroy());
    });
    server.once("close", () => {
        for (const bridge of bridges) bridge.destroy();
        bridges.clear();
    });
}
