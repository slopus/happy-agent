import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { Agent, createServer, request } from "node:http";
import { connect } from "node:net";
import { expect, it } from "vitest";
import { WORKSPACE_PROXY_ROUTE_HEADER, WorkspaceProxy } from "../../sources/api/WorkspaceProxy.js";

it("protects loopback proxy admission and never forwards its private credential", async () => {
    const proxy = new WorkspaceProxy();
    const token = randomBytes(32).toString("base64url");
    const port = await proxy.listenTcp(token);
    const received: Array<string | string[] | undefined> = [];
    const target = createServer((incoming, response) => {
        received.push(incoming.headers["proxy-authorization"]);
        response.end("ok");
    });
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    target.listen(0, "127.0.0.1");
    await once(target, "listening");
    const address = target.address();
    if (address === null || typeof address === "string") throw new Error("Missing fixture port.");
    const call = async (authorization?: string, reuse = false) =>
        await new Promise<number>((resolve, reject) => {
            const outgoing = request(
                {
                    agent: reuse ? agent : false,
                    hostname: "127.0.0.1",
                    port,
                    path: `http://127.0.0.1:${address.port}/`,
                    headers:
                        authorization === undefined ? {} : { "proxy-authorization": authorization },
                },
                (response) => {
                    response.resume();
                    response.on("error", reject);
                    response.on("end", () => resolve(response.statusCode!));
                },
            );
            outgoing.on("error", reject);
            outgoing.end();
        });
    try {
        expect(await call()).toBe(407);
        expect(await call("Bearer wrong")).toBe(407);
        expect(received).toEqual([]);
        expect(await call(`Bearer ${token}`, true)).toBe(200);
        expect(await call(undefined, true)).toBe(200);
        expect(await call()).toBe(407);
        expect(received).toEqual([undefined, undefined]);
    } finally {
        agent.destroy();
        await proxy.close();
        target.closeAllConnections();
        await new Promise<void>((resolve) => target.close(() => resolve()));
    }
});

it("opens a routed attachment's requests and tunnels from the route's network", async () => {
    const proxy = new WorkspaceProxy();
    const token = randomBytes(32).toString("base64url");
    const port = await proxy.listenTcp(token);
    const received: Array<string | string[] | undefined> = [];
    const target = createServer((incoming, response) => {
        received.push(incoming.headers[WORKSPACE_PROXY_ROUTE_HEADER]);
        response.end(`from ${incoming.url}`);
    });
    target.listen(0, "127.0.0.1");
    await once(target, "listening");
    const address = target.address();
    if (address === null || typeof address === "string") throw new Error("Missing fixture port.");
    // The "runner" names its dev server as localhost:3000; only the route knows where that is.
    const opened: string[] = [];
    const route = () =>
        proxy.route(async (host, port) => {
            opened.push(`${host}:${port}`);
            return connect(address.port, "127.0.0.1");
        });
    const routed = (key: string) => ({
        "proxy-authorization": `Bearer ${token}`,
        [WORKSPACE_PROXY_ROUTE_HEADER]: key,
    });
    try {
        const plain = await new Promise<string>((resolve, reject) => {
            const outgoing = request(
                {
                    agent: false,
                    hostname: "127.0.0.1",
                    port,
                    path: "http://localhost:3000/preview",
                    headers: routed(route()),
                },
                (response) => {
                    let body = "";
                    response.on("data", (chunk: Buffer) => (body += chunk.toString()));
                    response.on("end", () => resolve(body));
                    response.on("error", reject);
                },
            );
            outgoing.on("error", reject);
            outgoing.end();
        });
        expect(plain).toBe("from /preview");
        expect(received).toEqual([undefined]);

        const tunnel = connect(port, "127.0.0.1");
        await once(tunnel, "connect");
        const headers = Object.entries(routed(route()))
            .map(([name, value]) => `${name}: ${value}\r\n`)
            .join("");
        tunnel.write(`CONNECT localhost:3000 HTTP/1.1\r\nHost: localhost:3000\r\n${headers}\r\n`);
        let reply = "";
        tunnel.on("data", (chunk: Buffer) => {
            reply += chunk.toString();
            if (reply.startsWith("HTTP/1.1 200") && !reply.includes("GET")) {
                tunnel.write(
                    "GET /inside HTTP/1.1\r\nHost: localhost:3000\r\nConnection: close\r\n\r\n",
                );
            }
        });
        await once(tunnel, "end");
        expect(reply).toMatch(/^HTTP\/1.1 200 Connection Established/u);
        expect(reply).toContain("from /inside");
        expect(opened).toEqual(["localhost:3000", "localhost:3000"]);

        // A route is presented once; a stolen or replayed key is not a route.
        const replayed = route();
        const first = await statusOf(port, routed(replayed));
        const second = await statusOf(port, routed(replayed));
        expect([first, second]).toEqual([200, 502]);
    } finally {
        await proxy.close();
        target.closeAllConnections();
        await new Promise<void>((resolve) => target.close(() => resolve()));
    }
});

async function statusOf(port: number, headers: Record<string, string>): Promise<number> {
    return await new Promise<number>((resolve, reject) => {
        const outgoing = request(
            {
                agent: false,
                hostname: "127.0.0.1",
                port,
                // Nothing listens here on this machine, so only a route reaches a server.
                path: "http://127.0.0.1:9/",
                headers,
            },
            (response) => {
                response.resume();
                response.on("end", () => resolve(response.statusCode!));
            },
        );
        outgoing.on("error", reject);
        outgoing.end();
    });
}
