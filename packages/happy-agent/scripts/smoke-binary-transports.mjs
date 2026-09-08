import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { connect as connectUnix } from "node:net";
import { resolve } from "node:path";
import { inflateRawSync } from "node:zlib";

import { HappyAgentClient } from "@slopus/happy-agent-client";

import { createUnixSocketFetch } from "../dist/lifecycle/createUnixSocketFetch.js";

const WEBSOCKET_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const TERMINAL_MAGIC = 0x5254;
const TERMINAL_VERSION = 1;
const TERMINAL_HEADER_BYTES = 20;
const TERMINAL_COMPRESSED = 1;
const TERMINAL_PACKET = {
    clientHello: 1,
    welcome: 2,
    output: 3,
    outputAck: 4,
    input: 5,
    resizeApplied: 18,
};
const TEST_PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAAXNSR0IArs4c6QAAAERlWElmTU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAIKADAAQAAAABAAAAIAAAAACshmLzAAAARklEQVRIDe3SsQkAMAwDQQVcZP9ZMmDwBF+pe+NS2HDoJO8mvZ293RwfoK5EEqEABmyRRCiAAVskEQpgwBZJhAIYsEVI9AH7IAMiyextiAAAAABJRU5ErkJggg==",
    "base64",
);

async function main() {
    const binaryArgument = process.argv[2];
    if (binaryArgument === undefined) {
        throw new Error("Usage: node scripts/smoke-binary-transports.mjs <happy-agent-binary>");
    }

    const binary = resolve(binaryArgument);
    const root = await mkdtemp("/tmp/happy-agent-binary-smoke-");
    const happyHome = `${root}/.happy`;
    const workspacePath = `${root}/workspace`;
    await mkdir(workspacePath, { recursive: true });
    await writeFile(`${workspacePath}/binary-compatibility.txt`, "standalone binary\n", "utf8");

    const inferenceToken = randomBytes(24).toString("hex");
    let inferenceStep = 0;
    const inferenceFixture = createServer((request, response) => {
        void (async () => {
            if (
                request.method !== "POST" ||
                request.headers.authorization !== `Bearer ${inferenceToken}`
            ) {
                response.writeHead(401);
                response.end();
                return;
            }
            const body = JSON.parse(await readRequestBody(request));
            const sessionId = body?.options?.sessionId;
            if (typeof sessionId === "string" && sessionId.endsWith(":title")) {
                sendInference(response, {
                    content: [{ type: "text", text: "<title>Binary smoke</title>" }],
                    stopReason: "stop",
                });
                return;
            }
            if (inferenceStep === 0) {
                inferenceStep += 1;
                sendInference(response, {
                    content: [
                        {
                            arguments: {
                                cmd: "printf 'compute-pty-ok\\n'",
                                tty: true,
                                yield_time_ms: 1_000,
                            },
                            callId: "binary-compute-pty",
                            name: "exec_command",
                            type: "tool_call",
                        },
                    ],
                });
                return;
            }
            if (inferenceStep === 1) {
                if (!JSON.stringify(body).includes("compute-pty-ok")) {
                    throw new Error("The Bun compute PTY result did not reach inference.");
                }
                inferenceStep += 1;
                sendInference(response, {
                    content: [
                        {
                            arguments: {
                                input: {
                                    script: "log('workflow-monty-ok')\n{'ok': True}",
                                },
                            },
                            callId: "binary-workflow-run",
                            name: "run_workflow",
                            type: "tool_call",
                        },
                    ],
                });
                return;
            }
            if (inferenceStep === 2) {
                const workflowId = findWorkflowId(body);
                if (workflowId === undefined) {
                    throw new Error("The workflow launch result did not contain its ID.");
                }
                inferenceStep += 1;
                sendInference(response, {
                    content: [
                        {
                            arguments: { id: workflowId },
                            callId: "binary-workflow-wait",
                            name: "wait_workflow",
                            type: "tool_call",
                        },
                    ],
                });
                return;
            }
            if (inferenceStep === 3) {
                const serialized = JSON.stringify(body);
                if (!serialized.includes("is completed")) {
                    throw new Error("The Bun Monty workflow did not complete.");
                }
                inferenceStep += 1;
                sendInference(response, {
                    content: [{ type: "text", text: "Binary compute is healthy." }],
                    stopReason: "stop",
                });
                return;
            }
            throw new Error("The binary smoke made an unexpected inference request.");
        })().catch((error) => {
            response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
            response.end(error instanceof Error ? error.message : String(error));
        });
    });
    const inferencePort = await listenHttp(inferenceFixture);

    const daemonOutput = [];
    const daemon = spawn(binary, ["run"], {
        cwd: workspacePath,
        env: {
            ...process.env,
            HAPPY_GYM_INFERENCE_URL: `http://127.0.0.1:${String(inferencePort)}/inference`,
            HAPPY_GYM_TOKEN: inferenceToken,
            HAPPY_HOME_DIR: happyHome,
            HOME: root,
        },
        stdio: ["ignore", "pipe", "pipe"],
    });
    daemon.stdout.on("data", (chunk) => daemonOutput.push(chunk.toString("utf8")));
    daemon.stderr.on("data", (chunk) => daemonOutput.push(chunk.toString("utf8")));

    let client;
    let fixture;
    let terminal;
    try {
        const tokenPath = `${happyHome}/agent/token`;
        const socketPath = `${happyHome}/agent/server.sock`;
        const token = (await waitFor(async () => await readFile(tokenPath, "utf8"), daemon)).trim();
        client = new HappyAgentClient({
            endpoint: "http://happy-agent.release",
            fetch: createUnixSocketFetch(socketPath),
            token,
        });
        await waitFor(async () => ((await client.getHealth()).ready ? true : undefined), daemon);

        const registered = await client.registerProject({ path: workspacePath });
        const project = await waitFor(async () => {
            const current = (await client.getProject(registered.project.id)).project;
            if (current.initialization.status === "failed") {
                throw new Error(current.initialization.error ?? "Project initialization failed.");
            }
            return current.initialization.status === "ready" ? current : undefined;
        }, daemon);

        process.stdout.write("Checking standalone image processing.\n");
        const currentProfile = await client.getProfile();
        const profile = await client.setProfilePhoto(
            { contentType: "image/png", data: TEST_PNG },
            { ifMatch: currentProfile.profile.version },
        );
        const profilePhoto = await client.getProfilePhoto();
        if (
            profile.profile.photo?.thumbhash === undefined ||
            profilePhoto === null ||
            profilePhoto.contentType !== "image/webp" ||
            profilePhoto.data.byteLength === 0
        ) {
            throw new Error("The standalone profile image pipeline returned an invalid photo.");
        }
        const avatarProject = await client.setProjectAvatar(
            project.id,
            { contentType: "image/png", data: TEST_PNG },
            { ifMatch: project.version },
        );
        const avatar = await client.getProjectAvatar(project.id);
        if (
            avatarProject.project.avatar?.kind !== "image" ||
            avatarProject.project.avatar.thumbhash.length === 0 ||
            avatar === null ||
            avatar.contentType !== "image/webp" ||
            avatar.data.byteLength === 0
        ) {
            throw new Error("The standalone project image pipeline returned an invalid avatar.");
        }
        process.stdout.write("Standalone image processing is healthy.\n");

        process.stdout.write("Checking standalone file indexing.\n");
        await waitFor(async () => {
            const files = await client.searchFiles(project.id, {
                limit: 10,
                query: "binary-compatibility",
            });
            return files.files.some((file) => file.path === "binary-compatibility.txt")
                ? true
                : undefined;
        }, daemon);
        process.stdout.write("Standalone file indexing is healthy.\n");

        process.stdout.write("Checking standalone compute and workflows.\n");
        const agent = (
            await client.createAgent({
                title: "Binary compatibility",
                workspaceId: project.id,
            })
        ).agent;
        await client.sendMessage(agent.id, {
            mode: {
                effort: "off",
                modelId: "openai/gym",
                permissionMode: "full_access",
                providerId: "gym",
                serviceTier: null,
            },
            text: "Run the binary compute PTY check and a workflow.",
        });
        const finished = await waitFor(async () => {
            const events = await client.getEvents({ limit: 10_000 });
            return events.events.find(
                (event) => event.type === "run.finished" && event.payload.agentId === agent.id,
            );
        }, daemon);
        if (finished.type !== "run.finished" || finished.payload.run.status !== "completed") {
            const history = await client.getMessages(agent.id, { limit: 100 });
            throw new Error(
                `The standalone compute compatibility run did not complete at inference step ${String(inferenceStep)}: ${JSON.stringify(history.runs)}`,
            );
        }
        if (inferenceStep !== 4) {
            throw new Error("The standalone compute compatibility run ended before every check.");
        }
        process.stdout.write("Standalone compute and workflows are healthy.\n");

        const transportFailures = [];
        process.stdout.write("Checking standalone terminal transport.\n");
        try {
            terminal = (
                await client.openTerminal(project.id, {
                    command: "cat",
                })
            ).terminal;
            await readTerminalOutput({
                expected: "standalone-terminal-ok",
                path: `/v0/workspaces/${project.id}/terminals/${terminal.id}/attach`,
                socketPath,
                token,
            });
            process.stdout.write("Standalone terminal transport is healthy.\n");
        } catch (error) {
            transportFailures.push(error);
            process.stderr.write(
                `Standalone terminal transport failed: ${error instanceof Error ? error.message : String(error)}\n`,
            );
        }

        process.stdout.write("Checking standalone workspace proxy transport.\n");
        fixture = createServer((_request, response) => {
            const body = Buffer.from("standalone-proxy-ok");
            response.writeHead(200, {
                connection: "close",
                "content-length": String(body.byteLength),
                "content-type": "text/plain",
            });
            response.end(body);
        });
        const fixturePort = await listenHttp(fixture);
        try {
            const proxied = await proxyHttp({
                path: `/v0/workspaces/${project.id}/proxy`,
                port: fixturePort,
                socketPath,
                token,
            });
            if (!proxied.includes("standalone-proxy-ok")) {
                throw new Error(
                    `The standalone workspace proxy returned an unexpected response: ${proxied}`,
                );
            }
            process.stdout.write("Standalone workspace proxy transport is healthy.\n");
        } catch (error) {
            transportFailures.push(error);
            process.stderr.write(
                `Standalone workspace proxy transport failed: ${error instanceof Error ? error.message : String(error)}\n`,
            );
        }
        if (transportFailures.length > 0) {
            throw new AggregateError(
                transportFailures,
                "The standalone daemon's raw transports are not healthy.",
            );
        }
    } catch (error) {
        const output = daemonOutput.join("").trim();
        if (output.length > 0) process.stderr.write(`Standalone daemon output:\n${output}\n`);
        throw error;
    } finally {
        process.stdout.write("Stopping standalone transport smoke resources.\n");
        if (terminal !== undefined && client !== undefined) {
            await client.stopTerminal(terminal.workspaceId, terminal.id).catch(() => undefined);
        }
        await client?.shutdown().catch(() => undefined);
        await closeHttp(fixture).catch(() => undefined);
        await closeHttp(inferenceFixture).catch(() => undefined);
        daemon.kill("SIGTERM");
        await Promise.race([
            new Promise((resolveExit) => daemon.once("exit", resolveExit)),
            new Promise((resolveTimeout) => setTimeout(resolveTimeout, 2_000)),
        ]);
        if (daemon.exitCode === null) daemon.kill("SIGKILL");
        await rm(root, { force: true, recursive: true });
    }
}

