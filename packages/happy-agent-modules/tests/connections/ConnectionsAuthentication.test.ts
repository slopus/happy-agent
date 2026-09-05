import { createServer } from "node:http";
import { connect, type Socket } from "node:net";
import { once } from "node:events";
import { createRootContext } from "@steve.kite/stdlib";
import { expect, it, vi } from "vitest";
import { ConnectionsModule } from "../../sources/connections/index.js";

it.each([
    { team: false, bearer: true, expected: "remote-secret" },
    { team: true, bearer: true, expected: "remote-secret" },
    { team: false, bearer: false, expected: "cloud-user-token" },
    { team: true, bearer: false, expected: "requesting-team-user-token" },
])(
    "preserves authentication ownership for team=$team bearer=$bearer",
    async ({ team, bearer, expected }) => {
        const ctx = createRootContext();
        const sockets = new Set<Socket>();
        const mintForOrganization = vi.fn(async () => "cloud-user-token");
        const observed: string[] = [];
        const remote = createServer((req, res) => {
            observed.push(req.headers.authorization ?? "");
            res.writeHead(401, { "content-type": "application/json" });
            res.end('{"error":"Unauthorized","code":"unauthorized"}');
        });
        remote.listen(0, "127.0.0.1");
        await once(remote, "listening");
        const address = remote.address();
        if (address === null || typeof address === "string")
            throw new Error("Missing test server.");
        const module = new ConnectionsModule(
            {
                configuration: { values: { feature: { team: { enabled: team } } } },
                connections: {
                    remote: {
                        name: "Remote",
                        address: "tcTest",
                        ...(bearer
                            ? { token: "remote-secret" }
                            : { workos_organization_id: "org_destination" }),
                    },
                },
            } as never,
            {} as never,
            { mintForOrganization } as never,
            {
                openRemote: () => ({
                    connect: () => connect({ host: "127.0.0.1", port: address.port }),
                    close: async () => undefined,
                }),
            } as never,
            { register: () => undefined } as never,
        );
        const gateway = createServer((req, res) => {
            void module.forward(ctx, req, res, "remote", "/v0/health").catch(() => res.destroy());
        });
        for (const server of [remote, gateway])
            server.on("connection", (socket) => {
                sockets.add(socket);
                socket.once("close", () => sockets.delete(socket));
            });
        gateway.listen(0, "127.0.0.1");
        await once(gateway, "listening");
        try {
            const target = gateway.address();
            if (target === null || typeof target === "string")
                throw new Error("Missing test gateway.");
            const response = await fetch(`http://127.0.0.1:${target.port}/`, {
                headers: { authorization: "Bearer requesting-team-user-token" },
            });
            expect(response.status).toBe(401);
            expect(await response.json()).toEqual({ error: "Unauthorized", code: "unauthorized" });
            expect(observed).toEqual([`Bearer ${expected}`]);
            if (!team && !bearer)
                expect(mintForOrganization).toHaveBeenCalledWith(
                    ctx,
                    "org_destination",
                    expect.any(AbortSignal),
                );
            else expect(mintForOrganization).not.toHaveBeenCalled();
        } finally {
            await module.close(ctx);
            for (const socket of sockets) socket.destroy();
            await Promise.all(
                [remote, gateway].map(
                    (server) => new Promise<void>((resolve) => server.close(() => resolve())),
                ),
            );
        }
    },
);
