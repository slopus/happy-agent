import { once } from "node:events";
import { createServer, request } from "node:http";
import type { Socket } from "node:net";
import { HappyAgentClient } from "@slopus/happy-agent-client";
import { ApiModule } from "../../../sources/api/ApiModule.js";
import { servicesHarness } from "../../services/support/servicesHarness.js";

/** Real HTTP, API authentication, stores and services; unrelated feature observers are inert. */
export async function serviceApiHarness() {
    const f = await servicesHarness();
    const inert = new Proxy({}, { get: () => () => () => undefined }) as never;
    const api = new ApiModule(
        f.abort,
        f.config,
        f.events,
        inert,
        inert,
        f.bots,
        f.projects,
        f.workspaces,
        inert,
        inert,
        inert,
        inert,
        inert,
        inert,
        inert,
        inert,
        inert,
        inert,
        inert,
        inert,
        inert,
        inert,
        {
            enabled: false,
            onProfileUpdated: () => () => {},
            onDraftUpdated: () => () => {},
        } as never,
        inert,
        inert,
        undefined,
        f.services,
    );
    await api.beforeStart(f.ctx, f.agents);
    await api.markReady();
    const peers = new Set<Socket>();
    const server = createServer((req, res) => {
        void api.handleRequest(f.ctx, req, res);
    });
    server.on("connection", (socket) => {
        peers.add(socket);
        socket.once("close", () => peers.delete(socket));
        socket.on("error", () => {});
    });
    server.on("connect", (req, socket, head) => {
        void api.handleConnect(f.ctx, req, socket as Socket, head).then((handled) => {
            if (!handled) socket.destroy();
        });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const endpoint = `http://127.0.0.1:${port}`;
    const token = api.token()!;
    const client = new HappyAgentClient({ endpoint, token });
    return {
        ...f,
        api,
        client,
        endpoint,
        token,
        async connectService(
            workspaceId: string,
            serviceId: string,
            headers: Record<string, string>,
        ) {
            const req = request({
                host: "127.0.0.1",
                port,
                method: "CONNECT",
                path: `/v0/workspaces/${workspaceId}/services/${serviceId}/proxy`,
                headers,
            });
            const connected = once(req, "connect");
            req.end();
            const [response, socket, head] = await connected;
            return {
                status: response.statusCode as number,
                socket: socket as Socket,
                head: head as Buffer,
            };
        },
        async close() {
            await api.close();
            for (const peer of peers) peer.destroy();
            await new Promise<void>((resolve) => server.close(() => resolve()));
            await f.close();
        },
    };
}
