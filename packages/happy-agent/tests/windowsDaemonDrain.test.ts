import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { HappyAgentClient } from "@slopus/happy-agent-client";
import { describe, expect, it } from "vitest";
import { createUnixSocketFetch } from "../sources/lifecycle/createUnixSocketFetch.js";
import { drainLocalProtocolServer } from "../sources/lifecycle/stopLocalProtocolServer.js";

describe.runIf(process.platform === "win32")("Windows authenticated daemon drain", () => {
    it.each([200, 401, 404])(
        "keeps the daemon running and handles HTTP %s truthfully",
        async (status) => {
            const socketPath = `\\\\.\\pipe\\happy-drain-api-${randomUUID()}`;
            const seen: string[] = [];
            let draining = false;
            const server = createServer((request, response) => {
                expect(request.headers.authorization).toBe("Bearer drain-test-token");
                seen.push(`${request.method} ${request.url}`);
                response.setHeader("content-type", "application/json");
                if (request.url === "/v0/drain") {
                    if (status !== 200) {
                        response
                            .writeHead(status)
                            .end(
                                JSON.stringify({ code: "unavailable", error: "Drain unavailable" }),
                            );
                        return;
                    }
                    draining = true;
                    response.end(JSON.stringify({ draining: true, pid: process.pid }));
                    return;
                }
                response.end(
                    JSON.stringify({
                        healthy: true,
                        ready: true,
                        status: "ready",
                        draining,
                        drainWaitingFor: [],
                        version: { protocol: 24, daemon: "0.0.0" },
                    }),
                );
            });
            server.listen(socketPath);
            await once(server, "listening");
            const client = new HappyAgentClient({
                endpoint: "http://happy-agent/",
                token: "drain-test-token",
                fetch: createUnixSocketFetch(socketPath),
            });
            const progress: string[] = [];
            try {
                const result = drainLocalProtocolServer(client, (message) =>
                    progress.push(message),
                );
                if (status === 200) {
                    await result;
                    expect(progress).toContain("Daemon drain is complete.");
                    expect((await client.getHealth()).draining).toBe(true);
                } else {
                    await expect(result).rejects.toThrow();
                    expect(progress).not.toContain("Daemon drain is complete.");
                    expect((await client.getHealth()).draining).toBe(false);
                }
                expect(seen.some((path) => path.includes("shutdown"))).toBe(false);
            } finally {
                server.closeAllConnections();
                await new Promise<void>((resolve) => server.close(() => resolve()));
            }
        },
    );
});
