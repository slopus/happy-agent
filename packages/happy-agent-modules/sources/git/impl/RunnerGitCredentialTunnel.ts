import { connect } from "node:net";
import type { Duplex } from "node:stream";

import type { Compute, ComputeListener } from "@slopus/happy-agent-compute";
import type { Context } from "@steve.kite/stdlib";

/**
 * How Git on a runner reaches the credential proxy without the token ever leaving this machine.
 *
 * The proxy listens on this machine's loopback and adds a repository's token to requests for that
 * repository. Each runner gets one loopback port of its own, whose connections travel back over
 * the runner connection and into the proxy; Git on the runner is pointed at that port instead.
 */
export class RunnerGitCredentialTunnel {
    readonly #listeners = new Map<Compute, Promise<ComputeListener>>();
    #closed = false;

    /** The loopback port on the runner that leads to the proxy at `proxyPort` here. */
    async port(ctx: Context, machine: Compute, proxyPort: number): Promise<number> {
        if (this.#closed) throw new Error("The Git credential tunnel is closed.");
        let pending = this.#listeners.get(machine);
        if (pending === undefined) {
            pending = this.#open(ctx, machine, proxyPort);
            this.#listeners.set(machine, pending);
            pending.catch(() => {
                if (this.#listeners.get(machine) === pending) this.#listeners.delete(machine);
            });
        }
        return (await pending).port;
    }

    close(): void {
        this.#closed = true;
        for (const pending of this.#listeners.values()) {
            void pending.then((listener) => listener.close()).catch(() => undefined);
        }
        this.#listeners.clear();
    }

    async #open(ctx: Context, machine: Compute, proxyPort: number): Promise<ComputeListener> {
        const listen = machine.network?.listen;
        if (listen === undefined) {
            throw new Error("This runner cannot carry Git credentials; update its Happy Agent.");
        }
        const listener = await listen.call(machine.network, ctx);
        listener.onConnection((socket) => forward(socket, proxyPort));
        void listener.closed.finally(() => {
            const current = this.#listeners.get(machine);
            void current?.then((open) => {
                if (open === listener) this.#listeners.delete(machine);
            });
        });
        return listener;
    }
}

function forward(socket: Duplex, proxyPort: number): void {
    const upstream = connect({ host: "127.0.0.1", port: proxyPort });
    const end = () => {
        socket.destroy();
        upstream.destroy();
    };
    socket.on("error", end);
    upstream.on("error", end);
    socket.on("close", () => upstream.end());
    upstream.on("close", () => socket.end());
    socket.pipe(upstream);
    upstream.pipe(socket);
}
