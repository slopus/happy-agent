import type { Duplex } from "node:stream";

import type { Context } from "@steve.kite/stdlib";

/** Where to connect, as the compute's own network names it. */
export interface ComputeConnectOptions {
    host: string;
    port: number;
}

/** Which loopback port to listen on, and who may connect to it. */
export interface ComputeListenOptions {
    /**
     * The port, which must be free. Absent, the machine picks one. A port that is taken rejects
     * with `EADDRINUSE`, one the machine will not grant with `EACCES`.
     */
    port?: number;
    /**
     * Admit only connections from programs running as the machine's own user, the one serving
     * this compute. Linux checks each connection against the kernel's socket table and closes any
     * it cannot attribute; other systems expose no such table, and every local user can connect.
     */
    ownerOnly?: boolean;
}

/**
 * A loopback port on the compute's machine whose connections arrive here.
 *
 * Connections that arrive before anyone listens are held, up to a small bound, so none is lost
 * between `listen` resolving and the caller subscribing.
 */
export interface ComputeListener {
    /** The port, on the compute's own `127.0.0.1`. */
    readonly port: number;
    onConnection(listener: (socket: Duplex) => void): () => void;
    /** Stop accepting and drop connections nobody took. Accepted ones stay open. */
    close(): void;
    /** Settles once the listener stopped, whoever stopped it. */
    readonly closed: Promise<void>;
}

/**
 * Connections made from the compute's network rather than the caller's.
 *
 * `localhost` means the compute's own loopback, so a dev server an agent started on a remote
 * machine is reachable exactly as it is from that machine. The product uses this to preview web
 * applications; it is not an agent tool, and the agent sandbox does not apply.
 */
export interface ComputeNetwork {
    /**
     * Open a TCP connection. Resolves once it is established; rejects when it cannot be, with a
     * Node-style code such as `ECONNREFUSED`, `ENOTFOUND`, `ETIMEDOUT`, or `ENOTSUP`.
     *
     * The duplex is half-open, as TCP is: ending it sends a half-close while replies keep arriving,
     * the remote end's half-close ends its readable side while writes continue, and destroying it
     * aborts the connection.
     */
    connect(ctx: Context, options: ComputeConnectOptions): Promise<Duplex>;
    /**
     * Listen on the compute's loopback. This is how a program on a remote machine reaches back to
     * a service owned by the caller.
     */
    listen?(ctx: Context, options?: ComputeListenOptions): Promise<ComputeListener>;
}
