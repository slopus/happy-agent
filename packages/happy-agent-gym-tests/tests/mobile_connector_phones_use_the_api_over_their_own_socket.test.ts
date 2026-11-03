import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAgentGym, GymHttpClient, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { surfaceTeamClients } from "./support/surfaceTeamClients.js";

// The phone is written from API.md alone, independently of the daemon's own pairing code.
import {
    commitment,
    httpPhoneTransport,
    parseQr,
    phoneKey,
    phoneRequest,
    startPhonePairing,
    type PairedPhone,
} from "../../happy-agent-modules/tests/mobileConnector/support/fakePhone.js";

/** The connector's configured port, which its QR code carries and the daemon never binds. */
const PORT = 24_871;
/**
 * Where the fake Tailcat accepts connections, standing in for `server.tailcat:<port>` as a phone
 * dials it. Tailcat's exec service answers on every port, so the fake answers on one of its own.
 */
const TAILNET_PORT = 24_872;
const PHONE = `http://127.0.0.1:${String(TAILNET_PORT)}`;
const HANDSHAKE = "/v0/mobile-connector/handshake";
const FAKE_ADDRESS = "tcGymMobileConnectorAddress";
const PUBLIC_ORIGIN = "https://agent.example.com:8443";
let transport: "tailcat" | "https" = "tailcat";

const running = new Set<AgentGym>();
let fakeTailcatRoot: string | undefined;

beforeEach(async () => {
    // Only the Tailcat binary is fake. Like `serve exec -- <command>`, it runs the command for
    // each connection with the connection as its stdin and stdout, and publishes an address once
    // it accepts them. The command, the loopback listener, and everything behind them are the
    // daemon's own.
    fakeTailcatRoot = await mkdtemp(join(tmpdir(), "happy-gym-tailcat-"));
    const executable = join(fakeTailcatRoot, "tailcat");
    await writeFile(
        executable,
        `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createServer } from "node:net";
const args = process.argv.slice(2);
if (args[0] === "genkey") {
    writeFileSync(args.find((value) => value.startsWith("--key=")).slice(6), "key\\n", { mode: 0o600 });
    process.exit(0);
}
if (args.slice(1, 4).join(" ") !== "serve exec --") process.exit(2);
const [command, ...commandArguments] = args.slice(4);
const server = createServer((connection) => {
    const child = spawn(command, commandArguments, { stdio: ["pipe", "pipe", "inherit"] });
    connection.pipe(child.stdin);
    child.stdout.pipe(connection);
    connection.on("error", () => child.kill());
    child.stdin.on("error", () => connection.destroy());
});
server.listen(${String(TAILNET_PORT)}, "127.0.0.1", () => {
    writeFileSync(process.env.TAILCAT_ADDR_FILE, ${JSON.stringify(`${FAKE_ADDRESS}\n`)}, { mode: 0o600 });
});
process.on("SIGTERM", () => process.exit(0));
`,
    );
    await chmod(executable, 0o755);
    vi.stubEnv("HAPPY_AGENT_TAILCAT_PATH", executable);
});

afterEach(async () => {
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
    vi.unstubAllEnvs();
    if (fakeTailcatRoot !== undefined) await rm(fakeTailcatRoot, { force: true, recursive: true });
});

async function mobileGym(): Promise<AgentGym> {
    const gym = await createAgentGym({
        config: `[feature.mobile_connector]\nport = ${String(PORT)}\n[api]\npublic_port = ${String(TAILNET_PORT)}\n${transport === "https" ? `public_url = "${PUBLIC_ORIGIN}"\n` : ""}`,
        timeoutMs: 15_000,
    });
    running.add(gym);
    return gym;
}

interface MobileConnector {
    readonly status: string;
    readonly pairing: { readonly id: string; readonly status: string; readonly qr: string | null };
    readonly devices: readonly { readonly id: string }[];
}

async function startPairing(gym: AgentGym): Promise<MobileConnector> {
    const started = await gym.http.ok<{ mobileConnector: MobileConnector }>(
        "POST",
        "/v0/mobile-connector/pairing",
    );
    expect(started.mobileConnector).toMatchObject({
        status: "open",
        pairing: { status: "waiting" },
    });
    return started.mobileConnector;
}

async function pairPhone(gym: AgentGym): Promise<PairedPhone> {
    const started = await startPairing(gym);
    const session = await startPhonePairing(started.pairing.qr!, httpPhoneTransport(PHONE));
    const confirming = session.confirm();
    await gym.waitUntil(async () => {
        const current = await gym.http.ok<{
            mobileConnector: { pairing: { mobileConfirmed: boolean; emoji: string[] } };
        }>("GET", "/v0/mobile-connector");
        return current.mobileConnector.pairing.mobileConfirmed ? current : undefined;
    }, "the phone to confirm the emoji");
    await gym.http.ok("POST", "/v0/mobile-connector/pairing/confirm", {
        pairingId: started.pairing.id,
    });
    return await confirming;
}

