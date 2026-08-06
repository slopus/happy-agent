import { createServer, request } from "node:http";
import type { IncomingHttpHeaders, Server } from "node:http";
import { rm } from "node:fs/promises";

import { Endpoint, RelayMode, SecretKey } from "@number0/iroh/index.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { IrohNetwork, P2pNetwork } from "../../p2p/index.js";
import { ProtocolHttpClient } from "../../client/ProtocolHttpClient.js";
import { createP2pInstanceIdentity } from "../../p2p/P2pIdentity.js";
import { createTestSocketDirectory } from "../../testing/createTestSocketDirectory.js";
import { createProtocolHttpServer } from "../createProtocolHttpServer.js";
import { createServeP2pHttpRequest } from "../createServeP2pHttpRequest.js";
import { createServeP2pTunnel } from "../createServeP2pTunnel.js";
import type { P2pPeerTrustStoreContract } from "../../p2p/P2pPeerTrustStore.js";

const ALPN = [...Buffer.from("rig/p2p/5", "utf8")];
const cleanups: (() => Promise<void>)[] = [];
const peerTrustStore: P2pPeerTrustStoreContract = {
    preparePairing: async () => {
        throw new Error("Pairing is not used by this test.");
    },
    peerForBinding: () => undefined,
    peers: () => [],
    readyPairings: () => [],
    validate: async () => undefined,
    verifyOrPin: async () => undefined,
};

afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("P2P HTTP between two real daemon servers", () => {
    it("serves request/response and live events through the local peer prefix", async () => {
        const firstDaemon = await startDaemon("first-token");
        const secondDaemon = await startDaemon("second-token");
        const firstKey = SecretKey.generate();
        const secondKey = SecretKey.generate();
        const firstIdentity = createP2pInstanceIdentity();
        const secondIdentity = createP2pInstanceIdentity();
        const [firstEndpoint, secondEndpoint] = await Promise.all([
            Endpoint.bind({ alpns: [ALPN], secretKey: firstKey.toBytes() }, RelayMode.disabled()),
            Endpoint.bind({ alpns: [ALPN], secretKey: secondKey.toBytes() }, RelayMode.disabled()),
        ]);
        const firstId = firstEndpoint.id().toString();
        const secondId = secondEndpoint.id().toString();
        const firstNetwork = await P2pNetwork.create({
            config: {
                direct: {},
                enableDirect: false,
                enableIroh: true,
                enableSsh: false,
                exposeApi: false,
                iroh: {},
                name: "First",
                role: "primary",
            },
            createIrohTransport: (onStatusChange) =>
                IrohNetwork.create({
                    config: {},
                    endpointIds: [secondId],
                    endpoint: firstEndpoint,
                    identity: firstIdentity,
                    onStatusChange,
                    peerAddresses: new Map([[secondId, secondEndpoint.addr()]]),
                    relayMode: RelayMode.disabled(),
                    secretKey: firstKey,
                }),
            irohSecretKeyPath: "unused",
            identity: firstIdentity,
            peerTrustStore,
        });
        cleanups.push(() => firstNetwork.close());
        const secondNetwork = await P2pNetwork.create({
            config: {
                direct: {},
                enableDirect: false,
                enableIroh: true,
                enableSsh: false,
                exposeApi: true,
                iroh: {},
                name: "Second",
                role: "primary",
            },
            createIrohTransport: (onStatusChange) =>
                IrohNetwork.create({
                    config: {},
                    endpointIds: [firstId],
                    endpoint: secondEndpoint,
                    identity: secondIdentity,
                    onStatusChange,
                    peerAddresses: new Map([[firstId, firstEndpoint.addr()]]),
                    relayMode: RelayMode.disabled(),
                    secretKey: secondKey,
                    serveRequest: createServeP2pHttpRequest({
                        allowRequest: () => true,
                        socketPath: secondDaemon.socketPath,
                        token: "second-token",
                    }),
                    serveTunnel: createServeP2pTunnel({
                        socketPath: secondDaemon.socketPath,
                        token: "second-token",
                    }),
                }),
            irohSecretKeyPath: "unused",
            identity: secondIdentity,
            peerTrustStore,
        });
        cleanups.push(() => secondNetwork.close());
        await vi.waitFor(() => {
            expect(firstNetwork.status().transports[0]).toMatchObject({
                peers: [{ peerId: secondIdentity.instanceId, status: "connected" }],
            });
            expect(secondNetwork.status().transports[0]).toMatchObject({
                peers: [{ peerId: firstIdentity.instanceId, status: "connected" }],
            });
        });

        firstDaemon.server.closeAllConnections();
        await firstDaemon.close();
        const exposedFirst = await startDaemon("first-token", firstNetwork);
        const health = await get(
            exposedFirst.socketPath,
            `/p2p/peers/${secondIdentity.instanceId}/api/health`,
            "first-token",
        );
        expect(health.status).toBe(200);
        expect(JSON.parse(health.body)).toMatchObject({ status: "ready" });
        expect(health.headers["x-rig-p2p-peer"]).toBe(secondIdentity.instanceId);

        const hello = await readFirstSseFrame(
            exposedFirst.socketPath,
            `/p2p/peers/${secondIdentity.instanceId}/api/events/live`,
            "first-token",
        );
        expect(hello).toContain("event: hello");

        const peerClient = new ProtocolHttpClient({
            pathPrefix: `/p2p/peers/${secondIdentity.instanceId}/api`,
            socketPath: exposedFirst.socketPath,
            token: "first-token",
        });
        const createdSession = await peerClient.createSession({ cwd: process.cwd() });
        const scope = { projectId: createdSession.session.projectId };
        const createdTerminal = await peerClient.createRemoteTerminal(scope, {
            command: 'printf "p2p-terminal-ok\\n"',
        });
        const terminal = await peerClient.attachRemoteTerminal(scope, createdTerminal.terminal.id);
        await expect(terminal.exited).resolves.toBe(0);
        terminal.close();

        const target = createServer((_request, response) => response.end("p2p-browser-ok"));
        await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
        cleanups.push(
            () =>
                new Promise<void>((resolve) => {
                    target.closeAllConnections();
                    target.close(() => resolve());
                }),
        );
        const address = target.address();
        if (address === null || typeof address === "string") throw new Error("Missing test port.");
        const browserResponse = await peerClient.proxyHttpRequest(scope, {
            url: `http://127.0.0.1:${String(address.port)}/`,
        });
        const browserChunks: Buffer[] = [];
        for await (const chunk of browserResponse.body) browserChunks.push(Buffer.from(chunk));
        expect(Buffer.concat(browserChunks).toString()).toBe("p2p-browser-ok");

        const exposedSecond = await startDaemon("second-token", secondNetwork);
        const refusal = await get(
            exposedSecond.socketPath,
            `/p2p/peers/${firstIdentity.instanceId}/api/health`,
            "second-token",
        );
        expect(refusal.status).toBe(502);
    });
});

