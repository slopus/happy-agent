import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomInt, timingSafeEqual } from "node:crypto";

/** The longest request target a sign-in landing has; an authorization code and state fit in it. */
const MAX_CALLBACK_TARGET_LENGTH = 8_192;
const PAGE = `<!doctype html><meta charset="utf-8"><title>Signed in</title><p>Signed in. You can close this tab and go back to Happy.</p>`;

/**
 * The redirect address of one login, `http://127.0.0.1:<port>/callback`. When this machine can
 * listen there, a browser on the same machine finishes the login by landing on it; anywhere else
 * the page does not load and the person pastes the address back instead, which always works.
 */
export class McpLoginCallback {
    readonly redirectUri: string;
    /** The address the browser landed on, once it carried this login's state. */
    readonly received: Promise<string>;
    readonly #server: Server | undefined;

    private constructor(port: number, server: Server | undefined, received: Promise<string>) {
        this.redirectUri = `http://127.0.0.1:${String(port)}/callback`;
        this.#server = server;
        this.received = received;
    }

    static async open(state: string): Promise<McpLoginCallback> {
        let resolveReceived: (url: string) => void = () => undefined;
        const received = new Promise<string>((resolve) => {
            resolveReceived = resolve;
        });
        // Anything can connect to this port, and an exception escaping a request handler ends the
        // daemon, so every request is answered here and nothing it sends can throw past it.
        const server = createServer((request, response) => {
            try {
                const landed = landing(request, response, state);
                if (landed === undefined) return;
                const address = server.address();
                const port = address !== null && typeof address === "object" ? address.port : 0;
                resolveReceived(`http://127.0.0.1:${String(port)}${landed}`);
            } catch {
                try {
                    if (!response.headersSent) response.writeHead(500);
                    response.end();
                } catch {
                    request.socket.destroy();
                }
            }
        });
        server.on("clientError", (_error, socket) => {
            if (socket.writable)
                socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
            else socket.destroy();
        });
        const port = await new Promise<number | undefined>((resolve) => {
            server.once("error", () => resolve(undefined));
            server.listen(0, "127.0.0.1", () => {
                const address = server.address();
                resolve(address !== null && typeof address === "object" ? address.port : undefined);
            });
        });
        if (port !== undefined) {
            // A failure to accept a connection must not reach the process either.
            server.on("error", () => undefined);
            server.unref();
            return new McpLoginCallback(port, server, received);
        }
        // Nothing can listen here; the address only has to match between the link and the
        // exchange, and the person pastes it back.
        server.close();
        return new McpLoginCallback(randomInt(49_152, 65_536), undefined, new Promise(() => {}));
    }

    close(): void {
        this.#server?.closeAllConnections();
        this.#server?.close();
    }
}

/**
 * Answer one request, and return its target when it is this sign-in landing. Only an origin-form
 * target, a single path from this server's root, is parsed; `//host`, absolute-form, and `*`
 * targets are not a browser landing here and are refused before parsing.
 */
function landing(
    request: IncomingMessage,
    response: ServerResponse,
    state: string,
): string | undefined {
    const target = request.url ?? "";
    if (target.length > MAX_CALLBACK_TARGET_LENGTH) return reply(response, 414);
    if (!target.startsWith("/") || target.startsWith("//")) return reply(response, 400);
    let url: URL;
    try {
        url = new URL(target, "http://127.0.0.1");
    } catch {
        return reply(response, 400);
    }
    if (url.pathname !== "/callback") return reply(response, 404);
    if (request.method !== "GET") return reply(response, 405);
    if (!sameState(url.searchParams.get("state"), state)) {
        return reply(response, 400, "Unknown sign-in.");
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE);
    return target;
}

function reply(response: ServerResponse, status: number, text?: string): undefined {
    response.writeHead(status, { "content-type": "text/plain", connection: "close" }).end(text);
    return undefined;
}

function sameState(given: string | null, expected: string): boolean {
    if (given === null) return false;
    const left = Buffer.from(given);
    const right = Buffer.from(expected);
    return left.length === right.length && timingSafeEqual(left, right);
}
