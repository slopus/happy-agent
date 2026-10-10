import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createTcpServer, type Server, type Socket } from "node:net";
import type { Duplex } from "node:stream";

import { connectWorkspaceProxy, createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

interface Scenario {
    readonly id: string;
    readonly run: (gym: AgentGym) => Promise<void>;
}

const gyms = new Set<AgentGym>();

afterEach(async () => {
    await Promise.all([...gyms].map(async (gym) => await gym.dispose()));
    gyms.clear();
});

describe("workspace proxy API matrix", () => {
    it.each<Scenario>([
        {
            id: "P001-root-absolute-http",
            run: async (gym) => {
                const root = await rootWorkspace(gym);
                const fixture = await httpFixture((_request, response) =>
                    sendText(response, "root"),
                );
                try {
                    await expect(proxyHttp(gym, root, fixture.port, "/root")).resolves.toBe("root");
                } finally {
                    await fixture.close();
                }
            },
        },
        {
            id: "P002-child-absolute-http",
            run: async (gym) => {
                const child = await childWorkspace(gym);
                const fixture = await httpFixture((_request, response) =>
                    sendText(response, "child"),
                );
                try {
                    await expect(proxyHttp(gym, child, fixture.port, "/child")).resolves.toBe(
                        "child",
                    );
                } finally {
                    await fixture.close();
                }
            },
        },
        {
            id: "P003-root-nested-connect",
            run: async (gym) => {
                const root = await rootWorkspace(gym);
                const fixture = await tcpFixture((socket) => echo(socket, "tcp:"));
                try {
                    await expect(
                        proxyTcp(gym, root, fixture.port, Buffer.from("root"), "tcp:root".length),
                    ).resolves.toBe("tcp:root");
                } finally {
                    await fixture.close();
                }
            },
        },
        {
            id: "P004-child-nested-connect",
            run: async (gym) => {
                const child = await childWorkspace(gym);
                const fixture = await tcpFixture((socket) => echo(socket, "child:"));
                try {
                    await expect(
                        proxyTcp(
                            gym,
                            child,
                            fixture.port,
                            Buffer.from("value"),
                            "child:value".length,
                        ),
                    ).resolves.toBe("child:value");
                } finally {
                    await fixture.close();
                }
            },
        },
        {
            id: "P005-http-content-length-and-content-type",
            run: async (gym) => {
                const root = await rootWorkspace(gym);
                const fixture = await httpFixture((_request, response) => {
                    const body = Buffer.from("headers");
                    response.writeHead(200, {
                        "content-length": String(body.byteLength),
                        "content-type": "application/x-proxy-test",
                    });
                    response.end(body);
                });
                try {
                    const result = await proxyHttpResponse(gym, root, fixture.port, "/headers");
                    expect(result.headers).toMatchObject({
                        "content-length": "7",
                        "content-type": "application/x-proxy-test",
                    });
                    expect(result.body).toBe("headers");
                } finally {
                    await fixture.close();
                }
            },
        },
        {
            id: "P006-upstream-http-404-passes-through",
            run: async (gym) => {
                const root = await rootWorkspace(gym);
                const fixture = await httpFixture((_request, response) => {
                    response.writeHead(404, { "content-length": "0" });
                    response.end();
                });
                try {
                    await expect(
                        proxyHttpStatus(gym, root, fixture.port, "/missing"),
                    ).resolves.toBe(404);
                } finally {
                    await fixture.close();
                }
            },
        },
        {
            id: "P007-binary-tcp-payload-is-unchanged",
            run: async (gym) => {
                const root = await rootWorkspace(gym);
                const payload = Buffer.from([0, 1, 2, 127, 128, 254, 255]);
                const fixture = await tcpFixture((socket) =>
                    socket.on("data", (data) => socket.write(data)),
                );
                try {
                    await expect(
                        proxyTcpBytes(gym, root, fixture.port, payload, payload.length),
                    ).resolves.toEqual(payload);
                } finally {
                    await fixture.close();
                }
            },
        },
        {
            id: "P008-wrong-bearer-token-is-rejected",
            run: async (gym) => {
                const root = await rootWorkspace(gym);
                await expect(
                    connectWorkspaceProxy(gym.client, root, {
                        socketPath: gym.socketPath,
                        token: "wrong-token",
                    }),
                ).rejects.toThrow(/HTTP 401/);
            },
        },
        {
            id: "P009-missing-workspace-is-rejected",
            run: async (gym) => {
                await expect(
                    connectWorkspaceProxy(gym.client, "missingworkspace", {
                        socketPath: gym.socketPath,
                        token: gym.token,
                    }),
                ).rejects.toThrow(/HTTP 404/);
            },
        },
        {
            id: "P010-archived-child-is-not-a-proxy-root",
            run: async (gym) => {
                const child = await childWorkspace(gym);
                const current = (await gym.client.getWorkspace(child)).workspace;
                await gym.client.archiveWorkspace(child, { ifMatch: current.version });
                await expect(
                    connectWorkspaceProxy(gym.client, child, {
                        socketPath: gym.socketPath,
                        token: gym.token,
                    }),
                ).rejects.toThrow(/HTTP (404|409)/);
            },
        },
        {
            id: "P011-unreachable-target-returns-gateway-status",
            run: async (gym) => {
                const root = await rootWorkspace(gym);
                const fixture = await tcpFixture(() => undefined);
                const port = fixture.port;
                await fixture.close();
                await expect(proxyTcpStatus(gym, root, port)).resolves.toMatch(
                    /HTTP\/1\.1 (502|504) /,
                );
            },
        },
        {
            id: "P012-two-root-tunnels-are-independent",
            run: async (gym) => {
                const root = await rootWorkspace(gym);
                const fixture = await tcpFixture((socket) => echo(socket, "independent:"));
                try {
                    const results = await Promise.all([
                        proxyTcp(gym, root, fixture.port, Buffer.from("a"), "independent:a".length),
                        proxyTcp(gym, root, fixture.port, Buffer.from("b"), "independent:b".length),
                    ]);
                    expect(results.sort()).toEqual(["independent:a", "independent:b"]);
                } finally {
                    await fixture.close();
                }
            },
        },
        {
            id: "P013-root-and-child-tunnels-can-coexist",
            run: async (gym) => {
                const root = await rootWorkspace(gym);
                const child = await childWorkspace(gym);
                const fixture = await tcpFixture((socket) => echo(socket, "coexist:"));
                try {
                    const results = await Promise.all([
                        proxyTcp(
                            gym,
                            root,
                            fixture.port,
                            Buffer.from("root"),
                            "coexist:root".length,
                        ),
                        proxyTcp(
                            gym,
                            child,
                            fixture.port,
                            Buffer.from("child"),
                            "coexist:child".length,
                        ),
                    ]);
                    expect(results.sort()).toEqual(["coexist:child", "coexist:root"]);
                } finally {
                    await fixture.close();
                }
            },
        },
        {
            id: "P014-tunnel-rejects-malformed-target-form",
            run: async (gym) => {
                const root = await rootWorkspace(gym);
                const socket = await connectWorkspaceProxy(gym.client, root, {
                    socketPath: gym.socketPath,
                    token: gym.token,
                });
                try {
                    socket.write("GET /relative HTTP/1.1\r\nHost: localhost\r\n\r\n");
                    await expect(readUntil(socket, "\r\n\r\n")).resolves.toSatisfy((bytes) =>
                        /HTTP\/1\.1 400 /u.test(bytes.toString("utf8")),
                    );
                } finally {
                    socket.destroy();
                }
            },
        },
        {
            id: "P015-tcp-half-close-reaches-target",
            run: async (gym) => {
                const root = await rootWorkspace(gym);
                const fixture = await tcpFixture((socket) => {
                    socket.on("data", (data) => {
                        socket.write(Buffer.concat([Buffer.from("half:"), data]));
                        socket.end();
                    });
                });
                const socket = await connectWorkspaceProxy(gym.client, root, {
                    socketPath: gym.socketPath,
                    token: gym.token,
                });
                try {
                    await expect(
                        proxyTcpOnSocket(socket, fixture.port, Buffer.from("close")),
                    ).resolves.toEqual(Buffer.from("half:close"));
                } finally {
                    socket.destroy();
                    await fixture.close();
                }
            },
        },
        {
            id: "P016-proxy-remains-usable-after-target-closes",
            run: async (gym) => {
                const root = await rootWorkspace(gym);
                const fixture = await tcpFixture((socket) => socket.end());
                try {
                    await expect(proxyTcp(gym, root, fixture.port, Buffer.alloc(0))).resolves.toBe(
                        "",
                    );
                } finally {
                    await fixture.close();
                }
            },
        },
        {
            id: "P017-proxy-remains-usable-after-daemon-restart",
            run: async (gym) => {
                const root = await rootWorkspace(gym);
                const fixture = await tcpFixture((socket) => echo(socket, "restart:"));
                try {
                    await gym.restart();
                    await expect(
                        proxyTcp(gym, root, fixture.port, Buffer.from("ok"), "restart:ok".length),
                    ).resolves.toBe("restart:ok");
                } finally {
                    await fixture.close();
                }
            },
        },
        {
            id: "P018-invalid-workspace-encoding-is-rejected",
            run: async (gym) => {
                await expect(
                    connectWorkspaceProxy(gym.client, "invalidworkspace", {
                        socketPath: gym.socketPath,
                        token: gym.token,
                    }),
                ).rejects.toThrow(/HTTP (400|404)/);
            },
        },
    ])(
        "$id",
        async ({ run }) => {
            const gym = await createAgentGym({ timeoutMs: 15_000 });
            gyms.add(gym);
            await run(gym);
        },
        30_000,
    );
});

async function rootWorkspace(gym: AgentGym): Promise<string> {
    return await gym.waitUntil(async () => {
        const project = (await gym.client.listProjects()).projects.find(
            (candidate) =>
                candidate.status === "active" && candidate.initialization.status === "ready",
        );
        return project?.id;
    }, "root workspace readiness");
}

async function childWorkspace(gym: AgentGym): Promise<string> {
    const root = await rootWorkspace(gym);
    const created = await gym.client.createWorkspace({ name: "proxy-child", parentId: root });
    return await gym.waitUntil(async () => {
        const current = (await gym.client.getWorkspace(created.workspace.id)).workspace;
        if (current.initialization.status === "failed") {
            throw new Error(current.initialization.error ?? "child workspace failed");
        }
        return current.initialization.status === "ready" ? current.id : undefined;
    }, "child workspace readiness");
}

async function proxyHttp(
    gym: AgentGym,
    workspaceId: string,
    port: number,
    path: string,
): Promise<string> {
    return (await proxyHttpResponse(gym, workspaceId, port, path)).body;
}

async function proxyHttpResponse(
    gym: AgentGym,
    workspaceId: string,
    port: number,
    path: string,
): Promise<{
    readonly status: number;
    readonly headers: Record<string, string>;
    readonly body: string;
}> {
    const socket = await connectWorkspaceProxy(gym.client, workspaceId, {
        socketPath: gym.socketPath,
        token: gym.token,
    });
    try {
        socket.write(
            `GET http://127.0.0.1:${String(port)}${path} HTTP/1.1\r\n` +
                `Host: 127.0.0.1:${String(port)}\r\nConnection: close\r\n\r\n`,
        );
        const reader = new BufferReader(socket);
        const headerBytes = await reader.until("\r\n\r\n");
        const headerText = headerBytes.toString("utf8");
        const status = Number(/^HTTP\/1\.1 (\d+)/.exec(headerText)?.[1] ?? 0);
        const headers: Record<string, string> = {};
        for (const line of headerText.split("\r\n").slice(1)) {
            const separator = line.indexOf(":");
            if (separator > 0)
                headers[line.slice(0, separator).toLowerCase()] = line.slice(separator + 1).trim();
        }
        const length = Number(headers["content-length"] ?? 0);
        const body = (await reader.length(length)).toString("utf8");
        return { status, headers, body };
    } finally {
        socket.destroy();
    }
}

async function proxyHttpStatus(
    gym: AgentGym,
    workspaceId: string,
    port: number,
    path = "/status",
): Promise<number> {
    return (await proxyHttpResponse(gym, workspaceId, port, path)).status;
}

async function proxyTcp(
    gym: AgentGym,
    workspaceId: string,
    port: number,
    payload: Buffer,
    expectedLength = payload.length,
): Promise<string> {
    return (await proxyTcpBytes(gym, workspaceId, port, payload, expectedLength)).toString("utf8");
}

async function proxyTcpBytes(
    gym: AgentGym,
    workspaceId: string,
    port: number,
    payload: Buffer,
    expectedLength = payload.length,
): Promise<Buffer> {
    const socket = await connectWorkspaceProxy(gym.client, workspaceId, {
        socketPath: gym.socketPath,
        token: gym.token,
    });
    try {
        return await proxyTcpOnSocket(socket, port, payload, expectedLength);
    } finally {
        socket.destroy();
    }
}

async function proxyTcpOnSocket(
    socket: Duplex,
    port: number,
    payload: Buffer,
    expectedLength?: number,
): Promise<Buffer> {
    const reader = new BufferReader(socket);
    socket.write(
        `CONNECT 127.0.0.1:${String(port)} HTTP/1.1\r\nHost: 127.0.0.1:${String(port)}\r\n\r\n`,
    );
    const headers = (await reader.until("\r\n\r\n")).toString("utf8");
    if (!/^HTTP\/1\.1 200 /u.test(headers)) throw new Error(`Unexpected proxy status: ${headers}`);
    socket.write(payload);
    return expectedLength === undefined
        ? await reader.untilClose()
        : await reader.length(expectedLength);
}

async function proxyTcpStatus(gym: AgentGym, workspaceId: string, port: number): Promise<string> {
    const socket = await connectWorkspaceProxy(gym.client, workspaceId, {
        socketPath: gym.socketPath,
        token: gym.token,
    });
    try {
        socket.write(
            `CONNECT 127.0.0.1:${String(port)} HTTP/1.1\r\nHost: 127.0.0.1:${String(port)}\r\n\r\n`,
        );
        return (await readUntil(socket, "\r\n\r\n")).toString("utf8");
    } finally {
        socket.destroy();
    }
}

function echo(socket: Socket, prefix: string): void {
    socket.on("data", (data) => socket.write(Buffer.concat([Buffer.from(prefix), data])));
}

function sendText(response: ServerResponse, text: string): void {
    const body = Buffer.from(text);
    response.writeHead(200, {
        "content-length": String(body.byteLength),
        "content-type": "text/plain",
    });
    response.end(body);
}

async function httpFixture(
    handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ readonly port: number; close: () => Promise<void> }> {
    const server = createServer(handler);
    await listen(server);
    return { port: portOf(server), close: async () => await closeServer(server) };
}

async function tcpFixture(handler: (socket: Socket) => void): Promise<{
    readonly port: number;
    readonly close: () => Promise<void>;
}> {
    const server = createTcpServer(handler);
    await listen(server);
    return { port: portOf(server), close: async () => await closeServer(server) };
}

async function listen(server: Server): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
}