async function readTerminalOutput(options) {
    const webSocket = await openWebSocket(options);
    try {
        const terminalBytes = new ByteQueue();
        let output = "";
        let inputSent = false;
        webSocket.sendBinary(
            terminalFrame(
                TERMINAL_PACKET.clientHello,
                0,
                Buffer.from(
                    JSON.stringify({
                        capabilities: { grid: false, vt: true },
                        clientId: "standalone-release-smoke",
                        creditBytes: 256 * 1024,
                        parserFingerprint: "libghostty-vt/0.2/defaults",
                        resumeOutputOffset: 0,
                    }),
                ),
            ),
        );
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
            terminalBytes.push(await webSocket.readBinary(deadline - Date.now()));
            for (;;) {
                const header = terminalBytes.peek(TERMINAL_HEADER_BYTES);
                if (header === undefined) break;
                if (header.readUInt16BE(0) !== TERMINAL_MAGIC) {
                    throw new Error("The standalone terminal returned invalid wire bytes.");
                }
                const payloadLength = header.readUInt32BE(16);
                const frame = terminalBytes.read(TERMINAL_HEADER_BYTES + payloadLength);
                if (frame === undefined) break;
                const type = frame.readUInt8(3);
                const flags = frame.readUInt8(4);
                const sequence = Number(frame.readBigUInt64BE(8));
                const encoded = frame.subarray(TERMINAL_HEADER_BYTES);
                const payload = flags & TERMINAL_COMPRESSED ? inflateRawSync(encoded) : encoded;
                if (type === TERMINAL_PACKET.welcome) {
                    const welcome = JSON.parse(payload.toString("utf8"));
                    webSocket.sendBinary(
                        terminalFrame(
                            TERMINAL_PACKET.resizeApplied,
                            welcome.resizeRevision,
                            Buffer.alloc(0),
                        ),
                    );
                    if (!inputSent) {
                        inputSent = true;
                        setImmediate(() => {
                            webSocket.sendBinary(
                                terminalFrame(
                                    TERMINAL_PACKET.input,
                                    1,
                                    Buffer.from("standalone-terminal-ok\n"),
                                ),
                            );
                        });
                    }
                } else if (type === TERMINAL_PACKET.output) {
                    output += payload.toString("utf8");
                    webSocket.sendBinary(
                        terminalFrame(TERMINAL_PACKET.outputAck, sequence, Buffer.alloc(0)),
                    );
                    if (output.includes(options.expected)) return;
                }
            }
        }
        throw new Error(`Timed out waiting for standalone terminal output '${options.expected}'.`);
    } finally {
        webSocket.close();
    }
}

