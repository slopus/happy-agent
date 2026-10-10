import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { createServer as createTcpServer, type Socket } from "node:net";
import { inflateRawSync, deflateRawSync } from "node:zlib";

import {
    clientFrameEvent,
    connectTerminalWebSocket,
    connectWorkspaceProxy,
    createAgentGym,
    type AgentGym,
} from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const running = new Set<AgentGym>();

afterEach(async () => {
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
});

describe("public terminal and workspace proxy transports", () => {
    it("opens, attaches, replays, resizes, writes input, and stops root terminals", async () => {
        const gym = await createAgentGym({ timeoutMs: 15_000 });
        running.add(gym);
        const workspaceId = await rootWorkspaceId(gym);
        const stream = gym.stream();
        await stream.opened();

        const terminalResponse = await gym.client.openTerminal(workspaceId, {
            command: "printf 'terminal-output\\n'; sleep 30",
            cols: 80,
            rows: 24,
        });
        const terminal = terminalResponse.terminal;
        expect(terminal).toMatchObject({
            cols: 80,
            rows: 24,
            status: "running",
            workspaceId,
        });
        const created = await stream.waitFor((frame) => {
            const event = clientFrameEvent(frame);
            if (event?.type !== "terminal.created") return false;
            return event.payload.terminal.id === terminal.id;
        }, "the terminal.created event");
        expect(clientFrameEvent(created)?.payload).toMatchObject({
            terminal: { id: terminal.id, version: terminal.version },
        });

        const transport = { socketPath: gym.socketPath, token: gym.token };
        const first = new TerminalAttachment(
            await connectTerminalWebSocket(gym.client, workspaceId, terminal.id, transport),
            "terminal-first",
        );
        await first.ready();
        await expect(first.waitForOutput("terminal-output")).resolves.toContain("terminal-output");

        const second = new TerminalAttachment(
            await connectTerminalWebSocket(gym.client, workspaceId, terminal.id, transport),
            "terminal-second",
        );
        await second.ready();
        await expect(second.waitForOutput("terminal-output")).resolves.toContain("terminal-output");

        const resized = await gym.client.resizeTerminal(workspaceId, terminal.id, {
            cols: 100,
            rows: 30,
        });
        expect(resized.terminal).toMatchObject({
            cols: 100,
            rows: 30,
            status: "running",
        });
        expect(resized.terminal.version).not.toBe(terminal.version);
        await gym.waitForEvent(
            (event) =>
                event.type === "terminal.updated" &&
                event.payload.terminalId === terminal.id &&
                event.payload.version === resized.terminal.version,
            "the terminal resize event",
        );

        const stopped = await gym.client.stopTerminal(workspaceId, terminal.id);
        expect(stopped.terminal).toMatchObject({
            exitCode: expect.any(Number),
            id: terminal.id,
            status: "exited",
        });
        await gym.waitForEvent(
            (event) =>
                event.type === "terminal.updated" &&
                event.payload.terminalId === terminal.id &&
                event.payload.changes.status === "exited",
            "the terminal exit event",
        );
        await expect(gym.client.listTerminals(workspaceId)).resolves.toMatchObject({
            terminals: [expect.objectContaining({ id: terminal.id, status: "exited" })],
        });

        const childWorkspaceId = await readyChildWorkspace(gym, workspaceId);
        const childTerminal = (
            await gym.client.openTerminal(childWorkspaceId, {
                command: "printf 'child-terminal\\n'; sleep 30",
            })
        ).terminal;
        await expect(gym.client.listTerminals(childWorkspaceId)).resolves.toMatchObject({
            terminals: [expect.objectContaining({ id: childTerminal.id, status: "running" })],
        });
        const childAttachment = new TerminalAttachment(
            await connectTerminalWebSocket(
                gym.client,
                childWorkspaceId,
                childTerminal.id,
                transport,
            ),
            "terminal-child",
        );
        await childAttachment.ready();
        await expect(childAttachment.waitForOutput("child-terminal")).resolves.toContain(
            "child-terminal",
        );
        const childResized = await gym.client.resizeTerminal(childWorkspaceId, childTerminal.id, {
            cols: 90,
            rows: 28,
        });
        expect(childResized.terminal).toMatchObject({ cols: 90, rows: 28 });
        const childStopped = await gym.client.stopTerminal(childWorkspaceId, childTerminal.id);
        expect(childStopped.terminal.status).toBe("exited");
        childAttachment.close();

        first.close();
        second.close();
    }, 30_000);

    it("uses the binary attachment for input and refuses invalid terminal settings", async () => {
        const gym = await createAgentGym({ timeoutMs: 15_000 });
        running.add(gym);
        const workspaceId = await rootWorkspaceId(gym);

        await expect(gym.client.openTerminal(workspaceId, { cols: 501 })).rejects.toMatchObject({
            code: "invalid_request",
            status: 400,
        });

        const terminal = (
            await gym.client.openTerminal(workspaceId, {
                command: "read value; printf 'input:%s\\n' \"$value\"; sleep 30",
            })
        ).terminal;
        const attachment = new TerminalAttachment(
            await connectTerminalWebSocket(gym.client, workspaceId, terminal.id, {
                socketPath: gym.socketPath,
                token: gym.token,
            }),
            "terminal-input",
        );
        await attachment.ready();
        await attachment.writeInput("gym-input\n");
        await expect(attachment.waitForOutput("input:gym-input")).resolves.toContain(
            "input:gym-input",
        );
        attachment.close();
        await gym.client.stopTerminal(workspaceId, terminal.id);
    }, 30_000);

    it("enforces attachment authentication and closes malformed binary protocol sessions", async () => {
        const gym = await createAgentGym({ timeoutMs: 15_000 });
        running.add(gym);
        const workspaceId = await rootWorkspaceId(gym);
        const terminal = (
            await gym.client.openTerminal(workspaceId, {
                command: "sleep 30",
            })
        ).terminal;

        await expect(
            connectTerminalWebSocket(gym.client, workspaceId, terminal.id, {
                socketPath: gym.socketPath,
                token: "not-the-daemon-token",
            }),
        ).rejects.toThrow(/HTTP (401|404)/);

        const malformed = new TerminalAttachment(
            await connectTerminalWebSocket(gym.client, workspaceId, terminal.id, {
                socketPath: gym.socketPath,
                token: gym.token,
            }),
            "terminal-malformed",
        );
        await malformed.ready();
        malformed.writeRaw(Buffer.from("not-a-terminal-frame"));
        await malformed.closed();
        expect(malformed.errorText).toContain("wire");
        await gym.client.stopTerminal(workspaceId, terminal.id);
    }, 30_000);

    it("proxies plain HTTP and nested TCP CONNECT for root and child workspaces", async () => {
        const gym = await createAgentGym({ timeoutMs: 15_000 });
        running.add(gym);
        const rootId = await rootWorkspaceId(gym);
        const transport = { socketPath: gym.socketPath, token: gym.token };

        const httpFixture = await listenHttp((request, response) => {
            if (request.url !== "/gym-proxy") {
                response.writeHead(404);
                response.end();
                return;
            }
            const body = Buffer.from("proxy-http-ok");
            response.writeHead(200, {
                connection: "close",
                "content-length": String(body.byteLength),
                "content-type": "text/plain",
            });
            response.end(body);
        });
        const tcpFixture = await listenTcp((socket) => {
            socket.on("data", (data) => socket.write(Buffer.concat([Buffer.from("echo:"), data])));
        });
        try {
            await expect(proxyHttp(gym, rootId, httpFixture.port)).resolves.toBe("proxy-http-ok");
            await expect(proxyConnect(gym, rootId, tcpFixture.port)).resolves.toBe("echo:gym-tcp");

            await expect(
                connectWorkspaceProxy(gym.client, rootId, {
                    ...transport,
                    token: "not-the-daemon-token",
                }),
            ).rejects.toThrow(/HTTP 401/);

            const unavailable = await listenTcp(() => undefined);
            const unavailablePort = unavailable.port;
            await unavailable.close();
            await expect(proxyConnectStatus(gym, rootId, unavailablePort)).resolves.toMatch(
                /^HTTP\/1\.1 (502|504) /,
            );

            const childId = await readyChildWorkspace(gym, rootId);
            await expect(proxyHttp(gym, childId, httpFixture.port)).resolves.toBe("proxy-http-ok");
            await expect(proxyConnect(gym, childId, tcpFixture.port)).resolves.toBe("echo:gym-tcp");
        } finally {
            await httpFixture.close();
            await tcpFixture.close();
        }
    }, 30_000);
});

