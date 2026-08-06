import { createHash } from "node:crypto";
import { Duplex, PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import type { P2pSshPeer, P2pTrustedPeer } from "./P2pPeer.js";
import { createNodeFrameDuplex } from "./NodeFrameDuplex.js";
import { createP2pInstanceIdentity } from "./P2pIdentity.js";
import type { P2pTunnelRequestHead } from "./P2pTunnel.js";
import { SshBridgeResponder } from "./SshBridgeResponder.js";
import { SshTransport, type SshBridgeChannel } from "./SshTransport.js";

const hostKeyHash = new Uint8Array(createHash("sha256").update("ssh host").digest());
const ssh: P2pSshPeer = {
    agentSocketPath: "/unused",
    auth: "agent",
    host: "example.test",
    hostKeySha256: `SHA256:${Buffer.from(hostKeyHash).toString("base64")}`,
    port: 22,
    remoteRig: "rig",
    username: "steve",
};

describe("SSH bridge responder", () => {
    it("mutually authenticates allowlisted identities and serves framed HTTP", async () => {
        const initiatorIdentity = createP2pInstanceIdentity();
        const responderIdentity = createP2pInstanceIdentity();
        const initiatorPeer = peer(initiatorIdentity);
        const responderPeer = peer(responderIdentity);
        const committed = vi.fn(async () => undefined);
        const responder = new SshBridgeResponder({
            commitPeer: committed,
            identity: responderIdentity,
            peers: [initiatorPeer],
            serveRequest: async (peerId, request) => ({
                body: (async function* () {
                    yield Buffer.from(`${peerId}:${request.path}`);
                })(),
                headers: { "content-type": "text/plain" },
                status: 200,
            }),
        });
        const transport = SshTransport.create({
            identity: initiatorIdentity,
            openChannel: () => Promise.resolve(bridgeChannel(responder)),
            peers: [responderPeer],
        });

        const response = await transport.fetch(
            responderIdentity.instanceId,
            { body: Buffer.alloc(0), headers: {}, method: "GET", path: "/health" },
            new AbortController().signal,
        );
        const chunks: Buffer[] = [];
        for await (const chunk of response.body) chunks.push(Buffer.from(chunk));

        expect(response.status).toBe(200);
        expect(Buffer.concat(chunks).toString()).toBe(`${initiatorIdentity.instanceId}:/health`);
        expect(committed).toHaveBeenCalledWith(
            expect.objectContaining({ instanceId: initiatorIdentity.instanceId }),
            initiatorIdentity.publicKey,
        );
        await transport.close();
        responder.close();
    });

    it("refuses an authenticated SSH user whose Rig identity is not allowlisted", async () => {
        const initiatorIdentity = createP2pInstanceIdentity();
        const responderIdentity = createP2pInstanceIdentity();
        const responder = new SshBridgeResponder({
            identity: responderIdentity,
            peers: [],
            serveRequest: vi.fn(),
        });
        const transport = SshTransport.create({
            identity: initiatorIdentity,
            openChannel: () => Promise.resolve(bridgeChannel(responder)),
            peers: [peer(responderIdentity)],
        });

        await expect(
            transport.ping(responderIdentity.instanceId, new AbortController().signal),
        ).rejects.toThrow();
        expect(transport.status().peers[0]).toMatchObject({ status: "unreachable" });
        await transport.close();
        responder.close();
    });

    it("serves a bidirectional tunnel over the authenticated SSH bridge", async () => {
        const initiatorIdentity = createP2pInstanceIdentity();
        const responderIdentity = createP2pInstanceIdentity();
        const daemonStream = new EchoDuplex();
        let seenRequest: P2pTunnelRequestHead | undefined;
        const responder = new SshBridgeResponder({
            identity: responderIdentity,
            peers: [peer(initiatorIdentity)],
            serveRequest: vi.fn(),
            serveTunnel: async (_peerId, request) => {
                seenRequest = request;
                return {
                    response: {
                        headers: { upgrade: "websocket" },
                        status: 101,
                    },
                    stream: daemonStream,
                };
            },
        });
        const transport = SshTransport.create({
            identity: initiatorIdentity,
            openChannel: () => Promise.resolve(bridgeChannel(responder)),
            peers: [peer(responderIdentity)],
        });
        const connection = await transport.openTunnel(
            responderIdentity.instanceId,
            {
                headers: {
                    "sec-websocket-key": "test-key",
                    "sec-websocket-version": "13",
                },
                method: "GET",
                path: "/projects/project/terminals/terminal/attach",
            },
            new AbortController().signal,
        );
        const chunks: Buffer[] = [];
        connection.stream.end(Buffer.from("terminal bytes"));
        for await (const chunk of connection.stream) chunks.push(Buffer.from(chunk));

        expect(connection.response).toEqual({
            headers: { upgrade: "websocket" },
            status: 101,
        });
        expect(Buffer.concat(chunks).toString()).toBe("terminal bytes");
        expect(seenRequest).toMatchObject({
            method: "GET",
            path: "/projects/project/terminals/terminal/attach",
        });
        await transport.close();
        responder.close();
    });

    it("cancels the serving request when the initiating tunnel closes", async () => {
        const initiatorIdentity = createP2pInstanceIdentity();
        const responderIdentity = createP2pInstanceIdentity();
        const controller = new AbortController();
        let servingAborted!: () => void;
        const aborted = new Promise<void>((resolve) => {
            servingAborted = resolve;
        });
        const responder = new SshBridgeResponder({
            identity: responderIdentity,
            peers: [peer(initiatorIdentity)],
            serveRequest: vi.fn(),
            serveTunnel: async (_peerId, _request, signal) => {
                signal.addEventListener("abort", servingAborted, { once: true });
                return {
                    response: { headers: {}, status: 101 },
                    stream: new EchoDuplex(),
                };
            },
        });
        const transport = SshTransport.create({
            identity: initiatorIdentity,
            openChannel: () => Promise.resolve(bridgeChannel(responder)),
            peers: [peer(responderIdentity)],
        });

        const connection = await transport.openTunnel(
            responderIdentity.instanceId,
            { headers: {}, method: "GET", path: "/terminal" },
            controller.signal,
        );
        connection.stream.on("error", () => undefined);
        controller.abort();

        await aborted;
        expect(connection.stream.destroyed).toBe(true);
        await transport.close();
        responder.close();
    });

    it("closes a refused tunnel without waiting for peer payload frames", async () => {
        const initiatorIdentity = createP2pInstanceIdentity();
        const responderIdentity = createP2pInstanceIdentity();
        const responder = new SshBridgeResponder({
            identity: responderIdentity,
            peers: [peer(initiatorIdentity)],
            serveRequest: vi.fn(),
            serveTunnel: async () => ({
                response: { headers: {}, status: 403 },
                stream: new EchoDuplex(),
            }),
        });
        const transport = SshTransport.create({
            identity: initiatorIdentity,
            openChannel: () => Promise.resolve(bridgeChannel(responder)),
            peers: [peer(responderIdentity)],
        });

        const connection = await transport.openTunnel(
            responderIdentity.instanceId,
            { headers: {}, method: "GET", path: "/forbidden" },
            new AbortController().signal,
        );
        connection.stream.on("error", () => undefined);
        const closed = new Promise<void>((resolve) => {
            connection.stream.once("close", resolve);
        });
        connection.stream.resume();

        await closed;
        expect(connection.response.status).toBe(403);
        await transport.close();
        responder.close();
    });
});

function peer(identity: ReturnType<typeof createP2pInstanceIdentity>): P2pTrustedPeer {
    return {
        bindings: [],
        connections: { ssh },
        name: "Peer",
        instanceId: identity.instanceId,
        publicKey: identity.publicKey,
    };
}

function bridgeChannel(responder: SshBridgeResponder): SshBridgeChannel {
    const toResponder = new PassThrough();
    const fromResponder = new PassThrough();
    const responderStream = Duplex.from({ readable: toResponder, writable: fromResponder });
    void responder
        .accept(responderStream)
        .catch((error: unknown) => fromResponder.destroy(error as Error))
        .finally(() => fromResponder.end());
    return {
        close: () => {
            responderStream.destroy();
            toResponder.destroy();
            fromResponder.destroy();
        },
        diagnostics: () => "",
        duplex: createNodeFrameDuplex(fromResponder, toResponder),
        hostKeyHash,
    };
}

class EchoDuplex extends Duplex {
    override _read(): void {}

    override _write(
        chunk: Buffer,
        _encoding: BufferEncoding,
        callback: (error?: Error | null) => void,
    ): void {
        this.push(chunk);
        callback();
    }

    override _final(callback: (error?: Error | null) => void): void {
        this.push(null);
        callback();
    }
}
