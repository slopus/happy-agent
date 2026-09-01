import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { connect, type Socket } from "node:net";
import { dirname } from "node:path";

import type {
    HappyAgentConfiguration,
    PreparedHappyAgentRuntime,
} from "@slopus/happy-agent-modules";

export interface AgentDaemonPaths {
    readonly agentHome: string;
    readonly socketPath: string;
    readonly tokenPath: string;
}

export interface BoundAgentSocket {
    readonly socketPath: string;
    close(): Promise<void>;
}

export interface BoundAgentHttpServer {
    readonly host: string;
    readonly port: number;
    readonly url: string;
    close(): Promise<void>;
}

export function resolveAgentDaemonPaths(configuration: HappyAgentConfiguration): AgentDaemonPaths {
    return {
        agentHome: configuration.paths.agentHome,
        socketPath: configuration.paths.socketPath,
        tokenPath: configuration.paths.tokenPath,
    };
}

export async function bindAgentSocket(
    prepared: PreparedHappyAgentRuntime,
): Promise<BoundAgentSocket> {
    const paths = resolveAgentDaemonPaths(prepared.configuration);
    if ("bun" in process.versions) {
        const { bindBunAgentSocket } = await import("./bindBunAgentSocket.js");
        return await bindBunAgentSocket(prepared, paths);
    }
    return await bindNodeAgentSocket(prepared, paths.socketPath);
}

export async function bindNodeAgentSocket(
    prepared: PreparedHappyAgentRuntime,
    socketPath: string,
    options: { readonly maxRequestsPerSocket?: number } = {},
): Promise<BoundAgentSocket> {
    await prepareAgentSocketPath(socketPath);
    const { connections, server } = createAgentHttpServer(prepared);
    if (options.maxRequestsPerSocket !== undefined) {
        server.maxRequestsPerSocket = options.maxRequestsPerSocket;
    }

    const previousUmask = process.umask(0o077);
    try {
        await listenOnSocket(server, socketPath);
        await chmod(socketPath, 0o600);
    } catch (error) {
        await closeServer(server, connections, socketPath).catch(() => undefined);
        throw error;
    } finally {
        process.umask(previousUmask);
    }

    let closing: Promise<void> | undefined;
    return {
        socketPath,
        close: () => {
            closing ??= closeServer(server, connections, socketPath);
            return closing;
        },
    };
}

/** Bind the team API to an authenticated TCP HTTP listener. */
export async function bindAgentHttpServer(
    prepared: PreparedHappyAgentRuntime,
    host: string,
    port: number,
): Promise<BoundAgentHttpServer> {
    const { connections, server } = createAgentHttpServer(prepared);
    try {
        await listenOnTcp(server, host, port);
    } catch (error) {
        await closeHttpServer(server, connections).catch(() => undefined);
        throw error;
    }
    const address = server.address();
    if (address === null || typeof address === "string") {
        await closeHttpServer(server, connections);
        throw new Error("The Happy Agent team HTTP listener has no TCP address.");
    }
    const boundHost = address.address;
    const boundPort = address.port;
    let closing: Promise<void> | undefined;
    return {
        host: boundHost,
        port: boundPort,
        url: `http://${urlHost(boundHost)}:${String(boundPort)}`,
        close: () => {
            closing ??= closeHttpServer(server, connections);
            return closing;
        },
    };
}

function createAgentHttpServer(prepared: PreparedHappyAgentRuntime): {
    readonly connections: Set<Socket>;
    readonly server: Server;
} {
    const connections = new Set<Socket>();
    const server = createServer((request, response) => {
        void prepared.api
            .handleRequest(prepared.context("http-request"), request, response)
            .catch((error: unknown) => {
                sendUnexpectedError(response, error);
            });
    });
    server.headersTimeout = 10_000;
    server.keepAliveTimeout = 5_000;
    server.requestTimeout = 30_000;
    server.on("connection", (socket) => {
        connections.add(socket);
        socket.once("close", () => connections.delete(socket));
    });
    server.on("upgrade", (request, socket, head) => {
        void prepared.api
            .handleUpgrade(prepared.context("websocket-upgrade"), request, socket as Socket, head)
            .then((handled) => {
                if (!handled) socket.destroy();
            })
            .catch(() => socket.destroy());
    });
    server.on("connect", (request, socket, head) => {
        void prepared.api
            .handleConnect(prepared.context("http-connect"), request, socket as Socket, head)
            .then((handled) => {
                if (!handled) socket.destroy();
            })
            .catch(() => socket.destroy());
    });
    return { connections, server };
}

