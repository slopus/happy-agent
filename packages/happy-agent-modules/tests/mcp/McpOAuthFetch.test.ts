import {
    createServer,
    request as httpRequest,
    type IncomingMessage,
    type RequestOptions,
} from "node:http";
import type { LookupAddress } from "node:dns";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** What the mocked resolver answers for each host, one answer per lookup; the last one repeats. */
const dns = vi.hoisted(() => ({
    answers: new Map<string, (readonly LookupAddress[] | "never")[]>(),
    lookups: [] as string[],
}));
/** The options each https request was opened with. */
const opened = vi.hoisted(() => [] as RequestOptions[]);

vi.mock("node:dns/promises", async (importOriginal) => {
    const real = await importOriginal<typeof import("node:dns/promises")>();
    const lookup = async (host: string, options: object) => {
        const answers = dns.answers.get(host);
        if (answers === undefined) return await real.lookup(host, { ...options, all: true });
        dns.lookups.push(host);
        const answer = answers.length > 1 ? answers.shift() : answers[0];
        if (answer === "never" || answer === undefined) return await new Promise(() => {});
        return answer;
    };
    return { ...real, default: { ...real, lookup }, lookup };
});

// The fixtures speak plain HTTP, so https requests are sent as http with the same options,
// including the DNS lookup the request was given.
vi.mock("node:https", async (importOriginal) => {
    const real = await importOriginal<typeof import("node:https")>();
    const request = (url: URL, options: RequestOptions, callback: never) => {
        opened.push(options);
        return httpRequest(new URL(url.href.replace(/^https:/u, "http:")), options, callback);
    };
    return { ...real, default: { ...real, request }, request };
});

const { mcpOAuthFetch, resolveMcpOAuthEndpoint } =
    await import("../../sources/mcp/impl/mcpOAuthFetch.js");

interface Received {
    readonly path: string;
    readonly headers: IncomingMessage["headers"];
}