async function startDaemon(
    token: string,
    p2pNetwork?: P2pNetwork,
): Promise<{ close: () => Promise<void>; server: Server; socketPath: string }> {
    const directory = await createTestSocketDirectory();
    const socketPath = `${directory}/server.sock`;
    const server = createProtocolHttpServer({
        ...(p2pNetwork === undefined ? {} : { p2pNetwork }),
        token,
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => {
            server.off("error", reject);
            resolve();
        });
    });
    let closed = false;
    const close = async () => {
        if (closed) return;
        closed = true;
        await new Promise<void>((resolve, reject) => {
            server.close((error) => (error === undefined ? resolve() : reject(error)));
        });
        await rm(directory, { force: true, recursive: true });
    };
    cleanups.push(close);
    return { close, server, socketPath };
}

function get(
    socketPath: string,
    path: string,
    token: string,
): Promise<{
    body: string;
    headers: IncomingHttpHeaders;
    status: number;
}> {
    return new Promise((resolve, reject) => {
        const outgoing = request(
            { headers: { authorization: `Bearer ${token}` }, path, socketPath },
            (response) => {
                const chunks: Buffer[] = [];
                response.on("data", (chunk: Buffer) => chunks.push(chunk));
                response.once("end", () =>
                    resolve({
                        body: Buffer.concat(chunks).toString("utf8"),
                        headers: response.headers,
                        status: response.statusCode ?? 0,
                    }),
                );
            },
        );
        outgoing.once("error", reject);
        outgoing.end();
    });
}

function readFirstSseFrame(socketPath: string, path: string, token: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const outgoing = request(
            {
                headers: {
                    accept: "text/event-stream",
                    authorization: `Bearer ${token}`,
                },
                path,
                socketPath,
            },
            (response) => {
                let received = "";
                response.setEncoding("utf8");
                response.on("data", (chunk: string) => {
                    received += chunk;
                    if (!received.includes("event: hello")) return;
                    response.destroy();
                    outgoing.destroy();
                    resolve(received);
                });
            },
        );
        outgoing.once("error", (error) => {
            if (!outgoing.destroyed) reject(error);
        });
        outgoing.end();
    });
}
