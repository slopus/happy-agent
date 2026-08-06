import { createHash } from "node:crypto";
import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import type { P2pSshPeer, P2pTrustedPeer } from "./P2pPeer.js";
import { createNodeFrameDuplex } from "./NodeFrameDuplex.js";
import { readBytes, writeBytes, type P2pFrameDuplex } from "./P2pFrameDuplex.js";
import { readP2pHttpRequest, writeP2pHttpResponse } from "./P2pFrameProtocol.js";
import { runP2pResponderHello } from "./P2pHelloProtocol.js";
import { createP2pInstanceIdentity, type P2pInstanceIdentity } from "./P2pIdentity.js";
import { readP2pTunnelRequest, writeP2pTunnelResponse } from "./P2pTunnelProtocol.js";
import {
    encodeSshBridgePreface,
    readSshBridgePreface,
    sshChannelBinding,
    SshTransport,
    SSH_BRIDGE_PREFACE_BYTES,
    SSH_OPERATION_PING,
    SSH_OPERATION_TUNNEL,
    type SshBridgeChannel,
} from "./SshTransport.js";

const HOST_KEY_HASH = new Uint8Array(createHash("sha256").update("host key").digest());
const sshSettings: P2pSshPeer = {
    auth: "agent",
    host: "rig.example.com",
    hostKeySha256: `SHA256:${Buffer.from(HOST_KEY_HASH).toString("base64")}`,
    port: 22,
    remoteRig: "/usr/local/bin/rig",
    username: "steve",
};