/** One request to the connector's socket with any bearer, or none. */
async function phoneHttp(
    method: string,
    path: string,
    credential?: string,
    body?: unknown,
): Promise<{ status: number; body: unknown }> {
    const response = await fetch(`${PHONE}${path}`, {
        method,
        headers: {
            ...(credential === undefined ? {} : { authorization: `Bearer ${credential}` }),
            ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
}

interface RawResponse {
    readonly status: number;
    readonly headers: string;
    /** The decoded body, or `undefined` when the connection closed before it was complete. */
    readonly body: Buffer | undefined;
}

/**
 * One request the way the iOS app sends it: a fresh connection, `connection: close`, and the
 * response read until the connector closes it. The body must be complete by then.
 */
async function phoneRawGet(path: string, credential: string): Promise<RawResponse> {
    const raw = await new Promise<Buffer>((resolve, reject) => {
        const parts: Buffer[] = [];
        const connection = createConnection({ host: "127.0.0.1", port: TAILNET_PORT });
        connection.on("data", (part: Buffer) => parts.push(part));
        connection.once("error", reject);
        connection.once("close", () => resolve(Buffer.concat(parts)));
        connection.write(
            `GET ${path} HTTP/1.1\r\nhost: ${FAKE_ADDRESS}\r\nauthorization: Bearer ${credential}\r\n` +
                "connection: close\r\n\r\n",
        );
    });
    const headEnd = raw.indexOf("\r\n\r\n");
    if (headEnd < 0) throw new Error(`The connection closed after ${raw.length} bytes of head.`);
    const headers = raw.subarray(0, headEnd).toString("latin1");
    const status = Number(/^HTTP\/1\.1 (\d{3})/u.exec(headers)?.[1]);
    const rest = raw.subarray(headEnd + 4);
    if (!/^transfer-encoding:\s*chunked\s*$/imu.test(headers)) {
        const length = Number(/^content-length:\s*(\d+)\s*$/imu.exec(headers)?.[1]);
        return { status, headers, body: rest.length === length ? rest : undefined };
    }
    const chunks: Buffer[] = [];
    for (let cursor = 0; ; ) {
        const lineEnd = rest.indexOf("\r\n", cursor);
        if (lineEnd < 0) return { status, headers, body: undefined };
        const size = Number.parseInt(rest.subarray(cursor, lineEnd).toString("latin1"), 16);
        if (size === 0) return { status, headers, body: Buffer.concat(chunks) };
        if (lineEnd + 2 + size + 2 > rest.length) return { status, headers, body: undefined };
        chunks.push(rest.subarray(lineEnd + 2, lineEnd + 2 + size));
        cursor = lineEnd + 2 + size + 2;
    }
}

/** Text messages each WebSocket received, kept from the moment it was created. */
const received = new WeakMap<WebSocket, string[]>();

/** Open a WebSocket on the connector's socket, or report the status that refused it. */
async function phoneWebSocket(path: string, credential: string): Promise<WebSocket | number> {
    return await new Promise((resolve, reject) => {
        const webSocket = new WebSocket(`ws://127.0.0.1:${String(TAILNET_PORT)}${path}`, {
            headers: { authorization: `Bearer ${credential}` },
            perMessageDeflate: false,
        });
        const messages: string[] = [];
        received.set(webSocket, messages);
        // The first message can arrive with the upgrade itself, before anyone awaits it.
        webSocket.on("message", (data) => messages.push(String(data)));
        webSocket.once("open", () => resolve(webSocket));
        webSocket.once("unexpected-response", (_request, response) => {
            response.resume();
            resolve(response.statusCode ?? 0);
        });
        webSocket.once("error", reject);
    });
}

/** Open a `CONNECT` tunnel on the connector's socket, or report the status that refused it. */
async function phoneConnect(path: string, credential: string): Promise<Socket | number> {
    return await new Promise((resolve, reject) => {
        const request = httpRequest({
            host: "127.0.0.1",
            port: TAILNET_PORT,
            method: "CONNECT",
            path,
            headers: { authorization: `Bearer ${credential}` },
        });
        request.once("connect", (response, socket) => {
            if (response.statusCode === 200) resolve(socket);
            else {
                socket.destroy();
                resolve(response.statusCode ?? 0);
            }
        });
        request.once("response", (response) => {
            response.resume();
            resolve(response.statusCode ?? 0);
        });
        request.once("error", reject);
        request.end();
    });
}

async function rootWorkspaceId(gym: AgentGym): Promise<string> {
    const project = await gym.waitUntil(async () => {
        const projects = await gym.client.listProjects();
        const candidate = projects.projects.find((project) => project.status === "active");
        return candidate?.initialization.status === "ready" ? candidate : undefined;
    }, "the root project to become ready");
    return project.id;
}

/** A port bridge's control channel: an ordinary authenticated WebSocket upgrade. */
function bridgePath(gym: AgentGym, workspaceId: string): string {
    const url = new URL(gym.client.workspacePortBridgeUrl(workspaceId, { port: 0 }));
    return `${url.pathname}${url.search}`;
}

async function firstJson(gym: AgentGym, webSocket: WebSocket): Promise<Record<string, unknown>> {
    const text = await gym.waitUntil(
        () => received.get(webSocket)?.[0],
        "the WebSocket's first message",
    );
    return JSON.parse(text) as Record<string, unknown>;
}

function closed(target: { once(event: "close", listener: () => void): unknown }) {
    return new Promise<void>((resolve) => target.once("close", () => resolve()));
}

describe.each(["tailcat", "https"] as const)("phones use the API over %s", (mode) => {
    beforeEach(() => {
        transport = mode;
    });
    it("pairs through the real daemon and serves the paired phone the ordinary API", async () => {
        const gym = await mobileGym();
        const stream = gym.stream();
        await stream.opened();
        const paired = await pairPhone(gym);
        expect(paired).toMatchObject(
            mode === "tailcat"
                ? { address: FAKE_ADDRESS, port: PORT }
                : { address: PUBLIC_ORIGIN, port: 8443 },
        );

        const snapshot = await gym.http.ok<{ mobileConnector: MobileConnector }>(
            "GET",
            "/v0/mobile-connector",
        );
        expect(snapshot.mobileConnector).toMatchObject({
            status: "open",
            pairing: { status: "completed" },
            devices: [{ id: paired.deviceId }],
        });
        // The published client predates protocol 27, so it does not name this event yet.
        await gym.waitForEvent((event) => {
            const untyped = event as { readonly type: string; readonly payload: unknown };
            return (
                untyped.type === "mobile_connector.updated" &&
                (untyped.payload as { mobileConnector: MobileConnector }).mobileConnector.devices
                    .length === 1
            );
        }, "the paired phone to be announced");

        // Ordinary routes, read as the person who paired the phone.
        await expect(phoneHttp("GET", "/v0/health", paired.deviceToken)).resolves.toMatchObject({
            status: 200,
        });
        const projects = await phoneHttp("GET", "/v0/projects", paired.deviceToken);
        expect(projects.status).toBe(200);
        expect(projects.body).toEqual((await gym.http.request("GET", "/v0/projects")).body);

        // The event stream.
        const events = await fetch(`${PHONE}/v0/events/stream`, {
            headers: { authorization: `Bearer ${paired.deviceToken}` },
        });
        expect(events.status).toBe(200);
        const reader = events.body!.getReader();
        expect(new TextDecoder().decode((await reader.read()).value)).toContain("hello");
        await reader.cancel();

        // A port bridge's WebSocket and the workspace proxy's CONNECT. (Terminals need the Bun
        // runtime, which the gym does not run; every upgrade takes the same admission.)
        const workspaceId = await rootWorkspaceId(gym);
        const webSocket = await phoneWebSocket(bridgePath(gym, workspaceId), paired.deviceToken);
        if (!(webSocket instanceof WebSocket)) throw new Error(`Upgrade refused: ${webSocket}`);
        await expect(firstJson(gym, webSocket)).resolves.toMatchObject({ type: "ready" });
        webSocket.terminate();
        const tunnel = await phoneConnect(
            `/v0/workspaces/${workspaceId}/proxy`,
            paired.deviceToken,
        );
        expect(typeof tunnel).not.toBe("number");
        (tunnel as Socket).destroy();

        // Administration stays with the desktop, whatever the method.
        for (const [method, path, body] of [
            ["POST", "/v0/drain", undefined],
            ["POST", "/v0/shutdown", undefined],
            ["POST", "/v0/debug/inspector", undefined],
            ["DELETE", "/v0/debug/inspector", undefined],
            ["GET", "/v0/mobile-connector", undefined],
            ["POST", "/v0/mobile-connector/pairing", undefined],
            ["POST", "/v0/mobile-connector/pairing/confirm", { pairingId: "x" }],
            ["POST", "/v0/mobile-connector/pairing/cancel", { pairingId: "x" }],
            ["DELETE", `/v0/mobile-connector/devices/${paired.deviceId}`, undefined],
            ["POST", HANDSHAKE, { commitment: "x" }],
            ["GET", HANDSHAKE, undefined],
        ] as const) {
            await expect(
                phoneHttp(method, path, paired.deviceToken, body),
                `${method} ${path}`,
            ).resolves.toMatchObject({ status: 403, body: { code: "forbidden" } });
        }
        await gym.http.ok("GET", "/v0/health");
        expect(
            (await gym.http.ok<{ mobileConnector: MobileConnector }>("GET", "/v0/mobile-connector"))
                .mobileConnector.devices,
        ).toHaveLength(1);
        expect(gym.errors).toEqual([]);
        stream.close();
    }, 60_000);

    it("accepts only phone credentials on its socket, and none of them anywhere else", async () => {
        const gym = await mobileGym();
        const paired = await pairPhone(gym);
        const workspaceId = await rootWorkspaceId(gym);
        const unauthorized = { status: 401, body: { error: "Unauthorized", code: "unauthorized" } };

        // The main transport's own token, a missing header, and an unknown token are all refused
        // before routing, for HTTP, WebSocket upgrades, and CONNECT alike.
        for (const credential of [
            ...(mode === "tailcat" ? [gym.token] : []),
            undefined,
            randomBytes(32).toString("base64url"),
        ]) {
            await expect(phoneHttp("GET", "/v0/health", credential)).resolves.toEqual(unauthorized);
            await expect(phoneHttp("GET", "/v0/authentication", credential)).resolves.toMatchObject(
                mode === "tailcat" ? unauthorized : { status: 200, body: { authenticated: false } },
            );
            await expect(phoneHttp("GET", "/v0/no-such-route", credential)).resolves.toEqual(
                unauthorized,
            );
        }
        if (mode === "tailcat") {
            await expect(phoneWebSocket(bridgePath(gym, workspaceId), gym.token)).resolves.toBe(
                401,
            );
            await expect(
                phoneConnect(`/v0/workspaces/${workspaceId}/proxy`, gym.token),
            ).resolves.toBe(401);
        } else {
            await expect(phoneHttp("GET", "/v0/health", gym.token)).resolves.toMatchObject({
                status: 200,
            });
        }
        await expect(phoneWebSocket("/v0/runners/connect", gym.token)).resolves.toBe(401);

        // The main transport accepts no phone credential, and has no handshake routes.
        const asPhone = new GymHttpClient({
            socketPath: gym.socketPath,
            token: paired.deviceToken,
        });
        expect((await asPhone.request("GET", "/v0/health")).status).toBe(401);
        expect((await gym.http.request("GET", HANDSHAKE)).status).toBe(404);
        expect((await gym.http.request("POST", HANDSHAKE, { commitment: "x" })).status).toBe(404);
        expect((await gym.http.request("POST", `${HANDSHAKE}/reveal`, {})).status).toBe(404);

        // A pairing token reaches only the handshake start.
        const started = await startPairing(gym);
        const token = parseQr(started.pairing.qr!).t;
        expect(
            (
                await new GymHttpClient({ socketPath: gym.socketPath, token }).request(
                    "GET",
                    "/v0/health",
                )
            ).status,
        ).toBe(401);
        await expect(phoneHttp("GET", "/v0/health", token)).resolves.toEqual(unauthorized);
        await expect(phoneHttp("GET", HANDSHAKE, token)).resolves.toEqual(unauthorized);
        await expect(phoneHttp("POST", `${HANDSHAKE}/reject`, token)).resolves.toEqual(
            unauthorized,
        );

        // A handshake credential reaches only its own handshake's routes.
        const keys = phoneKey();
        const nonce = randomBytes(32);
        const { handshakeId } = await phoneRequest<{ handshakeId: string }>(
            httpPhoneTransport(PHONE),
            "POST",
            HANDSHAKE,
            token,
            {
                commitment: commitment(keys.publicKey, nonce).toString("base64url"),
                device: { name: "Gym phone", platform: "android" },
            },
        );
        await expect(phoneHttp("POST", HANDSHAKE, token, {})).resolves.toEqual(unauthorized);
        await expect(phoneHttp("GET", "/v0/health", handshakeId)).resolves.toEqual(unauthorized);
        await expect(phoneHttp("POST", HANDSHAKE, handshakeId, {})).resolves.toEqual(unauthorized);
        await expect(phoneWebSocket(bridgePath(gym, workspaceId), handshakeId)).resolves.toBe(401);
        await expect(phoneHttp("GET", HANDSHAKE, handshakeId)).resolves.toEqual({
            status: 200,
            body: { status: "verifying" },
        });
        await expect(phoneHttp("POST", `${HANDSHAKE}/reject`, handshakeId)).resolves.toEqual({
            status: 200,
            body: { status: "rejected" },
        });
        expect(gym.errors).toEqual([]);
    }, 60_000);

    it("closes a removed phone's event stream, WebSocket, and tunnel at once", async () => {
        const gym = await mobileGym();
        const removed = await pairPhone(gym);
        // A second phone keeps the socket open, so only revocation can close the first's work.
        const kept = await pairPhone(gym);
        const workspaceId = await rootWorkspaceId(gym);
        const webSocket = await phoneWebSocket(bridgePath(gym, workspaceId), removed.deviceToken);
        if (!(webSocket instanceof WebSocket)) throw new Error(`Upgrade refused: ${webSocket}`);
        await expect(firstJson(gym, webSocket)).resolves.toMatchObject({ type: "ready" });
        const keptSocket = await phoneWebSocket(bridgePath(gym, workspaceId), kept.deviceToken);
        if (!(keptSocket instanceof WebSocket)) throw new Error(`Upgrade refused: ${keptSocket}`);
        await expect(firstJson(gym, keptSocket)).resolves.toMatchObject({ type: "ready" });
        const tunnel = await phoneConnect(
            `/v0/workspaces/${workspaceId}/proxy`,
            removed.deviceToken,
        );
        if (typeof tunnel === "number") throw new Error(`CONNECT refused: ${String(tunnel)}`);
        const events = await fetch(`${PHONE}/v0/events/stream`, {
            headers: { authorization: `Bearer ${removed.deviceToken}` },
        });
        const reader = events.body!.getReader();
        await reader.read();
        const socketClosed = closed(webSocket);
        const tunnelClosed = closed(tunnel);
        const streamEnded = (async () => {
            try {
                while (!(await reader.read()).done);
            } catch {
                // A destroyed connection ends the stream with an error.
            }
        })();

        const after = await gym.http.ok<{ mobileConnector: MobileConnector }>(
            "DELETE",
            `/v0/mobile-connector/devices/${removed.deviceId}`,
        );
        expect(after.mobileConnector.devices.map((device) => device.id)).toEqual([kept.deviceId]);
        await Promise.all([socketClosed, tunnelClosed, streamEnded]);
        await expect(phoneHttp("GET", "/v0/health", removed.deviceToken)).resolves.toMatchObject({
            status: 401,
        });

        // The other phone's connection is untouched and its token still works.
        expect(keptSocket.readyState).toBe(WebSocket.OPEN);
        await expect(phoneHttp("GET", "/v0/health", kept.deviceToken)).resolves.toMatchObject({
            status: 200,
        });
        keptSocket.terminate();
        expect(gym.errors).toEqual([]);
    }, 60_000);

    it("lets a phone remove itself without touching another phone", async () => {
        const gym = await mobileGym();
        const leaving = await pairPhone(gym);
        const staying = await pairPhone(gym);
        const workspaceId = await rootWorkspaceId(gym);
        const webSocket = await phoneWebSocket(bridgePath(gym, workspaceId), leaving.deviceToken);
        if (!(webSocket instanceof WebSocket)) throw new Error(`Upgrade refused: ${webSocket}`);
        await expect(firstJson(gym, webSocket)).resolves.toMatchObject({ type: "ready" });
        const keptSocket = await phoneWebSocket(bridgePath(gym, workspaceId), staying.deviceToken);
        if (!(keptSocket instanceof WebSocket)) throw new Error(`Upgrade refused: ${keptSocket}`);
        await expect(firstJson(gym, keptSocket)).resolves.toMatchObject({ type: "ready" });
        const socketClosed = closed(webSocket);

        // Only a phone's own credential reaches the route, and never as an upgrade or tunnel.
        await expect(
            phoneWebSocket("/v0/mobile-connector/device", leaving.deviceToken),
        ).resolves.toBe(403);
        await expect(
            phoneConnect("/v0/mobile-connector/device", leaving.deviceToken),
        ).resolves.toBe(403);
        expect((await gym.http.request("DELETE", "/v0/mobile-connector/device")).status).toBe(404);
        if (mode === "https") {
            await expect(
                phoneHttp("DELETE", "/v0/mobile-connector/device", gym.token),
            ).resolves.toMatchObject({ status: 404 });
        }

        await expect(
            phoneHttp("DELETE", "/v0/mobile-connector/device", leaving.deviceToken),
        ).resolves.toEqual({ status: 200, body: {} });
        await socketClosed;
        await expect(phoneHttp("GET", "/v0/health", leaving.deviceToken)).resolves.toMatchObject({
            status: 401,
        });
        // A retry after a lost answer finds the phone already gone.
        await expect(
            phoneHttp("DELETE", "/v0/mobile-connector/device", leaving.deviceToken),
        ).resolves.toMatchObject({ status: 401, body: { code: "unauthorized" } });

        const snapshot = await gym.http.ok<{ mobileConnector: MobileConnector }>(
            "GET",
            "/v0/mobile-connector",
        );
        expect(snapshot.mobileConnector.devices.map((device) => device.id)).toEqual([
            staying.deviceId,
        ]);
        expect(keptSocket.readyState).toBe(WebSocket.OPEN);
        await expect(phoneHttp("GET", "/v0/health", staying.deviceToken)).resolves.toMatchObject({
            status: 200,
        });
        // The last phone removing itself still receives its answer before the socket closes.
        await expect(
            phoneHttp("DELETE", "/v0/mobile-connector/device", staying.deviceToken),
        ).resolves.toEqual({ status: 200, body: {} });
        keptSocket.terminate();
        expect(gym.errors).toEqual([]);
    }, 60_000);

    it("delivers a large response in full before closing a phone's connection", async () => {
        const gym = await mobileGym();
        const paired = await pairPhone(gym);
        const workspaceId = (await gym.client.getAgent(gym.defaultSessionId)).agent.workspaceId!;
        const bytes = randomBytes(1024 * 1024);
        await writeFile(join(gym.workspacePath, "large.bin"), bytes);

        // The daemon closes each connection right after its last byte; the pipe used to exit
        // before that byte reached the phone, which saw the body end mid-chunk.
        for (let attempt = 0; attempt < 10; attempt += 1) {
            const response = await phoneRawGet(
                `/v0/workspaces/${workspaceId}/file?path=large.bin`,
                paired.deviceToken,
            );
            expect(response.status).toBe(200);
            expect(response.body, `attempt ${String(attempt + 1)}`).toBeDefined();
            const { content } = JSON.parse(response.body!.toString("utf8")) as {
                content: string;
            };
            expect(Buffer.from(content, "base64").equals(bytes)).toBe(true);
        }
        expect(gym.errors).toEqual([]);
    }, 60_000);

    it("pairs and reconnects after a restart while another program holds its port", async () => {
        // Another Happy Agent on this computer with the same default port, say.
        const occupant = createServer();
        await new Promise<void>((resolve, reject) => {
            occupant.once("error", reject);
            occupant.listen(PORT, "127.0.0.1", resolve);
        });
        try {
            const gym = await mobileGym();
            const paired = await pairPhone(gym);
            expect(paired).toMatchObject(
                mode === "tailcat"
                    ? { address: FAKE_ADDRESS, port: PORT }
                    : { address: PUBLIC_ORIGIN, port: 8443 },
            );

            await gym.restart();
            await gym.waitUntil(async () => {
                const current = await gym.http.ok<{ mobileConnector: MobileConnector }>(
                    "GET",
                    "/v0/mobile-connector",
                );
                return current.mobileConnector.status === "open" ? current : undefined;
            }, "the socket to reopen for the paired phone");
            await expect(phoneHttp("GET", "/v0/health", paired.deviceToken)).resolves.toMatchObject(
                { status: 200 },
            );
            expect(gym.errors).toEqual([]);
        } finally {
            await new Promise<void>((resolve) => occupant.close(() => resolve()));
        }
    }, 60_000);
});

describe("public phone endpoint settings", () => {
    it("starts the daemon-owned public API even with mobile connectivity disabled", async () => {
        const gym = await createAgentGym({
            config: `[api]\npublic_url = "${PUBLIC_ORIGIN}"\npublic_port = ${TAILNET_PORT}\n[feature.mobile_connector]\nenabled = false\n`,
        });
        running.add(gym);
        expect((await gym.client.getConfig()).config.api).toEqual({
            publicUrl: PUBLIC_ORIGIN,
            localPort: TAILNET_PORT,
        });
        await expect(phoneHttp("GET", "/v0/health", gym.token)).resolves.toMatchObject({
            status: 200,
        });
        await expect(phoneHttp("GET", "/v0/authentication")).resolves.toMatchObject({
            status: 200,
            body: { authenticated: false, userId: null },
        });
        for (const path of ["/v0/drain", "/v0/shutdown", "/v0/debug", "/v0/debug/test"]) {
            await expect(phoneHttp("POST", path, gym.token)).resolves.toMatchObject({
                status: 403,
            });
        }
        expect((await gym.client.getMobileConnector()).mobileConnector.status).toBe("disabled");
    });
    beforeEach(() => {
        transport = "https";
    });

    it("finishes an authenticated public config response before removing its listener", async () => {
        const gym = await mobileGym();
        await expect(
            phoneHttp("PATCH", "/v0/config", gym.token, { api: { publicUrl: null } }),
        ).resolves.toMatchObject({
            status: 200,
            body: { config: { api: { publicUrl: null } } },
        });
        expect((await gym.client.getConfig()).config.api?.publicUrl).toBeNull();
        await gym.http.ok("GET", "/v0/health");
    });

    it("bounds old public streams and tunnels while flushing the endpoint-removal response", async () => {
        const gym = await mobileGym();
        const workspaceId = await rootWorkspaceId(gym);
        const events = await fetch(`${PHONE}/v0/events/stream`, {
            headers: { authorization: `Bearer ${gym.token}` },
        });
        const reader = events.body!.getReader();
        await reader.read();
        const streamClosed = (async () => {
            try {
                while (!(await reader.read()).done) {
                    /* Drain through the final event. */
                }
            } catch {
                /* A bounded transport close may reset an event stream. */
            }
        })();
        const websocket = await phoneWebSocket(bridgePath(gym, workspaceId), gym.token);
        if (!(websocket instanceof WebSocket)) throw new Error(`Upgrade refused: ${websocket}`);
        const socketClosed = closed(websocket);
        const tunnel = await phoneConnect(`/v0/workspaces/${workspaceId}/proxy`, gym.token);
        if (typeof tunnel === "number") throw new Error(`Tunnel refused: ${tunnel}`);
        const tunnelClosed = closed(tunnel);
        await expect(
            phoneHttp("PATCH", "/v0/config", gym.token, { api: { publicUrl: null } }),
        ).resolves.toMatchObject({ status: 200 });
        await Promise.all([streamClosed, socketClosed, tunnelClosed]);
        await gym.http.ok("GET", "/v0/health");
    }, 15_000);

    it("preserves phone credentials while switching between the single public listener and Tailcat", async () => {
        transport = "tailcat";
        const gym = await mobileGym();
        const paired = await pairPhone(gym);
        await gym.client.patchConfig({ api: { publicUrl: PUBLIC_ORIGIN } });
        await expect(phoneHttp("GET", "/v0/health", paired.deviceToken)).resolves.toMatchObject({
            status: 200,
        });
        await expect(phoneHttp("GET", "/v0/health", gym.token)).resolves.toMatchObject({
            status: 200,
        });
        await gym.client.patchConfig({ api: { publicUrl: null } });
        await expect(phoneHttp("GET", "/v0/health", paired.deviceToken)).resolves.toMatchObject({
            status: 200,
        });
        await expect(phoneHttp("GET", "/v0/health", gym.token)).resolves.toMatchObject({
            status: 401,
        });
    }, 60_000);

    it("keeps the primary API usable when the public port is occupied and recovers after restart", async () => {
        const occupant = createServer();
        await new Promise<void>((resolve) => occupant.listen(TAILNET_PORT, "127.0.0.1", resolve));
        let gym: AgentGym;
        try {
            gym = await mobileGym();
            expect((await gym.client.getMobileConnector()).mobileConnector).toMatchObject({
                status: "failed",
            });
            expect((await gym.client.getConfig()).config.api?.publicUrl).toBe(PUBLIC_ORIGIN);
            await gym.http.ok("GET", "/v0/health");
        } finally {
            await new Promise<void>((resolve) => occupant.close(() => resolve()));
        }
        await gym.restart();
        await expect(phoneHttp("GET", "/v0/health", gym.token)).resolves.toMatchObject({
            status: 200,
        });
        expect((await gym.client.getMobileConnector()).mobileConnector.status).toBe("open");
    }, 60_000);

    it("admits main API streaming and upgrades but denies public administration on every socket path", async () => {
        const gym = await mobileGym();
        const workspaceId = await rootWorkspaceId(gym);
        const events = await fetch(`${PHONE}/v0/events/stream`, {
            headers: { authorization: `Bearer ${gym.token}` },
        });
        expect(events.status).toBe(200);
        const reader = events.body!.getReader();
        expect(new TextDecoder().decode((await reader.read()).value)).toContain("hello");
        await reader.cancel();
        const websocket = await phoneWebSocket(bridgePath(gym, workspaceId), gym.token);
        if (!(websocket instanceof WebSocket)) throw new Error(`Upgrade refused: ${websocket}`);
        await expect(firstJson(gym, websocket)).resolves.toMatchObject({ type: "ready" });
        websocket.terminate();
        const tunnel = await phoneConnect(`/v0/workspaces/${workspaceId}/proxy`, gym.token);
        if (typeof tunnel === "number") throw new Error(`Tunnel refused: ${tunnel}`);
        tunnel.destroy();
        for (const path of ["/v0/drain", "/v0/shutdown", "/v0/debug", "/v0/debug/test"]) {
            await expect(phoneWebSocket(path, gym.token)).resolves.toBe(403);
            await expect(phoneConnect(path, gym.token)).resolves.toBe(403);
        }
        await expect(phoneHttp("POST", HANDSHAKE, gym.token, {})).resolves.toMatchObject({
            status: 401,
        });
        await expect(phoneWebSocket("/v0/exported-bots/connect", gym.token)).resolves.toBe(401);
    }, 60_000);

    it("allows only the team owner to change connectivity and rejects the whole member patch", async () => {
        const { gym, alice, bob } = await surfaceTeamClients({
            config: `[api]\npublic_port = ${TAILNET_PORT}\n`,
        });
        running.add(gym);
        const before = (await alice.getConfig()).config;
        await expect(
            bob.patchConfig({
                api: { publicUrl: "agent.example.com" },
                node: { name: "Must not change" },
            }),
        ).rejects.toMatchObject({ status: 403 });
        expect((await alice.getConfig()).config.node).toEqual(before.node);
        expect((await alice.getConfig()).config.mobileConnector?.publicUrl).toBeNull();
        await alice.patchConfig({ mobileConnector: { publicUrl: "agent.example.com" } });
        expect((await alice.getConfig()).config.mobileConnector?.publicUrl).toBe(
            "https://agent.example.com",
        );
        await expect(phoneHttp("GET", "/v0/projects", gym.token)).resolves.toMatchObject({
            status: 200,
        });
        const started = (await alice.startMobilePairing()).mobileConnector;
        const session = await startPhonePairing(started.pairing!.qr!, httpPhoneTransport(PHONE));
        await alice.confirmMobilePairing(started.pairing!.id);
        const paired = await session.confirm();
        await expect(phoneHttp("GET", "/v0/projects", paired.deviceToken)).resolves.toMatchObject({
            status: 200,
        });
    }, 60_000);

    it("normalizes, persists, resets, and rejects invalid changes before a compound patch", async () => {
        const gym = await mobileGym();
        expect((await gym.client.getConfig()).config.mobileConnector).toEqual({
            publicUrl: PUBLIC_ORIGIN,
            localPort: TAILNET_PORT,
        });
        const started = await startPairing(gym);
        const token = parseQr(started.pairing.qr!).t;
        const before = await gym.http.ok<{ config: { node: unknown } }>("GET", "/v0/config");
        expect(
            (
                await gym.http.request("PATCH", "/v0/config", {
                    mobileConnector: { publicUrl: "http://unsafe.example" },
                    node: { name: "Must not change" },
                })
            ).status,
        ).toBe(400);
        expect(
            (await gym.http.ok<{ config: { node: unknown } }>("GET", "/v0/config")).config.node,
        ).toEqual(before.config.node);
        await expect(
            gym.client.patchConfig({
                api: { publicUrl: "one.example" },
                mobileConnector: { publicUrl: "two.example" },
                node: { name: "Must not change" },
            }),
        ).rejects.toMatchObject({ status: 400 });
        expect((await gym.client.getConfig()).config.node).toEqual(before.config.node);
        expect((await gym.client.getConfig()).config.api?.publicUrl).toBe(PUBLIC_ORIGIN);
        await gym.http.ok("PATCH", "/v0/config", {
            api: { publicUrl: "https://agent.other.example" },
            mobileConnector: { publicUrl: " AGENT.Other.Example:443/ " },
        });
        expect(
            (await gym.http.ok<{ mobileConnector: MobileConnector }>("GET", "/v0/mobile-connector"))
                .mobileConnector.pairing.status,
        ).toBe("cancelled");
        await expect(phoneHttp("POST", HANDSHAKE, token, {})).resolves.toMatchObject({
            status: 401,
        });
        await gym.restart();
        expect((await gym.client.getConfig()).config.mobileConnector?.publicUrl).toBe(
            "https://agent.other.example",
        );
        await gym.http.ok("PATCH", "/v0/config", { mobileConnector: { publicUrl: null } });
        await gym.restart();
        expect((await gym.client.getConfig()).config.mobileConnector?.publicUrl).toBeNull();
        expect(parseQr((await startPairing(gym)).pairing.qr!).v).toBe(1);
    }, 60_000);
});
