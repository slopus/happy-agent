import type { Duplex } from "node:stream";

import type { Context } from "@steve.kite/stdlib";

/** Where to connect, as the compute's own network names it. */
export interface ComputeConnectOptions {
    host: string;
    port: number;
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
    /** Open a TCP connection. Resolves once it is established; rejects when it cannot be. */
    connect(ctx: Context, options: ComputeConnectOptions): Promise<Duplex>;
    /**
     * Listen on the compute's loopback. This is how a program on a remote machine reaches back to
     * something only the caller can do — Git reaching the credential proxy, for one.
     */
    listen?(ctx: Context): Promise<ComputeListener>;
}