describe("SSH P2P transport", () => {
    it("lists every configured peer while idle so a caller can still choose SSH", () => {
        const remote = createP2pInstanceIdentity();
        const transport = SshTransport.create({
            identity: createP2pInstanceIdentity(),
            openChannel: () => Promise.reject(new Error("The bridge was never opened.")),
            peers: [peerConfig(remote)],
        });

        expect(transport.status()).toEqual({
            direction: "outbound",
            peers: [
                {
                    address: "steve@rig.example.com:22",
                    name: "Peer",
                    peerId: remote.instanceId,
                    publicKey: remote.publicKey,
                    status: "connecting",
                },
            ],
            state: "ready",
            transport: "ssh",
        });
    });

    it("binds the verified host key into the hello and forwards an HTTP request", async () => {
        const remote = createP2pInstanceIdentity();
        let seenBinding: string | undefined;
        const transport = SshTransport.create({
            identity: createP2pInstanceIdentity(),
            openChannel: () =>
                Promise.resolve(
                    fakeBridge(HOST_KEY_HASH, async (duplex, binding) => {
                        seenBinding = binding;
                        await serveBridge(duplex, remote, binding);
                    }),
                ),
            peers: [peerConfig(remote)],
        });

        const response = await transport.fetch(
            remote.instanceId,
            { body: Buffer.alloc(0), headers: {}, method: "GET", path: "/status" },
            new AbortController().signal,
        );
        const chunks: string[] = [];
        for await (const chunk of response.body) chunks.push(Buffer.from(chunk).toString("utf8"));

        expect(response.status).toBe(200);
        expect(chunks.join("")).toBe("bridge answered /status");
        expect(seenBinding).toBe(sshChannelBinding(HOST_KEY_HASH));
        expect(transport.status().peers[0]).toMatchObject({
            peerId: remote.instanceId,
            status: "connected",
        });
        await transport.close();
    });

    it("answers a ping over a fresh bridge without leaving the channel open", async () => {
        const remote = createP2pInstanceIdentity();
        const closed: boolean[] = [];
        const transport = SshTransport.create({
            identity: createP2pInstanceIdentity(),
            openChannel: () => {
                const bridge = fakeBridge(HOST_KEY_HASH, (duplex, binding) =>
                    serveBridge(duplex, remote, binding),
                );
                const close = bridge.close;
                return Promise.resolve({
                    ...bridge,
                    close: () => {
                        closed.push(true);
                        close();
                    },
                });
            },
            peers: [peerConfig(remote)],
        });

        await transport.ping(remote.instanceId, new AbortController().signal);

        expect(closed).toEqual([true]);
        expect(transport.status().peers[0]).toMatchObject({ status: "connected" });
        await transport.close();
    });

    it("refuses a bridge whose signed identity is not the configured peer", async () => {
        const configured = createP2pInstanceIdentity();
        const impostor = createP2pInstanceIdentity();
        const transport = SshTransport.create({
            identity: createP2pInstanceIdentity(),
            openChannel: () =>
                Promise.resolve(
                    fakeBridge(HOST_KEY_HASH, (duplex, binding) =>
                        serveBridge(duplex, impostor, binding),
                    ),
                ),
            peers: [peerConfig(configured)],
        });

        await expect(
            transport.fetch(
                configured.instanceId,
                { body: Buffer.alloc(0), headers: {}, method: "GET", path: "/status" },
                new AbortController().signal,
            ),
        ).rejects.toThrow("does not match its allowlist");
        expect(transport.status().peers[0]).toMatchObject({ status: "unreachable" });
        await transport.close();
    });

    it("reports the remote command's bounded stderr when the bridge fails", async () => {
        const remote = createP2pInstanceIdentity();
        const transport = SshTransport.create({
            identity: createP2pInstanceIdentity(),
            openChannel: () => {
                const bridge = fakeBridge(HOST_KEY_HASH, async (_duplex, _binding) => undefined);
                return Promise.resolve({
                    ...bridge,
                    diagnostics: () => "rig: p2p bridge is disabled",
                });
            },
            peers: [peerConfig(remote)],
            validatePeer: () => Promise.resolve(),
        });

        await expect(
            transport.ping(remote.instanceId, new AbortController().signal),
        ).rejects.toThrow();
        expect(transport.status().peers[0]?.error).toContain("rig: p2p bridge is disabled");
        await transport.close();
    });

    it("refuses to open a bridge once the caller has cancelled", async () => {
        const remote = createP2pInstanceIdentity();
        const transport = SshTransport.create({
            identity: createP2pInstanceIdentity(),
            openChannel: () => Promise.reject(new Error("The bridge should not be opened.")),
            peers: [peerConfig(remote)],
        });
        const controller = new AbortController();
        controller.abort();

        await expect(
            transport.fetch(
                remote.instanceId,
                { body: Buffer.alloc(0), headers: {}, method: "GET", path: "/status" },
                controller.signal,
            ),
        ).rejects.toThrow();
        await transport.close();
    });

    it("keeps cancellation attached after the signed hello", async () => {
        const remote = createP2pInstanceIdentity();
        const controller = new AbortController();
        let closed = false;
        let helloFinished!: () => void;
        const hello = new Promise<void>((resolve) => {
            helloFinished = resolve;
        });
        const transport = SshTransport.create({
            identity: createP2pInstanceIdentity(),
            openChannel: () => {
                const bridge = fakeBridge(HOST_KEY_HASH, async (duplex, binding) => {
                    const hostKeyHash = await readSshBridgePreface(duplex.recv);
                    expect(sshChannelBinding(hostKeyHash)).toBe(binding);
                    await runP2pResponderHello(duplex, {
                        identity: remote,
                        localChannelBinding: binding,
                        remoteChannelBinding: binding,
                        transport: "ssh",
                    });
                    helloFinished();
                    await readBytes(duplex.recv, 1);
                    await new Promise(() => undefined);
                });
                return Promise.resolve({
                    ...bridge,
                    close: () => {
                        closed = true;
                        bridge.close();
                    },
                });
            },
            peers: [peerConfig(remote)],
        });
        const request = transport.fetch(
            remote.instanceId,
            { body: Buffer.alloc(0), headers: {}, method: "GET", path: "/slow" },
            controller.signal,
        );
        await hello;

        controller.abort();

        await expect(request).rejects.toThrow();
        expect(closed).toBe(true);
        await transport.close();
    });

    it("keeps cancellation attached for an open tunnel", async () => {
        const remote = createP2pInstanceIdentity();
        const controller = new AbortController();
        let closed = false;
        let opened!: () => void;
        const tunnelOpened = new Promise<void>((resolve) => {
            opened = resolve;
        });
        const transport = SshTransport.create({
            identity: createP2pInstanceIdentity(),
            openChannel: () => {
                const bridge = fakeBridge(HOST_KEY_HASH, async (duplex, binding) => {
                    await readSshBridgePreface(duplex.recv);
                    await runP2pResponderHello(duplex, {
                        identity: remote,
                        localChannelBinding: binding,
                        remoteChannelBinding: binding,
                        transport: "ssh",
                    });
                    expect((await readBytes(duplex.recv, 1))[0]).toBe(SSH_OPERATION_TUNNEL);
                    await readP2pTunnelRequest(duplex.recv);
                    await writeP2pTunnelResponse(duplex.send, {
                        headers: {},
                        status: 101,
                    });
                    opened();
                    await new Promise(() => undefined);
                });
                return Promise.resolve({
                    ...bridge,
                    close: () => {
                        closed = true;
                        bridge.close();
                    },
                });
            },
            peers: [peerConfig(remote)],
        });

        const connection = await transport.openTunnel(
            remote.instanceId,
            { headers: {}, method: "GET", path: "/terminal" },
            controller.signal,
        );
        await tunnelOpened;
        connection.stream.on("error", () => undefined);
        controller.abort();

        expect(connection.stream.destroyed).toBe(true);
        expect(closed).toBe(true);
        await transport.close();
    });

    it("reserves capacity before asynchronous SSH connections finish", async () => {
        const remote = createP2pInstanceIdentity();
        const controllers = Array.from({ length: 17 }, () => new AbortController());
        const transport = SshTransport.create({
            identity: createP2pInstanceIdentity(),
            openChannel: (_peer, signal) =>
                new Promise((_resolve, reject) => {
                    signal.addEventListener(
                        "abort",
                        () => reject(new Error("cancelled pending SSH connection")),
                        { once: true },
                    );
                }),
            peers: [peerConfig(remote)],
        });
        const requests = controllers.map((controller) =>
            transport.fetch(
                remote.instanceId,
                { body: Buffer.alloc(0), headers: {}, method: "GET", path: "/slow" },
                controller.signal,
            ),
        );

        await expect(requests[16]).rejects.toThrow("Too many SSH P2P bridges");
        for (const controller of controllers) controller.abort();
        await Promise.allSettled(requests);
        await transport.close();
    });

    it("aborts the underlying SSH open when its deadline expires", async () => {
        const remote = createP2pInstanceIdentity();
        let aborted = false;
        const transport = SshTransport.create({
            connectTimeoutMs: 10,
            identity: createP2pInstanceIdentity(),
            openChannel: (_peer, signal) =>
                new Promise((_resolve, reject) => {
                    signal.addEventListener(
                        "abort",
                        () => {
                            aborted = true;
                            reject(new Error("underlying SSH open aborted"));
                        },
                        { once: true },
                    );
                }),
            peers: [peerConfig(remote)],
        });

        await expect(
            transport.fetch(
                remote.instanceId,
                { body: Buffer.alloc(0), headers: {}, method: "GET", path: "/slow" },
                new AbortController().signal,
            ),
        ).rejects.toThrow("did not start in time");
        expect(aborted).toBe(true);
        await transport.close();
    });
});

