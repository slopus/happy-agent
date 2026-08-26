import { createServer, type Server } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";

import { openCloudSocialSocket } from "../../sources/cloud/CloudSocialSocket.js";

const version = "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e";
const nextVersion = "01991f3a-5c1e-7001-8000-2f9a1b3c4d5e";
const servers: Server[] = [];

afterEach(async () => {
    await Promise.all(
        servers
            .splice(0)
            .map(
                async (server) =>
                    await new Promise<void>((resolve) => server.close(() => resolve())),
            ),
    );
});

describe("Cloud social socket", () => {
    it("authenticates in a header and validates ordered state and update frames", async () => {
        const server = createServer();
        servers.push(server);
        const sockets = new WebSocketServer({ noServer: true });
        const authorization = vi.fn();
        server.on("upgrade", (request, socket, head) => {
            authorization(request.headers.authorization);
            sockets.handleUpgrade(request, socket, head, (webSocket) => {
                webSocket.send(JSON.stringify({ type: "state", version }));
                webSocket.send(
                    JSON.stringify({
                        type: "update",
                        updates: [
                            {
                                kind: "friend-added",
                                user: { firstName: "Grace", username: "grace" },
                            },
                        ],
                        version: nextVersion,
                    }),
                );
            });
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        if (address === null || typeof address === "string") throw new Error("Missing test port.");
        const states: string[] = [];
        const updates: string[] = [];
        const controller = new AbortController();

        const connection = await openCloudSocialSocket(
            `ws://127.0.0.1:${String(address.port)}/v0/updates`,
            "secret-access-token",
            controller.signal,
            {
                onState: (received) => {
                    states.push(received);
                },
                onUpdate: (received) => {
                    updates.push(received);
                },
            },
        );
        await vi.waitFor(() => expect(updates).toEqual([nextVersion]));

        expect(states).toEqual([version]);
        expect(authorization).toHaveBeenCalledWith("Bearer secret-access-token");
        connection.close();
        await connection.done;
        sockets.close();
    });
});
