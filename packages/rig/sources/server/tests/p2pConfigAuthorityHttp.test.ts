import { request, type Server } from "node:http";
import { rm } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";

import { createTestRootContext } from "../../testing/createTestRootContext.js";

import { InMemorySessionStore } from "../../session/InMemorySessionStore.js";
import { createTestSocketDirectory } from "../../testing/createTestSocketDirectory.js";
import { createProtocolHttpServer } from "../createProtocolHttpServer.js";

describe("P2P primary configuration authority", () => {
    it("allows local callers and the configured primary, but rejects every other peer", async () => {
        const store = await InMemorySessionStore.open(createTestRootContext());
        const rename = vi.fn(async (_name: string) => undefined);
        const primaryId = "aprimaryinstance000000001";
        const started = await startServer(
            await createProtocolHttpServer(createTestRootContext(), {
                canP2pPeerConfigure: (peerId) => peerId === primaryId,
                onDaemonConfigChange: async (_ctx, config) => {
                    await rename(config.p2p.name);
                    return {
                        globalEventQueue: store.globalEventQueue,
                        inferenceMaxRetries: config.settings.inferenceMaxRetries,
                        inferenceFatalRetries: config.settings.inferenceFatalRetries,
                    };
                },
                p2pNode: () => ({
                    name: "Secondary",
                    primaryId,
                    role: "secondary",
                }),
                store,
                token: "secret",
            }),
        );
        try {
            expect(await patch(started.socketPath, "anotherpeerinstance00001")).toBe(403);
            expect(
                await send(started.socketPath, "GET", "/config/instructions", undefined, "other"),
            ).toBe(403);
            expect(
                await send(
                    started.socketPath,
                    "PUT",
                    "/config/security",
                    JSON.stringify({ policy: "unsafe" }),
                    "other",
                ),
            ).toBe(403);
            expect(await patch(started.socketPath, primaryId)).toBe(200);
            expect(await patch(started.socketPath)).toBe(200);
            expect(rename).toHaveBeenCalledTimes(2);
        } finally {
            await started.close();
        }
    });
});

async function patch(socketPath: string, peerId?: string): Promise<number> {
    const body = JSON.stringify({
        p2p: { name: "Renamed 🛠️" },
        settings: {
            durableGlobalEventQueue: false,
            inferenceMaxRetries: 10,
            inferenceFatalRetries: 0,
        },
    });
    return send(socketPath, "PATCH", "/config", body, peerId);
}

async function send(
    socketPath: string,
    method: string,
    path: string,
    body?: string,
    peerId?: string,
): Promise<number> {
    return new Promise((resolve, reject) => {
        const outgoing = request(
            {
                headers: {
                    authorization: "Bearer secret",
                    ...(body === undefined
                        ? {}
                        : {
                              "content-length": Buffer.byteLength(body),
                              "content-type": "application/json",
                          }),
                    ...(peerId === undefined ? {} : { "x-rig-p2p-peer": peerId }),
                },
                method,
                path,
                socketPath,
            },
            (response) => {
                response.resume();
                response.once("end", () => resolve(response.statusCode ?? 0));
            },
        );
        outgoing.once("error", reject);
        outgoing.end(body);
    });
}

async function startServer(server: Server): Promise<{
    close: () => Promise<void>;
    socketPath: string;
}> {
    const directory = await createTestSocketDirectory();
    const socketPath = `${directory}/server.sock`;
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => {
            server.off("error", reject);
            resolve();
        });
    });
    return {
        close: async () => {
            await new Promise<void>((resolve, reject) =>
                server.close((error) => (error === undefined ? resolve() : reject(error))),
            );
            await rm(directory, { force: true, recursive: true });
        },
        socketPath,
    };
}