export async function prepareAgentSocketPath(socketPath: string): Promise<void> {
    if (Buffer.byteLength(socketPath) > 103) {
        throw new Error("The Happy agent socket path is too long for a Unix socket.");
    }
    await mkdir(dirname(socketPath), { mode: 0o700, recursive: true });
    let information;
    try {
        information = await lstat(socketPath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
    }
    if (!information.isSocket()) {
        throw new Error(`Refusing to replace a non-socket path: ${socketPath}`);
    }
    if (
        process.getuid !== undefined &&
        typeof information.uid === "number" &&
        information.uid !== process.getuid()
    ) {
        throw new Error(`Refusing to replace a socket owned by another user: ${socketPath}`);
    }
    if (await socketIsActive(socketPath)) {
        throw new Error(`Another Happy agent is already listening on ${socketPath}.`);
    }
    await unlink(socketPath);
}

/** Remove an inactive socket left by an interrupted daemon without preparing a new listener. */
export async function removeInactiveAgentSocket(socketPath: string): Promise<void> {
    let information;
    try {
        information = await lstat(socketPath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
    }
    if (!information.isSocket()) return;
    if (
        process.getuid !== undefined &&
        typeof information.uid === "number" &&
        information.uid !== process.getuid()
    ) {
        throw new Error(`Refusing to remove a socket owned by another user: ${socketPath}`);
    }
    if (await socketIsActive(socketPath)) {
        throw new Error(`Another Happy agent is already listening on ${socketPath}.`);
    }
    await unlink(socketPath);
}

async function socketIsActive(socketPath: string): Promise<boolean> {
    return await new Promise<boolean>((resolve, reject) => {
        const socket = connect(socketPath);
        socket.once("connect", () => {
            socket.destroy();
            resolve(true);
        });
        socket.once("error", (error: NodeJS.ErrnoException) => {
            socket.destroy();
            if (error.code === "ECONNREFUSED" || error.code === "ENOENT") {
                resolve(false);
                return;
            }
            reject(error);
        });
    });
}

async function listenOnSocket(server: Server, socketPath: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const failed = (error: Error): void => {
            server.off("listening", listening);
            reject(error);
        };
        const listening = (): void => {
            server.off("error", failed);
            resolve();
        };
        server.once("error", failed);
        server.once("listening", listening);
        server.listen(socketPath);
    });
}

async function listenOnTcp(server: Server, host: string, port: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const failed = (error: Error): void => {
            server.off("listening", listening);
            reject(error);
        };
        const listening = (): void => {
            server.off("error", failed);
            resolve();
        };
        server.once("error", failed);
        server.once("listening", listening);
        server.listen({ host, port });
    });
}

async function closeServer(
    server: Server,
    connections: Set<Socket>,
    socketPath: string,
): Promise<void> {
    for (const connection of connections) connection.destroy();
    await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
    }).catch((error: unknown) => {
        if (!(error instanceof Error) || !/not running/i.test(error.message)) throw error;
    });
    try {
        const information = await lstat(socketPath);
        if (
            information.isSocket() &&
            (process.getuid === undefined ||
                typeof information.uid !== "number" ||
                information.uid === process.getuid())
        ) {
            await unlink(socketPath);
        }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
}

async function closeHttpServer(server: Server, connections: Set<Socket>): Promise<void> {
    for (const connection of connections) connection.destroy();
    await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
    }).catch((error: unknown) => {
        if (!(error instanceof Error) || !/not running/i.test(error.message)) throw error;
    });
}

function urlHost(host: string): string {
    return host.includes(":") ? `[${host}]` : host;
}

function sendUnexpectedError(response: ServerResponse, error: unknown): void {
    if (response.headersSent || response.writableEnded) {
        response.destroy(error instanceof Error ? error : undefined);
        return;
    }
    response.statusCode = 500;
    response.setHeader("cache-control", "no-store");
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(JSON.stringify({ error: "An unexpected error occurred.", code: "internal" }));
}
