import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Server, utils } from "ssh2";
import { describe, expect, it } from "vitest";

import type { P2pTrustedPeer } from "./P2pPeer.js";
import { createP2pInstanceIdentity } from "./P2pIdentity.js";
import { SshBridgeResponder } from "./SshBridgeResponder.js";
import { SshTransport } from "./SshTransport.js";

describe("SSH P2P transport with a real SSH connection", () => {
    it("pins the host key, authenticates both Rig identities, and forwards HTTP", async () => {
        const directory = await mkdtemp(join(tmpdir(), "rig-ssh-p2p-"));
        const hostKey = generatePrivateKey();
        const clientKey = generatePrivateKey();
        const clientKeyPath = join(directory, "client-key");
        await writeFile(clientKeyPath, clientKey, { mode: 0o600 });
        const initiatorIdentity = createP2pInstanceIdentity();
        const responderIdentity = createP2pInstanceIdentity();
        const responder = new SshBridgeResponder({
            identity: responderIdentity,
            peers: [
                {
                    bindings: [],
                    connections: { ssh: placeholderSsh() },
                    name: "Peer",
                    instanceId: initiatorIdentity.instanceId,
                    publicKey: initiatorIdentity.publicKey,
                },
            ],
            serveRequest: async (_peerId, request) => ({
                body: (async function* () {
                    yield Buffer.from(`ssh:${request.path}`);
                })(),
                headers: {},
                status: 200,
            }),
        });
        const server = new Server({ hostKeys: [hostKey] }, (client) => {
            client.on("authentication", (context) => {
                if (context.method === "publickey") context.accept();
                else context.reject();
            });
            client.on("ready", () => {
                client.on("session", (accept) => {
                    const session = accept();
                    session.on("exec", (acceptExec, reject, info) => {
                        if (!info.command.endsWith(" p2p bridge --stdio")) {
                            reject();
                            return;
                        }
                        const stream = acceptExec();
                        void responder.accept(stream).catch(() => stream.destroy());
                    });
                });
            });
        });
        await listen(server);
        const address = server.address();
        if (address === null || typeof address === "string") throw new Error("Missing SSH port.");
        const ssh = {
            auth: "private_key" as const,
            host: "127.0.0.1",
            hostKeySha256: hostFingerprint(hostKey),
            port: address.port,
            privateKeyPath: clientKeyPath,
            remoteRig: "rig",
            username: "test",
        };
        const peer: P2pTrustedPeer = {
            bindings: [],
            connections: { ssh },
            name: "Peer",
            instanceId: responderIdentity.instanceId,
            publicKey: responderIdentity.publicKey,
        };
        const transport = SshTransport.create({
            identity: initiatorIdentity,
            peers: [peer],
        });
        try {
            const response = await transport.fetch(
                responderIdentity.instanceId,
                { body: Buffer.alloc(0), headers: {}, method: "GET", path: "/health" },
                new AbortController().signal,
            );
            const chunks: Buffer[] = [];
            for await (const chunk of response.body) chunks.push(Buffer.from(chunk));
            expect(Buffer.concat(chunks).toString()).toBe("ssh:/health");
        } finally {
            await transport.close();
            responder.close();
            await close(server);
            await rm(directory, { force: true, recursive: true });
        }
    });
});

function generatePrivateKey(): string {
    return generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
        format: "pem",
        type: "pkcs1",
    }) as string;
}

function hostFingerprint(privateKey: string): string {
    const parsed = utils.parseKey(privateKey);
    if (parsed instanceof Error || Array.isArray(parsed))
        throw new Error("Could not parse SSH key.");
    return `SHA256:${createHash("sha256").update(parsed.getPublicSSH()).digest("base64").replace(/=+$/u, "")}`;
}

function placeholderSsh() {
    return {
        agentSocketPath: "/unused",
        auth: "agent" as const,
        host: "unused",
        hostKeySha256: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        port: 22,
        remoteRig: "rig",
        username: "unused",
    };
}

function listen(server: Server): Promise<void> {
    return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
}

function close(server: Server): Promise<void> {
    return new Promise((resolve, reject) =>
        server.close((error) => {
            if (error === undefined) resolve();
            else reject(error);
        }),
    );
}
