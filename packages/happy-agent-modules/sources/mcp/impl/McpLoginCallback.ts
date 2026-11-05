import { createServer, type Server } from "node:http";
import { randomInt } from "node:crypto";

const MAX_CALLBACK_URL_LENGTH = 16_384;
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
        const server = createServer((request, response) => {
            const path = request.url ?? "/";
            const url = new URL(path.slice(0, MAX_CALLBACK_URL_LENGTH), "http://127.0.0.1");
            if (request.method !== "GET" || url.pathname !== "/callback") {
                response.writeHead(404).end();
                return;
            }
            if (url.searchParams.get("state") !== state) {
                response.writeHead(400, { "content-type": "text/plain" }).end("Unknown sign-in.");
                return;
            }
            response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE);
            const address = server.address();
            const port = address !== null && typeof address === "object" ? address.port : 0;
            resolveReceived(`http://127.0.0.1:${String(port)}${path}`);
        });
        const port = await new Promise<number | undefined>((resolve) => {
            server.once("error", () => resolve(undefined));
            server.listen(0, "127.0.0.1", () => {
                const address = server.address();
                resolve(address !== null && typeof address === "object" ? address.port : undefined);
            });
        });
        if (port !== undefined) {
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