async function openWebSocket(options) {
    const socket = connectUnix(options.socketPath);
    await new Promise((resolveConnect, rejectConnect) => {
        socket.once("connect", resolveConnect);
        socket.once("error", rejectConnect);
    });
    const key = randomBytes(16).toString("base64");
    socket.write(
        `GET ${options.path} HTTP/1.1\r\n` +
            "Host: happy-agent.release\r\n" +
            "Connection: Upgrade\r\n" +
            "Upgrade: websocket\r\n" +
            "Sec-WebSocket-Version: 13\r\n" +
            `Sec-WebSocket-Key: ${key}\r\n` +
            `Authorization: Bearer ${options.token}\r\n\r\n`,
    );
    const bytes = new SocketBytes(socket);
    const headers = (await bytes.readUntil("\r\n\r\n", 10_000)).toString("utf8");
    if (!headers.startsWith("HTTP/1.1 101 ")) {
        socket.destroy();
        throw new Error(`The standalone terminal upgrade failed: ${headers.trim()}`);
    }
    const expectedAccept = createHash("sha1")
        .update(key + WEBSOCKET_MAGIC)
        .digest("base64");
    if (!headers.toLowerCase().includes(`sec-websocket-accept: ${expectedAccept}`.toLowerCase())) {
        socket.destroy();
        throw new Error("The standalone terminal upgrade returned an invalid WebSocket accept.");
    }
    return {
        close: () => socket.destroy(),
        readBinary: async (timeoutMs) => {
            const first = await bytes.readBytes(2, timeoutMs);
            const opcode = first[0] & 0x0f;
            if ((first[0] & 0x80) === 0) {
                throw new Error("The standalone terminal fragmented a WebSocket message.");
            }
            let length = first[1] & 0x7f;
            if (length === 126) length = (await bytes.readBytes(2, timeoutMs)).readUInt16BE(0);
            else if (length === 127) {
                const large = (await bytes.readBytes(8, timeoutMs)).readBigUInt64BE(0);
                if (large > BigInt(Number.MAX_SAFE_INTEGER)) {
                    throw new Error("The standalone terminal WebSocket message is too large.");
                }
                length = Number(large);
            }
            const masked = (first[1] & 0x80) !== 0;
            const mask = masked ? await bytes.readBytes(4, timeoutMs) : undefined;
            const payload = await bytes.readBytes(length, timeoutMs);
            if (mask !== undefined) applyMask(payload, mask);
            if (opcode === 0x8) {
                const code = payload.byteLength >= 2 ? payload.readUInt16BE(0) : undefined;
                const reason = payload.byteLength > 2 ? payload.subarray(2).toString("utf8") : "";
                throw new Error(
                    `The standalone terminal WebSocket closed early${code === undefined ? "" : ` with code ${code}`}${reason.length === 0 ? "" : `: ${reason}`}.`,
                );
            }
            if (opcode !== 0x2) {
                throw new Error("The standalone terminal WebSocket returned a non-binary message.");
            }
            return payload;
        },
        sendBinary: (payload) => socket.write(webSocketClientFrame(payload)),
    };
}

