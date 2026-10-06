import { createServer, request } from "node:http";
import { execFile } from "node:child_process";
import { connect } from "node:net";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { InterceptingHttpProxy } from "./InterceptingHttpProxy.js";

const running = new Set<InterceptingHttpProxy>();

afterEach(async () => {
    await Promise.all([...running].map((proxy) => proxy.stop()));
    running.clear();
});

describe("InterceptingHttpProxy", () => {
    it.runIf(Number(process.versions.node.split(".")[0]) >= 24)(
        "serves a native fetch HTTP fixture by redirecting its CONNECT tunnel to the interceptor",
        async () => {
            const proxy: InterceptingHttpProxy = new InterceptingHttpProxy((intercepted) => {
                if (intercepted.method === "CONNECT") {
                    expect(intercepted.url).toBe("bedrock.gym.test:80");
                    return { request: { url: new URL(proxy.localUrl).host } };
                }
                expect(intercepted.method).toBe("POST");
                expect(intercepted.url).toBe("http://bedrock.gym.test/openai/v1/chat/completions");
                return {
                    response: { status: 201, body: Buffer.from(intercepted.body).toString() },
                };
            });
            running.add(proxy);
            await proxy.start();
            const { stdout } = await promisify(execFile)(
                process.execPath,
                [
                    "--input-type=module",
                    "--eval",
                    `const response = await fetch("http://bedrock.gym.test/openai/v1/chat/completions", {
                    method: "POST", body: "native fetch body", signal: AbortSignal.timeout(5000)
                });
                process.stdout.write(JSON.stringify({ status: response.status, body: await response.text() }));`,
                ],
                {
                    env: {
                        ...process.env,
                        HTTP_PROXY: proxy.localUrl,
                        http_proxy: proxy.localUrl,
                        HTTPS_PROXY: proxy.localUrl,
                        https_proxy: proxy.localUrl,
                        NO_PROXY: "",
                        no_proxy: "",
                        NODE_USE_ENV_PROXY: "1",
                    },
                    timeout: 7000,
                },
            );
            expect(JSON.parse(stdout)).toEqual({ status: 201, body: "native fetch body" });
            expect(proxy.exchanges.map((exchange) => exchange.request.method)).toEqual([
                "CONNECT",
                "POST",
            ]);
        },
    );

    it("records requests and can replace responses without contacting the target", async () => {
        const proxy = new InterceptingHttpProxy((intercepted) => ({
            response: {
                body: `replaced ${Buffer.from(intercepted.body).toString("utf8")}`,
                headers: { "content-type": "text/plain" },
                status: 201,
            },
        }));
        running.add(proxy);
        await proxy.start();

        const response = await sendThroughProxy(proxy, "http://unreachable.invalid/messages", "hi");

        expect(response).toEqual({ body: "replaced hi", status: 201 });
        expect(proxy.exchanges).toHaveLength(1);
        expect(proxy.exchanges[0]).toMatchObject({
            request: { method: "POST", url: "http://unreachable.invalid/messages" },
            response: { status: 201 },
            responseSource: "interceptor",
        });
    });

    it("can rewrite a request, pass it upstream, and rewrite the upstream response", async () => {
        const upstream = createServer(async (incoming, response) => {
            const chunks: Buffer[] = [];
            for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
            response.writeHead(202, { "x-upstream": "yes" });
            response.end(`upstream ${Buffer.concat(chunks).toString("utf8")}`);
        });
        await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
        const address = upstream.address();
        if (address === null || typeof address === "string") throw new Error("No upstream port.");

        const proxy = new InterceptingHttpProxy(() => ({
            request: {
                body: "rewritten request",
                url: `http://127.0.0.1:${address.port}/rewritten`,
            },
            transformResponse: (response) => ({
                body: `rewritten ${Buffer.from(response.body).toString("utf8")}`,
                headers: { "x-intercepted": "yes" },
                status: 203,
            }),
        }));
        running.add(proxy);

        try {
            await proxy.start();
            const response = await sendThroughProxy(
                proxy,
                "http://original.invalid/original",
                "original request",
            );

            expect(response).toEqual({
                body: "rewritten upstream rewritten request",
                status: 203,
            });
            expect(proxy.exchanges[0]).toMatchObject({
                forwardedRequest: {
                    url: `http://127.0.0.1:${address.port}/rewritten`,
                },
                request: { url: "http://original.invalid/original" },
                response: { status: 203 },
                responseSource: "interceptor",
            });
        } finally {
            await new Promise<void>((resolve, reject) => {
                upstream.close((error) => (error === undefined ? resolve() : reject(error)));
            });
        }
    });

    it("handles a CONNECT client reset while the interceptor is pending", async () => {
        let observeConnect: (() => void) | undefined;
        let releaseHandler: (() => void) | undefined;
        const connectObserved = new Promise<void>((resolve) => {
            observeConnect = resolve;
        });
        const handlerReleased = new Promise<void>((resolve) => {
            releaseHandler = resolve;
        });
        const proxy = new InterceptingHttpProxy(async (intercepted) => {
            if (intercepted.method !== "CONNECT") return;
            observeConnect?.();
            await handlerReleased;
            return { response: { status: 200 } };
        });
        running.add(proxy);
        await proxy.start();

        const proxyUrl = new URL(proxy.url.replace("host.docker.internal", "127.0.0.1"));
        const client = connect(Number(proxyUrl.port), proxyUrl.hostname);
        client.on("error", () => undefined);
        await new Promise<void>((resolve) => client.once("connect", resolve));
        client.write("CONNECT example.invalid:443 HTTP/1.1\r\nHost: example.invalid:443\r\n\r\n");
        await connectObserved;

        client.resetAndDestroy();
        await new Promise<void>((resolve) => setImmediate(resolve));
        releaseHandler?.();
        await new Promise<void>((resolve) => setImmediate(resolve));

        expect(proxy.exchanges[0]).toMatchObject({
            request: { method: "CONNECT", url: "example.invalid:443" },
            response: { status: 200 },
            responseSource: "interceptor",
        });
    });
});

function sendThroughProxy(
    proxy: InterceptingHttpProxy,
    target: string,
    body: string,
): Promise<{ body: string; status: number }> {
    const proxyUrl = new URL(proxy.url.replace("host.docker.internal", "127.0.0.1"));
    return new Promise((resolve, reject) => {
        const outgoing = request(
            {
                headers: { "content-type": "text/plain" },
                host: proxyUrl.hostname,
                method: "POST",
                path: target,
                port: Number(proxyUrl.port),
            },
            async (response) => {
                const chunks: Buffer[] = [];
                for await (const chunk of response) chunks.push(Buffer.from(chunk));
                resolve({
                    body: Buffer.concat(chunks).toString("utf8"),
                    status: response.statusCode ?? 0,
                });
            },
        );
        outgoing.once("error", reject);
        outgoing.end(body);
    });
}