function portOf(server: Server): number {
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Fixture has no port.");
    return address.port;
}

async function closeServer(server: Server): Promise<void> {
    await new Promise<void>((resolve) => server.close(() => resolve()));
}

class BufferReader {
    readonly #socket: Duplex;
    #buffer = Buffer.alloc(0);
    #closed = false;
    readonly #waiters = new Set<() => void>();

    constructor(socket: Duplex) {
        this.#socket = socket;
        socket.on("data", (chunk: Buffer) => {
            this.#buffer = Buffer.concat([this.#buffer, Buffer.from(chunk)]);
            this.#wake();
        });
        socket.once("close", () => {
            this.#closed = true;
            this.#wake();
        });
    }

    async until(marker: string): Promise<Buffer> {
        const needle = Buffer.from(marker);
        for (;;) {
            const index = this.#buffer.indexOf(needle);
            if (index >= 0) return this.#take(index + needle.byteLength);
            await this.#wait();
        }
    }

    async untilClose(): Promise<Buffer> {
        while (!this.#closed) await this.#wait();
        return this.#buffer;
    }

    async length(length: number): Promise<Buffer> {
        while (this.#buffer.length < length && !this.#closed) await this.#wait();
        if (this.#buffer.length < length) {
            throw new Error(`Proxy closed before ${String(length)} bytes arrived.`);
        }
        return this.#take(length);
    }

    #take(length: number): Buffer {
        const result = this.#buffer.subarray(0, length);
        this.#buffer = this.#buffer.subarray(length);
        return result;
    }

    async #wait(): Promise<void> {
        if (this.#closed) return;
        await new Promise<void>((resolve) => {
            const waiter = (): void => {
                this.#waiters.delete(waiter);
                clearTimeout(timer);
                resolve();
            };
            const timer = setTimeout(waiter, 15_000);
            timer.unref?.();
            this.#waiters.add(waiter);
        });
        if (this.#closed && this.#buffer.length === 0) return;
    }

    #wake(): void {
        for (const waiter of this.#waiters) waiter();
    }
}

async function readUntil(socket: Duplex, marker: string): Promise<Buffer> {
    const reader = new BufferReader(socket);
    return await reader.until(marker);
}

async function readBytes(socket: Duplex, length: number): Promise<Buffer> {
    const reader = new BufferReader(socket);
    if (length === 0) return Buffer.alloc(0);
    return await reader.length(length);
}
