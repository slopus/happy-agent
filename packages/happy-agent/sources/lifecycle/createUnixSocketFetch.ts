import { request as httpRequest } from "node:http";
import { Readable } from "node:stream";

/**
 * Adapts the daemon's Unix socket to the standard Fetch API consumed by HappyAgentClient.
 *
 * Platform transport stays outside the client package, so the client itself remains
 * browser-safe while the local TUI can use exactly the same state implementation.
 */
export function createUnixSocketFetch(socketPath: string): typeof globalThis.fetch {
    return async (input, init = {}) => {
        const source = input instanceof Request ? input : undefined;
        const url = new URL(source?.url ?? String(input));
        const headers = new Headers(source?.headers);
        new Headers(init.headers).forEach((value, name) => headers.set(name, value));
        const signal = init.signal ?? source?.signal;
        const body = init.body;
        if (
            body !== undefined &&
            body !== null &&
            typeof body !== "string" &&
            !(body instanceof Uint8Array) &&
            !(body instanceof ArrayBuffer) &&
            !(body instanceof URLSearchParams)
        ) {
            throw new TypeError("Unix-socket fetch supports buffered request bodies.");
        }

        return new Promise<Response>((resolve, reject) => {
            if (signal?.aborted === true) {
                reject(signal.reason ?? new DOMException("The request was aborted.", "AbortError"));
                return;
            }
            const request = httpRequest({
                headers: Object.fromEntries(headers),
                method: init.method ?? source?.method ?? "GET",
                path: `${url.pathname}${url.search}`,
                socketPath,
            });
            let settled = false;
            let responseStream: import("node:http").IncomingMessage | undefined;
            const abort = () => {
                const reason =
                    signal?.reason instanceof Error
                        ? signal.reason
                        : new DOMException("The request was aborted.", "AbortError");
                request.destroy(reason);
                responseStream?.destroy(reason);
            };
            signal?.addEventListener("abort", abort, { once: true });
            // A server may answer a bounded upload before every buffered byte has reached it.
            // Node can then report more than one late socket-write error after the response. Keep
            // the listener for the request's whole lifetime so those expected post-response
            // errors cannot escape as uncaught exceptions.
            const handleTransportError = (error: Error): void => {
                if (settled) return;
                settled = true;
                signal?.removeEventListener("abort", abort);
                reject(error);
            };
            request.on("error", handleTransportError);
            request.on("socket", (socket) => {
                if (body === undefined || body === null) return;
                // Linux may deliver a late buffered-write EPIPE on the socket rather than the
                // ClientRequest after an early bounded-upload response.
                socket.on("error", handleTransportError);
                request.once("close", () => socket.removeListener("error", handleTransportError));
            });
            request.once("response", (response) => {
                if (settled) return;
                settled = true;
                responseStream = response;
                const responseHeaders = new Headers();
                for (const [name, value] of Object.entries(response.headers)) {
                    for (const item of Array.isArray(value) ? value : [value]) {
                        if (item !== undefined) responseHeaders.append(name, String(item));
                    }
                }
                response.once("close", () => signal?.removeEventListener("abort", abort));
                resolve(
                    new Response(Readable.toWeb(response) as ReadableStream<Uint8Array>, {
                        headers: responseHeaders,
                        status: response.statusCode ?? 500,
                        ...(response.statusMessage === undefined
                            ? {}
                            : { statusText: response.statusMessage }),
                    }),
                );
            });
            if (body === undefined || body === null) {
                request.end();
            } else if (body instanceof URLSearchParams) {
                request.end(body.toString());
            } else {
                request.end(body);
            }
        });
    };
}
