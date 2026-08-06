import { request as sendHttpRequest, type IncomingMessage } from "node:http";

import type { P2pHttpRequest, P2pHttpResponse, ServeP2pHttpRequest } from "../p2p/index.js";
import { selectP2pRequestHeaders, selectP2pResponseHeaders } from "./p2pHttpHeaders.js";

export function createServeP2pHttpRequest(options: {
    allowRequest: (peerId: string, request: P2pHttpRequest) => boolean;
    socketPath: string;
    token: string;
}): ServeP2pHttpRequest {
    return async (peerId, request, signal) => {
        if (isProtectedP2pPath(request.path)) {
            return jsonResponse(403, "That daemon API route is not shared over P2P.");
        }
        if (!options.allowRequest(peerId, request)) {
            return jsonResponse(403, "That daemon API route is not available to this P2P peer.");
        }
        return await sendToLocalDaemon(options, peerId, request, signal);
    };
}

function sendToLocalDaemon(
    options: { socketPath: string; token: string },
    peerId: string,
    request: P2pHttpRequest,
    signal: AbortSignal,
): Promise<P2pHttpResponse> {
    return new Promise((resolve, reject) => {
        if (signal.aborted) {
            reject(new Error("The peer cancelled the request."));
            return;
        }
        let incoming: IncomingMessage | undefined;
        const outgoing = sendHttpRequest(
            {
                headers: {
                    ...selectP2pRequestHeaders(request.headers),
                    authorization: `Bearer ${options.token}`,
                    "content-length": String(request.body.byteLength),
                    "x-rig-p2p-peer": peerId,
                },
                method: request.method,
                path: request.path,
                socketPath: options.socketPath,
            },
            (received) => {
                incoming = received;
                resolve({
                    body: responseBody(received, signal, abort),
                    headers: selectP2pResponseHeaders(received.headers),
                    status: received.statusCode ?? 502,
                });
            },
        );
        const abort = () => {
            const error = new Error("The peer cancelled the request.");
            outgoing.destroy(error);
            incoming?.destroy(error);
        };
        signal.addEventListener("abort", abort, { once: true });
        outgoing.once("error", (error) => {
            signal.removeEventListener("abort", abort);
            reject(error);
        });
        outgoing.end(request.body);
    });
}

async function* responseBody(
    response: IncomingMessage,
    signal: AbortSignal,
    abort: () => void,
): AsyncIterable<Uint8Array> {
    try {
        for await (const chunk of response) {
            yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        }
    } finally {
        signal.removeEventListener("abort", abort);
        if (!response.complete) response.destroy();
    }
}

function isProtectedP2pPath(path: string): boolean {
    const pathname = new URL(path, "http://rig.local").pathname;
    return (
        pathname === "/p2p" ||
        pathname.startsWith("/p2p/") ||
        pathname === "/shutdown" ||
        pathname === "/debug/inspector" ||
        /^\/webapps\/[^/]+\/context$/u.test(pathname)
    );
}

function jsonResponse(status: number, error: string): P2pHttpResponse {
    const body = Buffer.from(`${JSON.stringify({ error })}\n`, "utf8");
    return {
        body: (async function* () {
            yield body;
        })(),
        headers: {
            "content-length": String(body.byteLength),
            "content-type": "application/json; charset=utf-8",
        },
        status,
    };
}
