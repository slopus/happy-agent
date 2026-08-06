import { createServer } from "node:http";
import { connect } from "node:net";
import { rm } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { createTestSocketDirectory } from "../testing/createTestSocketDirectory.js";
import { attachP2pSshBridge } from "./attachP2pSshBridge.js";

describe("SSH P2P bridge CONNECT route", () => {
    it("requires the daemon token before handing the duplex to P2P", async () => {
        const directory = await createTestSocketDirectory();
        const socketPath = `${directory}/bridge.sock`;
        const server = createServer();
        let accepted = false;
        attachP2pSshBridge(server, "secret", async (stream) => {
            accepted = true;
            stream.end();
        });
        await listen(server, socketPath);
        try {
            expect(await connectResponse(socketPath, "wrong")).toContain("401 Unauthorized");
            expect(accepted).toBe(false);
            expect(await connectResponse(socketPath, "secret")).toContain(
                "200 Connection Established",
            );
            expect(accepted).toBe(true);
        } finally {
            await close(server);
            await rm(directory, { force: true, recursive: true });
        }
    });

    it("refuses the bridge when SSH API sharing is disabled", async () => {
        const directory = await createTestSocketDirectory();
        const socketPath = `${directory}/bridge.sock`;
        const server = createServer();
        attachP2pSshBridge(server, "secret", undefined);
        await listen(server, socketPath);
        try {
            expect(await connectResponse(socketPath, "secret")).toContain("403 Forbidden");
        } finally {
            await close(server);
            await rm(directory, { force: true, recursive: true });
        }
    });
});

function connectResponse(socketPath: string, token: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const socket = connect(socketPath);
        let response = "";
        socket.setEncoding("utf8");
        socket.once("connect", () => {
            socket.write(
                `CONNECT /p2p/transports/ssh HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${token}\r\n\r\n`,
            );
        });
        socket.on("data", (chunk: string) => {
            response += chunk;
            if (response.includes("\r\n\r\n")) {
                socket.destroy();
                resolve(response);
            }
        });
        socket.once("error", reject);
    });
}

function listen(server: ReturnType<typeof createServer>, socketPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolve);
    });
}

function close(server: ReturnType<typeof createServer>): Promise<void> {
    return new Promise((resolve, reject) => {
        server.close((error) => {
            if (error === undefined) resolve();
            else reject(error);
        });
    });
}
