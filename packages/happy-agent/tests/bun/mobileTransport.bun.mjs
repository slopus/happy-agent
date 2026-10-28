import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { once } from "node:events";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";

import { createAgentGym } from "../../../happy-agent-gym/sources/index.ts";
// The phone is written from API.md alone, independently of the daemon's own pairing code.
import {
    httpPhoneTransport,
    parseQr,
    startPhonePairing,
} from "../../../happy-agent-modules/tests/mobileConnector/support/fakePhone.ts";

/**
 * The mobile connector's socket through the real daemon on Bun's native transports, in both
 * deployment modes: the same API stack as the main listener, flagged as mobile. Only Tailcat is a
 * fake: like `serve exec`, it runs the daemon's own pipe for each connection, on the port named by
 * `FAKE_TAILCAT_TAILNET_PORT` in place of `server.tailcat:<port>`, and publishes an address.
 */
const FAKE_ADDRESS = "tcBunMobileConnectorAddress";
let tailcatRoot;

beforeAll(async () => {
    tailcatRoot = await mkdtemp(join(tmpdir(), "happy-bun-tailcat-"));
    const executable = join(tailcatRoot, "tailcat");
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
server.listen(Number(process.env.FAKE_TAILCAT_TAILNET_PORT), "127.0.0.1", () => {
    writeFileSync(process.env.TAILCAT_ADDR_FILE, ${JSON.stringify(`${FAKE_ADDRESS}\n`)}, { mode: 0o600 });
});
process.on("SIGTERM", () => process.exit(0));
`,
    );
    await chmod(executable, 0o755);
    process.env.HAPPY_AGENT_TAILCAT_PATH = executable;
});

afterAll(async () => {
    delete process.env.HAPPY_AGENT_TAILCAT_PATH;
    delete process.env.FAKE_TAILCAT_TAILNET_PORT;
    if (tailcatRoot !== undefined) await rm(tailcatRoot, { force: true, recursive: true });
});

function teamConfig() {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const encoded = [
        { alg: "EdDSA", typ: "JWT" },
        {
            sub: "alice",
            iss: "https://mobile.test",
            aud: "mobile-tests",
            exp: Math.floor(Date.now() / 1000) + 3600,
        },
    ]
        .map((part) => Buffer.from(JSON.stringify(part)).toString("base64url"))
        .join(".");
    return {
        config: `
[feature.team]
enabled = true
host = "127.0.0.1"
port = 0
authentication = "jwt"
owner_user_id = "alice"
[feature.team.jwt]
name = "Mobile test sign-in"
authorization_url = "https://mobile.test/authorize"
token_url = "https://mobile.test/token"
client_id = "mobile-tests"
issuer = "https://mobile.test"
audience = "mobile-tests"
algorithms = ["EdDSA"]
public_key = """
${pem}"""
`,
        token: `${encoded}.${sign(null, Buffer.from(encoded), privateKey).toString("base64url")}`,
    };
}

for (const mode of ["standalone", "team"]) {
    describe(`the mobile transport on Bun (${mode})`, () => {
        const port = mode === "standalone" ? 24_881 : 24_882;
        // The configured port is only the number in the QR code; the fake Tailcat answers here.
        const tailnetPort = port + 100;
        const phone = `http://127.0.0.1:${String(tailnetPort)}`;
        let gym;
        let paired;
        let workspaceId;
        let target;

        const phoneHttp = async (method, path, credential, body) => {
            const response = await fetch(`${phone}${path}`, {
                method,
                headers: {
                    ...(credential === undefined ? {} : { authorization: `Bearer ${credential}` }),
                    ...(body === undefined ? {} : { "content-type": "application/json" }),
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
            return { status: response.status, body: await response.json().catch(() => null) };
        };

        const pair = async () => {
            const started = (await gym.client.startMobilePairing()).mobileConnector;
            expect(started).toMatchObject({ status: "open", pairing: { status: "waiting" } });
            expect(parseQr(started.pairing.qr)).toMatchObject({ a: FAKE_ADDRESS, p: port });
            const session = await startPhonePairing(started.pairing.qr, httpPhoneTransport(phone));
            const confirming = session.confirm();
            await gym.waitUntil(async () => {
                const current = (await gym.client.getMobileConnector()).mobileConnector;
                return current.pairing?.mobileConfirmed === true ? current : undefined;
            }, "the phone to confirm the emoji");
            await gym.client.confirmMobilePairing(started.pairing.id);
            return await confirming;
        };

        beforeAll(async () => {
            const team = mode === "team" ? teamConfig() : undefined;
            process.env.FAKE_TAILCAT_TAILNET_PORT = String(tailnetPort);
            gym = await createAgentGym({
                config: `[feature.mobile_connector]\nport = ${String(port)}\n${team?.config ?? ""}`,
                timeoutMs: 20_000,
                ...(team === undefined ? {} : { teamUser: { token: team.token, name: "Alice" } }),
            });
            paired = await pair();
            const projects = await gym.waitUntil(async () => {
                const listed = await gym.client.listProjects();
                const ready = listed.projects.find(
                    (project) => project.initialization.status === "ready",
                );
                return ready;
            }, "the root project to become ready");
            workspaceId = projects.id;
            target = createServer((_request, response) => response.end("through the phone"));
            target.listen(0, "127.0.0.1");
            await once(target, "listening");
        }, 60_000);

        afterAll(async () => {
            target?.closeAllConnections();
            target?.close();
            await gym?.dispose();
        });

        const webSocket = (path, credential) =>
            new Promise((resolve, reject) => {
                const socket = new WebSocket(`ws://127.0.0.1:${String(tailnetPort)}${path}`, {
                    headers: { authorization: `Bearer ${credential}` },
                    perMessageDeflate: false,
                });
                socket.once("open", () => {
                    // A removed phone's socket is cut, not closed politely.
                    socket.on("error", () => undefined);
                    resolve(socket);
                });
                socket.once("unexpected-response", (_request, response) => {
                    response.resume();
                    resolve(response.statusCode);
                });
                socket.once("error", reject);
            });

        const tunnel = (credential) =>
            new Promise((resolve, reject) => {
                const request = httpRequest({
                    host: "127.0.0.1",
                    port: tailnetPort,
                    method: "CONNECT",
                    path: `/v0/workspaces/${workspaceId}/proxy`,
                    headers: { authorization: `Bearer ${credential}` },
                });
                request.once("connect", (response, socket) => {
                    // The request ends with its tunnel; a removed phone's closes abruptly.
                    request.on("error", () => undefined);
                    response.on("error", () => undefined);
                    socket.on("error", () => undefined);
                    if (response.statusCode === 200) resolve(socket);
                    else {
                        socket.destroy();
                        resolve(response.statusCode);
                    }
                });
                request.once("response", (response) => {
                    response.resume();
                    resolve(response.statusCode);
                });
                request.once("error", reject);
                request.end();
            });

        /** One plain proxied request inside the workspace tunnel, to this machine's fixture. */
        const throughTunnel = async (socket) => {
            let text = "";
            socket.on("data", (chunk) => (text += chunk.toString()));
            socket.write(
                `GET http://127.0.0.1:${String(target.address().port)}/ HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`,
            );
            await once(socket, "end");
            return text;
        };

        const terminalPath = async () => {
            const terminal = (await gym.client.openTerminal(workspaceId, { command: "sleep 60" }))
                .terminal;
            return `/v0/workspaces/${workspaceId}/terminals/${terminal.id}/attach`;
        };

        test("serves a paired phone ordinary routes, SSE, a WebSocket, and CONNECT", async () => {
            const health = await phoneHttp("GET", "/v0/health", paired.deviceToken);
            expect(health.status).toBe(200);
            const projects = await phoneHttp("GET", "/v0/projects", paired.deviceToken);
            expect(projects.status).toBe(200);
            expect(projects.body.projects.map((project) => project.id)).toContain(workspaceId);

            const events = await fetch(`${phone}/v0/events/stream`, {
                headers: { authorization: `Bearer ${paired.deviceToken}` },
            });
            expect(events.status).toBe(200);
            const reader = events.body.getReader();
            expect(new TextDecoder().decode((await reader.read()).value)).toContain("hello");
            await reader.cancel();

            const socket = await webSocket(await terminalPath(), paired.deviceToken);
            expect(socket).toBeInstanceOf(WebSocket);
            socket.terminate();

            const opened = await tunnel(paired.deviceToken);
            expect(typeof opened).not.toBe("number");
            expect(await throughTunnel(opened)).toContain("through the phone");
        }, 30_000);

        test("refuses administration to a phone and every other credential on its socket", async () => {
            for (const [method, path] of [
                ["POST", "/v0/drain"],
                ["POST", "/v0/shutdown"],
                ["POST", "/v0/debug/inspector"],
                ["GET", "/v0/mobile-connector"],
                ["POST", "/v0/mobile-connector/pairing"],
                ["DELETE", `/v0/mobile-connector/devices/${paired.deviceId}`],
                ["GET", "/v0/mobile-connector/handshake"],
            ]) {
                expect(
                    await phoneHttp(method, path, paired.deviceToken),
                    `${method} ${path}`,
                ).toMatchObject({ status: 403, body: { code: "forbidden" } });
            }
            const unauthorized = {
                status: 401,
                body: { error: "Unauthorized", code: "unauthorized" },
            };
            for (const credential of [
                gym.token,
                undefined,
                randomBytes(32).toString("base64url"),
            ]) {
                expect(await phoneHttp("GET", "/v0/health", credential)).toEqual(unauthorized);
                expect(await phoneHttp("GET", "/v0/authentication", credential)).toEqual(
                    unauthorized,
                );
            }
            expect(await webSocket(await terminalPath(), gym.token)).toBe(401);
            expect(await webSocket("/v0/runners/connect", gym.token)).toBe(401);
            expect(await tunnel(gym.token)).toBe(401);
        }, 30_000);

        test("closes a removed phone's event stream, WebSocket, and tunnel", async () => {
            const other = await pair();
            const socket = await webSocket(await terminalPath(), paired.deviceToken);
            expect(socket).toBeInstanceOf(WebSocket);
            const kept = await webSocket(await terminalPath(), other.deviceToken);
            expect(kept).toBeInstanceOf(WebSocket);
            const opened = await tunnel(paired.deviceToken);
            expect(typeof opened).not.toBe("number");
            const events = await fetch(`${phone}/v0/events/stream`, {
                headers: { authorization: `Bearer ${paired.deviceToken}` },
            });
            const reader = events.body.getReader();
            await reader.read();
            const socketClosed = once(socket, "close");
            const tunnelClosed = once(opened, "close");
            const streamEnded = (async () => {
                try {
                    while (!(await reader.read()).done);
                } catch {
                    // A destroyed connection ends the stream with an error.
                }
            })();

            const after = (await gym.client.removeMobileDevice(paired.deviceId)).mobileConnector;
            expect(after.devices.map((device) => device.id)).toEqual([other.deviceId]);
            // Within a second: the tunnel's own idle timeout must not be what closes it.
            const closedInTime = Promise.all([socketClosed, tunnelClosed, streamEnded]);
            const late = new Promise((_, reject) =>
                setTimeout(() => reject(new Error("A connection outlived its removal.")), 1_000),
            );
            await Promise.race([closedInTime, late]);
            expect((await phoneHttp("GET", "/v0/health", paired.deviceToken)).status).toBe(401);
            expect(kept.readyState).toBe(WebSocket.OPEN);
            expect((await phoneHttp("GET", "/v0/health", other.deviceToken)).status).toBe(200);
            kept.terminate();
        }, 30_000);
    });
}
