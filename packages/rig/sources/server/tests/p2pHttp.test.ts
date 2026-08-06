import { request } from "node:http";
import type { Server } from "node:http";
import { rm } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import type { P2pStatus } from "../../protocol/index.js";
import { createTestSocketDirectory } from "../../testing/createTestSocketDirectory.js";
import { createProtocolHttpServer } from "../createProtocolHttpServer.js";

describe("P2P HTTP API", () => {
    it("reports the stable instance, transport address, and verified peer health", async () => {
        const status: P2pStatus = {
            instanceId: "alocalinstance00000000001",
            publicKey: "A".repeat(43),
            transports: [
                {
                    apiExposed: false,
                    localAddress: "local-endpoint",
                    peers: [
                        {
                            address: "remote-endpoint",
                            lastSeenAt: 123,
                            peerId: "aremoteinstance0000000001",
                            rttMs: 7,
                            status: "connected",
                        },
                    ],
                    relayUrl: "https://relay.example.com",
                    state: "ready",
                    transport: "iroh",
                },
            ],
        };
        const started = await startServer(() => status);
        try {
            await expect(getStatus(started.socketPath)).resolves.toEqual(status);
        } finally {
            await started.close();
        }
    });

    it("reports no transports when P2P networking is disabled", async () => {
        const started = await startServer();
        try {
            await expect(getStatus(started.socketPath)).resolves.toEqual({ transports: [] });
        } finally {
            await started.close();
        }
    });

    it("reports why configured P2P networking could not start", async () => {
        const status: P2pStatus = {
            transports: [
                {
                    error: "Native binding is unavailable.",
                    state: "unavailable",
                    transport: "iroh",
                },
            ],
        };
        const started = await startServer(() => status);
        try {
            await expect(getStatus(started.socketPath)).resolves.toEqual(status);
        } finally {
            await started.close();
        }
    });
});

async function startServer(p2pStatus?: () => P2pStatus): Promise<{
    close: () => Promise<void>;
    socketPath: string;
}> {
    const directory = await createTestSocketDirectory();
    const socketPath = `${directory}/server.sock`;
    const server = createProtocolHttpServer({
        ...(p2pStatus === undefined ? {} : { p2pStatus }),
        token: "test-token",
    });
    await listen(server, socketPath);
    return {
        close: async () => {
            await close(server);
            await rm(directory, { force: true, recursive: true });
        },
        socketPath,
    };
}

function getStatus(socketPath: string): Promise<P2pStatus> {
    return new Promise((resolve, reject) => {
        const outgoing = request(
            {
                headers: { authorization: "Bearer test-token" },
                method: "GET",
                path: "/p2p/status",
                socketPath,
            },
            (response) => {
                const chunks: Buffer[] = [];
                response.on("data", (chunk: Buffer) => chunks.push(chunk));
                response.once("end", () => {
                    try {
                        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as P2pStatus);
                    } catch (error) {
                        reject(error);
                    }
                });
            },
        );
        outgoing.once("error", reject);
        outgoing.end();
    });
}

function listen(server: Server, socketPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => {
            server.off("error", reject);
            resolve();
        });
    });
}

function close(server: Server): Promise<void> {
    return new Promise((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
}
