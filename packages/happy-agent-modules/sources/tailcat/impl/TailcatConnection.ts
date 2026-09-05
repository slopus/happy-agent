import { spawn, type ChildProcess } from "node:child_process";
import { connect, type Socket } from "node:net";

/** A persistent Tailcat SOCKS carrier with native TCP sockets on both Node and Bun. */
export class TailcatConnection {
    readonly #executable: string;
    readonly #address: string;
    readonly #onClose: () => void;
    readonly #sockets = new Set<Socket>();
    #stopped = false;
    #starting: Promise<number> | undefined;
    #run: { child: ChildProcess; exited: Promise<void> } | undefined;

    constructor(executable: string, address: string, onClose: () => void = () => undefined) {
        this.#executable = executable;
        this.#address = address;
        this.#onClose = onClose;
    }

    async connect(port: number): Promise<Socket> {
        if (this.#stopped) throw failed();
        const socksPort = await (this.#starting ??= this.#start());
        if (this.#stopped) throw failed();
        const socket = connect({ host: "127.0.0.1", port: socksPort });
        this.#sockets.add(socket);
        socket.once("close", () => this.#sockets.delete(socket));
        socket.setTimeout(30_000, () => socket.destroy(failed()));
        // Always own errors, including the gap between SOCKS admission and HTTP attachment.
        socket.on("error", () => undefined);
        try {
            socket.write(Buffer.from([5, 1, 0]));
            const greeting = await readBytes(socket, 2);
            if (greeting[0] !== 5 || greeting[1] !== 0) throw failed();
            const host = Buffer.from("server.tailcat");
            const query = Buffer.alloc(7 + host.length);
            query.set([5, 1, 0, 3, host.length]);
            host.copy(query, 5);
            query.writeUInt16BE(port, 5 + host.length);
            socket.write(query);
            const reply = await readBytes(socket, 4);
            if (reply[0] !== 5 || reply[1] !== 0 || reply[2] !== 0) throw failed();
            const bytes =
                reply[3] === 1
                    ? 4
                    : reply[3] === 4
                      ? 16
                      : reply[3] === 3
                        ? (await readBytes(socket, 1))[0]!
                        : -1;
            if (bytes < 0) throw failed();
            await readBytes(socket, bytes + 2);
            socket.setTimeout(0);
            return socket;
        } catch {
            socket.destroy();
            throw failed();
        }
    }

    async close(): Promise<void> {
        this.#stopped = true;
        this.#onClose();
        for (const socket of this.#sockets) socket.destroy();
        const run = this.#run;
        if (run === undefined) return;
        run.child.kill("SIGTERM");
        const timer = setTimeout(() => run.child.kill("SIGKILL"), 2000);
        timer.unref();
        await run.exited;
        clearTimeout(timer);
    }

    async #start(): Promise<number> {
        const child = spawn(
            this.#executable,
            ["--key=new", "socks", "--listen=127.0.0.1:0", this.#address],
            { stdio: ["ignore", "pipe", "pipe"] },
        );
        const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
        const run = { child, exited };
        this.#run = run;
        void exited.then(() => {
            if (this.#run === run) {
                this.#run = undefined;
                this.#starting = undefined;
            }
        });
        return await new Promise<number>((resolve, reject) => {
            let settled = false;
            let output = "";
            const timer = setTimeout(() => {
                settle();
                child.kill("SIGKILL");
            }, 30_000);
            timer.unref();
            const settle = (port?: number) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                output = "";
                if (port === undefined) reject(failed());
                else resolve(port);
            };
            const data = (chunk: Buffer) => {
                if (settled) return;
                output = `${output}${chunk.toString("utf8")}`.slice(-8192);
                const match = /SOCKS running at socks5h:\/\/127\.0\.0\.1:(\d+)/u.exec(output);
                if (match !== null) {
                    const port = Number(match[1]);
                    if (port >= 1 && port <= 65535) settle(port);
                }
            };
            child.stdout?.on("data", data);
            child.stderr?.on("data", data);
            child.once("error", () => settle());
            void exited.then(() => settle());
        });
    }
}

async function readBytes(socket: Socket, size: number): Promise<Buffer> {
    return await new Promise<Buffer>((resolve, reject) => {
        const cleanup = () => {
            socket.off("readable", read);
            socket.off("error", stop);
            socket.off("end", stop);
            socket.off("close", stop);
        };
        const stop = () => {
            cleanup();
            reject(failed());
        };
        const read = () => {
            const bytes: Buffer | null = socket.read(size);
            if (bytes !== null) {
                cleanup();
                resolve(bytes);
            } else if (socket.destroyed || socket.readableEnded) stop();
        };
        socket.on("readable", read);
        socket.once("error", stop);
        socket.once("end", stop);
        socket.once("close", stop);
        read();
    });
}

function failed(): Error {
    return new Error("The remote Tailcat transport is unavailable.");
}
