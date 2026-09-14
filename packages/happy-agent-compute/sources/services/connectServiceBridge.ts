import { createConnection, type Socket } from "node:net";
import { ServiceEndpointUnavailableError } from "./ServiceRuntimeErrors.js";

/** Authenticate on the controller-only Unix socket; never put its credential in an HTTP request. */
export function connectServiceBridge(
    socketPath: string,
    token: string,
    connections: Set<Socket>,
): Promise<Socket> {
    if (connections.size >= 64)
        throw new ServiceEndpointUnavailableError(
            "This service already has the maximum number of open connections.",
        );
    return new Promise((resolve, reject) => {
        const socket = createConnection({ path: socketPath });
        // The caller may cross an asynchronous tracing boundary before attaching its listeners.
        socket.on("error", () => undefined);
        connections.add(socket);
        socket.once("close", () => connections.delete(socket));
        let settled = false;
        const timer = setTimeout(() => fail(), 5000);
        timer.unref();
        const cleanup = () => {
            clearTimeout(timer);
            socket.removeListener("connect", authenticate);
            socket.removeListener("data", acknowledge);
            socket.removeListener("error", fail);
            socket.removeListener("close", fail);
        };
        const fail = () => {
            if (settled) return;
            settled = true;
            cleanup();
            socket.destroy();
            reject(new ServiceEndpointUnavailableError());
        };
        const authenticate = () => socket.write(token, "ascii");
        const acknowledge = (data: Buffer) => {
            if (data.length === 0) return;
            if (data[0] !== 1) {
                fail();
                return;
            }
            settled = true;
            socket.pause();
            cleanup();
            if (data.length > 1) socket.unshift(data.subarray(1));
            resolve(socket);
        };
        socket.once("connect", authenticate);
        socket.on("data", acknowledge);
        socket.once("error", fail);
        socket.once("close", fail);
    });
}