async function rootWorkspaceId(gym: AgentGym): Promise<string> {
    const project = await gym.waitUntil(
        async () => {
            const projects = await gym.client.listProjects();
            const candidate = projects.projects.find((project) => project.status === "active");
            return candidate?.initialization.status === "ready" ? candidate : undefined;
        },
        "the root project to become ready",
        15_000,
    );
    expect(project.agents.length).toBeGreaterThan(0);
    const root = await gym.client.getWorkspace(project.id);
    expect(root.workspace.id).toBe(project.id);
    return project.id;
}

async function readyChildWorkspace(gym: AgentGym, parentId: string): Promise<string> {
    const created = await gym.client.createWorkspace({
        name: "gym-child",
        parentId,
    });
    return await gym.waitUntil(
        async () => {
            const current = await gym.client.getWorkspace(created.workspace.id);
            if (current.workspace.initialization.status === "failed") {
                throw new Error(
                    `The child workspace failed to initialize: ${
                        current.workspace.initialization.error ?? "unknown error"
                    }`,
                );
            }
            return current.workspace.initialization.status === "ready"
                ? current.workspace.id
                : undefined;
        },
        "the child workspace to become ready",
        15_000,
    );
}

async function proxyHttp(gym: AgentGym, workspaceId: string, port: number): Promise<string> {
    const socket = await connectWorkspaceProxy(gym.client, workspaceId, {
        socketPath: gym.socketPath,
        token: gym.token,
    });
    const reader = new ByteReader(socket);
    try {
        socket.write(
            `GET http://127.0.0.1:${String(port)}/gym-proxy HTTP/1.1\r\n` +
                `Host: 127.0.0.1:${String(port)}\r\nConnection: close\r\n\r\n`,
        );
        const headers = (await reader.readUntil("\r\n\r\n")).toString("utf8");
        expect(headers).toMatch(/^HTTP\/1\.1 200 /);
        const length = Number(/(?:^|\r\n)content-length:\s*(\d+)/i.exec(headers)?.[1]);
        if (!Number.isSafeInteger(length)) throw new Error("The proxy response had no length.");
        return (await reader.readBytes(length)).toString("utf8");
    } finally {
        socket.destroy();
    }
}

