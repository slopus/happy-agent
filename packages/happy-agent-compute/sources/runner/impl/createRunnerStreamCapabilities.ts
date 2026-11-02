import { Duplex } from "node:stream";

import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

import type {
    ComputeListener,
    ComputeListenOptions,
    ComputeNetwork,
} from "../../ComputeNetwork.js";
import type {
    ComputeProcess,
    ComputeProcesses,
    ComputeProcessExit,
    ComputeProcessSignal,
} from "../../ComputeProcesses.js";
import type { ComputeWatch, ComputeWatchBatch, ComputeWatcher } from "../../ComputeWatcher.js";
import { ChunkDelivery } from "../../processes/impl/ChunkDelivery.js";
import { RunnerProtocolError } from "../RunnerErrors.js";
import type { RunnerStream, RunnerStreamHandlers } from "../RunnerLink.js";
import {
    RUNNER_STREAM_WINDOW_BYTES,
    runnerAcceptedConnectionSchema,
    runnerWatchBatchSchema,
    type RunnerMethodParams,
    type RunnerMethodResult,
} from "../runnerProtocol.js";

type StreamMethod = "process.start" | "watch.start" | "net.connect" | "net.listen" | "net.accept";
type StreamParams<Method extends StreamMethod> = Omit<
    RunnerMethodParams<Method>,
    "computeId" | "stream"
>;

/** Connections a listener holds for a caller that has not subscribed yet. */
const MAX_HELD_CONNECTIONS = 64;
/**
 * How long a connection that finished in both directions may keep delivering what it had already
 * sent before the runner is told to drop it, as TCP lingers after a close.
 */
const RUNNER_SOCKET_LINGER_MS = 30_000;

/** How the stream capabilities reach their runner compute. */
export interface RunnerStreamStarter {
    /**
     * Register a stream, ask the runner to start it, and resolve with its handle. `handlers` is
     * given the handle so its callbacks can acknowledge what they consumed.
     */
    start<Method extends StreamMethod>(
        method: Method,
        params: StreamParams<Method>,
        handlers: (stream: () => RunnerStream) => RunnerStreamHandlers,
    ): Promise<{ stream: RunnerStream; result: RunnerMethodResult<Method> }>;
    resize(stream: RunnerStream, cols: number, rows: number): void;
    signal(stream: RunnerStream, signal: ComputeProcessSignal): void;
}

const encoder = new TextEncoder();

/** Programs on the runner, with the same delivery and backpressure as programs on the host. */
export function createRunnerProcesses(starter: RunnerStreamStarter): ComputeProcesses {
    return {
        async start(_ctx: Context, options): Promise<ComputeProcess> {
            let resolveExit!: (exit: ComputeProcessExit) => void;
            const exit = new Promise<ComputeProcessExit>((resolve) => {
                resolveExit = resolve;
            });
            let stdout!: ChunkDelivery;
            let stderr!: ChunkDelivery;
            const { stream } = await starter.start(
                "process.start",
                {
                    command: options.command,
                    args: [...(options.args ?? [])],
                    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
                    ...(options.environment === undefined
                        ? {}
                        : { environment: { ...options.environment } }),
                    ...(options.terminal === undefined
                        ? {}
                        : {
                              terminal: {
                                  cols: options.terminal.cols,
                                  rows: options.terminal.rows,
                                  ...(options.terminal.name === undefined
                                      ? {}
                                      : { name: options.terminal.name }),
                              },
                          }),
                },
                (handle) => {
                    stdout = new ChunkDelivery(RUNNER_STREAM_WINDOW_BYTES, (bytes) =>
                        handle().consumed("out", bytes),
                    );
                    stderr = new ChunkDelivery(RUNNER_STREAM_WINDOW_BYTES, (bytes) =>
                        handle().consumed("err", bytes),
                    );
                    const delivery = (channel: "out" | "err") =>
                        channel === "out" ? stdout : stderr;
                    return {
                        data: (channel, chunk) => delivery(channel).push(chunk),
                        eof: (channel) => delivery(channel).end(),
                        exit: ({ exitCode, signal }) => {
                            stdout.end();
                            stderr.end();
                            resolveExit({ exitCode, signal });
                        },
                        lost: () => {
                            stdout.end();
                            stderr.end();
                            resolveExit({ exitCode: null, signal: "SIGKILL" });
                        },
                    };
                },
            );
            return {
                onStdout: (listener) => stdout.listen(listener),
                onStderr: (listener) => stderr.listen(listener),
                write: (data) =>
                    stream.write(typeof data === "string" ? encoder.encode(data) : data).then(
                        () => true,
                        () => false,
                    ),
                endInput: () => stream.end(),
                resize: (cols, rows) => starter.resize(stream, cols, rows),
                signal: (signal) => starter.signal(stream, signal),
                pause() {
                    stdout.setPaused(true);
                    stderr.setPaused(true);
                },
                resume() {
                    stdout.setPaused(false);
                    stderr.setPaused(false);
                },
                exited: exit.then(async (ended) => {
                    await Promise.all([stdout.drained(), stderr.drained()]);
                    return ended;
                }),
            };
        },
    };
}

