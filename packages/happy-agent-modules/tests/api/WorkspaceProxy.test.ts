import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { Agent, createServer, request } from "node:http";
import { expect, it } from "vitest";
import { WorkspaceProxy } from "../../sources/api/WorkspaceProxy.js";

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