function webSocketClientFrame(payload) {
    const source = Buffer.from(payload);
    const mask = randomBytes(4);
    const lengthBytes = source.byteLength < 126 ? 0 : source.byteLength <= 0xffff ? 2 : 8;
    const frame = Buffer.alloc(2 + lengthBytes + mask.byteLength + source.byteLength);
    frame[0] = 0x82;
    if (lengthBytes === 0) frame[1] = 0x80 | source.byteLength;
    else if (lengthBytes === 2) {
        frame[1] = 0x80 | 126;
        frame.writeUInt16BE(source.byteLength, 2);
    } else {
        frame[1] = 0x80 | 127;
        frame.writeBigUInt64BE(BigInt(source.byteLength), 2);
    }
    mask.copy(frame, 2 + lengthBytes);
    source.copy(frame, 2 + lengthBytes + mask.byteLength);
    applyMask(frame.subarray(2 + lengthBytes + mask.byteLength), mask);
    return frame;
}

function applyMask(payload, mask) {
    for (let index = 0; index < payload.byteLength; index += 1) {
        payload[index] ^= mask[index % 4];
    }
}

function terminalFrame(type, sequence, payload) {
    const frame = Buffer.alloc(TERMINAL_HEADER_BYTES + payload.byteLength);
    frame.writeUInt16BE(TERMINAL_MAGIC, 0);
    frame.writeUInt8(TERMINAL_VERSION, 2);
    frame.writeUInt8(type, 3);
    frame.writeBigUInt64BE(BigInt(sequence), 8);
    frame.writeUInt32BE(payload.byteLength, 16);
    payload.copy(frame, TERMINAL_HEADER_BYTES);
    return frame;
}