async function proxyConnect(gym: AgentGym, workspaceId: string, port: number): Promise<string> {
    const socket = await connectWorkspaceProxy(gym.client, workspaceId, {
        socketPath: gym.socketPath,
        token: gym.token,
    });
    const reader = new ByteReader(socket);
    try {
        socket.write(
            `CONNECT 127.0.0.1:${String(port)} HTTP/1.1\r\n` +
                `Host: 127.0.0.1:${String(port)}\r\n\r\n`,
        );
        expect((await reader.readUntil("\r\n\r\n")).toString("utf8")).toMatch(/^HTTP\/1\.1 200 /);
        socket.write("gym-tcp");
        return (await reader.readBytes("echo:gym-tcp".length)).toString("utf8");
    } finally {
        socket.destroy();
    }
}

async function proxyConnectStatus(
    gym: AgentGym,
    workspaceId: string,
    port: number,
): Promise<string> {
    const socket = await connectWorkspaceProxy(gym.client, workspaceId, {
        socketPath: gym.socketPath,
        token: gym.token,
    });
    const reader = new ByteReader(socket);
    try {
        socket.write(
            `CONNECT 127.0.0.1:${String(port)} HTTP/1.1\r\n` +
                `Host: 127.0.0.1:${String(port)}\r\n\r\n`,
        );
        return (await reader.readUntil("\r\n\r\n")).toString("utf8");
    } finally {
        socket.destroy();
    }
}

async function listenHttp(
    handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ readonly port: number; close(): Promise<void> }> {
    const server = createServer(handler);
    await listen(server);
    return {
        close: async () => await closeServer(server),
        port: portOf(server),
    };
}

async function listenTcp(
    handler: (socket: Socket) => void,
): Promise<{ readonly port: number; close(): Promise<void> }> {
    const server = createTcpServer(handler);
    await listen(server);
    return {
        close: async () => await closeServer(server),
        port: portOf(server),
    };
}

async function listen(server: ListenableServer): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const onError = (error: unknown): void => reject(error);
        server.once("error", onError);
        server.listen(0, "127.0.0.1", () => resolve());
    });
}

function portOf(server: { address(): ReturnType<import("node:net").Server["address"]> }): number {
    const address = server.address();
    if (address === null || typeof address === "string")
        throw new Error("The fixture has no port.");
    return address.port;
}

async function closeServer(server: {
    close(callback: (error?: Error) => void): void;
}): Promise<void> {
    await new Promise<void>((resolve) => server.close(() => resolve()));
}

interface ListenableServer {
    listen(port: number, host: string, callback: () => void): unknown;
    once(event: "error", listener: (error: unknown) => void): unknown;
}

class ByteReader {
    readonly #socket: Duplex;
    #buffer = Buffer.alloc(0);
    #failure: Error | undefined;
    readonly #waiters = new Set<() => void>();