/** A local server answering every path with `respond`, recording what reached it. */
async function local(
    respond: (path: string) => { status: number; headers?: object; body?: string },
) {
    const received: Received[] = [];
    const server = createServer((request, response) => {
        const path = request.url ?? "/";
        received.push({ path, headers: request.headers });
        request.resume();
        request.on("end", () => {
            const reply = respond(path);
            response.writeHead(reply.status, { ...reply.headers });
            response.end(reply.body);
        });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("No port.");
    return {
        port: address.port,
        received,
        close: async () => {
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
}

beforeEach(() => {
    dns.answers.clear();
    dns.lookups.length = 0;
    opened.length = 0;
});
afterEach(() => vi.useRealTimers());

describe("the OAuth fetch for an MCP server", () => {
    const server = new URL("https://mcp.example.com/mcp");

    it("reaches only https endpoints on public addresses, except the server's own loopback host", async () => {
        await expect(
            resolveMcpOAuthEndpoint(new URL("https://93.184.216.34/token"), server),
        ).resolves.toEqual([{ address: "93.184.216.34", family: 4 }]);
        for (const refused of [
            "http://auth.example.com/token",
            "https://10.0.0.5/token",
            "https://172.20.1.1/token",
            "https://192.168.1.1/token",
            "https://127.0.0.1/token",
            "https://169.254.169.254/latest/meta-data",
            "https://100.100.100.100/token",
            "https://[::1]/token",
            "https://[fd00:ec2::254]/token",
            "https://[fe80::1]/token",
            "https://[::ffff:10.0.0.1]/token",
            "https://localhost/token",
            "https://user:secret@auth.example.com/token",
        ]) {
            await expect(
                resolveMcpOAuthEndpoint(new URL(refused), server),
                refused,
            ).rejects.toThrow();
        }
        const loopback = new URL("http://127.0.0.1:4000/mcp");
        await expect(
            resolveMcpOAuthEndpoint(new URL("http://127.0.0.1:5000/token"), loopback),
        ).resolves.toHaveLength(1);
        await expect(
            resolveMcpOAuthEndpoint(new URL("http://localhost:5000/token"), loopback),
        ).rejects.toThrow("not https");
        // An https server's own host may be private, since the person configured it.
        await expect(
            resolveMcpOAuthEndpoint(
                new URL("https://10.1.2.3/.well-known/oauth-protected-resource"),
                new URL("https://10.1.2.3/mcp"),
            ),
        ).resolves.toHaveLength(1);
    });

    it("refuses a host name with any private address, and one whose lookup does not finish", async () => {
        dns.answers.set("inside.test", [[{ address: "10.0.0.7", family: 4 }]]);
        dns.answers.set("mixed.test", [
            [
                { address: "93.184.216.34", family: 4 },
                { address: "fd00::1", family: 6 },
            ],
        ]);
        await expect(
            resolveMcpOAuthEndpoint(new URL("https://inside.test/token"), server),
        ).rejects.toThrow("private network address");
        await expect(
            resolveMcpOAuthEndpoint(new URL("https://mixed.test/token"), server),
        ).rejects.toThrow("private network address");

        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        dns.answers.set("slow.test", ["never"]);
        const slow = resolveMcpOAuthEndpoint(new URL("https://slow.test/token"), server);
        const settled = expect(slow).rejects.toThrow("could not be looked up in time");
        await vi.advanceTimersByTimeAsync(5_000);
        await settled;
    });

    it("connects only to the addresses it checked, on every hop, whatever DNS answers later", async () => {
        const fixture = await local((path) =>
            path === "/first"
                ? { status: 302, headers: { location: "/second" } }
                : { status: 200, body: '{"ok":true}' },
        );
        try {
            // The server's own host: checked once per hop, then rebound to an address nothing
            // listens on. Every hop still reaches the address it checked.
            const own = `rebind.test:${String(fixture.port)}`;
            dns.answers.set("rebind.test", [
                [{ address: "127.0.0.1", family: 4 }],
                [{ address: "127.0.0.1", family: 4 }],
                [{ address: "10.255.255.1", family: 4 }],
            ]);
            const oauthFetch = mcpOAuthFetch(new URL(`https://${own}/mcp`));
            const response = await oauthFetch(`https://${own}/first`);
            await expect(response.json()).resolves.toEqual({ ok: true });
            expect(fixture.received.map((request) => request.path)).toEqual(["/first", "/second"]);
            expect(fixture.received[0]?.headers.host).toBe(own);
            expect(dns.lookups).toEqual(["rebind.test", "rebind.test"]);

            // Another host: public when checked, then rebound to loopback. The connection is
            // given only the checked address, so nothing reaches this machine.
            dns.answers.set("evil.test", [
                [{ address: "192.0.2.1", family: 4 }],
                [{ address: "127.0.0.1", family: 4 }],
            ]);
            opened.length = 0;
            await expect(
                mcpOAuthFetch(server)(`https://evil.test:${String(fixture.port)}/token`, {
                    signal: AbortSignal.timeout(300),
                }),
            ).rejects.toThrow();
            expect(fixture.received).toHaveLength(2);
            const lookup = opened[0]?.lookup as
                | ((
                      host: string,
                      options: object,
                      callback: (error: Error | null, found: LookupAddress[]) => void,
                  ) => void)
                | undefined;
            expect(lookup).toBeTypeOf("function");
            const pinned = await new Promise<LookupAddress[]>((resolve, reject) =>
                lookup?.("evil.test", { all: true }, (error, found) =>
                    error === null ? resolve(found) : reject(error),
                ),
            );
            expect(pinned).toEqual([{ address: "192.0.2.1", family: 4 }]);
        } finally {
            await fixture.close();
        }
    });

    it("sends no configured headers, follows bounded GET redirects, and bounds the body", async () => {
        let respond: (path: string) => {
            status: number;
            headers?: object;
            body?: string;
        } = () => ({
            status: 200,
            body: "{}",
        });
        const fixture = await local((path) => respond(path));
        try {
            const origin = `http://127.0.0.1:${String(fixture.port)}`;
            const oauthFetch = mcpOAuthFetch(new URL(`${origin}/mcp`));

            await oauthFetch(`${origin}/.well-known/oauth-protected-resource`, {
                headers: {
                    Accept: "application/json",
                    "MCP-Protocol-Version": "2025-06-18",
                    "X-Api-Key": "configured-secret",
                    Authorization: "Bearer configured-token",
                    Cookie: "session=1",
                },
            });
            const sent = fixture.received[0]?.headers ?? {};
            expect(sent["x-api-key"]).toBeUndefined();
            expect(sent.authorization).toBeUndefined();
            expect(sent.cookie).toBeUndefined();
            expect(sent.accept).toBe("application/json");
            expect(sent["mcp-protocol-version"]).toBe("2025-06-18");

            // A form body keeps its content type and length.
            fixture.received.length = 0;
            await oauthFetch(`${origin}/token`, {
                method: "POST",
                body: new URLSearchParams({ grant_type: "refresh_token" }),
            });
            expect(fixture.received[0]?.headers["content-type"]).toContain(
                "application/x-www-form-urlencoded",
            );
            expect(fixture.received[0]?.headers["content-length"]).toBe(
                String("grant_type=refresh_token".length),
            );

            fixture.received.length = 0;
            respond = (path) =>
                path === "/first"
                    ? { status: 302, headers: { location: "/second" } }
                    : { status: 200, body: '{"ok":true}' };
            await expect((await oauthFetch(`${origin}/first`)).json()).resolves.toEqual({
                ok: true,
            });
            expect(fixture.received.map((request) => request.path)).toEqual(["/first", "/second"]);

            respond = () => ({ status: 307, headers: { location: "/again" } });
            await expect(
                oauthFetch(`${origin}/token`, { method: "POST", body: "code=1" }),
            ).rejects.toThrow("redirected a request");
            await expect(oauthFetch(`${origin}/loop`)).rejects.toThrow("redirected too many times");

            respond = () => ({ status: 302, headers: { location: "http://169.254.169.254/" } });
            await expect(oauthFetch(`${origin}/away`)).rejects.toThrow("not https");
            dns.answers.set("inside.test", [[{ address: "10.0.0.7", family: 4 }]]);
            respond = () => ({ status: 302, headers: { location: "https://inside.test/" } });
            await expect(oauthFetch(`${origin}/away`)).rejects.toThrow("private network address");

            respond = () => ({ status: 200, body: "x".repeat(300 * 1024) });
            await expect(oauthFetch(`${origin}/big`)).rejects.toThrow("too large");
        } finally {
            await fixture.close();
        }
    });
});
