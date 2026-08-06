import { connect } from "node:net";

import { readTokenIfPresent } from "../client/index.js";
import { RigUserError } from "../RigUserError.js";
import { getEnvironmentLocalServerPaths } from "../server/index.js";

const MAXIMUM_RESPONSE_HEAD_BYTES = 8 * 1024;

/**
 * Bridges one SSH exec channel into the daemon-owned SSH P2P responder.
 *
 * Stdout is protocol bytes only. Diagnostics belong on stderr because even
 * one human-readable byte on stdout would corrupt the framed P2P session.
 */
export async function runP2pBridgeCommand(): Promise<void> {
    const paths = getEnvironmentLocalServerPaths();
    const token = await readTokenIfPresent(paths.tokenPath);
    if (token === undefined) {
        throw new RigUserError("The Rig daemon is not running on the remote machine.");
    }
    const socket = connect(paths.socketPath);
    await waitForConnection(socket);
    socket.write(
        [
            "CONNECT /p2p/transports/ssh HTTP/1.1",
            "Host: localhost",
            `Authorization: Bearer ${token}`,
            "Connection: keep-alive",
            "",
            "",
        ].join("\r\n"),
    );
    const remainder = await readSuccessfulConnectHead(socket);
    if (remainder.byteLength > 0) process.stdout.write(remainder);
    process.stdin.pipe(socket);
    socket.pipe(process.stdout);
    await new Promise<void>((resolve, reject) => {
        socket.once("close", resolve);
        socket.once("error", reject);
        process.stdin.once("error", reject);
        process.stdout.once("error", reject);
    });
}

function waitForConnection(socket: ReturnType<typeof connect>): Promise<void> {
    return new Promise((resolve, reject) => {
        const connected = () => finish();
        const failed = (error: Error) => finish(error);
        const finish = (error?: Error) => {
            socket.off("connect", connected);
            socket.off("error", failed);
            if (error === undefined) resolve();
            else reject(error);
        };
        socket.once("connect", connected);
        socket.once("error", failed);
    });
}

function readSuccessfulConnectHead(socket: ReturnType<typeof connect>): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        let buffered = Buffer.alloc(0);
        const failed = (error: Error) => finish(error);
        const closed = () =>
            finish(new Error("The remote Rig daemon closed the SSH bridge unexpectedly."));
        const received = (chunk: Buffer) => {
            buffered = Buffer.concat([buffered, chunk]);
            if (buffered.byteLength > MAXIMUM_RESPONSE_HEAD_BYTES) {
                finish(new Error("The remote Rig daemon returned an oversized bridge response."));
                return;
            }
            const end = buffered.indexOf("\r\n\r\n");
            if (end < 0) return;
            const head = buffered.subarray(0, end).toString("ascii");
            if (!/^HTTP\/1\.1 200(?:\s|$)/u.test(head)) {
                finish(new Error("The remote Rig daemon refused the SSH P2P bridge."));
                return;
            }
            finish(undefined, buffered.subarray(end + 4));
        };
        const finish = (error?: Error, remainder = Buffer.alloc(0)) => {
            socket.off("data", received);
            socket.off("error", failed);
            socket.off("close", closed);
            if (error === undefined) resolve(remainder);
            else reject(error);
        };
        socket.on("data", received);
        socket.once("error", failed);
        socket.once("close", closed);
    });
}