function proxyHttp(options) {
    return new Promise((resolveProxy, rejectProxy) => {
        let connected = false;
        const request = httpRequest({
            headers: { authorization: `Bearer ${options.token}` },
            method: "CONNECT",
            path: options.path,
            socketPath: options.socketPath,
        });
        request.setTimeout(10_000, () =>
            request.destroy(
                new Error(
                    connected
                        ? "Workspace proxy response timed out."
                        : "Workspace proxy CONNECT timed out.",
                ),
            ),
        );
        request.once("error", rejectProxy);
        request.once("response", (response) => {
            response.resume();
            rejectProxy(
                new Error(`The standalone workspace proxy returned HTTP ${response.statusCode}.`),
            );
        });
        request.once("connect", (response, socket, head) => {
            connected = true;
            if (response.statusCode !== 200) {
                socket.destroy();
                rejectProxy(
                    new Error(
                        `The standalone workspace proxy returned HTTP ${response.statusCode}.`,
                    ),
                );
                return;
            }
            socket.setTimeout(10_000, () =>
                socket.destroy(new Error("Workspace proxy response timed out.")),
            );
            let responseBytes = Buffer.from(head);
            socket.on("data", (chunk) => {
                responseBytes = Buffer.concat([responseBytes, chunk]);
            });
            socket.once("end", () => resolveProxy(responseBytes.toString("utf8")));
            socket.once("error", rejectProxy);
            socket.write(
                `GET http://127.0.0.1:${options.port}/ HTTP/1.1\r\n` +
                    `Host: 127.0.0.1:${options.port}\r\nConnection: close\r\n\r\n`,
            );
        });
        request.end();
    });
}

class ByteQueue {
    buffer = Buffer.alloc(0);

    peek(length) {
        return this.buffer.byteLength < length ? undefined : this.buffer.subarray(0, length);
    }

    push(bytes) {
        this.buffer = Buffer.concat([this.buffer, bytes]);
    }