/** Watches on the runner, decoded from the stream's newline-delimited JSON batches. */
export function createRunnerWatcher(starter: RunnerStreamStarter): ComputeWatcher {
    return {
        async watch(_ctx, options): Promise<ComputeWatch> {
            const decoder = new TextDecoder();
            const held: Array<{ batch: ComputeWatchBatch; bytes: number }> = [];
            let partial = "";
            let listener: ((batch: ComputeWatchBatch) => void) | undefined;
            let resolveClosed!: (result: { reason?: string }) => void;
            const closed = new Promise<{ reason?: string }>((resolve) => {
                resolveClosed = resolve;
            });
            let handle!: () => RunnerStream;
            const deliver = () => {
                while (listener !== undefined && held.length > 0) {
                    const { batch, bytes } = held.shift()!;
                    listener(batch);
                    handle().consumed("out", bytes);
                }
            };
            const { stream } = await starter.start(
                "watch.start",
                {
                    path: options.path,
                    ...(options.ignore === undefined ? {} : { ignore: [...options.ignore] }),
                },
                (getStream) => {
                    handle = getStream;
                    return {
                        data(_channel, chunk) {
                            partial += decoder.decode(chunk, { stream: true });
                            let newline = partial.indexOf("\n");
                            while (newline >= 0) {
                                const line = partial.slice(0, newline);
                                partial = partial.slice(newline + 1);
                                const bytes = encoder.encode(line).byteLength + 1;
                                const batch: unknown = JSON.parse(line);
                                if (!Value.Check(runnerWatchBatchSchema, batch)) {
                                    throw new RunnerProtocolError(
                                        "The runner sent an invalid file watch batch.",
                                    );
                                }
                                held.push({ batch, bytes });
                                newline = partial.indexOf("\n");
                            }
                            deliver();
                        },
                        eof: () => undefined,
                        exit: ({ error }) =>
                            resolveClosed(error === undefined ? {} : { reason: error.message }),
                        lost: (reason) => resolveClosed({ reason }),
                    };
                },
            );
            return {
                onChange(next) {
                    listener = next;
                    deliver();
                    return () => {
                        if (listener === next) listener = undefined;
                    };
                },
                closed,
                close: () => stream.close(),
            };
        },
    };
}

/** Connections from the runner's network, as ordinary Node duplex streams. */
export function createRunnerNetwork(starter: RunnerStreamStarter): ComputeNetwork {
    return {
        async connect(_ctx, options) {
            const socket = new RunnerSocket();
            const { stream } = await starter.start("net.connect", options, (handle) =>
                socket.handlers(handle),
            );
            socket.attach(stream);
            return socket;
        },
        listen: async (_ctx, options = {}) => await listenOnRunner(starter, options),
    };
}

/**
 * A loopback listener on the runner. The runner announces each accepted connection on the
 * listener's stream, and this side attaches it to a stream of its own before handing it on.
 */
