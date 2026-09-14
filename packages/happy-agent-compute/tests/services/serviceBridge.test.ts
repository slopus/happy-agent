import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, Socket, type Server } from "node:net";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { connectServiceBridge } from "../../sources/services/connectServiceBridge.js";
import { ServiceEndpointUnavailableError } from "../../sources/services/ServiceRuntimeErrors.js";

const sockets = new Set<Socket>();
const servers = new Set<Server>();
const directories = new Set<string>();
afterEach(async () => {
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    await Promise.all(
        [...servers].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
    servers.clear();
    await Promise.all(
        [...directories].map((directory) => rm(directory, { recursive: true, force: true })),
    );
    directories.clear();
});

async function listener(connected: (socket: Socket) => void): Promise<string> {
    await mkdir(join(process.cwd(), ".context"), { recursive: true });
    const directory = await mkdtemp(join(process.cwd(), ".context", "service-bridge-"));
    directories.add(directory);
    // Keep the socket inside the workspace while avoiding the Unix path-length limit.
    const path = relative(process.cwd(), join(directory, "socket"));
    const server = createServer((socket) => {
        sockets.add(socket);
        socket.on("error", () => undefined);
        socket.once("close", () => sockets.delete(socket));
        connected(socket);
    });
    servers.add(server);
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(path, () => {
            server.removeListener("error", reject);
            resolve();
        });
    });
    return path;
}

describe.runIf(process.platform !== "win32")("private service bridge", () => {
    it("authenticates once and preserves application bytes arriving with the acknowledgement", async () => {
        const token = "a".repeat(64);
        let presented = "";
        const path = await listener((socket) => {
            const authenticate = (data: Buffer) => {
                presented += data.toString("ascii");
                if (presented.length < 64) return;
                socket.removeListener("data", authenticate);
                socket.end(Buffer.concat([Buffer.from([1]), Buffer.from("application-data")]));
            };
            socket.on("data", authenticate);
        });
        const connections = new Set<Socket>();
        const socket = await connectServiceBridge(path, token, connections);
        sockets.add(socket);
        const received = await new Promise<string>((resolve, reject) => {
            let output = "";
            socket.on("data", (data: Buffer) => {
                output += data.toString("utf8");
            });
            socket.once("error", reject);
            socket.once("end", () => resolve(output));
            socket.resume();
        });
        expect(presented).toBe(token);
        expect(received).toBe("application-data");
    });
    it("treats a native endpoint refusal as unavailable without returning credentials", async () => {
        const path = await listener((socket) =>
            socket.once("data", () => socket.end(Buffer.from([0]))),
        );
        await expect(connectServiceBridge(path, "b".repeat(64), new Set())).rejects.toEqual(
            new ServiceEndpointUnavailableError(),
        );
    });
    it("rejects a revoked pending connection promptly", async () => {
        let received!: () => void;
        const authenticated = new Promise<void>((resolve) => {
            received = resolve;
        });
        const path = await listener((socket) => socket.once("data", received));
        const connections = new Set<Socket>();
        const connecting = connectServiceBridge(path, "c".repeat(64), connections);
        const rejected = expect(connecting).rejects.toBeInstanceOf(ServiceEndpointUnavailableError);
        await authenticated;
        for (const socket of connections) socket.destroy();
        await rejected;
    });
    it("caps connections before opening another socket", () => {
        const connections = new Set(Array.from({ length: 64 }, () => new Socket()));
        try {
            expect(() => connectServiceBridge("unused", "d".repeat(64), connections)).toThrow(
                /maximum number/u,
            );
        } finally {
            for (const socket of connections) socket.destroy();
        }
    });
});