    read(length) {
        if (this.buffer.byteLength < length) return undefined;
        const result = this.buffer.subarray(0, length);
        this.buffer = this.buffer.subarray(length);
        return result;
    }
}

class SocketBytes extends ByteQueue {
    failure;
    ended = false;
    waiters = new Set();

    constructor(socket) {
        super();
        socket.on("data", (chunk) => {
            this.push(Buffer.from(chunk));
            this.wake();
        });
        socket.once("error", (error) => {
            this.failure = error;
            this.wake();
        });
        socket.once("end", () => {
            this.ended = true;
            this.wake();
        });
    }

    async readBytes(length, timeoutMs) {
        for (;;) {
            if (this.failure !== undefined) throw this.failure;
            const result = this.read(length);
            if (result !== undefined) return result;
            if (this.ended) throw new Error("The standalone terminal socket closed early.");
            await this.wait(timeoutMs);
        }
    }

    async readUntil(marker, timeoutMs) {
        const needle = Buffer.from(marker);
        for (;;) {
            if (this.failure !== undefined) throw this.failure;
            const index = this.buffer.indexOf(needle);
            if (index >= 0) return this.read(index + needle.byteLength);
            if (this.ended) throw new Error("The standalone terminal socket closed early.");
            await this.wait(timeoutMs);
        }
    }

    async wait(timeoutMs) {
        await new Promise((resolveWait, rejectWait) => {
            const wake = () => {
                clearTimeout(timer);
                this.waiters.delete(wake);
                resolveWait();
            };
            const timer = setTimeout(
                () => {
                    this.waiters.delete(wake);
                    rejectWait(new Error("Timed out waiting for standalone terminal bytes."));
                },
                Math.max(1, timeoutMs),
            );
            timer.unref?.();
            this.waiters.add(wake);
        });
    }

    wake() {
        for (const waiter of this.waiters) waiter();
    }
}

async function waitFor(check, process, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    let lastError;
    while (Date.now() < deadline) {
        if (process.exitCode !== null) {
            throw new Error(`The standalone daemon exited with code ${process.exitCode}.`);
        }
        try {
            const result = await check();
            if (result !== undefined) return result;
        } catch (error) {
            lastError = error;
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    }
    throw lastError ?? new Error("Timed out waiting for the standalone daemon.");
}

function listenHttp(server) {
    return new Promise((resolveListen, rejectListen) => {
        server.once("error", rejectListen);
        server.listen(0, "127.0.0.1", () => {
            server.off("error", rejectListen);
            const address = server.address();
            if (address === null || typeof address === "string") {
                rejectListen(new Error("The standalone proxy fixture did not bind a TCP port."));
                return;
            }
            resolveListen(address.port);
        });
    });
}

function closeHttp(server) {
    if (server === undefined) return Promise.resolve();
    server.closeAllConnections?.();
    return new Promise((resolveClose, rejectClose) => {
        server.close((error) => (error === undefined ? resolveClose() : rejectClose(error)));
    });
}

async function readRequestBody(request) {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of request) {
        const buffer = Buffer.from(chunk);
        bytes += buffer.byteLength;
        if (bytes > 16 * 1024 * 1024) throw new Error("Inference request is too large.");
        chunks.push(buffer);
    }
    return Buffer.concat(chunks, bytes).toString("utf8");
}

function sendInference(response, body) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
}

function findWorkflowId(value) {
    if (typeof value === "string") {
        if (!value.includes("workflow")) return undefined;
        const rendered = /\(([a-z][a-z0-9]*)\) is (?:running|completed|failed|paused)/u.exec(value);
        if (rendered?.[1] !== undefined) return rendered[1];
        try {
            return findWorkflowId(JSON.parse(value));
        } catch {
            return undefined;
        }
    }
    if (Array.isArray(value)) {
        for (const item of value) {
            const found = findWorkflowId(item);
            if (found !== undefined) return found;
        }
        return undefined;
    }
    if (value === null || typeof value !== "object") return undefined;
    if (
        typeof value.id === "string" &&
        (typeof value.workflow === "string" ||
            value.status === "running" ||
            value.status === "completed")
    ) {
        return value.id;
    }
    for (const item of Object.values(value)) {
        const found = findWorkflowId(item);
        if (found !== undefined) return found;
    }
    return undefined;
}

await main();
