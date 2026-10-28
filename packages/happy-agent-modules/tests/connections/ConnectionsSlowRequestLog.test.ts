import { createServer } from "node:http";
import { connect, type Socket } from "node:net";
import { once } from "node:events";
import { createRootContext, withLogger, type LogContext, type Logger } from "@steve.kite/stdlib";
import { afterEach, expect, it, vi } from "vitest";
import { CloudOperationError } from "../../sources/cloud/index.js";
import { ConnectionsModule } from "../../sources/connections/index.js";

afterEach(() => {
    vi.restoreAllMocks();
});

it("logs safe timing fields for a proxied request slower than one second", async () => {
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const logs: Array<{ level: keyof Logger; message: string }> = [];
    const ctx = withLogger(createRootContext(), recordingLogger(logs));
    const mintForOrganization = vi.fn(async () => {
        clock += 1_400;
        return "cloud-user-token";
    });
    const gateway = await proxy(mintForOrganization);
    try {
        const slow = await fetch(
            `${gateway.url}/team/v0/spaces/sidebar?widgets=private-value&cursor=abc&widgets=b`,
        );
        expect(slow.status).toBe(200);
        await slow.text();
        await vi.waitFor(() => expect(logs).toHaveLength(1));
        expect(logs[0]).toEqual({
            level: "info",
            message:
                "connections:forward:slow connection=team method=GET path=/v0/spaces/sidebar?widgets&cursor status=200 totalMs=1400 responseMs=1400 tokenMs=1400 stream=false",
        });

        // A fast request is not logged; a request whose token wait fails reports Cloud's status.
        const fast = await fetch(`${gateway.url}/bearer/v0/spaces`);
        expect(fast.status).toBe(200);
        await fast.text();
        mintForOrganization.mockImplementationOnce(async () => {
            clock += 2_000;
            throw new CloudOperationError(
                503,
                "cloud_unavailable",
                "Cloud authentication is temporarily unavailable.",
                {} as never,
            );
        });
        const failed = await fetch(`${gateway.url}/team/v0/bootstrap/desktop`, {
            method: "POST",
        });
        expect(failed.status).toBe(503);
        await vi.waitFor(() => expect(logs).toHaveLength(2));
        expect(logs[1]?.message).toBe(
            "connections:forward:slow connection=team method=POST path=/v0/bootstrap/desktop status=503 totalMs=2000 responseMs=none tokenMs=2000 stream=false",
        );
        expect(JSON.stringify(logs)).not.toMatch(/cloud-user-token|remote-secret|private-value/);
    } finally {
        await gateway.close(ctx);
    }

    async function proxy(mint: typeof mintForOrganization) {
        const sockets = new Set<Socket>();
        const remote = createServer((_req, res) => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end("{}");
        });
        remote.listen(0, "127.0.0.1");
        await once(remote, "listening");
        const address = remote.address();
        if (address === null || typeof address === "string")
            throw new Error("Missing test server.");
        const module = new ConnectionsModule(
            {
                configuration: { values: { feature: { team: { enabled: false } } } },
                connections: {
                    team: {
                        name: "Team",
                        address: "tcTeam",
                        workos_organization_id: "org_destination",
                    },
                    bearer: { name: "Bearer", address: "tcBearer", token: "remote-secret" },
                },
            } as never,
            {} as never,
            { mintForOrganization: mint, refreshOrganizationsAhead: () => undefined } as never,
            {
                openRemote: () => ({
                    connect: () => connect({ host: "127.0.0.1", port: address.port }),
                    close: async () => undefined,
                }),
            } as never,
            { register: () => undefined } as never,
        );
        const gatewayServer = createServer((req, res) => {
            const [, id, ...rest] = (req.url ?? "/").split("/");
            module.forward(ctx, req, res, id!, `/${rest.join("/")}`).catch((error: unknown) => {
                res.writeHead(error instanceof CloudOperationError ? error.status : 500);
                res.end();
            });
        });
        for (const server of [remote, gatewayServer])
            server.on("connection", (socket) => {
                sockets.add(socket);
                socket.once("close", () => sockets.delete(socket));
            });
        gatewayServer.listen(0, "127.0.0.1");
        await once(gatewayServer, "listening");
        const target = gatewayServer.address();
        if (target === null || typeof target === "string") throw new Error("Missing test gateway.");
        return {
            url: `http://127.0.0.1:${String(target.port)}`,
            close: async (closeCtx: typeof ctx) => {
                await module.close(closeCtx);
                for (const socket of sockets) socket.destroy();
                await Promise.all(
                    [remote, gatewayServer].map(
                        (server) => new Promise<void>((resolve) => server.close(() => resolve())),
                    ),
                );
            },
        };
    }
});

function recordingLogger(records: Array<{ level: keyof Logger; message: string }>): Logger {
    const write =
        (level: keyof Logger) =>
        (_context: LogContext, ...args: readonly unknown[]) => {
            records.push({ level, message: args.map(String).join(" ") });
        };
    return {
        debug: write("debug"),
        error: write("error"),
        fatal: write("fatal"),
        info: write("info"),
        trace: write("trace"),
        warn: write("warn"),
    };
}
