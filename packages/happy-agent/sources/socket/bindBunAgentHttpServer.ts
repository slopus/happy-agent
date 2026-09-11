import { randomBytes } from "node:crypto";
import type { PreparedHappyAgentRuntime } from "@slopus/happy-agent-modules";

import { bindNodeAgentHttpServer, type BoundAgentHttpServer } from "./AgentSocket.js";
import { startBunSocketBridge, type BunSocketBridge } from "./BunSocketBridge.js";
import { bunRuntime, startBunHttpServer, type BunWebSocketServer } from "./bindBunAgentSocket.js";
import { createBunHttpForwarder } from "./createBunHttpForwarder.js";
import { forwardBunRemoteAttachment } from "./forwardBunRemoteAttachment.js";

/** Team TCP uses the same native Bun HTTP, WebSocket, and tunnel paths as standalone. */
export async function bindBunAgentHttpServer(
    prepared: PreparedHappyAgentRuntime,
    host: string,
    port: number,
): Promise<BoundAgentHttpServer> {
    const bun = bunRuntime();
    const http = await bindNodeAgentHttpServer(prepared, "127.0.0.1", 0);
    const forwarder = createBunHttpForwarder({ hostname: http.host, port: http.port });
    let nativeHttp: BunWebSocketServer | undefined;
    let bridge: BunSocketBridge | undefined;
    const close = async () => {
        bridge?.close();
        forwarder.close();
        try {
            await Promise.resolve(nativeHttp?.stop(true));
        } finally {
            await http.close();
        }
    };
    try {
        const proxyToken = randomBytes(32).toString("base64url");
        const proxyPort = await prepared.api.listenWorkspaceProxyTcp(proxyToken);
        nativeHttp = startBunHttpServer(
            bun,
            prepared,
            { hostname: "127.0.0.1", port: 0 },
            forwarder,
        );
        bridge = startBunSocketBridge(bun, {
            publicAddress: { hostname: host, port },
            httpAddress: { hostname: "127.0.0.1", port: nativeHttp.port },
            proxyHttpAddress: { hostname: "127.0.0.1", port: proxyPort },
            proxyHttpAuthorization: `Bearer ${proxyToken}`,
            prepareWorkspaceProxy: (pathname, authorization) =>
                prepared.api.prepareWorkspaceProxySocket(
                    prepared.context("bun-http-connect"),
                    pathname,
                    authorization,
                ),
            forwardRemoteAttachment: (head, stream, bytes) =>
                forwardBunRemoteAttachment(prepared, head, stream, bytes),
        });
        if (bridge.hostname === undefined || bridge.port === undefined) {
            throw new Error("The Happy Agent team HTTP listener has no TCP address.");
        }
    } catch (error) {
        await close().catch(() => undefined);
        throw error;
    }
    const boundHost = bridge.hostname;
    const boundPort = bridge.port;
    let closing: Promise<void> | undefined;
    return {
        host: boundHost,
        port: boundPort,
        url: `http://${boundHost.includes(":") ? `[${boundHost}]` : boundHost}:${boundPort}`,
        close: () => (closing ??= close()),
    };
}
