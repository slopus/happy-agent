import type { IncomingMessage, ServerResponse } from "node:http";

import { Value } from "@sinclair/typebox/value";

import {
    P2P_HTTP_MAXIMUM_BODY_BYTES,
    p2pHttpRequestHeadSchema,
    type P2pNetwork,
} from "../p2p/index.js";
import { selectP2pRequestHeaders } from "./p2pHttpHeaders.js";

export async function proxyP2pHttpRequest(
    network: P2pNetwork,
    peerId: string,
    path: string,
    request: IncomingMessage,
    response: ServerResponse,
): Promise<void> {
    if (isP2pPath(path)) {
        sendJsonError(response, 403, "P2P routes cannot be forwarded through another peer.");
        return;
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    request.once("aborted", abort);
    response.once("close", abort);
    try {
        const body = await readBody(request);
        const head = {
            headers: selectP2pRequestHeaders(request.headers),
            method: request.method ?? "GET",
            path,
        };
        if (!Value.Check(p2pHttpRequestHeadSchema, head)) {
            sendJsonError(response, 405, "That HTTP method cannot be forwarded over P2P.");
            return;
        }
        const { response: forwarded, transport } = await network.fetch(
            peerId,
            {
                body,
                ...head,
            },
            controller.signal,
        );
        response.writeHead(forwarded.status, {
            ...forwarded.headers,
            "x-rig-p2p-peer": peerId,
            "x-rig-p2p-transport": transport,
        });
        for await (const chunk of forwarded.body) {
            if (controller.signal.aborted) return;
            if (!response.write(chunk) && !(await waitForDrain(response, controller.signal))) {
                return;
            }
        }
        response.end();
    } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof P2pRequestBodyTooLargeError) {
            sendJsonError(response, 413, "Request body is larger than the P2P limit.");
        } else if (!response.headersSent) {
            sendJsonError(response, 502, "The peer could not complete the request.");
        } else {
            response.destroy();
        }
    } finally {
        controller.abort();
        request.off("aborted", abort);
        response.off("close", abort);
    }
}

function waitForDrain(response: ServerResponse, signal: AbortSignal): Promise<boolean> {
    return new Promise((resolve) => {
        if (signal.aborted) return resolve(false);
        const drained = () => finish(true);
        const aborted = () => finish(false);
        const finish = (result: boolean) => {
            response.off("drain", drained);
            signal.removeEventListener("abort", aborted);
            resolve(result);
        };
        response.once("drain", drained);
        signal.addEventListener("abort", aborted, { once: true });
    });
}

async function readBody(request: IncomingMessage): Promise<Uint8Array> {
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        length += buffer.byteLength;
        if (length > P2P_HTTP_MAXIMUM_BODY_BYTES) throw new P2pRequestBodyTooLargeError();
        chunks.push(buffer);
    }
    return Buffer.concat(chunks);
}

function isP2pPath(path: string): boolean {
    const pathname = new URL(path, "http://rig.local").pathname;
    return pathname === "/p2p" || pathname.startsWith("/p2p/");
}

function sendJsonError(response: ServerResponse, status: number, error: string): void {
    const body = `${JSON.stringify({ error })}\n`;
    response.writeHead(status, {
        "content-length": String(Buffer.byteLength(body)),
        "content-type": "application/json; charset=utf-8",
    });
    response.end(body);
}

class P2pRequestBodyTooLargeError extends Error {}
