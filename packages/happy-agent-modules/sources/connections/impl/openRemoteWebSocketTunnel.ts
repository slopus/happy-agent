import type { IncomingMessage, OutgoingHttpHeaders } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, type RawData } from "ws";

import { WEBSOCKET_TUNNEL_MAX_MESSAGE_BYTES, WebSocketTunnel } from "../../transport/index.js";
import { RemoteConnectionError } from "../RemoteConnectionError.js";
import type {
    RemoteProxyExchange,
    RemoteProxyOptions,
    RemoteProxyReplacement,
} from "./RemoteProxyConnection.js";

const MAX_REFUSAL_BODY_BYTES = 64 * 1024;

/**
 * Carry a client's `CONNECT` over the remote's WebSocket twin of that tunnel, so nothing between
 * the daemon and the remote has to support `CONNECT`. The client receives the same
 * `200 Connection Established` and the same bytes it would through a `CONNECT`.
 */
export async function openRemoteWebSocketTunnel(options: {
    readonly url: string;
    readonly token: string;
    readonly client: Duplex;
    readonly head: Buffer;
    readonly idleMs: number;
    readonly screen: NonNullable<RemoteProxyOptions["screen"]>;
    readonly signal: AbortSignal;
}): Promise<RemoteProxyExchange> {
    const { client } = options;
    const exchange: RemoteProxyExchange = { streaming: true };
    const socket = new WebSocket(options.url, {
        headers: { authorization: `Bearer ${options.token}` },
        followRedirects: false,
        handshakeTimeout: 30_000,
        maxPayload: WEBSOCKET_TUNNEL_MAX_MESSAGE_BYTES,
        perMessageDeflate: false,
    });
    socket.binaryType = "nodebuffer";
    return await new Promise<RemoteProxyExchange>((resolve, reject) => {
        let settled = false;
        const settle = (error?: unknown) => {
            if (settled) return;
            settled = true;
            options.signal.removeEventListener("abort", abort);
            if (error === undefined) resolve(exchange);
            else reject(error);
        };
        const abort = () => {
            socket.terminate();
            client.destroy();
            settle(options.signal.reason);
        };
        options.signal.addEventListener("abort", abort, { once: true });
        socket.once("unexpected-response", (_request, response: IncomingMessage) => {
            void refuse(response, options).then(
                (answer) => {
                    exchange.status = answer.status;
                    exchange.respondedAt = performance.now();
                    client.end(answer.bytes);
                    socket.terminate();
                    settle();
                },
                (error: unknown) => {
                    socket.terminate();
                    settle(error);
                },
            );
        });
        socket.once("error", () => {
            if (exchange.status === undefined) settle(unavailable());
            else client.destroy();
        });
        socket.once("open", () => {
            exchange.status = 200;
            exchange.respondedAt = performance.now();
            client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
            const tunnel = new WebSocketTunnel({
                get bufferedAmount() {
                    return socket.bufferedAmount;
                },
                send: (data) => socket.send(data, { binary: true }),
                close: (code, reason) => socket.close(code, reason),
                pause: () => socket.pause(),
                resume: () => socket.resume(),
            });
            let heardAt = Date.now();
            const keepalive = setInterval(
                () => {
                    if (Date.now() - heardAt >= options.idleMs) {
                        socket.terminate();
                        return;
                    }
                    socket.ping();
                },
                Math.max(1, Math.floor(options.idleMs / 3)),
            );
            keepalive.unref();
            const heard = () => {
                heardAt = Date.now();
            };
            socket.on("pong", heard);
            socket.on("ping", heard);
            socket.on("message", (data: RawData, binary: boolean) => {
                heard();
                tunnel.message(binary ? (data as Buffer) : data.toString());
            });
            socket.once("close", () => {
                clearInterval(keepalive);
                tunnel.webSocketClosed();
                client.destroy();
                settle();
            });
            client.on("error", () => tunnel.destroy());
            tunnel.on("error", () => client.destroy());
            client.once("close", () => tunnel.destroy());
            if (options.head.length > 0) tunnel.write(options.head);
            client.pipe(tunnel);
            tunnel.pipe(client);
        });
    });
}

/** The remote refused the upgrade: screen it, then answer the client with HTTP bytes. */
async function refuse(
    response: IncomingMessage,
    options: { readonly token: string; readonly screen: NonNullable<RemoteProxyOptions["screen"]> },
): Promise<{ status: number; bytes: Buffer }> {
    const status = response.statusCode ?? 502;
    const body = await readBounded(response);
    const screened =
        (status >= 300 && status < 400 && status !== 304) || status === 401 || status === 403;
    const replacement: RemoteProxyReplacement | undefined = screened
        ? await options.screen(
              {
                  status,
                  contentType: response.headers["content-type"],
                  body: status === 401 || status === 403 ? body : undefined,
              },
              options.token,
          )
        : undefined;
    if (replacement !== undefined) {
        const json = Buffer.from(JSON.stringify(replacement.body));
        return {
            status: replacement.status,
            bytes: httpBytes(
                replacement.status,
                {
                    "cache-control": "no-store",
                    "content-length": String(json.length),
                    "content-type": "application/json; charset=utf-8",
                },
                json,
            ),
        };
    }
    const content = body ?? Buffer.alloc(0);
    const headers: OutgoingHttpHeaders = {
        "content-length": String(content.length),
        ...(response.headers["content-type"] === undefined
            ? {}
            : { "content-type": response.headers["content-type"] }),
    };
    return { status, bytes: httpBytes(status, headers, content) };
}

async function readBounded(response: IncomingMessage): Promise<Buffer | undefined> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response as AsyncIterable<Buffer>) {
        size += chunk.length;
        if (size > MAX_REFUSAL_BODY_BYTES) return undefined;
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}

function httpBytes(status: number, headers: OutgoingHttpHeaders, body: Buffer): Buffer {
    const lines = [`HTTP/1.1 ${String(status)} Remote Response`];
    for (const [name, value] of Object.entries(headers)) {
        if (value !== undefined) lines.push(`${name}: ${String(value)}`);
    }
    return Buffer.concat([Buffer.from(`${lines.join("\r\n")}\r\n\r\n`), body]);
}

function unavailable(): RemoteConnectionError {
    return new RemoteConnectionError(
        503,
        "remote_unavailable",
        "The remote Happy Agent is unavailable.",
    );
}