async function listenOnRunner(
    starter: RunnerStreamStarter,
    options: ComputeListenOptions,
): Promise<ComputeListener> {
    const decoder = new TextDecoder();
    const held: RunnerSocket[] = [];
    let partial = "";
    let listener: ((socket: Duplex) => void) | undefined;
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
        resolveClosed = resolve;
    });
    let ended = false;
    const end = () => {
        ended = true;
        for (const socket of held.splice(0)) socket.destroy();
        resolveClosed();
    };
    const accept = (listenerStream: RunnerStream, connection: number) => {
        const socket = new RunnerSocket();
        void starter
            .start("net.accept", { listener: listenerStream.id, connection }, (handle) =>
                socket.handlers(handle),
            )
            .then(({ stream }) => {
                socket.attach(stream);
                if (ended) {
                    socket.destroy();
                } else if (listener !== undefined) {
                    listener(socket);
                } else if (held.length < MAX_HELD_CONNECTIONS) {
                    held.push(socket);
                } else {
                    socket.destroy();
                }
            })
            .catch(() => socket.destroy());
    };
    let handle!: () => RunnerStream;
    const params = {
        ...(options.port === undefined ? {} : { port: options.port }),
        ...(options.ownerOnly === undefined ? {} : { ownerOnly: options.ownerOnly }),
    };
    const { stream, result } = await starter.start("net.listen", params, (getStream) => {
        handle = getStream;
        return {
            data(_channel, chunk) {
                partial += decoder.decode(chunk, { stream: true });
                let newline = partial.indexOf("\n");
                while (newline >= 0) {
                    const line = partial.slice(0, newline);
                    partial = partial.slice(newline + 1);
                    const announced: unknown = JSON.parse(line);
                    if (!Value.Check(runnerAcceptedConnectionSchema, announced)) {
                        throw new RunnerProtocolError(
                            "The runner announced an invalid connection.",
                        );
                    }
                    handle().consumed("out", encoder.encode(line).byteLength + 1);
                    accept(handle(), announced.connection);
                    newline = partial.indexOf("\n");
                }
            },
            eof: () => undefined,
            exit: () => end(),
            lost: () => end(),
        };
    });
    return {
        port: result.port,
        onConnection(next) {
            listener = next;
            for (const socket of held.splice(0)) next(socket);
            return () => {
                if (listener === next) listener = undefined;
            };
        },
        close: () => stream.close(),
        closed,
    };
}

/**
 * A connection on the runner. Bytes the reader has not taken yet are not acknowledged, so a slow
 * reader slows the remote end through the runner's window instead of filling this process.
 */
class RunnerSocket extends Duplex {
    #stream: RunnerStream | undefined;
    #handle: (() => RunnerStream) | undefined;
    #unacknowledged = 0;
    #ended = false;
    #exited = false;
    #linger: ReturnType<typeof setTimeout> | undefined;

    attach(stream: RunnerStream): void {
        this.#stream = stream;
    }

    handlers(handle: () => RunnerStream): RunnerStreamHandlers {
        this.#handle = handle;
        return {
            data: (_channel, chunk) => {
                if (this.push(chunk)) handle().consumed("out", chunk.byteLength);
                else this.#unacknowledged += chunk.byteLength;
            },
            eof: () => {
                this.#ended = true;
                this.push(null);
            },
            exit: ({ error }) => {
                this.#finished();
                if (error !== undefined) {
                    this.destroy(error);
                    return;
                }
                if (!this.#ended) {
                    this.#ended = true;
                    this.push(null);
                }
            },
            lost: (reason) => {
                this.#finished();
                this.destroy(new Error(reason));
            },
        };
    }

    override _read(): void {
        if (this.#unacknowledged === 0 || this.#handle === undefined) return;
        const bytes = this.#unacknowledged;
        this.#unacknowledged = 0;
        this.#handle().consumed("out", bytes);
    }

    override _write(
        chunk: Buffer,
        _encoding: BufferEncoding,
        callback: (error?: Error | null) => void,
    ): void {
        const stream = this.#stream ?? this.#handle?.();
        if (stream === undefined) {
            callback(new Error("The connection is not open."));
            return;
        }
        stream.write(chunk).then(() => callback(), callback);
    }

    override _final(callback: (error?: Error | null) => void): void {
        (this.#stream ?? this.#handle?.())?.end();
        callback();
    }

    /**
     * Both directions finishing destroys this side at once, while bytes written last may still be
     * on their way through the runner's window. Closing the stream then would drop them, so a
     * connection that finished cleanly is left to end on the runner by itself, within a bound.
     * Anything else — an error, or a destroy before both sides finished — stops it now.
     */
    override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
        const stream = this.#stream ?? this.#handle?.();
        const finishedCleanly = error === null && this.#ended && this.writableFinished;
        if (!finishedCleanly || this.#exited) {
            stream?.close();
        } else {
            this.#linger = setTimeout(() => stream?.close(), RUNNER_SOCKET_LINGER_MS);
            this.#linger.unref?.();
        }
        callback(error);
    }

    #finished(): void {
        this.#exited = true;
        clearTimeout(this.#linger);
    }
}