describe("SSH bridge preface", () => {
    it("round-trips the verified host-key hash the responder reads", async () => {
        const preface = encodeSshBridgePreface(HOST_KEY_HASH);
        expect(preface.byteLength).toBe(SSH_BRIDGE_PREFACE_BYTES);

        expect(await readSshBridgePreface(bytes(preface))).toEqual(HOST_KEY_HASH);
    });

    it("rejects an unsupported version", async () => {
        const preface = encodeSshBridgePreface(HOST_KEY_HASH);
        preface[0] = 9;

        await expect(readSshBridgePreface(bytes(preface))).rejects.toThrow("unsupported version");
    });

    it("rejects a preface that ends before its host-key hash", async () => {
        await expect(readSshBridgePreface(bytes(Uint8Array.of(1, 2, 3)))).rejects.toThrow(
            "ended before its frame was complete",
        );
    });
});

function bytes(values: Uint8Array) {
    const pipe = new PassThrough();
    pipe.end(values);
    return createNodeFrameDuplex(pipe, new PassThrough()).recv;
}

function peerConfig(identity: P2pInstanceIdentity): P2pTrustedPeer {
    return {
        bindings: [],
        connections: { ssh: sshSettings },
        name: "Peer",
        instanceId: identity.instanceId,
        publicKey: identity.publicKey,
    };
}

/** Stands in for one authenticated `rig p2p bridge --stdio` exec. */
function fakeBridge(
    hostKeyHash: Uint8Array,
    serve: (duplex: P2pFrameDuplex, channelBinding: string) => Promise<void>,
): SshBridgeChannel {
    const toBridge = new PassThrough();
    const fromBridge = new PassThrough();
    // The remote command exits once it has served, which closes its stdout.
    void serve(createNodeFrameDuplex(toBridge, fromBridge), sshChannelBinding(hostKeyHash))
        .catch(() => undefined)
        .finally(() => fromBridge.end());
    return {
        close: () => {
            toBridge.destroy();
            fromBridge.destroy();
        },
        diagnostics: () => "",
        duplex: createNodeFrameDuplex(fromBridge, toBridge),
        hostKeyHash,
    };
}

/** The responder half the real bridge command has to implement. */
async function serveBridge(
    duplex: P2pFrameDuplex,
    identity: P2pInstanceIdentity,
    expectedBinding: string,
): Promise<void> {
    const channelBinding = sshChannelBinding(await readSshBridgePreface(duplex.recv));
    if (channelBinding !== expectedBinding) {
        throw new Error("The initiator sent a different host-key hash.");
    }
    await runP2pResponderHello(duplex, {
        identity,
        localChannelBinding: channelBinding,
        remoteChannelBinding: channelBinding,
        transport: "ssh",
    });
    const operation = (await readBytes(duplex.recv, 1))[0];
    if (operation === SSH_OPERATION_PING) {
        await writeBytes(duplex.send, Uint8Array.of(SSH_OPERATION_PING));
        return;
    }
    const request = await readP2pHttpRequest(duplex.recv);
    await writeP2pHttpResponse(duplex.send, {
        body: (async function* () {
            yield Buffer.from(`bridge answered ${request.path}`);
        })(),
        headers: { "content-type": "text/plain" },
        status: 200,
    });
}
