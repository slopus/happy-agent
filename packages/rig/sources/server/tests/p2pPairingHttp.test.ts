import type { Server } from "node:http";
import { rm } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";

import { ProtocolHttpClient } from "../../client/ProtocolHttpClient.js";
import type { P2pPairingServiceContract } from "../../p2p/P2pPairingService.js";
import type { P2pPairingState } from "../../protocol/index.js";
import { createTestSocketDirectory } from "../../testing/createTestSocketDirectory.js";
import { createProtocolHttpServer } from "../createProtocolHttpServer.js";

const pairingId = "apairinginstance000000001";
const state: P2pPairingState = {
    emojis: ["💍", "☔️", "📅", "🍞"],
    expiresAt: Date.now() + 60_000,
    id: pairingId,
    peer: {
        instanceId: "aremoteinstance0000000001",
        name: "Build Mac 🛠️",
        publicKey: "B".repeat(43),
    },
    phase: "verifying",
    role: "joiner",
};

describe("P2P pairing HTTP API", () => {
    it("exposes the complete authenticated invitation and verification flow", async () => {
        const answer = vi.fn(() => state);
        const join = vi.fn(async () => ({ id: pairingId }));
        const service: P2pPairingServiceContract = {
            answer,
            createInvitation: async () => ({
                id: pairingId,
                invitation: "rig://join/payload",
            }),
            get: () => state,
            join,
        };
        const started = await startServer(service);
        const client = new ProtocolHttpClient({
            socketPath: started.socketPath,
            token: "test-token",
        });
        try {
            await expect(client.createP2pInvitation()).resolves.toEqual({
                id: pairingId,
                invitation: "rig://join/payload",
            });
            await client.joinP2pInvitation("rig://join/payload");
            await expect(client.getP2pPairing(pairingId)).resolves.toEqual(state);
            await client.answerP2pVerification(pairingId, true);
            expect(join).toHaveBeenCalledWith("rig://join/payload");
            expect(answer).toHaveBeenCalledWith(pairingId, true);
        } finally {
            await started.close();
        }
    });
});

async function startServer(p2pPairing: P2pPairingServiceContract): Promise<{
    close: () => Promise<void>;
    socketPath: string;
}> {
    const directory = await createTestSocketDirectory();
    const socketPath = `${directory}/server.sock`;
    const server = createProtocolHttpServer({ p2pPairing, token: "test-token" });
    await listen(server, socketPath);
    return {
        close: async () => {
            await close(server);
            await rm(directory, { force: true, recursive: true });
        },
        socketPath,
    };
}

function listen(server: Server, socketPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => {
            server.off("error", reject);
            resolve();
        });
    });
}

function close(server: Server): Promise<void> {
    return new Promise((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
}
