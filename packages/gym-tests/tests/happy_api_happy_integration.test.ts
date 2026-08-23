import { createServer, type RequestListener, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { clientFrameEvent, createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import nacl from "tweetnacl";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";

const gyms = new Set<AgentGym>();
const servers = new Set<Server>();
const webSocketServers = new Set<WebSocketServer>();

afterEach(async () => {
    await Promise.all([...gyms].map(async (gym) => await gym.dispose()));
    gyms.clear();
    await Promise.all(
        [...webSocketServers].map(
            async (server) =>
                await new Promise<void>((resolve) => {
                    for (const socket of server.clients) socket.terminate();
                    server.close(() => resolve());
                }),
        ),
    );
    webSocketServers.clear();
    await Promise.all(
        [...servers].map(
            async (server) =>
                await new Promise<void>((resolve) => {
                    server.closeAllConnections();
                    server.close(() => resolve());
                }),
        ),
    );
    servers.clear();
});

describe("Happy integration API", () => {
    it("returns pairing data and streams complete pairing and failure snapshots", async () => {
        let requests = 0;
        const serverUrl = await startHappyServer((_request, response) => {
            requests += 1;
            sendJson(
                response,
                requests === 1 ? { state: "requested" } : { state: "not-a-happy-state" },
            );
        });
        const gym = await createAgentGym({
            environment: {
                HAPPY_AGENT_HAPPY_SERVER_URL: serverUrl,
            },
            timeoutMs: 15_000,
        });
        gyms.add(gym);

        const initial = await gym.client.getHappyIntegration();
        expect(initial.integration).toMatchObject({
            authorization: null,
            configured: false,
            error: null,
            status: "disconnected",
        });
        await expect(gym.client.getDesktopBootstrap()).resolves.toMatchObject({
            happyIntegration: initial.integration,
        });

        const stream = gym.stream();
        try {
            await stream.opened();
            const startedAt = Date.now();
            const started = await gym.client.startHappyIntegration();
            expect(started.integration).toMatchObject({
                authorization: {
                    data: expect.stringMatching(/^happy:\/\/terminal\?[A-Za-z0-9_-]+$/u),
                    expiresAt: expect.any(Number),
                    kind: "qr",
                },
                configured: false,
                error: null,
                status: "pairing",
            });
            expect(started.integration.authorization?.expiresAt).toBeGreaterThanOrEqual(
                startedAt + 110_000,
            );
            expect(started.integration.authorization?.expiresAt).toBeLessThanOrEqual(
                Date.now() + 120_000,
            );

            const pairingFrame = await stream.waitFor((frame) => {
                const event = clientFrameEvent(frame);
                return (
                    event?.type === "happy.integration.updated" &&
                    event.payload.integration.status === "pairing"
                );
            }, "the Happy pairing event");
            const pairingEvent = clientFrameEvent(pairingFrame);
            expect(pairingEvent?.type).toBe("happy.integration.updated");
            if (pairingEvent?.type !== "happy.integration.updated") {
                throw new Error("The pairing update was not a typed Happy integration event.");
            }
            expect(pairingEvent.payload.integration).toEqual(started.integration);

            const failedFrame = await stream.waitFor((frame) => {
                const event = clientFrameEvent(frame);
                return (
                    event?.type === "happy.integration.updated" &&
                    event.payload.integration.status === "failed"
                );
            }, "the Happy authorization failure event");
            const failedEvent = clientFrameEvent(failedFrame);
            expect(failedEvent?.type).toBe("happy.integration.updated");
            if (failedEvent?.type !== "happy.integration.updated") {
                throw new Error("The failure update was not a typed Happy integration event.");
            }
            expect(failedEvent.payload.integration).toMatchObject({
                authorization: null,
                configured: false,
                error: {
                    code: "invalid_response",
                    message: expect.any(String),
                },
                status: "failed",
            });
            await expect(gym.client.getHappyIntegration()).resolves.toEqual({
                integration: failedEvent.payload.integration,
            });
        } finally {
            stream.close();
        }
    }, 30_000);

    it("keeps disconnected state when Happy cannot create an authorization request", async () => {
        const serverUrl = await startHappyServer((_request, response) => {
            sendJson(response, { error: "unavailable" }, 503);
        });
        const gym = await createAgentGym({
            environment: {
                HAPPY_AGENT_HAPPY_SERVER_URL: serverUrl,
            },
            timeoutMs: 15_000,
        });
        gyms.add(gym);
        const before = await gym.client.getHappyIntegration();
        const eventsBefore = (await gym.events()).filter(
            (event) => event.type === "happy.integration.updated",
        );

        let caught: unknown;
        try {
            await gym.client.startHappyIntegration();
        } catch (error: unknown) {
            caught = error;
        }
        expect(caught).toMatchObject({
            body: { integration: before.integration },
            code: "happy_unavailable",
            status: 503,
        });
        await expect(gym.client.getHappyIntegration()).resolves.toEqual(before);
        expect(
            (await gym.events()).filter((event) => event.type === "happy.integration.updated"),
        ).toEqual(eventsBefore);
    }, 30_000);

    it("reports a disabled integration and refuses to start it", async () => {
        const gym = await createAgentGym({
            config: "[settings]\nhappy_integration = false\n",
            timeoutMs: 15_000,
        });
        gyms.add(gym);
        const before = await gym.client.getHappyIntegration();
        expect(before.integration).toMatchObject({
            authorization: null,
            configured: false,
            error: null,
            status: "disabled",
        });

        let caught: unknown;
        try {
            await gym.client.startHappyIntegration();
        } catch (error: unknown) {
            caught = error;
        }
        expect(caught).toMatchObject({
            body: { integration: before.integration },
            code: "unsupported",
            status: 503,
        });
        await expect(gym.client.getHappyIntegration()).resolves.toEqual(before);
    }, 30_000);

    it("joins concurrent starts and exposes idempotent cancel, re-pair, and unlink controls", async () => {
        const happy = await startProtocolHappyServer({ authorizePairing: false });
        const gym = await createAgentGym({
            environment: { HAPPY_AGENT_HAPPY_SERVER_URL: happy.url },
            timeoutMs: 15_000,
        });
        gyms.add(gym);

        const [first, joined] = await Promise.all([
            gym.client.startHappyIntegration(),
            gym.client.startHappyIntegration(),
        ]);
        expect(joined).toEqual(first);
        expect(happy.authorizationRequests).toBe(1);

        const cancelled = await gym.client.cancelHappyIntegration();
        expect(cancelled.integration).toMatchObject({
            authorization: null,
            configured: false,
            error: null,
            status: "disconnected",
        });
        await expect(gym.client.cancelHappyIntegration()).resolves.toEqual(cancelled);

        const replacement = await gym.client.rePairHappyIntegration();
        expect(replacement.integration.status).toBe("pairing");
        if (
            first.integration.status !== "pairing" ||
            replacement.integration.status !== "pairing"
        ) {
            throw new Error("Happy did not return the two pairing authorizations.");
        }
        expect(replacement.integration.authorization.data).not.toBe(
            first.integration.authorization.data,
        );

        const unlinked = await gym.client.disconnectHappyIntegration();
        expect(unlinked.integration).toMatchObject({
            authorization: null,
            configured: false,
            error: null,
            status: "disconnected",
        });

        const externalHome = join(dirname(gym.happyHome), "credentials", "happy");
        await writeLegacyCredentials(externalHome, "changed-after-unlink", happy.url, 9);
        await expect(gym.client.disconnectHappyIntegration()).resolves.toEqual(unlinked);
        await gym.restart();
        await expect(waitForIntegration(gym, "connected")).resolves.toMatchObject({
            configured: true,
        });
    }, 30_000);

    it("authorizes, connects an existing agent, and preserves ordered state across restart", async () => {
        const happy = await startProtocolHappyServer({ authorizePairing: true });
        const gym = await createAgentGym({
            environment: { HAPPY_AGENT_HAPPY_SERVER_URL: happy.url },
            timeoutMs: 20_000,
        });
        gyms.add(gym);

        const started = await gym.client.startHappyIntegration();
        expect(started.integration.status).toBe("pairing");
        const connected = await waitForIntegration(gym, "connected");
        expect(connected.configured).toBe(true);
        expect(happy.machineRegistrations).toBe(1);
        await gym.waitUntil(
            () => (happy.sessionCreations > 0 ? happy.sessionCreations : undefined),
            "the existing agent to be attached to Happy",
        );

        const publicSnapshot = JSON.stringify(connected);
        expect(publicSnapshot).not.toContain("happy-authorized-token");
        expect(publicSnapshot).not.toContain(Buffer.alloc(32, 7).toString("base64"));
        const settingsPath = join(gym.happyHome, "agent", "happy", "settings.json");
        await expect(readFile(settingsPath, "utf8")).resolves.toContain(happy.url);

        await gym.restart();
        const restarted = await waitForIntegration(gym, "connected");
        expect(restarted.version > connected.version).toBe(true);
        expect(happy.machineRegistrations).toBeGreaterThanOrEqual(2);
        expect(happy.authorizationRequests).toBe(2);
    }, 45_000);

    it("suppresses rejected imported credentials across restart and accepts a changed login", async () => {
        const happy = await startProtocolHappyServer({
            authorizePairing: false,
            registrationStatus: (token) => (token === "rejected-token" ? 401 : 200),
        });
        const gym = await createAgentGym({
            environment: { HAPPY_AGENT_HAPPY_SERVER_URL: happy.url },
            timeoutMs: 20_000,
        });
        gyms.add(gym);
        const externalHome = join(dirname(gym.happyHome), "credentials", "happy");
        await writeLegacyCredentials(externalHome, "rejected-token", happy.url, 3);

        await gym.restart();
        const rejected = await waitForIntegration(gym, "failed");
        expect(rejected).toMatchObject({
            configured: false,
            error: { code: "credentials_rejected" },
        });
        const daemonCredentialPath = join(gym.happyHome, "agent", "happy", "access.key");
        await expect(stat(daemonCredentialPath)).rejects.toMatchObject({ code: "ENOENT" });
        const registrationsAfterRejection = happy.machineRegistrations;

        await gym.restart();
        const suppressed = await gym.client.getHappyIntegration();
        expect(suppressed.integration).toMatchObject({
            configured: false,
            status: "disconnected",
        });
        expect(happy.machineRegistrations).toBe(registrationsAfterRejection);
        const pairing = await gym.client.startHappyIntegration();
        expect(pairing.integration.status).toBe("pairing");
        await gym.client.cancelHappyIntegration();

        await writeLegacyCredentials(externalHome, "replacement-token", happy.url, 4);
        await gym.restart();
        const restored = await waitForIntegration(gym, "connected");
        expect(restored.configured).toBe(true);
        expect(happy.machineRegistrations).toBeGreaterThan(registrationsAfterRejection);
    }, 60_000);

    it("revalidates a failed socket handshake and invalidates credentials rejected by HTTP", async () => {
        const happy = await startProtocolHappyServer({
            authorizePairing: false,
            registrationStatus: (_token, attempt) => (attempt === 1 ? 200 : 401),
            socketMode: "reject",
        });
        const gym = await createAgentGym({
            environment: { HAPPY_AGENT_HAPPY_SERVER_URL: happy.url },
            timeoutMs: 20_000,
        });
        gyms.add(gym);
        const externalHome = join(dirname(gym.happyHome), "credentials", "happy");
        await writeLegacyCredentials(externalHome, "socket-token", happy.url, 5);

        await gym.restart();
        const failed = await waitForIntegration(gym, "failed");
        expect(failed).toMatchObject({
            configured: false,
            error: { code: "credentials_rejected" },
        });
        expect(happy.machineRegistrations).toBe(2);
        expect(happy.socketConnections).toBeGreaterThanOrEqual(1);
    }, 45_000);

    it("does not inspect or copy external credentials while the integration is disabled", async () => {
        const happy = await startProtocolHappyServer({ authorizePairing: false });
        const gym = await createAgentGym({
            config: "[settings]\nhappy_integration = false\n",
            environment: { HAPPY_AGENT_HAPPY_SERVER_URL: happy.url },
            timeoutMs: 15_000,
        });
        gyms.add(gym);
        const externalHome = join(dirname(gym.happyHome), "credentials", "happy");
        await writeLegacyCredentials(externalHome, "private-disabled-token", happy.url, 6);

        await gym.restart();
        const state = await gym.client.getHappyIntegration();
        expect(state.integration).toMatchObject({ configured: false, status: "disabled" });
        expect(happy.machineRegistrations).toBe(0);
        await expect(
            stat(join(gym.happyHome, "agent", "happy", "access.key")),
        ).rejects.toMatchObject({ code: "ENOENT" });
        await expect(
            stat(join(gym.happyHome, "agent", "happy", "machine.json")),
        ).rejects.toMatchObject({ code: "ENOENT" });
    }, 30_000);
});

async function startHappyServer(handler: RequestListener): Promise<string> {
    const server = createServer(handler);
    servers.add(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address() as AddressInfo;
    return `http://127.0.0.1:${String(address.port)}`;
}

function sendJson(response: ServerResponse, body: unknown, status = 200): void {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
}

interface ProtocolHappyServer {
    readonly url: string;
    readonly authorizationRequests: number;
    readonly machineRegistrations: number;
    readonly sessionCreations: number;
    readonly socketConnections: number;
}

async function startProtocolHappyServer(options: {
    authorizePairing: boolean;
    registrationStatus?: (token: string, attempt: number) => number;
    socketMode?: "connect" | "reject";
}): Promise<ProtocolHappyServer> {
    let authorizationRequests = 0;
    let machineRegistrations = 0;
    let sessionCreations = 0;
    let socketConnections = 0;
    const secret = new Uint8Array(32).fill(7);
    const server = createServer((request, response) => {
        const url = new URL(request.url ?? "/", "http://happy.test");
        void readRequestBody(request).then(
            (body) => {
                if (request.method === "POST" && url.pathname === "/v1/auth/request") {
                    authorizationRequests += 1;
                    const parsed = JSON.parse(body) as { publicKey: string };
                    if (!options.authorizePairing || authorizationRequests === 1) {
                        sendJson(response, { state: "requested" });
                        return;
                    }
                    sendJson(response, {
                        response: sealHappyAuthorization(secret, parsed.publicKey),
                        state: "authorized",
                        token: "happy-authorized-token",
                    });
                    return;
                }
                if (request.method === "POST" && url.pathname === "/v1/machines") {
                    machineRegistrations += 1;
                    const token = bearerToken(request.headers.authorization);
                    const status = options.registrationStatus?.(token, machineRegistrations) ?? 200;
                    if (status !== 200) {
                        sendJson(response, { error: "registration rejected" }, status);
                        return;
                    }
                    sendJson(response, {
                        machine: { daemonStateVersion: 1, metadataVersion: 1 },
                    });
                    return;
                }
                if (request.method === "POST" && url.pathname === "/v1/sessions") {
                    sessionCreations += 1;
                    const parsed = JSON.parse(body) as { metadata?: string };
                    sendJson(response, {
                        session: {
                            agentState: null,
                            agentStateVersion: 0,
                            id: "happy-session-1",
                            metadata: parsed.metadata,
                            metadataVersion: 0,
                        },
                    });
                    return;
                }
                if (
                    request.method === "GET" &&
                    url.pathname === "/v3/sessions/happy-session-1/messages"
                ) {
                    sendJson(response, { hasMore: false, messages: [] });
                    return;
                }
                if (
                    request.method === "POST" &&
                    url.pathname === "/v3/sessions/happy-session-1/messages"
                ) {
                    sendJson(response, { success: true });
                    return;
                }
                sendJson(response, { error: "not found" }, 404);
            },
            () => sendJson(response, { error: "invalid request" }, 400),
        );
    });
    servers.add(server);
    const webSockets = new WebSocketServer({ noServer: true });
    webSocketServers.add(webSockets);
    server.on("upgrade", (request, socket, head) => {
        const url = new URL(request.url ?? "/", "http://happy.test");
        if (url.pathname !== "/v1/updates/") {
            socket.destroy();
            return;
        }
        webSockets.handleUpgrade(request, socket, head, (webSocket) => {
            webSockets.emit("connection", webSocket, request);
        });
    });
    webSockets.on("connection", (socket: WebSocket) => {
        socketConnections += 1;
        socket.send(
            `0${JSON.stringify({
                maxPayload: 1_000_000,
                pingInterval: 25_000,
                pingTimeout: 20_000,
                sid: `engine-${String(socketConnections)}`,
                upgrades: [],
            })}`,
        );
        socket.on("message", (value) => {
            const packet = value.toString();
            if (!packet.startsWith("40")) return;
            if (options.socketMode === "reject") {
                socket.send(`44${JSON.stringify({ message: "Unauthorized" })}`);
                return;
            }
            socket.send(`40${JSON.stringify({ sid: `socket-${String(socketConnections)}` })}`);
        });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address() as AddressInfo;
    return {
        get authorizationRequests() {
            return authorizationRequests;
        },
        get machineRegistrations() {
            return machineRegistrations;
        },
        get sessionCreations() {
            return sessionCreations;
        },
        get socketConnections() {
            return socketConnections;
        },
        url: `http://127.0.0.1:${String(address.port)}`,
    };
}

function sealHappyAuthorization(secret: Uint8Array, publicKeyBase64: string): string {
    const recipient = new Uint8Array(Buffer.from(publicKeyBase64, "base64"));
    const ephemeral = nacl.box.keyPair();
    const nonce = nacl.randomBytes(nacl.box.nonceLength);
    const ciphertext = nacl.box(secret, nonce, recipient, ephemeral.secretKey);
    return Buffer.concat([
        Buffer.from(ephemeral.publicKey),
        Buffer.from(nonce),
        Buffer.from(ciphertext),
    ]).toString("base64");
}

async function readRequestBody(request: import("node:http").IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf8");
}

function bearerToken(value: string | undefined): string {
    return value?.startsWith("Bearer ") === true ? value.slice("Bearer ".length) : "";
}

async function waitForIntegration(
    gym: AgentGym,
    status: "connected" | "failed",
): Promise<Awaited<ReturnType<AgentGym["client"]["getHappyIntegration"]>>["integration"]> {
    return await gym.waitUntil(async () => {
        const integration = (await gym.client.getHappyIntegration()).integration;
        return integration.status === status ? integration : undefined;
    }, `the Happy integration to become ${status}`);
}

async function writeLegacyCredentials(
    directory: string,
    token: string,
    serverUrl: string,
    fill: number,
): Promise<void> {
    await mkdir(directory, { recursive: true });
    await writeFile(
        join(directory, "access.key"),
        JSON.stringify({ secret: Buffer.alloc(32, fill).toString("base64"), token }),
    );
    await writeFile(join(directory, "settings.json"), JSON.stringify({ serverUrl }));
}
