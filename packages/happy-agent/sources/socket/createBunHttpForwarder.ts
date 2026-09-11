import { Agent, request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { Readable } from "node:stream";

const HOP_HEADERS = new Set([
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
]);

/** Stream native Bun HTTP requests through the existing authenticated API handler. */
export function createBunHttpForwarder(
    target: string | { readonly hostname: string; readonly port: number },
) {
    const agent = new Agent({
        keepAlive: true,
        maxSockets: 256,
        maxFreeSockets: 16,
        timeout: 60_000,
    });
    let closed = false;
    return {
        close() {
            closed = true;
            agent.destroy();
        },
        async forward(request: Request, finished: () => void = () => {}): Promise<Response> {
            if (closed) throw new Error("The HTTP listener has stopped.");
            request.signal.throwIfAborted();
            const url = new URL(request.url);
            const headers = endToEndHeaders(Object.fromEntries(request.headers));
            return await new Promise<Response>((resolve, reject) => {
                const upstream = httpRequest({
                    agent,
                    ...(typeof target === "string" ? { socketPath: target } : target),
                    method: request.method,
                    path: `${url.pathname}${url.search}`,
                    headers: Object.fromEntries(headers),
                });
                const upload =
                    request.body === null ? undefined : Readable.fromWeb(request.body as never);
                const timer = setTimeout(
                    () => upstream.destroy(new Error("The API request timed out.")),
                    30_000,
                );
                timer.unref();
                const abort = () => upstream.destroy(new Error("The HTTP request was cancelled."));
                let completed = false;
                const cleanup = () => {
                    if (completed) return;
                    completed = true;
                    clearTimeout(timer);
                    request.signal.removeEventListener("abort", abort);
                    finished();
                };
                request.signal.addEventListener("abort", abort, { once: true });
                if (request.signal.aborted) abort();
                upstream.on("error", (error) => {
                    cleanup();
                    upload?.destroy();
                    reject(error);
                });
                upstream.once("response", (response) => {
                    clearTimeout(timer);
                    response.socket.setTimeout(0);
                    response.once("close", () => {
                        cleanup();
                        if (!upstream.writableFinished) {
                            upload?.destroy();
                            upstream.destroy();
                        }
                    });
                    const status = response.statusCode ?? 502;
                    const empty =
                        request.method === "HEAD" ||
                        status === 204 ||
                        status === 205 ||
                        status === 304;
                    if (empty) response.resume();
                    resolve(
                        new Response(
                            empty ? null : (Readable.toWeb(response) as ReadableStream<Uint8Array>),
                            {
                                status,
                                headers: endToEndHeaders(response.headers),
                            },
                        ),
                    );
                });
                if (upload === undefined) upstream.end();
                else {
                    upload.on("error", () =>
                        upstream.destroy(new Error("The request body could not be read.")),
                    );
                    upload.pipe(upstream);
                }
            });
        },
    };
}

function endToEndHeaders(source: IncomingHttpHeaders): Headers {
    const connection = new Set(
        (source.connection ?? "")
            .toLowerCase()
            .split(",")
            .map((value) => value.trim()),
    );
    const headers = new Headers();
    for (const [name, value] of Object.entries(source)) {
        if (
            value === undefined ||
            HOP_HEADERS.has(name.toLowerCase()) ||
            connection.has(name.toLowerCase())
        )
            continue;
        for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
    }
    return headers;
}