    constructor(socket: Duplex) {
        this.#socket = socket;
        socket.on("data", (chunk: Buffer) => {
            this.#buffer = Buffer.concat([this.#buffer, Buffer.from(chunk)]);
            this.#wake();
        });
        socket.once("error", (error: Error) => {
            this.#failure = error;
            this.#wake();
        });
        socket.once("close", () => this.#wake());
    }

    async readUntil(marker: string): Promise<Buffer> {
        const needle = Buffer.from(marker);
        for (;;) {
            if (this.#failure !== undefined) throw this.#failure;
            const index = this.#buffer.indexOf(needle);
            if (index >= 0) {
                const end = index + needle.byteLength;
                return this.#take(end);
            }
            await this.#wait();
        }
    }

    async readBytes(length: number): Promise<Buffer> {
        for (;;) {
            if (this.#failure !== undefined) throw this.#failure;
            if (this.#buffer.byteLength >= length) return this.#take(length);
            await this.#wait();
        }
    }

    #take(length: number): Buffer {
        const result = this.#buffer.subarray(0, length);
        this.#buffer = this.#buffer.subarray(length);
        return result;
    }

    async #wait(): Promise<void> {
        await new Promise<void>((resolve) => {
            const waiter = (): void => {
                this.#waiters.delete(waiter);
                clearTimeout(timer);
                resolve();
            };
            const timer = setTimeout(waiter, 10_000);
            timer.unref?.();
            this.#waiters.add(waiter);
        });
    }

    #wake(): void {
        for (const waiter of this.#waiters) waiter();
    }
}

const WIRE_MAGIC = 0x5254;
const WIRE_VERSION = 1;
const WIRE_HEADER_BYTES = 20;
const WIRE_COMPRESSED = 1;
const PACKET = {
    ClientHello: 1,
    Welcome: 2,
    Output: 3,
    OutputAck: 4,
    Input: 5,
    InputAck: 6,
    Resize: 7,
    ResizeAck: 8,
    Error: 17,
    ResizeApplied: 18,
} as const;

class TerminalAttachment {
    readonly #stream: Duplex;
    readonly #name: string;
    readonly #closedPromise: Promise<void>;
    #resolveClosed!: () => void;
    readonly #readyPromise: Promise<void>;
    #resolveReady!: () => void;
    #buffer = Buffer.alloc(0);
    #output = "";
    #failure: Error | undefined;
    #inputSequence = 0;
    #resizeSequence = 0;
    readonly #inputWaiters = new Map<number, () => void>();
    readonly #resizeWaiters = new Map<number, () => void>();
    readonly #outputWaiters = new Set<{
        readonly needle: string;
        readonly resolve: (value: string) => void;
        readonly reject: (error: Error) => void;
        readonly timer: ReturnType<typeof setTimeout>;
    }>();
    errorText = "";

    constructor(stream: Duplex, name: string) {
        this.#stream = stream;
        this.#name = name;
        this.#readyPromise = new Promise<void>((resolve) => {
            this.#resolveReady = resolve;
        });
        this.#closedPromise = new Promise<void>((resolve) => {
            this.#resolveClosed = resolve;
        });
        stream.on("data", (chunk: Buffer) => this.#consume(Buffer.from(chunk)));
        stream.once("error", (error: Error) => {
            this.#failure = error;
            this.errorText ||= error.message;
            this.#rejectWaiters(error);
        });
        stream.once("close", () => {
            this.#resolveClosed();
            if (this.#failure === undefined) this.#failure = new Error(`${this.#name} closed.`);
            this.#rejectWaiters(this.#failure);
        });
        this.#sendJson(PACKET.ClientHello, 0, {
            capabilities: { grid: false, vt: true },
            clientId: name,
            creditBytes: 256 * 1024,
            parserFingerprint: "libghostty-vt/0.2/defaults",
            resumeOutputOffset: 0,
        });
    }

    async ready(): Promise<void> {
        await this.#readyPromise;
        if (this.#failure !== undefined) throw this.#failure;
    }

    async closed(): Promise<void> {
        await this.#closedPromise;
    }

    close(): void {
        this.#stream.destroy();
    }

    writeRaw(data: Uint8Array): void {
        this.#stream.write(Buffer.from(data));
    }

    async writeInput(data: string): Promise<void> {
        const sequence = ++this.#inputSequence;
        await new Promise<void>((resolve, reject) => {
            this.#inputWaiters.set(sequence, resolve);
            try {
                this.#send(PACKET.Input, sequence, Buffer.from(data));
            } catch (error) {
                this.#inputWaiters.delete(sequence);
                reject(error);
            }
        });
    }

    async waitForOutput(needle: string): Promise<string> {
        if (this.#output.includes(needle)) return this.#output;
        return await new Promise<string>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.#outputWaiters.delete(waiter);
                reject(new Error(`Timed out waiting for terminal output "${needle}".`));
            }, 10_000);
            timer.unref?.();
            const waiter = { needle, reject, resolve, timer };
            this.#outputWaiters.add(waiter);
        });
    }

    #consume(chunk: Buffer): void {
        this.#buffer = Buffer.concat([this.#buffer, chunk]);
        while (this.#buffer.byteLength >= WIRE_HEADER_BYTES) {
            if (this.#buffer.readUInt16BE(0) !== WIRE_MAGIC) {
                this.errorText = "invalid wire magic";
                this.#stream.destroy(new Error("invalid wire magic"));
                return;
            }
            if (this.#buffer.readUInt8(2) !== WIRE_VERSION) {
                this.errorText = "unsupported wire version";
                this.#stream.destroy(new Error("unsupported wire version"));
                return;
            }
            const length = this.#buffer.readUInt32BE(16);
            const frameLength = WIRE_HEADER_BYTES + length;
            if (this.#buffer.byteLength < frameLength) return;
            const type = this.#buffer.readUInt8(3);
            const flags = this.#buffer.readUInt8(4);
            const sequence = Number(this.#buffer.readBigUInt64BE(8));
            const encoded = this.#buffer.subarray(WIRE_HEADER_BYTES, frameLength);
            this.#buffer = this.#buffer.subarray(frameLength);
            const payload =
                flags & WIRE_COMPRESSED ? inflateRawSync(encoded) : Buffer.from(encoded);
            this.#receive(type, sequence, payload);
        }
    }

    #receive(type: number, sequence: number, payload: Buffer): void {
        if (type === PACKET.Welcome) {
            const welcome = JSON.parse(payload.toString("utf8")) as {
                resizeRevision: number;
            };
            this.#send(PACKET.ResizeApplied, welcome.resizeRevision, Buffer.alloc(0));
            this.#resolveReady();
            return;
        }
        if (type === PACKET.Output) {
            this.#output += payload.toString("utf8");
            this.#send(PACKET.OutputAck, sequence, Buffer.alloc(0));
            for (const waiter of this.#outputWaiters) {
                if (!this.#output.includes(waiter.needle)) continue;
                clearTimeout(waiter.timer);
                this.#outputWaiters.delete(waiter);
                waiter.resolve(this.#output);
            }
            return;
        }
        if (type === PACKET.InputAck) {
            this.#inputWaiters.get(sequence)?.();
            this.#inputWaiters.delete(sequence);
            return;
        }
        if (type === PACKET.ResizeAck) {
            const resize = JSON.parse(payload.toString("utf8")) as {
                requestSequence: number;
                resizeRevision: number;
            };
            this.#send(PACKET.ResizeApplied, resize.resizeRevision, Buffer.alloc(0));
            if (resize.requestSequence > 0) {
                this.#resizeWaiters.get(resize.requestSequence)?.();
                this.#resizeWaiters.delete(resize.requestSequence);
            }
            return;
        }
        if (type === PACKET.Error) {
            const error = JSON.parse(payload.toString("utf8")) as { error?: string };
            this.errorText = error.error ?? "terminal protocol error";
            this.#failure = new Error(this.errorText);
            this.#stream.destroy(this.#failure);
        }
    }

    #sendJson(type: number, sequence: number, value: unknown): void {
        this.#send(type, sequence, Buffer.from(JSON.stringify(value), "utf8"));
    }

    #send(type: number, sequence: number, payload: Buffer): void {
        const source = Buffer.from(payload);
        const compressed = source.byteLength >= 512 ? deflateRawSync(source) : source;
        const useCompression = compressed.byteLength + 16 < source.byteLength;
        const body = useCompression ? compressed : source;
        const frame = Buffer.alloc(WIRE_HEADER_BYTES + body.byteLength);
        frame.writeUInt16BE(WIRE_MAGIC, 0);
        frame.writeUInt8(WIRE_VERSION, 2);
        frame.writeUInt8(type, 3);
        frame.writeUInt8(useCompression ? WIRE_COMPRESSED : 0, 4);
        frame.writeBigUInt64BE(BigInt(sequence), 8);
        frame.writeUInt32BE(body.byteLength, 16);
        body.copy(frame, WIRE_HEADER_BYTES);
        this.#stream.write(frame);
    }

    #rejectWaiters(error: Error): void {
        for (const waiter of this.#outputWaiters) {
            clearTimeout(waiter.timer);
            waiter.reject(error);
        }
        this.#outputWaiters.clear();
        this.#inputWaiters.clear();
        this.#resizeWaiters.clear();
    }
}
