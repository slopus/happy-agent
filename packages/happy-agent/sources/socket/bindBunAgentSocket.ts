import { chmod, unlink } from "node:fs/promises";
import { join } from "node:path";
import { isWindowsNamedPipe, readAgentSocketInformation } from "./agentSocketPaths.js";

import {
    type PreparedHappyAgentRuntime,
    type PreparedTerminalSocket,
} from "@slopus/happy-agent-modules";
import { WebSocketDuplex } from "@slopus/happy-agent-modules/transport";

import {
    startBunSocketBridge,
    type BunRuntime as BunSocketRuntime,
    type BunSocketBridge,
    type BunSocketAddress,
} from "./BunSocketBridge.js";
import {
    bindNodeAgentSocket,
    prepareAgentSocketPath,
    type AgentDaemonPaths,
    type BoundAgentSocket,
} from "./AgentSocket.js";
import {
    createBunBinaryWebSocket,
    type BunServerWebSocket,
    type BunWebSocketState,
} from "./createBunBinaryWebSocket.js";
import { createBunHttpForwarder } from "./createBunHttpForwarder.js";
import { forwardBunRemoteAttachment } from "./forwardBunRemoteAttachment.js";

const MAX_TERMINAL_WIRE_MESSAGE_BYTES = 4 * 1024 * 1024 + 20;

interface TerminalWebSocketData extends BunWebSocketState {
    readonly prepared: Extract<PreparedTerminalSocket, { readonly attach: unknown }>;
}

interface BunTerminalWebSocket extends BunServerWebSocket {
    data: TerminalWebSocketData;
}

export interface BunWebSocketServer {
    readonly hostname: string;
    readonly port: number;
    stop(closeActiveConnections?: boolean): Promise<void> | void;
    upgrade(request: Request, options: { readonly data: TerminalWebSocketData }): boolean;
    timeout(request: Request, seconds: number): void;
}

interface BunRuntime extends BunSocketRuntime {
    serve(options: Record<string, unknown>): BunWebSocketServer;
}

export async function bindBunAgentSocket(
    prepared: PreparedHappyAgentRuntime,
    paths: AgentDaemonPaths,
): Promise<BoundAgentSocket> {
    const bun = bunRuntime();
    const httpSocketPath = join(paths.agentHome, "h.sock");
    const proxyHttpSocketPath = join(paths.agentHome, "p.sock");
    const nativeHttpSocketPath = join(paths.agentHome, "w.sock");
    const forwarder = createBunHttpForwarder(httpSocketPath);
    await Promise.all([
        prepareAgentSocketPath(paths.socketPath),
        prepareAgentSocketPath(proxyHttpSocketPath),
        prepareAgentSocketPath(nativeHttpSocketPath),
    ]);

    let http: BoundAgentSocket | undefined;
    let nativeHttp: BunWebSocketServer | undefined;
    let bridge: BunSocketBridge | undefined;
    const previousUmask = process.umask(0o077);
    try {
        http = await bindNodeAgentSocket(prepared, httpSocketPath);
        await prepared.api.listenWorkspaceProxyHttp(proxyHttpSocketPath);
        nativeHttp = startBunHttpServer(bun, prepared, { unix: nativeHttpSocketPath }, forwarder);
        bridge = startBunSocketBridge(bun, {
            forwardRemoteAttachment: (head, stream, bytes) =>
                forwardBunRemoteAttachment(prepared, head, stream, bytes),
            httpAddress: { unix: nativeHttpSocketPath },
            prepareWorkspaceProxy: async (pathname, authorization) =>
                await prepared.api.prepareWorkspaceProxySocket(
                    prepared.context("bun-http-connect"),
                    pathname,
                    authorization,
                ),
            proxyHttpAddress: { unix: proxyHttpSocketPath },
            publicAddress: { unix: paths.socketPath },
        });
        await Promise.all(
            [paths.socketPath, proxyHttpSocketPath, nativeHttpSocketPath]
                .filter((path) => !isWindowsNamedPipe(path))
                .map((path) => chmod(path, 0o600)),
        );
    } catch (error) {
        bridge?.close();
        forwarder.close();
        await Promise.resolve(nativeHttp?.stop(true)).catch(() => undefined);
        await http?.close().catch(() => undefined);
        await Promise.all([
            removeOwnedSocket(paths.socketPath),
            removeOwnedSocket(nativeHttpSocketPath),
        ]);
        throw error;
    } finally {
        process.umask(previousUmask);
    }

    let closing: Promise<void> | undefined;
    return {
        socketPath: paths.socketPath,
        close: () => {
            closing ??= (async () => {
                bridge!.close();
                forwarder.close();
                await Promise.resolve(nativeHttp!.stop(true));
                await http!.close();
                await Promise.all([
                    removeOwnedSocket(paths.socketPath),
                    removeOwnedSocket(nativeHttpSocketPath),
                ]);
            })();
            return closing;
        },
    };
}

