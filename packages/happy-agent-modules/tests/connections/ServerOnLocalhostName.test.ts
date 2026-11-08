import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
    normalizeServerUrl,
    serverConnectHost,
} from "../../sources/connections/impl/normalizeServerUrl.js";
import {
    requireServerSignIn,
    serverAcceptsToken,
} from "../../sources/connections/impl/serverRequests.js";

const servers: Server[] = [];

afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
        servers
            .splice(0)
            .map(
                async (server) =>
                    await new Promise<void>((resolve) => server.close(() => resolve())),
            ),
    );
});

/** A Happy server's discovery on 127.0.0.1 that records the requests it receives. */
async function discovery(): Promise<{ port: number; seen: IncomingHttpHeaders[] }> {
    const seen: IncomingHttpHeaders[] = [];
    const server = createServer((request, response) => {
        seen.push(request.headers);
        response.setHeader("content-type", "application/json");
        response.end(
            JSON.stringify({
                authenticated: request.headers.authorization === "Bearer good",
                userId: null,
                methods: [
                    {
                        type: "oauth",
                        id: "jwt",
                        name: "Cloud",
                        authorizationUrl: "http://acme.localhost/authorize",
                        tokenUrl: "http://acme.localhost/token",
                        clientId: "happy",
                    },
                ],
            }),
        );
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return { port: (server.address() as AddressInfo).port, seen };
}

describe("a server at a name under localhost", () => {
    it("is accepted over plain http, as RFC 6761 reserves those names for loopback", () => {
        expect(normalizeServerUrl("http://Acme.localhost:31360")).toBe(
            "http://acme.localhost:31360/",
        );
        for (const refused of [
            "http://localhost.example.com",
            "http://acme-localhost",
            "http://acme.localhost.",
            "http://.localhost",
        ]) {
            expect(normalizeServerUrl(refused), refused).toBeUndefined();
        }
        expect(serverConnectHost("acme.localhost")).toBe("127.0.0.1");
        expect(serverConnectHost("localhost")).toBe("localhost");
        expect(serverConnectHost("[::1]")).toBe("::1");
        expect(serverConnectHost("happy.example.com")).toBe("happy.example.com");
    });

    it("is reached on 127.0.0.1 without a lookup, under its own name", async () => {
        const { port, seen } = await discovery();
        // DNS would be asked through fetch; the daemon never hands it such a name.
        const fetch = vi.spyOn(globalThis, "fetch");
        const url = `http://acme.localhost:${String(port)}/`;

        await requireServerSignIn(url);
        expect(await serverAcceptsToken(url, "good")).toBe(true);
        expect(await serverAcceptsToken(url, "stale")).toBe(false);

        expect(fetch).not.toHaveBeenCalled();
        expect(seen.map((headers) => headers.host)).toEqual([
            `acme.localhost:${String(port)}`,
            `acme.localhost:${String(port)}`,
            `acme.localhost:${String(port)}`,
        ]);
        expect(seen.map((headers) => headers.authorization)).toEqual([
            undefined,
            "Bearer good",
            "Bearer stale",
        ]);
    });

    it("reports a name under localhost with nothing listening as unreachable", async () => {
        const { port } = await discovery();
        await new Promise<void>((resolve) => servers.pop()!.close(() => resolve()));
        await expect(
            requireServerSignIn(`http://acme.localhost:${String(port)}/`),
        ).rejects.toMatchObject({
            status: 503,
            code: "remote_unavailable",
        });
    });
});