export function startBunHttpServer(
    bun: BunRuntime,
    prepared: PreparedHappyAgentRuntime,
    address: BunSocketAddress,
    forwarder: ReturnType<typeof createBunHttpForwarder>,
): BunWebSocketServer {
    return bun.serve({
        ...address,
        idleTimeout: 60,
        // The shared API owns its per-route streaming body limits.
        maxRequestBodySize: Number.MAX_SAFE_INTEGER,
        async fetch(request: Request, server: BunWebSocketServer) {
            if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
                server.timeout(request, 0);
                try {
                    return await forwarder.forward(request, () => server.timeout(request, 60));
                } catch {
                    server.timeout(request, 60);
                    return socketResponse(
                        500,
                        "internal",
                        "The API connection could not be completed.",
                    );
                }
            }
            const pathname = new URL(request.url).pathname;
            const terminal = await prepared.api.prepareTerminalSocket(
                prepared.context("bun-websocket-upgrade"),
                pathname,
                request.headers.get("authorization") ?? undefined,
            );
            if (!terminal.handled) {
                return socketResponse(404, "not_found", "The requested endpoint does not exist.");
            }
            if ("rejection" in terminal) {
                return socketResponse(
                    terminal.rejection.status,
                    terminal.rejection.code,
                    terminal.rejection.message,
                );
            }
            const data: TerminalWebSocketData = { handlers: undefined, prepared: terminal };
            if (server.upgrade(request, { data })) return undefined;
            return socketResponse(500, "internal", "The terminal upgrade could not be completed.");
        },
        websocket: {
            maxPayloadLength: MAX_TERMINAL_WIRE_MESSAGE_BYTES,
            open(webSocket: BunTerminalWebSocket) {
                try {
                    webSocket.data.prepared.attach(
                        new WebSocketDuplex(createBunBinaryWebSocket(webSocket, webSocket.data)),
                    );
                } catch (error) {
                    webSocket.data.handlers?.error(
                        error instanceof Error ? error : new Error(String(error)),
                    );
                    webSocket.close(1011, "The terminal could not be attached.");
                }
            },
            message(webSocket: BunTerminalWebSocket, message: string | Uint8Array) {
                if (typeof message === "string") {
                    webSocket.data.handlers?.error(
                        new Error("Remote terminal WebSocket messages must be binary."),
                    );
                    webSocket.close(1003, "Binary messages are required.");
                    return;
                }
                webSocket.data.handlers?.message(Buffer.from(message));
            },
            close(webSocket: BunTerminalWebSocket) {
                webSocket.data.handlers?.close();
            },
            error(webSocket: BunTerminalWebSocket, error: Error) {
                webSocket.data.handlers?.error(error);
            },
        },
    });
}

function socketResponse(status: number, code: string, message: string): Response {
    return Response.json(
        { error: message, code },
        {
            headers: { "cache-control": "no-store" },
            status,
        },
    );
}

export function bunRuntime(): BunRuntime {
    const bun = (globalThis as { Bun?: unknown }).Bun;
    if (
        typeof bun !== "object" ||
        bun === null ||
        !("listen" in bun) ||
        typeof bun.listen !== "function" ||
        !("connect" in bun) ||
        typeof bun.connect !== "function" ||
        !("serve" in bun) ||
        typeof bun.serve !== "function"
    ) {
        throw new Error("The Bun socket runtime is unavailable.");
    }
    return bun as BunRuntime;
}

async function removeOwnedSocket(path: string): Promise<void> {
    if (isWindowsNamedPipe(path)) return;
    try {
        const information = await readAgentSocketInformation(path);
        if (
            information.isSocket() &&
            (process.getuid === undefined ||
                typeof information.uid !== "number" ||
                information.uid === process.getuid())
        ) {
            await unlink(path);
        }
    } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
            throw error;
        }
    }
}
